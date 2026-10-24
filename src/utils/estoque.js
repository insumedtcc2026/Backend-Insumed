// Estoque reservado: o que já está prometido em coletas agendadas.
// A baixa de verdade só acontece quando a coleta é concluída; até lá a
// quantidade continua no estoque, mas não está livre para outro paciente.
//   disponível = em estoque - reservado

import knex from '../database/index.js';

/**
 * Quantidade reservada por insumo (Map ins_id -> total).
 * @param ignorarSolId agendamento que não deve contar (ex.: o próprio, ao remarcar)
 */
export async function reservados(insIds, { db = knex, ignorarSolId = null } = {}) {
  const ids = [...new Set(insIds.map(Number).filter(Boolean))];
  if (!ids.length) return new Map();

  const q = db('coleta as c')
    .join('solicitacao as s', 's.sol_id', 'c.sol_id')
    .whereIn('c.ins_id', ids)
    .where('s.sol_status', 'agendado')
    .groupBy('c.ins_id')
    .select('c.ins_id')
    .sum({ total: 'c.quantidade' });
  if (ignorarSolId) q.whereNot('s.sol_id', ignorarSolId);

  const linhas = await q;
  return new Map(linhas.map((l) => [Number(l.ins_id), Number(l.total ?? 0)]));
}

// Acrescenta ins_reservado e ins_disponivel a uma lista de insumos
export async function comReserva(insumos, opcoes) {
  const mapa = await reservados(insumos.map((i) => i.ins_id), opcoes);
  return insumos.map((i) => {
    const reservado = mapa.get(Number(i.ins_id)) ?? 0;
    return {
      ...i,
      ins_reservado: reservado,
      ins_disponivel: Math.max(0, Number(i.ins_quantidade ?? 0) - reservado),
    };
  });
}
