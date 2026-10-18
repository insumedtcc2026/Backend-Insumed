// Tarefa diária (Vercel Cron, uma vez por dia de manhã) e avisos que
// dependem da data. Tudo aqui pode rodar mais de uma vez no mesmo dia sem
// duplicar nada: cada aviso tem uma chave única e as mudanças de status
// usam UPDATE condicional.
//
// Datas sempre no fuso de Brasília (dataHojeBrasil); o agendamento só tem
// data (sem horário), então os lembretes são por dia.

import knex from '../database/index.js';
import { ACOES, registrarHistorico } from '../utils/historico.js';
import { dataHojeBrasil } from '../utils/validacoes.js';
import { dataBR, isoData, somarDias } from '../utils/status.js';
import { adminsDoPosto, paciente } from './destinatarios.js';
import { criarNotificacoes } from './gravar.js';
import { carregarContexto, LINKS, primeiroNome } from './regras.js';
import { processarEventos } from './processador.js';

// Prazos combinados com a unidade (18/10/2026)
export const PRAZOS = {
  lembreteDiasAntes: 1,
  naoCompareceuDias: 7,      // data passada sem conclusão nem remarcação
  analiseParadaDias: 7,      // prescrição Pendente sem análise
  reenvioSemRespostaDias: 5, // paciente não reenviou
  semAgendamentoDias: 3,     // autorizada sem coleta agendada
  vencendoDias: 7,           // autorizada perto do vencimento, sem retirada
  retencaoLidasDias: 180,    // notificações lidas somem depois disso
};

// Início do dia (Brasília) de "hoje - n": eventos antes disso têm mais de n dias
const inicioDoDia = (iso) => `${iso}T00:00:00-03:00`;

// Prescrições que já viraram agendamento ativo (agendado/concluído) ou já foram retiradas
const origensCom = (status) => knex('solicitacao')
  .whereNotNull('sol_origem_id')
  .whereIn('sol_status', status)
  .pluck('sol_origem_id');

// Última vez que cada solicitação recebeu uma das ações (sem subconsulta correlacionada)
async function ultimaAcao(ids, acoes) {
  if (!ids.length) return new Map();
  const linhas = await knex('historico_solicitacao')
    .whereIn('sol_id', ids)
    .whereIn('his_acao', acoes)
    .select('sol_id')
    .max({ quando: 'his_criado_em' })
    .max({ his_id: 'his_id' })
    .groupBy('sol_id');
  return new Map(linhas.map((l) => [l.sol_id, { quando: new Date(l.quando), his_id: l.his_id }]));
}

// ---------------------------------------------------------------
// Lembretes de coleta (paciente)
// ---------------------------------------------------------------

function lembrete(ag, tipo) {
  const posto = ag.pos_nome ?? 'unidade';
  const recado = ag.sol_recado ? ` Orientação da unidade: ${ag.sol_recado}` : '';
  if (tipo === 'hoje') {
    return {
      tom: 'agenda', prioridade: 1, titulo: 'Dia de retirada',
      mensagem: `Hoje é o dia agendado para a retirada de ${ag.insumos}. Dirija-se à ${posto}` +
        `${ag.pos_endereco ? ` (${ag.pos_endereco})` : ''}${ag.sol_protocolo ? ` e leve o protocolo ${ag.sol_protocolo}` : ''}.${recado}`,
    };
  }
  return {
    tom: 'agenda', prioridade: 2, titulo: 'Retirada próxima',
    mensagem: `A data para retirada de ${ag.insumos} está se aproximando: ${dataBR(ag.sol_data_de_coleta)}, na ${posto}. ` +
      `Verifique seu agendamento e programe-se para comparecer à unidade.${recado}`,
  };
}

/**
 * Lembretes "retirada próxima" (N dias antes) e "dia de retirada".
 * Só agendamentos com status "agendado": cancelado, concluído, não
 * compareceu ou remarcado para outra data não recebe (a chave leva a data,
 * então a remarcação gera lembretes da nova data).
 * @param pac_id opcional: só os de um paciente (usado quando ele abre o sino)
 */
