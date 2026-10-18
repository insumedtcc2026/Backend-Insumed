import knex from '../database/index.js';
import { dataHojeBrasil } from '../utils/validacoes.js';
import { paginar } from '../utils/paginacao.js';
import { destinatarioDaSessao } from '../notificacoes/destinatarios.js';
import { processarEventos } from '../notificacoes/processador.js';
import { gerarLembretes, tarefaDiaria } from '../notificacoes/tarefas.js';

// Toda consulta é filtrada pelo destinatário tirado do TOKEN; nenhuma rota
// aceita "de quem" pelo corpo ou pela URL. Assim ninguém lê nem marca a
// notificação de outra pessoa.
const doDestinatario = (dest) => (qb) =>
  qb.where('n.not_dest_tipo', dest.tipo).where('n.not_dest_id', dest.id);

const COLUNAS = [
  'n.not_id', 'n.not_evento', 'n.not_tom', 'n.not_titulo', 'n.not_mensagem', 'n.not_prioridade',
  'n.not_link', 'n.sol_id', 'n.not_criada_em', 'n.not_atualizada_em', 'n.not_lida_em',
];

const formatar = (n) => ({
  id: n.not_id,
  evento: n.not_evento,
  tom: n.not_tom,
  titulo: n.not_titulo,
  mensagem: n.not_mensagem,
  prioridade: n.not_prioridade,
  link: n.not_link,
  sol_id: n.sol_id,
  criada_em: n.not_criada_em,
  atualizada_em: n.not_atualizada_em,
  lida: Boolean(n.not_lida_em),
  lida_em: n.not_lida_em,
});

const contarNaoLidas = async (dest) => Number(
  (await knex('notificacao as n').modify(doDestinatario(dest)).whereNull('n.not_lida_em').count({ total: '*' }).first())?.total ?? 0,
);

// O resumo é consultado de tempos em tempos pelo sino. Aproveita a chamada
// para processar eventos que ficaram para trás (rede de segurança) — no
// máximo a cada 20 s por instância do servidor.
let ultimaRepescagem = 0;
async function repescagem(dest) {
  try {
    if (Date.now() - ultimaRepescagem > 20000) {
      ultimaRepescagem = Date.now();
      await processarEventos({ limite: 30 });
    }
    // lembretes do próprio paciente, caso a tarefa diária ainda não tenha rodado
    if (dest.tipo === 'PACIENTE') await gerarLembretes(dataHojeBrasil(), { pac_id: dest.id });
  } catch (error) {
    console.error('Erro na repescagem de notificações:', error);
  }
}

async function destinatario(req, res) {
  const dest = await destinatarioDaSessao(req.session);
  if (!dest) res.status(403).json({ error: 'Usuário não identificado para notificações' });
  return dest;
}

export default {
  // GET /notificacoes?page=&porPagina=&situacao=nao_lidas
  async listar(req, res) {
    try {
      const dest = await destinatario(req, res);
      if (!dest) return;
      const { situacao } = req.query;
      if (situacao && !['todas', 'nao_lidas'].includes(situacao)) {
        return res.status(400).json({ error: 'Situação inválida' });
      }

      const consulta = knex('notificacao as n')
        .modify(doDestinatario(dest))
        .modify((qb) => { if (situacao === 'nao_lidas') qb.whereNull('n.not_lida_em'); });

      const pagina = await paginar(
        consulta,
        (qb) => qb.select(COLUNAS).orderBy([{ column: 'n.not_atualizada_em', order: 'desc' }, { column: 'n.not_id', order: 'desc' }]),
        req.query,
        { padrao: 15, maximo: 50 },
      );

      return res.status(200).json({ ...pagina, itens: pagina.itens.map(formatar), naoLidas: await contarNaoLidas(dest) });
    } catch (error) {
      console.error('Erro ao listar notificações:', error);
      return res.status(500).json({ error: 'Erro ao carregar as notificações' });
    }
  },

  // GET /notificacoes/resumo — contador e as mais recentes (usado pelo sino)
  async resumo(req, res) {
    try {
      const dest = await destinatario(req, res);
      if (!dest) return;
      await repescagem(dest);

      const ultimas = await knex('notificacao as n')
        .modify(doDestinatario(dest))
        .select(COLUNAS)
        .orderBy([{ column: 'n.not_atualizada_em', order: 'desc' }, { column: 'n.not_id', order: 'desc' }])
        .limit(6);

      return res.status(200).json({ naoLidas: await contarNaoLidas(dest), ultimas: ultimas.map(formatar) });
    } catch (error) {
      console.error('Erro ao montar resumo de notificações:', error);
      return res.status(500).json({ error: 'Erro ao carregar as notificações' });
    }
  },

  // PATCH /notificacoes/:id/lida — ler não muda nada na prescrição/agendamento
  async marcarLida(req, res) {
    try {
      const dest = await destinatario(req, res);
      if (!dest) return;
      const { id } = req.params;

      const existe = await knex('notificacao as n').modify(doDestinatario(dest)).where('n.not_id', id).first('n.not_id', 'n.not_lida_em');
      if (!existe) return res.status(404).json({ error: 'Notificação não encontrada' });

      if (!existe.not_lida_em) {
        await knex('notificacao')
          .where({ not_id: id, not_dest_tipo: dest.tipo, not_dest_id: dest.id })
          .whereNull('not_lida_em')
          .update({ not_lida_em: knex.fn.now() });
      }
      return res.status(200).json({ message: 'Notificação marcada como lida', naoLidas: await contarNaoLidas(dest) });
    } catch (error) {
      console.error('Erro ao marcar notificação:', error);
      return res.status(500).json({ error: 'Erro ao marcar a notificação como lida' });
    }
  },

  // PATCH /notificacoes/lidas  { ate?: not_id } — marca todas (até a mais
  // recente que a pessoa viu, para não marcar uma que acabou de chegar)
  async marcarTodas(req, res) {
    try {
      const dest = await destinatario(req, res);
      if (!dest) return;
      const ate = req.body?.ate;
      if (ate !== undefined && !(Number.isInteger(Number(ate)) && Number(ate) > 0)) {
        return res.status(400).json({ error: 'Parâmetro "ate" inválido' });
      }

      const marcadas = await knex('notificacao')
        .where({ not_dest_tipo: dest.tipo, not_dest_id: dest.id })
        .whereNull('not_lida_em')
        .modify((qb) => { if (ate !== undefined) qb.where('not_id', '<=', Number(ate)); })
        .update({ not_lida_em: knex.fn.now() });

      return res.status(200).json({ message: 'Notificações marcadas como lidas', marcadas: Number(marcadas), naoLidas: await contarNaoLidas(dest) });
    } catch (error) {
      console.error('Erro ao marcar notificações:', error);
      return res.status(500).json({ error: 'Erro ao marcar as notificações como lidas' });
    }
  },

  // GET /tarefas/diaria — chamada pela Vercel Cron (protegida por CRON_SECRET)
  async tarefaDiaria(req, res) {
    try {
      const resultado = await tarefaDiaria();
      console.log('Tarefa diária de notificações:', JSON.stringify(resultado));
      return res.status(200).json(resultado);
    } catch (error) {
      console.error('Erro na tarefa diária:', error);
      return res.status(500).json({ error: 'Erro na tarefa diária' });
    }
  },
};
