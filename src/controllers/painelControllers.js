import knex from '../database/index.js';
import {
  coletarErros, dataHojeBrasil, formatarTelefone, normalizarEmail, normalizarNome,
  validarDataISO, validarEmail, validarNome, validarTelefone,
} from '../utils/validacoes.js';
import { ACOES } from '../utils/historico.js';

// Insumo com quantidade até este valor aparece como "estoque baixo" no painel.
export const LIMITE_ESTOQUE_BAIXO = 5;

// Quantos dias à frente a sugestão de datas considera.
const DIAS_SUGESTAO = 14;

// Admin "universal" enxerga todos os postos; os demais, só o próprio.
const doPosto = (admin, coluna) => (qb) => {
  if (!admin.tp_universal) qb.where(coluna, admin.posto_id ?? null);
};

const contar = async (query) => Number((await query.count({ total: '*' }).first())?.total ?? 0);

// Perfis de admin e autorizador compartilham as mesmas regras de edição.
const PERFIS = {
  ADMIN: {
    tabela: 'administrador', id: 'adm_id',
    colunas: { nome: 'adm_nome', email: 'adm_email', telefone: 'adm_tel' },
  },
  AUTORIZADOR: {
    tabela: 'autorizador', id: 'aut_id',
    colunas: { nome: 'aut_nome', email: 'aut_email', telefone: 'aut_tel' },
  },
};

async function buscarPerfil(tipo, id) {
  if (tipo === 'ADMIN') {
    const adm = await knex('administrador as adm')
      .leftJoin('postosdesaude as pos', 'pos.pos_id', 'adm.pos_id')
      .where('adm.adm_id', id)
      .first(
        'adm.adm_id', 'adm.adm_matricula', 'adm.adm_nome', 'adm.adm_email', 'adm.adm_tel',
        'adm.adm_cpf', 'adm.tp_universal', 'adm.pos_id',
        'pos.pos_nome', 'pos.pos_endereco',
      );
    if (!adm) return null;
    return {
      tipo,
      id: adm.adm_id,
      nome: adm.adm_nome,
      email: adm.adm_email,
      telefone: adm.adm_tel,
      cpf: adm.adm_cpf,
      matricula: adm.adm_matricula,
      universal: Boolean(adm.tp_universal),
      posto: adm.pos_id ? { pos_id: adm.pos_id, pos_nome: adm.pos_nome, pos_endereco: adm.pos_endereco } : null,
    };
  }

  const aut = await knex('autorizador')
    .where('aut_id', id)
    .first('aut_id', 'aut_nome', 'aut_email', 'aut_tel', 'aut_cpf');
  if (!aut) return null;
  return {
    tipo,
    id: aut.aut_id,
    nome: aut.aut_nome,
    email: aut.aut_email,
    telefone: aut.aut_tel,
    cpf: aut.aut_cpf,
  };
}

