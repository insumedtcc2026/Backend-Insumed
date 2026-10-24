import knex from '../database/index.js';
import bcrypt from 'bcrypt';
import jsonwebtoken from 'jsonwebtoken';
import {
  cpfValido, mensagemErroBanco, normalizarEmail, somenteDigitos, validarEmail, whereCpf,
} from '../utils/validacoes.js';
import { cadastrarComConvite } from '../utils/equipe.js';
import { registrarFalhaLogin, registrarSucessoLogin } from '../middleware/limiteLogin.js';

// Os três perfis que podem entrar pelo mesmo formulário de login, na ordem
// em que são procurados. Cada um diz onde ficam e-mail, CPF e senha, o que
// vai no token e o que volta para o frontend (formato de sempre).
const PERFIS_LOGIN = [
  {
    tipo: 'ADMIN',
    tabela: 'administrador',
    email: 'adm_email', cpf: 'adm_cpf', senha: 'adm_senha', nome: 'adm_nome',
    ativo: 'adm_ativo', provisoria: 'adm_senha_provisoria',
    token: (a) => ({
      // adm_id (migração de 18/10): número fixo do admin
      id: a.adm_id ?? undefined,
      email: a.adm_email,
      posto_id: a.pos_id,
      tp_universal: a.tp_universal,
      tipo: 'ADMIN',
    }),
    usuario: (a) => ({
      adm_id: a.adm_id ?? null,
      adm_nome: a.adm_nome,
      adm_cpf: a.adm_cpf,
      adm_email: a.adm_email,
      adm_tel: a.adm_tel,
      // informações necessárias para autorização
      posto_id: a.pos_id,
      tp_universal: a.tp_universal,
      tipo: 'ADMIN',
    }),
  },
  {
    tipo: 'AUTORIZADOR',
    tabela: 'autorizador',
    email: 'aut_email', cpf: 'aut_cpf', senha: 'aut_senha', nome: 'aut_nome',
    ativo: 'aut_ativo', provisoria: 'aut_senha_provisoria',
    token: (a) => ({ id: a.aut_id, email: a.aut_email, tipo: 'AUTORIZADOR' }),
    usuario: (a) => ({
      aut_id: a.aut_id,
      aut_nome: a.aut_nome,
      aut_cpf: a.aut_cpf,
      aut_email: a.aut_email,
      aut_tel: a.aut_tel,
      tipo: 'AUTORIZADOR',
    }),
  },
  {
    tipo: 'PACIENTE',
    tabela: 'pacientes',
    email: 'pac_email', cpf: 'pac_cpf', senha: 'pac_senha', nome: 'pac_nome',
    token: (p) => ({ id: p.pac_id, email: p.pac_email, tipo: 'PACIENTE' }),
    usuario: (p) => ({
      pac_id: p.pac_id,
      pac_nome: p.pac_nome,
      pac_email: p.pac_email,
      pac_telefone: p.pac_telefone,
      pac_cpf: p.pac_cpf,
      pac_cep: p.pac_cep,
      pac_data_nasc: p.pac_data_nasc,
      pac_endereco: p.pac_endereco,
      pac_sexo: p.pac_sexo,
      pac_raca: p.pac_raca,
      // atendimento prioritário declarado (etapa 3)
      pac_pcd: Boolean(p.pac_pcd),
      pac_gestante: Boolean(p.pac_gestante),
      pac_prioridade_conferida: p.pac_prioridade_conferida ?? null,
      tipo: 'PACIENTE',
    }),
  },
];

// "E-mail ou CPF" do formulário -> { email } | { cpf } | null
export function lerIdentificador(valor) {
  if (typeof valor !== 'string' || !valor.trim()) return null;
  if (valor.includes('@')) return validarEmail(valor) ? null : { email: normalizarEmail(valor) };
  const digitos = somenteDigitos(valor);
  return digitos.length === 11 && cpfValido(digitos) ? { cpf: digitos } : null;
}

