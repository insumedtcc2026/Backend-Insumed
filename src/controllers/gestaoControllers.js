// GESTÃO (admin): lista de separação do dia e previsão de demanda.
// As duas telas só leem o que as etapas anteriores já gravam (agendamentos,
// itens da prescrição, retirada recorrente e estoque): nenhuma tabela nova.

import knex from '../database/index.js';
import { itensDasPrescricoes } from '../utils/itensPrescricao.js';
import { isoData, somarDias } from '../utils/status.js';
import { dataHojeBrasil, idValido, validarDataISO } from '../utils/validacoes.js';

export const HORIZONTES_PREVISAO = [30, 60, 90];
// Janela usada para a média das retiradas avulsas (sem uso contínuo)
export const DIAS_HISTORICO_AVULSAS = 90;

const primeiroNome = (nome) => String(nome ?? '').trim().split(/\s+/)[0] || 'Paciente';

// Admin de unidade vê só a dele; o universal vê todas ou filtra por ?pos_id=
function postoDoFiltro(req) {
  const admin = req.session;
  if (!admin.tp_universal) return { pos_id: admin.posto_id ?? null };
  if (req.query.pos_id === undefined || req.query.pos_id === '') return { pos_id: undefined };
  if (!idValido(req.query.pos_id)) return { erro: 'Unidade inválida.' };
  return { pos_id: Number(req.query.pos_id) };
}

const ordemTurno = (t) => (t === 'tarde' ? 1 : 0);
// na lista, quem já retirou vai para o fim do turno
const ordemSituacao = { separar: 0, nao_vai: 0, entregue: 1 };

