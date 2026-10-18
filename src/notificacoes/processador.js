// Processador das notificações.
//
// O histórico (historico_solicitacao) é gravado na MESMA transação de cada
// operação; por isso ele funciona como "outbox": se a operação foi
// confirmada, o evento existe. Depois do commit, cada linha nova do
// histórico vira notificação uma única vez (tabela notificacao_evento).
// Uma falha aqui nunca desfaz a operação principal: o evento fica marcado
// como "erro" e a tarefa diária tenta de novo.

import { randomUUID } from 'node:crypto';
import knex from '../database/index.js';
import { notificacoesDoEvento } from './regras.js';

const MAX_TENTATIVAS = 5;
// evento "processando" há mais que isso = a execução anterior morreu no meio
const TRAVADO_MS = 10 * 60 * 1000;

// Reserva o evento para esta execução. Duas execuções ao mesmo tempo
// (duas requisições, ou requisição + tarefa diária) não processam o mesmo.
async function reservarNovo(his_id, token) {
  await knex('notificacao_evento')
    .insert({ his_id, nev_token: token })
    .onConflict('his_id')
    .ignore();
  const linha = await knex('notificacao_evento').where('his_id', his_id).first('nev_token');
  return linha?.nev_token === token;
}

async function reservarRepeticao(evento, token) {
  const n = await knex('notificacao_evento')
    .where({ his_id: evento.his_id, nev_token: evento.nev_token })
    .update({
      nev_token: token,
      nev_status: 'processando',
      nev_tentativas: Number(evento.nev_tentativas ?? 0) + 1,
      nev_atualizado: knex.fn.now(),
    });
  return Number(n) > 0;
}

async function processarUm(his, token) {
  try {
    await knex.transaction(async (trx) => {
      await notificacoesDoEvento(trx, his);
      await trx('notificacao_evento')
        .where({ his_id: his.his_id, nev_token: token })
        .update({ nev_status: 'ok', nev_erro: null, nev_atualizado: trx.fn.now() });
    });
    return true;
  } catch (error) {
    console.error(`Erro ao gerar notificações do evento ${his.his_id}:`, error);
    await knex('notificacao_evento')
      .where({ his_id: his.his_id, nev_token: token })
      .update({ nev_status: 'erro', nev_erro: String(error?.message ?? error).slice(0, 500), nev_atualizado: knex.fn.now() })
      .catch(() => {});
    return false;
  }
}

/**
 * Processa os eventos do histórico que ainda não viraram notificação.
 * @param limite        quantos eventos novos, no máximo
 * @param repetirFalhas também tenta de novo os que falharam ou travaram
 */
export async function processarEventos({ limite = 30, repetirFalhas = false } = {}) {
  const token = randomUUID();
  const resultado = { processados: 0, falhas: 0 };

  const novos = await knex('historico_solicitacao as h')
    .leftJoin('notificacao_evento as e', 'e.his_id', 'h.his_id')
    .whereNull('e.his_id')
    .orderBy('h.his_id', 'asc')
    .limit(limite)
    .select('h.*');

  for (const his of novos) {
    if (!(await reservarNovo(his.his_id, token))) continue;
    (await processarUm(his, token)) ? resultado.processados++ : resultado.falhas++;
  }

  if (repetirFalhas) {
    const travadoAntes = new Date(Date.now() - TRAVADO_MS).toISOString();
    const repetir = await knex('notificacao_evento as e')
      .join('historico_solicitacao as h', 'h.his_id', 'e.his_id')
      .where('e.nev_tentativas', '<', MAX_TENTATIVAS)
      .where((w) => w
        .where('e.nev_status', 'erro')
        .orWhere((p) => p.where('e.nev_status', 'processando').where('e.nev_atualizado', '<', travadoAntes)))
      .orderBy('e.his_id', 'asc')
      .limit(limite)
      .select('h.*', 'e.nev_token', 'e.nev_tentativas');

    for (const evento of repetir) {
      if (!(await reservarRepeticao(evento, token))) continue;
      const { nev_token, nev_tentativas, ...his } = evento; // eslint-disable-line no-unused-vars
      (await processarUm(his, token)) ? resultado.processados++ : resultado.falhas++;
    }
  }

  return resultado;
}

// Chamado pelos controllers DEPOIS do commit e ANTES da resposta (na
// Vercel o trabalho depois da resposta pode ser interrompido). Nunca lança
// erro: a operação principal já foi concluída.
export async function notificar() {
  try {
    await processarEventos({ limite: 30 });
  } catch (error) {
    console.error('Erro ao processar notificações:', error);
  }
}
