// Quantas versões anteriores cada prescrição tem (> 0 = o paciente já
// reenviou uma correção depois de um pedido de reenvio).
import knex from '../database/index.js';

// Para usar em .leftJoin(...versoesJoin('sol')) + .select(COLUNA_VERSOES)
export const versoesJoin = (alias) => [
  knex('prescricao_versao').select('sol_id').count({ n: '*' }).groupBy('sol_id').as('ver'),
  'ver.sol_id',
  `${alias}.sol_id`,
];

export const COLUNA_VERSOES = knex.raw('COALESCE(ver.n, 0) AS versoes_anteriores');

// Filtro "tem versão anterior"
export const comVersaoAnterior = (coluna) => (qb) =>
  qb.whereIn(coluna, knex('prescricao_versao').select('sol_id'));

export const numerarVersoes = (lista) =>
  lista.map((p) => ({ ...p, versoes_anteriores: Number(p.versoes_anteriores ?? 0) }));