export async function gerarLembretes(hoje = dataHojeBrasil(), { pac_id } = {}) {
  const vespera = somarDias(hoje, PRAZOS.lembreteDiasAntes);
  const agendamentos = await knex('solicitacao')
    .where('sol_status', 'agendado')
    .whereIn('sol_data_de_coleta', [hoje, vespera])
    .modify((qb) => { if (pac_id) qb.where('pac_id', pac_id); })
    .pluck('sol_id');

  const lista = [];
  for (const sol_id of agendamentos) {
    const ag = await carregarContexto(knex, sol_id);
    if (!ag || ag.sol_status !== 'agendado') continue;
    const data = isoData(ag.sol_data_de_coleta);
    const tipo = data === hoje ? 'hoje' : 'vespera';
    lista.push({
      dest: paciente(ag.pac_id),
      evento: tipo === 'hoje' ? 'lembrete_hoje' : 'lembrete_vespera',
      ...lembrete(ag, tipo),
      link: LINKS.agendamentoPaciente(sol_id),
      sol_id,
      chave: `lembrete:${sol_id}:${data}:${tipo}`,
    });
  }
  return criarNotificacoes(knex, lista);
}

// ---------------------------------------------------------------
// Coleta com data passada
// ---------------------------------------------------------------

// Dia seguinte à data: avisa a equipe para concluir, remarcar ou cancelar.
export async function avisarColetasAtrasadas(hoje = dataHojeBrasil()) {
  const atrasadas = await knex('solicitacao as s')
    .leftJoin('pacientes as p', 'p.pac_id', 's.pac_id')
    .where('s.sol_status', 'agendado')
    .where('s.sol_data_de_coleta', '<', hoje)
    .select('s.sol_id', 's.pos_id', 's.sol_protocolo', 's.sol_data_de_coleta', 'p.pac_nome');

  const lista = [];
  for (const ag of atrasadas) {
    const data = isoData(ag.sol_data_de_coleta);
    const limite = dataBR(somarDias(data, PRAZOS.naoCompareceuDias + 1));
    for (const dest of await adminsDoPosto(knex, ag.pos_id)) {
      lista.push({
        dest, evento: 'coleta_sem_baixa', tom: 'alerta', prioridade: 1,
        titulo: 'Coleta sem baixa',
        mensagem: `A coleta de ${primeiroNome(ag.pac_nome)}${ag.sol_protocolo ? ` (protocolo ${ag.sol_protocolo})` : ''} ` +
          `estava marcada para ${dataBR(data)} e não foi concluída nem cancelada. Conclua, remarque ou cancele. ` +
          `Sem remarcação, ela será registrada como "não compareceu" em ${limite}.`,
        link: LINKS.agendaAdmin(ag.sol_protocolo ?? String(ag.sol_id)),
        sol_id: ag.sol_id,
        chave: `coleta_sem_baixa:${ag.sol_id}:${data}`,
      });
    }
  }
  return criarNotificacoes(knex, lista);
}

// Mais de 7 dias depois da data, sem conclusão nem remarcação: "não
// compareceu". O histórico registra (o paciente é avisado por ele).
export async function marcarNaoCompareceu(hoje = dataHojeBrasil()) {
  const limite = somarDias(hoje, -PRAZOS.naoCompareceuDias);
  const candidatos = await knex('solicitacao')
    .where('sol_status', 'agendado')
    .where('sol_data_de_coleta', '<', limite)
    .select('sol_id', 'sol_protocolo', 'sol_data_de_coleta', 'sol_origem_id');

  let marcados = 0;
  for (const ag of candidatos) {
    await knex.transaction(async (trx) => {
      const n = await trx('solicitacao')
        .where({ sol_id: ag.sol_id, sol_status: 'agendado' })
        .update({ sol_status: 'nao_compareceu' });
      if (!n) return;
      marcados++;
      const detalhe = `${ag.sol_protocolo ?? 'Agendamento ' + ag.sol_id} · coleta de ${dataBR(ag.sol_data_de_coleta)} não realizada`;
      await registrarHistorico(trx, null, {
        sol_id: ag.sol_id, acao: ACOES.NAO_COMPARECEU, de: 'agendado', para: 'nao_compareceu', detalhe,
      });
      if (ag.sol_origem_id) {
        await registrarHistorico(trx, null, {
          sol_id: ag.sol_origem_id, acao: ACOES.NAO_COMPARECEU, de: 'Autorizado', para: 'Autorizado', detalhe,
        });
      }
    });
  }
  return marcados;
}

// ---------------------------------------------------------------
// Prescrição vencida
// ---------------------------------------------------------------