export default {

  // PERFIL DO USUÁRIO LOGADO (admin ou autorizador)
  async meuPerfil(req, res) {
    try {
      const perfil = await buscarPerfil(req.session.tipo, req.session.id);
      if (!perfil) return res.status(404).json({ error: 'Usuário não encontrado' });
      return res.status(200).json(perfil);
    } catch (error) {
      console.error('Erro ao buscar perfil:', error);
      return res.status(500).json({ error: 'Erro ao buscar o perfil' });
    }
  },

  // EDIÇÃO DO PRÓPRIO PERFIL: nome, e-mail e telefone.
  // CPF, matrícula e posto não são alterados por aqui.
  async atualizarMeuPerfil(req, res) {
    try {
      const config = PERFIS[req.session.tipo];
      if (!config) return res.status(403).json({ error: 'Perfil sem permissão' });

      const { nome, email, telefone } = req.body ?? {};
      const erros = coletarErros(validarNome(nome), validarEmail(email), validarTelefone(telefone));
      if (erros.length) return res.status(400).json({ sucesso: false, erros });

      const emailFinal = normalizarEmail(email);
      const duplicado = await knex(config.tabela)
        .whereRaw(`LOWER(${config.colunas.email}) = ?`, [emailFinal])
        .whereNot(config.id, req.session.id)
        .first(config.id);
      if (duplicado) return res.status(409).json({ error: 'E-mail já cadastrado' });

      const alteradas = await knex(config.tabela)
        .where(config.id, req.session.id)
        .update({
          [config.colunas.nome]: normalizarNome(nome),
          [config.colunas.email]: emailFinal,
          [config.colunas.telefone]: formatarTelefone(telefone),
        });
      if (!alteradas) return res.status(404).json({ error: 'Usuário não encontrado' });

      return res.status(200).json({
        message: 'Perfil atualizado com sucesso',
        perfil: await buscarPerfil(req.session.tipo, req.session.id),
      });
    } catch (error) {
      console.error('Erro ao atualizar perfil:', error);
      return res.status(500).json({ error: 'Erro ao atualizar o perfil' });
    }
  },

  // PAINEL DO ADMIN ("fila de trabalho"): contadores da Home
  async painelAdmin(req, res) {
    try {
      const admin = req.session;
      const hoje = dataHojeBrasil();

      const [pendentes, autorizadasSemAgendamento, coletasHoje, estoqueBaixo] = await Promise.all([
        contar(knex('solicitacao').where('sol_status', 'Pendente').modify(doPosto(admin, 'pos_id'))),

        contar(
          knex('solicitacao as sol')
            .leftJoin(
              knex('solicitacao')
                .select('sol_origem_id')
                .whereNotNull('sol_origem_id')
                .whereIn('sol_status', ['agendado', 'concluido'])
                .groupBy('sol_origem_id')
                .as('ag'),
              'ag.sol_origem_id',
              'sol.sol_id',
            )
            .where('sol.sol_status', 'Autorizado')
            .whereNull('ag.sol_origem_id')
            .modify(doPosto(admin, 'sol.pos_id')),
        ),

        contar(
          knex('solicitacao')
            .where('sol_status', 'agendado')
            .where('sol_data_de_coleta', hoje)
            .modify(doPosto(admin, 'pos_id')),
        ),

        contar(knex('insumo').where('ins_quantidade', '<=', LIMITE_ESTOQUE_BAIXO).modify(doPosto(admin, 'pos_id'))),
      ]);

      return res.status(200).json({
        hoje,
        pendentes,
        autorizadasSemAgendamento,
        coletasHoje,
        estoqueBaixo,
        limiteEstoqueBaixo: LIMITE_ESTOQUE_BAIXO,
      });
    } catch (error) {
      console.error('Erro ao montar painel do admin:', error);
      return res.status(500).json({ error: 'Erro ao carregar o painel' });
    }
  },

  // DATAS SUGERIDAS para um novo agendamento no posto: próximos dias úteis
  // com a quantidade de coletas já marcadas (menos coletas = melhor dia).
  async datasSugeridas(req, res) {
    try {
      const pos_id = Number(req.query.pos_id);
      if (!Number.isInteger(pos_id) || pos_id <= 0) {
        return res.status(400).json({ message: 'Informe o posto de coleta' });
      }

      // dias úteis a partir de amanhã (segunda a sexta)
      const dias = [];
      const base = new Date(`${dataHojeBrasil()}T12:00:00Z`);
      for (let i = 1; dias.length < DIAS_SUGESTAO && i < DIAS_SUGESTAO * 2; i++) {
        const d = new Date(base.getTime() + i * 86400000);
        const semana = d.getUTCDay();
        if (semana !== 0 && semana !== 6) dias.push(d.toISOString().slice(0, 10));
      }

      const linhas = await knex('solicitacao')
        .where('pos_id', pos_id)
        .where('sol_status', 'agendado')
        .whereBetween('sol_data_de_coleta', [dias[0], dias[dias.length - 1]])
        .select('sol_data_de_coleta')
        .count({ total: '*' })
        .groupBy('sol_data_de_coleta');

      const porDia = new Map(
        linhas.map((l) => {
          const data = l.sol_data_de_coleta instanceof Date
            ? l.sol_data_de_coleta.toISOString().slice(0, 10)
            : String(l.sol_data_de_coleta).slice(0, 10);
          return [data, Number(l.total)];
        }),
      );

      const datas = dias.map((data) => ({ data, agendados: porDia.get(data) ?? 0 }));
      const menores = [...datas].sort((a, b) => a.agendados - b.agendados || a.data.localeCompare(b.data)).slice(0, 3);

      return res.status(200).json({
        datas,
        sugeridas: menores.map((d) => d.data).sort(),
      });
    } catch (error) {
      console.error('Erro ao sugerir datas:', error);
      return res.status(500).json({ message: 'Erro ao sugerir datas' });
    }
  },

  // ATIVIDADES DA UNIDADE: tudo o que foi registrado no histórico
  // (quem revisou, autorizou, agendou, entregou, transferiu...), do mais
  // recente para o mais antigo, com filtros. Admin de posto vê só o seu.
  async atividades(req, res) {
    try {
      const admin = req.session;
      const { data_inicio, data_fim, acao, usuario, busca } = req.query;
      const page = Math.max(1, Number(req.query.page) || 1);
      const porPagina = Math.min(Math.max(Number(req.query.porPagina) || 30, 1), 100);

      if ((data_inicio && validarDataISO(data_inicio)) || (data_fim && validarDataISO(data_fim))) {
        return res.status(400).json({ error: 'Intervalo de datas inválido' });
      }
      if (data_inicio && data_fim && data_inicio > data_fim) {
        return res.status(400).json({ error: 'A data inicial não pode ser maior que a data final' });
      }
      if (acao && !Object.values(ACOES).includes(acao)) {
        return res.status(400).json({ error: 'Tipo de atividade inválido' });
      }

      const base = knex('historico_solicitacao as h')
        .join('solicitacao as s', 's.sol_id', 'h.sol_id')
        .leftJoin('pacientes as p', 'p.pac_id', 's.pac_id')
        .leftJoin('postosdesaude as pos', 'pos.pos_id', 's.pos_id')
        .modify(doPosto(admin, 's.pos_id'))
        .modify((qb) => {
          // datas no fuso de Brasília (UTC-3)
          if (data_inicio) qb.where('h.his_criado_em', '>=', `${data_inicio}T00:00:00-03:00`);
          if (data_fim) qb.where('h.his_criado_em', '<=', `${data_fim}T23:59:59.999-03:00`);
          if (acao) qb.where('h.his_acao', acao);
          if (usuario?.trim()) qb.whereILike('h.his_usuario_nome', `%${usuario.trim()}%`);
          if (busca?.trim()) {
            const termo = busca.trim();
            qb.where((w) => w.whereILike('p.pac_nome', `%${termo}%`).orWhereILike('s.sol_protocolo', `%${termo}%`));
          }
        });

      const total = await contar(base.clone());
      const totalPaginas = Math.max(1, Math.ceil(total / porPagina));
      const pagina = Math.min(page, totalPaginas);

      const linhas = await base
        .select(
          'h.his_id', 'h.sol_id', 'h.his_acao', 'h.his_status_anterior', 'h.his_status_novo',
          'h.his_detalhe', 'h.his_usuario_tipo', 'h.his_usuario_nome', 'h.his_criado_em',
          's.sol_protocolo', 's.sol_status', 'p.pac_id', 'p.pac_nome', 'pos.pos_nome',
        )
        .orderBy([{ column: 'h.his_criado_em', order: 'desc' }, { column: 'h.his_id', order: 'desc' }])
        .limit(porPagina)
        .offset((pagina - 1) * porPagina);

      return res.status(200).json({
        total,
        paginaAtual: pagina,
        totalPaginas,
        itens: linhas.map((h) => ({
          his_id: h.his_id,
          sol_id: h.sol_id,
          acao: h.his_acao,
          de: h.his_status_anterior,
          para: h.his_status_novo,
          detalhe: h.his_detalhe,
          quando: h.his_criado_em,
          usuario_tipo: h.his_usuario_tipo,
          usuario_nome: h.his_usuario_nome,
          protocolo: h.sol_protocolo,
          status_atual: h.sol_status,
          pac_id: h.pac_id,
          pac_nome: h.pac_nome,
          pos_nome: h.pos_nome,
        })),
      });
    } catch (error) {
      console.error('Erro ao listar atividades:', error);
      return res.status(500).json({ error: 'Erro ao listar as atividades' });
    }
  },
};
