// GESTÃO (admin): lista de separação do dia.
// A tela só lê o que as etapas anteriores já gravam (agendamentos,
// itens da prescrição, retirada recorrente e estoque): nenhuma tabela nova.

import knex from '../database/index.js';
import { dataHojeBrasil, idValido, validarDataISO } from '../utils/validacoes.js';


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
};