// Vencida sem retirada: o paciente é avisado para enviar uma nova e o
// agendamento ativo (se houver) é cancelado com o motivo "Prescrição vencida".
export async function tratarVencidas(hoje = dataHojeBrasil()) {
  const retiradas = await origensCom(['concluido']);
  const vencidas = await knex('solicitacao')
    .whereIn('sol_status', ['Revisado', 'Aprovado', 'Autorizado'])
    .whereNotNull('sol_data_vencimento')
    .where('sol_data_vencimento', '<', hoje)
    .modify((qb) => { if (retiradas.length) qb.whereNotIn('sol_id', retiradas); })
    .pluck('sol_id');

  const lista = [];
  let cancelados = 0;
  for (const sol_id of vencidas) {
    const c = await carregarContexto(knex, sol_id);
    if (!c) continue;

    const ativos = await knex('solicitacao')
      .where({ sol_origem_id: sol_id, sol_status: 'agendado' })
      .select('sol_id', 'sol_protocolo');
    for (const ag of ativos) {
      await knex.transaction(async (trx) => {
        const [linha] = await trx('solicitacao')
          .where({ sol_id: ag.sol_id, sol_status: 'agendado' })
          .update({ sol_status: 'cancelado', sol_motivo_cancelamento: 'Prescrição vencida', sol_data_cancelamento: trx.fn.now() })
          .returning(['sol_id']);
        if (!linha) return;
        cancelados++;
        const detalhe = `${ag.sol_protocolo ?? 'Agendamento ' + ag.sol_id} · Motivo: Prescrição vencida`;
        await registrarHistorico(trx, null, { sol_id: ag.sol_id, acao: ACOES.CANCELADA, de: 'agendado', para: 'cancelado', detalhe });
        await registrarHistorico(trx, null, { sol_id, acao: ACOES.CANCELADA, de: 'Autorizado', para: 'Autorizado', detalhe });
      });
    }

    lista.push({
      dest: paciente(c.pac_id), evento: 'prescricao_vencida', tom: 'erro', prioridade: 1,
      titulo: 'Prescrição vencida',
      mensagem: `Sua prescrição de ${c.insumos} venceu em ${dataBR(c.sol_data_vencimento)} sem que a retirada fosse feita. ` +
        'Para continuar recebendo, envie uma prescrição nova pela página Enviar prescrição.',
      link: '/enviarsolicitacao',
      sol_id,
      chave: `vencida:${sol_id}`,
    });
  }
  await criarNotificacoes(knex, lista);
  return { avisadas: lista.length, cancelados };
}

// ---------------------------------------------------------------
// Pendências por tempo
// ---------------------------------------------------------------

