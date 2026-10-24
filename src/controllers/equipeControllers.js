// EQUIPE: convites, cadastro direto e ativação de administradores e
// autorizadores. Tudo aqui é do admin universal, menos a troca da própria
// senha, que vale para qualquer funcionário logado.

import bcrypt from 'bcrypt';
import knex from '../database/index.js';
import {
  PERFIS_EQUIPE, VALIDADE_CONVITE_DIAS, cadastrarAdministrador, cadastrarAutorizador,
  gerarCodigoConvite, hashCodigo,
} from '../utils/equipe.js';
import { idDoAdmin } from '../utils/contas.js';
import { coletarErros, idValido, mensagemErroBanco, validarConfirmacaoSenha, validarSenha } from '../utils/validacoes.js';

// Tabela e colunas de cada perfil da equipe
const TABELAS = {
  ADMIN: { tabela: 'administrador', id: 'adm_id', ativo: 'adm_ativo', senha: 'adm_senha', provisoria: 'adm_senha_provisoria' },
  AUTORIZADOR: { tabela: 'autorizador', id: 'aut_id', ativo: 'aut_ativo', senha: 'aut_senha', provisoria: 'aut_senha_provisoria' },
};

const situacaoConvite = (c, agora = new Date()) => {
  if (c.cnv_usado_em) return 'usado';
  if (c.cnv_cancelado_em) return 'cancelado';
  if (new Date(c.cnv_expira_em) < agora) return 'expirado';
  return 'pendente';
};

