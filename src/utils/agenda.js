// Agenda da unidade: horário por dia da semana e turno, vagas por turno e
// dias fechados. Unidade sem horário cadastrado usa o PADRAO (segunda a
// sexta, manhã e tarde, sem limite de vagas), então nada muda para quem
// ainda não configurou.
//
// Agendamentos antigos, sem turno, contam como "manhã".

import knex from '../database/index.js';
import { isoData, somarDias } from './status.js';

export const TURNOS = ['manha', 'tarde'];
export const ROTULO_TURNO = { manha: 'manhã', tarde: 'tarde' };

const HORA_PADRAO = { manha: ['08:00', '12:00'], tarde: ['13:00', '17:00'] };
export const PADRAO = [1, 2, 3, 4, 5].flatMap((dia) =>
  TURNOS.map((turno) => ({ dia_semana: dia, turno, abre: HORA_PADRAO[turno][0], fecha: HORA_PADRAO[turno][1], vagas: null })),
);

const REGEX_HORA = /^([01]\d|2[0-3]):[0-5]\d$/;

export const diaDaSemana = (iso) => new Date(`${iso}T12:00:00Z`).getUTCDay();

/**
 * Horário cadastrado da unidade (ou o padrão). { horarios, padrao }
 */
export async function horariosDoPosto(pos_id, { db = knex } = {}) {
  const linhas = await db('posto_horario')
    .where('pos_id', pos_id)
    .orderBy('phr_dia_semana')
    .orderBy('phr_turno')
    .select('phr_dia_semana', 'phr_turno', 'phr_abre', 'phr_fecha', 'phr_vagas');
  if (!linhas.length) return { horarios: PADRAO, padrao: true };
  return {
    horarios: linhas.map((l) => ({
      dia_semana: Number(l.phr_dia_semana),
      turno: l.phr_turno,
      abre: l.phr_abre,
      fecha: l.phr_fecha,
      vagas: l.phr_vagas == null ? null : Number(l.phr_vagas),
    })),
    padrao: false,
  };
}

/**
 * Confere a lista enviada pela página "Horários da unidade".
 * Devolve { horarios } ou { erro }.
 */
export function lerHorarios(lista) {
  if (!Array.isArray(lista)) return { erro: 'Envie a lista de horários.' };
  const vistos = new Set();
  const horarios = [];
  for (const h of lista) {
    const dia = Number(h?.dia_semana);
    if (!Number.isInteger(dia) || dia < 0 || dia > 6) return { erro: 'Dia da semana inválido.' };
    if (!TURNOS.includes(h?.turno)) return { erro: 'Turno inválido (manhã ou tarde).' };
    if (!REGEX_HORA.test(h?.abre ?? '') || !REGEX_HORA.test(h?.fecha ?? '')) {
      return { erro: 'Informe os horários no formato HH:MM.' };
    }
    if (h.abre >= h.fecha) return { erro: 'O horário de fechar deve ser depois do de abrir.' };
    let vagas = null;
    if (h.vagas !== undefined && h.vagas !== null && h.vagas !== '') {
      vagas = Number(h.vagas);
      if (!Number.isInteger(vagas) || vagas < 1 || vagas > 500) return { erro: 'Vagas por turno: de 1 a 500 (vazio = sem limite).' };
    }
    const chave = `${dia}:${h.turno}`;
    if (vistos.has(chave)) return { erro: 'O mesmo turno aparece duas vezes no mesmo dia.' };
    vistos.add(chave);
    horarios.push({ dia_semana: dia, turno: h.turno, abre: h.abre, fecha: h.fecha, vagas });
  }
  return { horarios };
}

/**
 * Situação de cada dia e turno entre `inicio` e `fim` (inclusive):
 * [{ data, turno, abre, fecha, vagas, ocupadas, livres, fechado_motivo }]
 * Só entram os turnos em que a unidade atende. livres = null quando não
 * há limite.
 */