export async function avisarPendencias(hoje = dataHojeBrasil()) {
  const lista = [];
  const comPaciente = () => knex('solicitacao as s').leftJoin('pacientes as p', 'p.pac_id', 's.pac_id');

  // 1) Em análise há mais de 7 dias (desde o envio ou o último reenvio)
  const pendentes = await comPaciente().where('s.sol_status', 'Pendente')
    .select('s.sol_id', 's.pos_id', 's.sol_data_solicitacao', 'p.pac_nome');
  const entradas = await ultimaAcao(pendentes.map((p) => p.sol_id), [ACOES.ENVIADA, ACOES.REENVIADA]);
  const limiteAnalise = new Date(inicioDoDia(somarDias(hoje, -(PRAZOS.analiseParadaDias - 1))));
  for (const p of pendentes) {
    const entrada = entradas.get(p.sol_id);
    const quando = entrada?.quando ?? new Date(p.sol_data_solicitacao);
    if (!(quando < limiteAnalise)) continue;
    for (const dest of await adminsDoPosto(knex, p.pos_id)) {
      lista.push({
        dest, evento: 'analise_parada', tom: 'alerta', prioridade: 1,
        titulo: 'Prescrição parada',
        mensagem: `A prescrição nº ${p.sol_id} de ${primeiroNome(p.pac_nome)} aguarda análise há mais de ${PRAZOS.analiseParadaDias} dias.`,
        link: LINKS.analisarAdmin(p.sol_id),
        sol_id: p.sol_id,
        chave: `analise_parada:${p.sol_id}:${entrada?.his_id ?? 0}`,
      });
    }
  }

  // 2) Reenvio pedido há mais de 5 dias sem resposta: um lembrete ao paciente
  const reenvios = await knex('solicitacao').where('sol_status', 'Reenvio').select('sol_id', 'pac_id');
  const pedidos = await ultimaAcao(reenvios.map((r) => r.sol_id), [ACOES.REENVIO]);
  const limiteReenvio = new Date(inicioDoDia(somarDias(hoje, -(PRAZOS.reenvioSemRespostaDias - 1))));
  for (const r of reenvios) {
    const pedido = pedidos.get(r.sol_id);
    if (!pedido || !(pedido.quando < limiteReenvio)) continue;
    lista.push({
      dest: paciente(r.pac_id), evento: 'reenvio_pendente', tom: 'alerta', prioridade: 1,
      titulo: 'Correção pendente',
      mensagem: 'A unidade ainda aguarda a nova versão da sua prescrição. Envie a correção pela página Minhas prescrições.',
      link: LINKS.reenvioPaciente(r.sol_id),
      sol_id: r.sol_id,
      chave: `reenvio_pendente:${r.sol_id}:${pedido.his_id}`,
    });
  }

  // 3) Autorizada há mais de 3 dias e ainda sem coleta agendada
  // 4) Autorizada que vence em até 7 dias e ainda não foi retirada
  const comAgendamento = await origensCom(['agendado', 'concluido']);
  const retiradas = await origensCom(['concluido']);
  const autorizadas = await comPaciente().where('s.sol_status', 'Autorizado')
    .select('s.sol_id', 's.pos_id', 's.sol_data_vencimento', 'p.pac_nome');
  const autorizacoes = await ultimaAcao(autorizadas.map((a) => a.sol_id), [ACOES.AUTORIZADA]);
  const limiteAgendar = new Date(inicioDoDia(somarDias(hoje, -(PRAZOS.semAgendamentoDias - 1))));
  const limiteVencendo = somarDias(hoje, PRAZOS.vencendoDias);

  for (const a of autorizadas) {
    const vencimento = isoData(a.sol_data_vencimento);
    if (vencimento && vencimento < hoje) continue; // vencida: tratada em tratarVencidas
    const admins = await adminsDoPosto(knex, a.pos_id);
    const autorizacao = autorizacoes.get(a.sol_id);

    if (!comAgendamento.includes(a.sol_id) && autorizacao && autorizacao.quando < limiteAgendar) {
      lista.push(...admins.map((dest) => ({
        dest, evento: 'sem_agendamento', tom: 'alerta', prioridade: 1,
        titulo: 'Autorizada aguardando agendamento',
        mensagem: `A prescrição nº ${a.sol_id} de ${primeiroNome(a.pac_nome)} foi autorizada há mais de ${PRAZOS.semAgendamentoDias} dias e ainda não tem coleta agendada.`,
        link: LINKS.filaAdmin('ParaAgendar'),
        sol_id: a.sol_id,
        chave: `sem_agendamento:${a.sol_id}:${autorizacao.his_id}`,
      })));
    }

    if (vencimento && vencimento <= limiteVencendo && !retiradas.includes(a.sol_id)) {
      lista.push(...admins.map((dest) => ({
        dest, evento: 'perto_do_vencimento', tom: 'alerta', prioridade: 2,
        titulo: 'Prescrição perto do vencimento',
        mensagem: `A prescrição nº ${a.sol_id} de ${primeiroNome(a.pac_nome)} vence em ${dataBR(vencimento)} e ainda não foi retirada.`,
        link: comAgendamento.includes(a.sol_id) ? LINKS.agendaAdmin(String(a.sol_id)) : LINKS.filaAdmin('ParaAgendar'),
        sol_id: a.sol_id,
        chave: `perto_do_vencimento:${a.sol_id}:${vencimento}`,
      })));
    }
  }

  return criarNotificacoes(knex, lista);
}

// Notificações lidas há mais de 180 dias somem.
export async function limparAntigas() {
  const limite = new Date(Date.now() - PRAZOS.retencaoLidasDias * 86400000).toISOString();
  return knex('notificacao').whereNotNull('not_lida_em').where('not_lida_em', '<', limite).del();
}

/**
 * Tudo o que roda uma vez por dia. A ordem importa: primeiro as mudanças de
 * status (não compareceu, vencidas), depois o processamento dos eventos que
 * elas geraram, e só então os lembretes e pendências do estado final.
 */
export async function tarefaDiaria(hoje = dataHojeBrasil()) {
  const resultado = { hoje };
  resultado.naoCompareceu = await marcarNaoCompareceu(hoje);
  resultado.vencidas = await tratarVencidas(hoje);
  resultado.eventos = await processarEventos({ limite: 500, repetirFalhas: true });
  resultado.lembretes = await gerarLembretes(hoje);
  resultado.coletasSemBaixa = await avisarColetasAtrasadas(hoje);
  resultado.pendencias = await avisarPendencias(hoje);
  resultado.limpeza = await limparAntigas();
  return resultado;
}