export default {

  // busca todos os administradores
  async administradorall(req, res) {
    try {
      const dados = (await knex('administrador')).map(({ adm_senha, ...resto }) => resto);
      return res.status(200).send(dados);
    } catch (error) {
      return res.status(500).send({
        message: 'Erro ao buscar administradores'
      });
    }
  },

  // Cadastro pelo link do convite (o admin universal gera o convite com a
  // unidade). Sem convite válido, nada é criado.
  async createadministrador(req, res) {
    try {
      const { status, body } = await cadastrarComConvite('ADMIN', req.body ?? {});
      return res.status(status).send(body);
    } catch (error) {
      console.error('Erro ao criar administrador:', error);
      // índice único da matrícula (cadastro simultâneo)
      if (error?.code === '23505') {
        return res.status(409).json({ sucesso: false, erros: ['Matrícula já cadastrada.'] });
      }
      const doBanco = mensagemErroBanco(error);
      if (doBanco) return res.status(400).json({ sucesso: false, erros: [doBanco] });
      return res.status(500).send({
        erro: 'Erro ao criar administrador. Tente novamente.'
      });
    }
  },

  // LOGIN ÚNICO: e-mail ou CPF + senha, para os três perfis.
  // O e-mail é único entre os perfis; o CPF não (a mesma pessoa pode ser
  // paciente e funcionária). Nesse caso a resposta pede a escolha do perfil
  // ("escolher_perfil") e o frontend repete o login enviando "perfil".
  async loginGeral(req, res) {
    try {
      const { senha, perfil } = req.body ?? {};
      const informado = req.body?.login ?? req.body?.email;

      if (!informado || !senha) {
        return res.status(400).json({ erro: 'E-mail ou CPF e senha são obrigatórios' });
      }

      const id = lerIdentificador(informado);
      if (!id || typeof senha !== 'string') {
        return res.status(400).json({ erro: 'Informe um e-mail ou CPF válido.' });
      }

      const secret = process.env.ACCESS_TOKEN_SECRET;
      if (!secret) {
        console.error('ACCESS_TOKEN_SECRET não configurada');
        return res.status(500).json({ erro: 'Chave de autenticação não configurada' });
      }

      // contas com essa senha, em cada perfil
      const encontrados = [];
      for (const config of PERFIS_LOGIN) {
        if (perfil && perfil !== config.tipo) continue;
        const linhas = id.email
          ? await knex(config.tabela).whereRaw(`LOWER(${config.email}) = ?`, [id.email])
          : await knex(config.tabela).whereRaw(...whereCpf(config.cpf), [id.cpf]);
        for (const linha of linhas) {
          if (linha[config.senha] && await bcrypt.compare(senha, linha[config.senha])) {
            encontrados.push({ config, linha });
          }
        }
      }

      if (!encontrados.length) {
        const tentativasRestantes = registrarFalhaLogin(req);

        if (tentativasRestantes === 0) {
          return res.status(429).json({
            erro: 'Muitas tentativas de login. Seu acesso foi bloqueado por 15 minutos.',
            tentar_novamente_em: 15 * 60
          });
        }

        return res.status(401).json({
          msg: id.email ? 'E-mail ou senha inválidos' : 'CPF ou senha inválidos',
          tentativas_restantes: tentativasRestantes
        });
      }

      // conta desativada pelo admin universal (a senha estava certa)
      const ativos = encontrados.filter(({ config, linha }) => !config.ativo || linha[config.ativo] !== false);
      if (!ativos.length) {
        registrarSucessoLogin(req);
        return res.status(403).json({
          erro: 'Esta conta foi desativada. Procure a administração da rede de saúde.'
        });
      }

      if (ativos.length > 1) {
        registrarSucessoLogin(req);
        return res.status(200).json({
          escolher_perfil: true,
          perfis: ativos.map(({ config, linha }) => ({ tipo: config.tipo, nome: linha[config.nome] })),
        });
      }

      const [{ config, linha }] = ativos;
      const token = jsonwebtoken.sign(config.token(linha), secret, { expiresIn: '7d' });

      registrarSucessoLogin(req);
      return res.status(200).json({
        msg: 'Autenticação realizada com sucesso',
        token,
        usuario: config.usuario(linha),
        // cadastro feito pelo admin universal: trocar a senha antes de usar
        ...(config.provisoria && linha[config.provisoria] ? { trocar_senha: true } : {}),
        ...(config.tipo === 'PACIENTE' ? { tipo: 'PACIENTE' } : {}),
      });

    } catch (error) {
      console.error('ERRO NO LOGIN:', error);
      return res.status(500).json({
        erro: 'Erro interno ao fazer login. Tente novamente.'
      });
    }
  },
};