export default {

  // Lista de funcionários (sem senha), administradores primeiro
  async listar(req, res) {
    try {
      const admins = await knex('administrador as adm')
        .leftJoin('postosdesaude as pos', 'pos.pos_id', 'adm.pos_id')
        .orderBy('adm.adm_nome')
        .select(
          'adm.adm_id', 'adm.adm_nome', 'adm.adm_email', 'adm.adm_tel', 'adm.adm_matricula',
          'adm.tp_universal', 'adm.adm_ativo', 'adm.adm_senha_provisoria', 'adm.pos_id', 'pos.pos_nome',
        );
      const autorizadores = await knex('autorizador')
        .orderBy('aut_nome')
        .select('aut_id', 'aut_nome', 'aut_email', 'aut_tel', 'aut_ativo', 'aut_senha_provisoria');

      const equipe = [
        ...admins.map((a) => ({
          perfil: 'ADMIN',
          id: a.adm_id,
          nome: a.adm_nome,
          email: a.adm_email,
          telefone: a.adm_tel,
          matricula: a.adm_matricula,
          universal: Boolean(a.tp_universal),
          unidade: a.tp_universal ? 'Todas as unidades' : a.pos_nome ?? null,
          ativo: a.adm_ativo !== false,
          senha_provisoria: Boolean(a.adm_senha_provisoria),
        })),
        ...autorizadores.map((a) => ({
          perfil: 'AUTORIZADOR',
          id: a.aut_id,
          nome: a.aut_nome,
          email: a.aut_email,
          telefone: a.aut_tel,
          unidade: null,
          ativo: a.aut_ativo !== false,
          senha_provisoria: Boolean(a.aut_senha_provisoria),
        })),
      ];

      return res.status(200).json(equipe);
    } catch (error) {
      console.error('Erro ao listar a equipe:', error);
      return res.status(500).json({ error: 'Erro ao listar a equipe' });
    }
  },

  // Cadastro direto pelo admin universal, com senha provisória gerada aqui.
  // A senha volta UMA vez na resposta, para ser entregue ao funcionário.
  async cadastrar(req, res) {
    try {
      const { perfil, ...dados } = req.body ?? {};
      if (!PERFIS_EQUIPE.includes(perfil)) {
        return res.status(400).json({ sucesso: false, erros: ['Escolha o perfil: administrador ou autorizador.'] });
      }
      const { status, body } = perfil === 'ADMIN'
        ? await cadastrarAdministrador(knex, dados, { senhaProvisoria: true })
        : await cadastrarAutorizador(knex, dados, { senhaProvisoria: true });
      return res.status(status).json(body);
    } catch (error) {
      console.error('Erro ao cadastrar funcionário:', error);
      if (error?.code === '23505') {
        return res.status(409).json({ sucesso: false, erros: ['Matrícula já cadastrada.'] });
      }
      const doBanco = mensagemErroBanco(error);
      if (doBanco) return res.status(400).json({ sucesso: false, erros: [doBanco] });
      return res.status(500).json({ erro: 'Erro ao cadastrar funcionário. Tente novamente.' });
    }
  },

  // Desativar / reativar. Ninguém desativa a si mesmo nem um admin universal.
  async alterarAtivo(req, res) {
    try {
      const config = TABELAS[req.params.perfil];
      if (!config) return res.status(400).json({ error: 'Perfil inválido.' });
      if (typeof req.body?.ativo !== 'boolean') {
        return res.status(400).json({ error: 'Informe se a conta fica ativa (true) ou inativa (false).' });
      }

      const id = Number(req.params.id);
      const conta = await knex(config.tabela).where(config.id, id).first();
      if (!conta) return res.status(404).json({ error: 'Funcionário não encontrado.' });

      if (req.params.perfil === 'ADMIN') {
        if (id === await idDoAdmin(req.session)) {
          return res.status(400).json({ error: 'Você não pode desativar a sua própria conta.' });
        }
        if (conta.tp_universal && req.body.ativo === false) {
          return res.status(400).json({ error: 'Um administrador universal não pode ser desativado por aqui.' });
        }
      }

      await knex(config.tabela).where(config.id, id).update({ [config.ativo]: req.body.ativo });
      return res.status(200).json({
        message: req.body.ativo ? 'Conta reativada.' : 'Conta desativada. O acesso foi bloqueado.',
        ativo: req.body.ativo,
      });
    } catch (error) {
      console.error('Erro ao alterar a conta:', error);
      return res.status(500).json({ error: 'Erro ao alterar a conta' });
    }
  },

  // Novo convite. O código aparece só nesta resposta (no banco fica o hash).
  async criarConvite(req, res) {
    try {
      const { perfil, posto_id } = req.body ?? {};
      if (!PERFIS_EQUIPE.includes(perfil)) {
        return res.status(400).json({ error: 'Escolha o perfil do convite: administrador ou autorizador.' });
      }

      let posto = null;
      if (perfil === 'ADMIN') {
        if (!idValido(posto_id)) return res.status(400).json({ error: 'Escolha a unidade do novo administrador.' });
        posto = await knex('postosdesaude').where('pos_id', Number(posto_id)).first('pos_id', 'pos_nome');
        if (!posto) return res.status(400).json({ error: 'Unidade de saúde não encontrada.' });
      }

      const codigo = gerarCodigoConvite();
      const expira = new Date(Date.now() + VALIDADE_CONVITE_DIAS * 86400000);
      const [novo] = await knex('convite_equipe')
        .insert({
          cnv_perfil: perfil,
          pos_id: posto?.pos_id ?? null,
          cnv_codigo_hash: hashCodigo(codigo),
          cnv_expira_em: expira,
          cnv_criado_por: await idDoAdmin(req.session),
        })
        .returning('cnv_id');

      return res.status(201).json({
        cnv_id: typeof novo === 'object' ? novo.cnv_id : novo,
        codigo,
        perfil,
        posto,
        expira_em: expira.toISOString(),
      });
    } catch (error) {
      console.error('Erro ao criar convite:', error);
      return res.status(500).json({ error: 'Erro ao criar convite' });
    }
  },

  // Convites dos últimos 30 dias (sem o código), mais recentes primeiro
  async listarConvites(req, res) {
    try {
      const desde = new Date(Date.now() - 30 * 86400000);
      const linhas = await knex('convite_equipe as c')
        .leftJoin('postosdesaude as pos', 'pos.pos_id', 'c.pos_id')
        .where('c.cnv_criado_em', '>=', desde)
        .orderBy('c.cnv_id', 'desc')
        .select(
          'c.cnv_id', 'c.cnv_perfil', 'c.pos_id', 'pos.pos_nome', 'c.cnv_criado_em', 'c.cnv_expira_em',
          'c.cnv_usado_em', 'c.cnv_usado_email', 'c.cnv_cancelado_em',
        );
      return res.status(200).json(linhas.map((c) => ({ ...c, situacao: situacaoConvite(c) })));
    } catch (error) {
      console.error('Erro ao listar convites:', error);
      return res.status(500).json({ error: 'Erro ao listar convites' });
    }
  },

  // Público: o formulário do link mostra para que perfil e unidade é o
  // convite antes de a pessoa preencher. Não marca nada como usado.
  async infoConvite(req, res) {
    try {
      const codigo = String(req.query.codigo ?? '');
      const convite = codigo
        ? await knex('convite_equipe as c')
          .leftJoin('postosdesaude as pos', 'pos.pos_id', 'c.pos_id')
          .where('c.cnv_codigo_hash', hashCodigo(codigo))
          .first('c.cnv_perfil', 'c.pos_id', 'pos.pos_nome', 'c.cnv_expira_em', 'c.cnv_usado_em', 'c.cnv_cancelado_em')
        : null;
      if (!convite) return res.status(404).json({ error: 'Convite inválido. Confira o link recebido.' });

      const situacao = situacaoConvite(convite);
      if (situacao !== 'pendente') {
        const motivo = { usado: 'Este convite já foi usado.', cancelado: 'Este convite foi cancelado.', expirado: 'Este convite expirou. Peça um novo.' };
        return res.status(410).json({ error: motivo[situacao], situacao });
      }
      return res.status(200).json({
        perfil: convite.cnv_perfil,
        posto: convite.pos_id ? { pos_id: convite.pos_id, pos_nome: convite.pos_nome } : null,
        expira_em: convite.cnv_expira_em,
      });
    } catch (error) {
      console.error('Erro ao consultar convite:', error);
      return res.status(500).json({ error: 'Erro ao consultar o convite' });
    }
  },

  async cancelarConvite(req, res) {
    try {
      const convite = await knex('convite_equipe').where('cnv_id', Number(req.params.id)).first();
      if (!convite) return res.status(404).json({ error: 'Convite não encontrado.' });
      if (situacaoConvite(convite) !== 'pendente') {
        return res.status(409).json({ error: 'Só é possível cancelar convites ainda não usados e dentro da validade.' });
      }
      await knex('convite_equipe').where('cnv_id', convite.cnv_id).update({ cnv_cancelado_em: knex.fn.now() });
      return res.status(200).json({ message: 'Convite cancelado.' });
    } catch (error) {
      console.error('Erro ao cancelar convite:', error);
      return res.status(500).json({ error: 'Erro ao cancelar convite' });
    }
  },

  // Troca da própria senha (admin ou autorizador). Obrigatória no primeiro
  // acesso de quem foi cadastrado com senha provisória.
  async trocarSenha(req, res) {
    try {
      const sessao = req.session;
      const config = TABELAS[sessao.tipo];
      if (!config) return res.status(403).json({ error: 'Perfil sem permissão' });

      const { senha_atual, nova_senha, confirmacao_senha } = req.body ?? {};
      const erros = coletarErros(
        typeof senha_atual === 'string' && senha_atual ? null : 'Informe a senha atual.',
        validarSenha(nova_senha),
        validarConfirmacaoSenha(nova_senha, confirmacao_senha),
        nova_senha && nova_senha === senha_atual ? 'A nova senha deve ser diferente da atual.' : null,
      );
      if (erros.length) return res.status(400).json({ sucesso: false, erros });

      const id = sessao.tipo === 'ADMIN' ? await idDoAdmin(sessao) : Number(sessao.id);
      const conta = await knex(config.tabela).where(config.id, id ?? null).first();
      if (!conta) return res.status(404).json({ error: 'Usuário não encontrado' });

      if (!(await bcrypt.compare(senha_atual, conta[config.senha]))) {
        return res.status(400).json({ sucesso: false, erros: ['A senha atual está incorreta.'] });
      }

      await knex(config.tabela).where(config.id, id).update({
        [config.senha]: await bcrypt.hash(nova_senha, 10),
        [config.provisoria]: false,
      });
      return res.status(200).json({ message: 'Senha alterada com sucesso.' });
    } catch (error) {
      console.error('Erro ao trocar a senha:', error);
      return res.status(500).json({ error: 'Erro ao trocar a senha' });
    }
  },
};