export default {

  // GET /agendamentos/separacao?data=AAAA-MM-DD[&pos_id=]
  // Coletas do dia, por unidade, em duas visões: o total de cada insumo a
  // separar e a lista por paciente. Quem avisou que não vai continua na
  // lista (riscado na tela), mas fica fora do total.
  async separacao(req, res) {
    try {
      const data = req.query.data || dataHojeBrasil();
      if (validarDataISO(data)) return res.status(400).json({ message: 'Data inválida.' });
      const { pos_id, erro } = postoDoFiltro(req);
      if (erro) return res.status(400).json({ message: erro });

      const coletas = await knex('solicitacao as sol')
        .leftJoin('pacientes as pac', 'pac.pac_id', 'sol.pac_id')
        .leftJoin('postosdesaude as pos', 'pos.pos_id', 'sol.pos_id')
        .whereIn('sol.sol_status', ['agendado', 'concluido'])
        .where('sol.sol_data_de_coleta', data)
        .modify((qb) => { if (pos_id !== undefined) qb.where('sol.pos_id', pos_id); })
        .select('sol.sol_id', 'sol.sol_protocolo', 'sol.sol_status', 'sol.sol_turno', 'sol.sol_presenca',
          'sol.sol_retirado_por_nome', 'sol.pos_id', 'pos.pos_nome', 'pac.pac_nome');

      const linhas = coletas.length
        ? await knex('coleta as col')
          .leftJoin('insumo as ins', 'ins.ins_id', 'col.ins_id')
          .whereIn('col.sol_id', coletas.map((c) => c.sol_id))
          .orderBy('col.col_id')
          .select('col.sol_id', 'col.ins_id', 'col.quantidade', 'ins.ins_nome', 'ins.ins_marca')
        : [];
      const itensDe = new Map();
      for (const l of linhas) {
        const lista = itensDe.get(l.sol_id) ?? [];
        lista.push({ ins_id: l.ins_id, ins_nome: l.ins_nome ?? 'Insumo', ins_marca: l.ins_marca ?? null, quantidade: Number(l.quantidade ?? 0) });
        itensDe.set(l.sol_id, lista);
      }

      const unidades = new Map();
      for (const c of coletas) {
        if (!unidades.has(c.pos_id)) {
          unidades.set(c.pos_id, { pos_id: c.pos_id, pos_nome: c.pos_nome ?? 'Unidade', insumos: new Map(), pacientes: [] });
        }
        const u = unidades.get(c.pos_id);
        const itens = itensDe.get(c.sol_id) ?? [];
        const naoVai = c.sol_status === 'agendado' && c.sol_presenca === 'nao_vou';
        u.pacientes.push({
          sol_id: c.sol_id,
          protocolo: c.sol_protocolo,
          turno: c.sol_turno ?? 'manha',
          primeiro_nome: primeiroNome(c.pac_nome),
          presenca: c.sol_presenca ?? null,
          situacao: c.sol_status === 'concluido' ? 'entregue' : naoVai ? 'nao_vai' : 'separar',
          retirado_por_nome: c.sol_retirado_por_nome ?? null,
          itens,
        });
        for (const i of itens) {
          const t = u.insumos.get(i.ins_id) ?? { ins_id: i.ins_id, ins_nome: i.ins_nome, ins_marca: i.ins_marca, separar: 0, entregue: 0, nao_vai: 0 };
          if (c.sol_status === 'concluido') t.entregue += i.quantidade;
          else if (naoVai) t.nao_vai += i.quantidade;
          else t.separar += i.quantidade;
          u.insumos.set(i.ins_id, t);
        }
      }

      const saida = [...unidades.values()]
        .sort((a, b) => a.pos_nome.localeCompare(b.pos_nome, 'pt-BR'))
        .map((u) => ({
          pos_id: u.pos_id,
          pos_nome: u.pos_nome,
          por_insumo: [...u.insumos.values()].sort((a, b) => a.ins_nome.localeCompare(b.ins_nome, 'pt-BR')),
          por_paciente: u.pacientes.sort((a, b) =>
            ordemTurno(a.turno) - ordemTurno(b.turno) || ordemSituacao[a.situacao] - ordemSituacao[b.situacao] || a.primeiro_nome.localeCompare(b.primeiro_nome, 'pt-BR') || a.sol_id - b.sol_id),
        }));

      return res.status(200).json({ data, unidades: saida });
    } catch (error) {
      console.error('Erro ao montar a lista de separação:', error);
      return res.status(500).json({ message: 'Erro ao montar a lista de separação' });
    }
  },

  // GET /indicadores/previsao?dias=30|60|90[&pos_id=]
  // Necessidade de cada insumo nos próximos dias, somando:
  //  - coletas já agendadas (as atrasadas contam para hoje);
  //  - ciclos futuros das prescrições de uso contínuo, até o vencimento;
  //  - prescrições autorizadas que ainda esperam a 1ª retirada;
  //  - média diária das retiradas avulsas dos últimos 90 dias x dias.
  // Compara com o estoque e estima a data em que o insumo acaba.
  async previsao(req, res) {
    try {
      const dias = Number(req.query.dias ?? 30);
      if (!HORIZONTES_PREVISAO.includes(dias)) {
        return res.status(400).json({ message: `Escolha ${HORIZONTES_PREVISAO.join(', ')} dias.` });
      }
      const { pos_id, erro } = postoDoFiltro(req);
      if (erro) return res.status(400).json({ message: erro });

      const hoje = dataHojeBrasil();
      const fim = somarDias(hoje, dias - 1);
      const doPosto = (coluna) => (qb) => { if (pos_id !== undefined) qb.where(coluna, pos_id); };

      const insumos = await knex('insumo as ins')
        .leftJoin('postosdesaude as pos', 'pos.pos_id', 'ins.pos_id')
        .modify(doPosto('ins.pos_id'))
        .select('ins.ins_id', 'ins.ins_nome', 'ins.ins_marca', 'ins.ins_quantidade', 'ins.pos_id', 'pos.pos_nome');

      // consumo previsto por insumo: Map ins_id -> Map data -> quantidade
      const eventos = new Map();
      const partes = new Map(); // ins_id -> { agendado, recorrente, a_agendar, avulso }
      const parte = (ins_id) => {
        const id = Number(ins_id);
        if (!partes.has(id)) partes.set(id, { agendado: 0, recorrente: 0, a_agendar: 0, avulso: 0 });
        return partes.get(id);
      };
      const somar = (ins_id, data, qtd, tipo) => {
        const id = Number(ins_id);
        const porData = eventos.get(id) ?? new Map();
        porData.set(data, (porData.get(data) ?? 0) + qtd);
        eventos.set(id, porData);
        parte(id)[tipo] += qtd;
      };

      // 1) coletas agendadas até o fim do período
      const agendadas = await knex('coleta as col')
        .join('solicitacao as sol', 'sol.sol_id', 'col.sol_id')
        .where('sol.sol_status', 'agendado')
        .where('sol.sol_data_de_coleta', '<=', fim)
        .modify(doPosto('sol.pos_id'))
        .select('col.ins_id', 'col.quantidade', 'sol.sol_data_de_coleta');
      for (const a of agendadas) {
        const data = isoData(a.sol_data_de_coleta);
        somar(a.ins_id, data < hoje ? hoje : data, Number(a.quantidade ?? 0), 'agendado');
      }

      // 2) e 3) prescrições autorizadas e válidas: ciclos futuros e 1ª retirada
      const prescricoes = await knex('solicitacao')
        .where('sol_status', 'Autorizado')
        .where((w) => w.whereNull('sol_data_vencimento').orWhere('sol_data_vencimento', '>=', hoje))
        .modify(doPosto('pos_id'))
        .select('sol_id', 'sol_periodicidade_dias', 'sol_data_vencimento');
      if (prescricoes.length) {
        const ids = prescricoes.map((p) => p.sol_id);
        const itens = await itensDasPrescricoes(ids);
        const ciclos = await knex('solicitacao')
          .whereIn('sol_origem_id', ids)
          .whereIn('sol_status', ['agendado', 'concluido'])
          .select('sol_origem_id', 'sol_status', 'sol_data_de_coleta');
        for (const p of prescricoes) {
          const dela = ciclos.filter((c) => Number(c.sol_origem_id) === Number(p.sol_id));
          const lista = itens.get(Number(p.sol_id)) ?? [];
          const periodo = Number(p.sol_periodicidade_dias) || null;
          const vencimento = isoData(p.sol_data_vencimento);
          const limite = vencimento && vencimento < fim ? vencimento : fim;

          if (!dela.length) {
            // autorizada, ainda sem agendamento: a 1ª retirada vem logo
            for (const i of lista) somar(i.ins_id, hoje, i.quantidade, 'a_agendar');
            if (!periodo) continue;
          } else if (!periodo) {
            continue; // retirada única já agendada (conta no item 1) ou feita
          }

          // próximo ciclo: depois do agendado em aberto ou da última retirada
          const datas = dela.map((c) => isoData(c.sol_data_de_coleta)).filter(Boolean).sort();
          let proxima = datas.length ? somarDias(datas.at(-1), periodo) : somarDias(hoje, periodo);
          if (proxima < hoje) proxima = hoje;
          while (proxima <= limite) {
            for (const i of lista) somar(i.ins_id, proxima, i.quantidade, 'recorrente');
            proxima = somarDias(proxima, periodo);
          }
        }
      }

      // 4) retiradas avulsas (sem uso contínuo) concluídas nos últimos 90 dias
      const inicioHistorico = somarDias(hoje, -DIAS_HISTORICO_AVULSAS);
      const avulsas = await knex('coleta as col')
        .join('solicitacao as sol', 'sol.sol_id', 'col.sol_id')
        .leftJoin('solicitacao as ori', 'ori.sol_id', 'sol.sol_origem_id')
        .where('sol.sol_status', 'concluido')
        .where('sol.sol_data_de_coleta', '>=', inicioHistorico)
        .where('sol.sol_data_de_coleta', '<', hoje)
        .where((w) => w.whereNull('ori.sol_periodicidade_dias').orWhere('ori.sol_periodicidade_dias', '<=', 0))
        .modify(doPosto('sol.pos_id'))
        .groupBy('col.ins_id')
        .select('col.ins_id')
        .sum({ total: 'col.quantidade' });
      const mediaDiaria = new Map(avulsas.map((a) => [Number(a.ins_id), Number(a.total ?? 0) / DIAS_HISTORICO_AVULSAS]));

      const saida = insumos.map((ins) => {
        const id = Number(ins.ins_id);
        const estoque = Math.max(0, Number(ins.ins_quantidade ?? 0));
        const media = mediaDiaria.get(id) ?? 0;
        const p = { ...parte(id), avulso: Math.round(media * dias) };
        const necessidade = p.agendado + p.recorrente + p.a_agendar + p.avulso;

        // dia a dia, quando o consumo acumulado passa do estoque
        let acaba_em = null;
        const porData = eventos.get(id) ?? new Map();
        let acumulado = 0;
        for (let d = 0; d < dias; d++) {
          const data = somarDias(hoje, d);
          acumulado += (porData.get(data) ?? 0) + media;
          if (acumulado > estoque + 1e-9) { acaba_em = data; break; }
        }

        return {
          ins_id: id,
          ins_nome: ins.ins_nome,
          ins_marca: ins.ins_marca ?? null,
          pos_id: ins.pos_id,
          pos_nome: ins.pos_nome ?? null,
          estoque,
          ...p,
          necessidade,
          saldo: estoque - necessidade,
          falta: Math.max(0, necessidade - estoque),
          acaba_em,
        };
      });

      saida.sort((a, b) =>
        b.falta - a.falta
        || (a.acaba_em ?? '9999').localeCompare(b.acaba_em ?? '9999')
        || a.saldo - b.saldo
        || String(a.ins_nome).localeCompare(String(b.ins_nome), 'pt-BR'));

      return res.status(200).json({
        dias, de: hoje, ate: fim, historico_dias: DIAS_HISTORICO_AVULSAS, insumos: saida,
      });
    } catch (error) {
      console.error('Erro ao calcular a previsão de demanda:', error);
      return res.status(500).json({ message: 'Erro ao calcular a previsão de demanda' });
    }
  },
};