export async function agendaDoPosto(pos_id, inicio, fim, { db = knex, ignorarSolId = null } = {}) {
  const { horarios } = await horariosDoPosto(pos_id, { db });
  const bloqueios = new Map(
    (await db('posto_bloqueio').where('pos_id', pos_id).whereBetween('pbl_data', [inicio, fim]).select('pbl_data', 'pbl_motivo'))
      .map((b) => [isoData(b.pbl_data), b.pbl_motivo ?? 'Unidade fechada']),
  );

  const ocupacao = await db('solicitacao')
    .where('pos_id', pos_id)
    .where('sol_status', 'agendado')
    .whereBetween('sol_data_de_coleta', [inicio, fim])
    .modify((qb) => { if (ignorarSolId) qb.whereNot('sol_id', ignorarSolId); })
    .select('sol_data_de_coleta', 'sol_turno')
    .count({ total: '*' })
    .groupBy('sol_data_de_coleta', 'sol_turno');
  const ocupadas = new Map();
  for (const o of ocupacao) {
    const chave = `${isoData(o.sol_data_de_coleta)}:${o.sol_turno ?? 'manha'}`;
    ocupadas.set(chave, (ocupadas.get(chave) ?? 0) + Number(o.total));
  }

  const dias = [];
  for (let data = inicio; data <= fim; data = somarDias(data, 1)) {
    const semana = diaDaSemana(data);
    for (const h of horarios.filter((x) => x.dia_semana === semana)) {
      const n = ocupadas.get(`${data}:${h.turno}`) ?? 0;
      dias.push({
        data,
        turno: h.turno,
        abre: h.abre,
        fecha: h.fecha,
        vagas: h.vagas,
        ocupadas: n,
        livres: h.vagas == null ? null : Math.max(0, h.vagas - n),
        fechado_motivo: bloqueios.get(data) ?? null,
      });
    }
  }
  return dias;
}

const temVaga = (t) => !t.fechado_motivo && (t.livres === null || t.livres > 0);

/**
 * Confere se dá para marcar naquele dia/turno. Sem turno, escolhe o
 * primeiro turno do dia com vaga. Devolve { turno } ou { erro }.
 */
export async function conferirVaga(pos_id, data, turno, opcoes = {}) {
  if (turno != null && turno !== '' && !TURNOS.includes(turno)) return { erro: 'Turno inválido (manhã ou tarde).' };
  const doDia = await agendaDoPosto(pos_id, data, data, opcoes);
  if (!doDia.length) return { erro: 'A unidade não atende neste dia. Escolha outra data.' };
  if (doDia[0].fechado_motivo) return { erro: `A unidade estará fechada neste dia (${doDia[0].fechado_motivo}). Escolha outra data.` };

  if (!turno) {
    const livre = doDia.find(temVaga);
    return livre ? { turno: livre.turno } : { erro: 'Não há vagas neste dia. Escolha outra data.' };
  }
  const t = doDia.find((x) => x.turno === turno);
  if (!t) return { erro: `A unidade não atende no turno da ${ROTULO_TURNO[turno]} neste dia.` };
  if (!temVaga(t)) return { erro: `O turno da ${ROTULO_TURNO[turno]} deste dia está lotado. Escolha outro turno ou outra data.` };
  return { turno };
}

/**
 * Próximas opções com vaga a partir de `desde` (inclusive), até `limite`
 * opções ou `ate` (ex.: vencimento da prescrição).
 */
export async function proximasOpcoes(pos_id, desde, { limite = 10, ate = null, janelaDias = 45, ...opcoes } = {}) {
  const fimJanela = somarDias(desde, janelaDias);
  const fim = ate && ate < fimJanela ? ate : fimJanela;
  if (fim < desde) return [];
  return (await agendaDoPosto(pos_id, desde, fim, opcoes)).filter(temVaga).slice(0, limite);
}
