// Itens da prescrição: uma receita pode listar vários insumos (bolsa e
// placa, fita e lanceta). Ficam na tabela solicitacao_item. As colunas
// antigas (solicitacao.ins_id e sol_insumo_quant) continuam guardando o
// primeiro item, para telas e relatórios antigos não quebrarem.
//
// Retirada recorrente: sol_periodicidade_dias na prescrição (vazio = uma
// retirada só). Cada agendamento guarda o ciclo (sol_ciclo).

import knex from '../database/index.js';
import { idValido } from './validacoes.js';
import { isoData, somarDias } from './status.js';

export const MAX_ITENS_PRESCRICAO = 10;
export const PERIODICIDADE_MIN = 7;
export const PERIODICIDADE_MAX = 180;

/**
 * Lê os itens enviados na revisão: { itens: [{ ins_id, quantidade }] } ou,
 * em clientes antigos, { ins_id, sol_insumo_quant }. Itens repetidos viram
 * um só, com a soma. Devolve { itens } ou { erro }.
 */
export function lerItens(body) {
  const brutos = Array.isArray(body?.itens)
    ? body.itens
    : body?.ins_id !== undefined && body?.ins_id !== null && body?.ins_id !== ''
      ? [{ ins_id: body.ins_id, quantidade: body.sol_insumo_quant }]
      : [];

  if (!brutos.length) return { erro: 'Informe pelo menos um insumo da prescrição.' };
  if (brutos.length > MAX_ITENS_PRESCRICAO) {
    return { erro: `Uma prescrição pode ter no máximo ${MAX_ITENS_PRESCRICAO} insumos.` };
  }

  const porInsumo = new Map();
  for (const item of brutos) {
    if (!idValido(item?.ins_id)) return { erro: 'Insumo inválido.' };
    const quantidade = Number(item?.quantidade);
    if (!Number.isInteger(quantidade) || quantidade <= 0) {
      return { erro: 'Informe a quantidade de cada insumo (número inteiro maior que zero).' };
    }
    const id = Number(item.ins_id);
    porInsumo.set(id, (porInsumo.get(id) ?? 0) + quantidade);
  }
  return { itens: [...porInsumo].map(([ins_id, quantidade]) => ({ ins_id, quantidade })) };
}

/**
 * Periodicidade da retirada recorrente: vazio/0/false = retirada única.
 * Devolve { dias } (null = única) ou { erro }.
 */
export function lerPeriodicidade(valor) {
  if (valor === undefined || valor === null || valor === '' || valor === false || Number(valor) === 0) {
    return { dias: null };
  }
  const dias = Number(valor);
  if (!Number.isInteger(dias) || dias < PERIODICIDADE_MIN || dias > PERIODICIDADE_MAX) {
    return { erro: `A frequência da retirada deve ser entre ${PERIODICIDADE_MIN} e ${PERIODICIDADE_MAX} dias.` };
  }
  return { dias };
}

// Troca os itens de uma prescrição (dentro da transação de quem chama)
export async function salvarItens(trx, sol_id, itens) {
  await trx('solicitacao_item').where('sol_id', sol_id).del();
  await trx('solicitacao_item').insert(
    itens.map((i) => ({ sol_id, ins_id: i.ins_id, sit_quantidade: i.quantidade })),
  );
}

const resumo = (itens) => itens.map((i) => `${i.quantidade}x ${i.ins_nome}`).join(', ');

/**
 * Itens de várias prescrições (Map sol_id -> [{ ins_id, ins_nome, ins_marca, quantidade }]).
 * Prescrição sem linhas em solicitacao_item (anterior à migração) usa as
 * colunas antigas.
 */
export async function itensDasPrescricoes(solIds, { db = knex } = {}) {
  const ids = [...new Set(solIds.map(Number).filter(Boolean))];
  const mapa = new Map();
  if (!ids.length) return mapa;

  const linhas = await db('solicitacao_item as it')
    .join('insumo as ins', 'ins.ins_id', 'it.ins_id')
    .whereIn('it.sol_id', ids)
    .orderBy('it.sol_id')
    .orderBy('it.sit_id')
    .select('it.sol_id', 'it.ins_id', 'ins.ins_nome', 'ins.ins_marca', 'it.sit_quantidade as quantidade');
  for (const l of linhas) {
    const lista = mapa.get(Number(l.sol_id)) ?? [];
    lista.push({ ins_id: l.ins_id, ins_nome: l.ins_nome, ins_marca: l.ins_marca ?? null, quantidade: Number(l.quantidade) });
    mapa.set(Number(l.sol_id), lista);
  }

  const semItens = ids.filter((id) => !mapa.has(id));
  if (semItens.length) {
    const antigas = await db('solicitacao as sol')
      .join('insumo as ins', 'ins.ins_id', 'sol.ins_id')
      .whereIn('sol.sol_id', semItens)
      .where('sol.sol_insumo_quant', '>', 0)
      .select('sol.sol_id', 'sol.ins_id', 'ins.ins_nome', 'ins.ins_marca', 'sol.sol_insumo_quant as quantidade');
    for (const l of antigas) {
      mapa.set(Number(l.sol_id), [
        { ins_id: l.ins_id, ins_nome: l.ins_nome, ins_marca: l.ins_marca ?? null, quantidade: Number(l.quantidade) },
      ]);
    }
  }
  return mapa;
}

/**
 * Acrescenta `itens` e `insumos_resumo` ("2x Bolsa, 1x Placa") a linhas de
 * prescrição. Aceita uma linha ou uma lista.
 */
export async function comItens(linhas, opcoes) {
  if (!linhas) return linhas;
  const lista = Array.isArray(linhas) ? linhas : [linhas];
  const mapa = await itensDasPrescricoes(lista.map((l) => l.sol_id), opcoes);
  const saida = lista.map((l) => {
    const itens = mapa.get(Number(l.sol_id)) ?? [];
    return { ...l, itens, insumos_resumo: itens.length ? resumo(itens) : null };
  });
  return Array.isArray(linhas) ? saida : saida[0];
}

// Quantas retiradas cabem entre a primeira data e o vencimento
export function retiradasAteVencer(primeira, vencimento, dias) {
  if (!dias || !primeira || !vencimento) return 1;
  const ms = new Date(`${vencimento}T00:00:00Z`) - new Date(`${primeira}T00:00:00Z`);
  if (ms < 0) return 0;
  return Math.floor(ms / (dias * 86400000)) + 1;
}

/**
 * Situação da retirada recorrente de uma prescrição, a partir dos
 * agendamentos dela: quantas retiradas foram feitas e a data prevista da
 * próxima (null se não é de uso contínuo, se já há um ciclo agendado ou
 * se a próxima cairia depois do vencimento).
 */
export function resumoRecorrencia(prescricao, agendamentos) {
  const concluidos = agendamentos.filter((a) => a.sol_status === 'concluido');
  const dias = Number(prescricao.sol_periodicidade_dias) || null;
  const base = { retiradas_concluidas: concluidos.length, proxima_retirada: null };
  if (!dias || !concluidos.length || agendamentos.some((a) => a.sol_status === 'agendado')) return base;

  const ultima = concluidos.map((a) => isoData(a.sol_data_de_coleta)).filter(Boolean).sort().at(-1);
  if (!ultima) return base;
  const proxima = somarDias(ultima, dias);
  const vencimento = isoData(prescricao.sol_data_vencimento);
  return { ...base, proxima_retirada: vencimento && proxima > vencimento ? null : proxima };
}
