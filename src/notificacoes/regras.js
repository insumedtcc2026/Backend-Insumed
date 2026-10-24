// Regras das notificações: para cada ação gravada no histórico
// (src/utils/historico.js), quem é avisado e com qual texto.
// Os textos ficam todos aqui, num lugar só.
//
// Privacidade: o paciente nunca vê o nome de quem fez na unidade; a equipe
// vê o primeiro nome do paciente e o número/protocolo, nunca o CPF.

import { ACOES } from '../utils/historico.js';
import { dataBR, STATUS_AGENDAMENTO } from '../utils/status.js';
import { adminsDoPosto, paciente, todosAutorizadores } from './destinatarios.js';
import { atualizarAgregada, criarNotificacoes } from './gravar.js';

export const primeiroNome = (nome) => String(nome ?? '').trim().split(/\s+/)[0] || 'Paciente';

// "Fralda G", "Fralda G e Luva", "Fralda G, Luva e Sonda"
export function listaInsumos(nomes) {
  const unicos = [...new Set(nomes.filter(Boolean))];
  if (!unicos.length) return 'seus insumos';
  if (unicos.length === 1) return unicos[0];
  return `${unicos.slice(0, -1).join(', ')} e ${unicos[unicos.length - 1]}`;
}

// Links do frontend (sem dado pessoal na URL)
export const LINKS = {
  prescricaoPaciente: (id) => `/prescricoes?sol_id=${id}`,
  reenvioPaciente: (id) => `/prescricoes?sol_id=${id}&acao=reenviar`,
  agendamentoPaciente: (id) => `/agendamentos?sol_id=${id}`,
  analisarAdmin: (id) => `/administrador/prescricao/autorizarprescricao/${id}`,
  naoAutorizadaAdmin: (id) => `/administrador/prescricao/nao-autorizada/${id}`,
  filaAdmin: (status) => `/versolicitaçoes?status=${status}`,
  agendaAdmin: (busca) => `/Agendamentosadm?busca=${encodeURIComponent(busca)}`,
  filaAutorizador: '/verprescricoesaprovadas?status=Revisado',
  analisarAutorizador: (id) => `/autorizador/solicitacao/${id}`,
  insumosAdmin: '/insumos',
  pedidosAdmin: '/Agendamentosadm?aba=pedidos',
};

const plural = (n, um, varios) => (n === 1 ? um : varios);

// Contexto do evento: a solicitação (prescrição ou agendamento) com
// paciente, posto, insumo(s) e o agendamento/prescrição relacionados.
export async function carregarContexto(db, sol_id) {
  const sol = await db('solicitacao as s')
    .leftJoin('pacientes as p', 'p.pac_id', 's.pac_id')
    .leftJoin('postosdesaude as pos', 'pos.pos_id', 's.pos_id')
    .leftJoin('insumo as i', 'i.ins_id', 's.ins_id')
    .where('s.sol_id', sol_id)
    .first(
      's.sol_id', 's.pac_id', 's.pos_id', 's.sol_status', 's.sol_protocolo', 's.sol_data_de_coleta',
      's.sol_origem_id', 's.sol_recado', 's.sol_motivo_cancelamento', 's.sol_data_vencimento',
      's.sol_insumo_quant', 'p.pac_nome', 'pos.pos_nome', 'pos.pos_endereco', 'i.ins_nome',
    );
  if (!sol) return null;

  const ehAgendamento = STATUS_AGENDAMENTO.includes(sol.sol_status);
  let insumos = sol.ins_nome ? [sol.ins_nome] : [];
  if (!ehAgendamento) {
    // prescrição com vários insumos (etapa 2)
    const itens = await db('solicitacao_item as it')
      .leftJoin('insumo as i', 'i.ins_id', 'it.ins_id')
      .where('it.sol_id', sol_id)
      .orderBy('it.sit_id')
      .pluck('i.ins_nome');
    if (itens.length) insumos = itens;
  } else {
    insumos = await db('coleta as c')
      .leftJoin('insumo as i', 'i.ins_id', 'c.ins_id')
      .where('c.sol_id', sol_id)
      .pluck('i.ins_nome');
  }
  return { ...sol, ehAgendamento, insumos: listaInsumos(insumos) };
}

// ---------------------------------------------------------------
// Agregados de trabalho pendente (uma notificação por pessoa)
// ---------------------------------------------------------------

export async function atualizarFilaAnalise(db, pos_id) {
  const admins = await adminsDoPosto(db, pos_id);
  for (const adm of admins) {
    const q = db('solicitacao').where('sol_status', 'Pendente');
    if (!adm.universal) q.where('pos_id', adm.pos_id ?? null);
    const n = Number((await q.count({ total: '*' }).first())?.total ?? 0);
    await atualizarAgregada(db, adm, {
      evento: 'fila_analise',
      n,
      montar: (qtd) => ({
        tom: 'info',
        prioridade: 1,
        titulo: 'Prescrições para analisar',
        mensagem: `${plural(qtd, 'Há 1 prescrição', `Há ${qtd} prescrições`)} aguardando análise${adm.universal ? '' : ' na sua unidade'}.`,
        link: LINKS.filaAdmin('Pendente'),
      }),
    });
  }
}

export async function atualizarFilaAutorizacao(db) {
  const n = Number((await db('solicitacao').whereIn('sol_status', ['Revisado', 'Aprovado']).count({ total: '*' }).first())?.total ?? 0);
  for (const aut of await todosAutorizadores(db)) {
    await atualizarAgregada(db, aut, {
      evento: 'fila_autorizacao',
      n,
      montar: (qtd) => ({
        tom: 'info',
        prioridade: 1,
        titulo: 'Solicitações para autorizar',
        mensagem: `Você tem ${plural(qtd, '1 solicitação', `${qtd} solicitações`)} aguardando sua análise.`,
        link: LINKS.filaAutorizador,
      }),
    });
  }
}

// ---------------------------------------------------------------
// Ação do histórico -> notificações
// ---------------------------------------------------------------

const motivoDoDetalhe = (detalhe) => {
  const m = /Motivo:\s*([\s\S]+)$/.exec(detalhe ?? '');
  return (m ? m[1] : detalhe ?? '').trim();
};

const comMotivo = (texto, motivo) => (motivo ? `${texto} Motivo: ${motivo}.` : texto).replace(/\.\.$/, '.');

const REGRAS = {
  async [ACOES.ENVIADA](db, his, c, criar) {
    await criar([{
      dest: paciente(c.pac_id), evento: 'prescricao_recebida', tom: 'info', prioridade: 2,
      titulo: 'Prescrição recebida',
      mensagem: 'Recebemos sua prescrição! A unidade vai analisá-la e você será avisado assim que houver uma atualização.',
      link: LINKS.prescricaoPaciente(c.sol_id),
    }]);
    await atualizarFilaAnalise(db, c.pos_id);
  },

  async [ACOES.REVISADA](db, his, c, criar) {
    await criar([{
      dest: paciente(c.pac_id), evento: 'prescricao_revisada', tom: 'info', prioridade: 3,
      titulo: 'Prescrição revisada',
      mensagem: `Sua prescrição de ${c.insumos} foi conferida pela unidade e seguiu para autorização.`,
      link: LINKS.prescricaoPaciente(c.sol_id),
    }]);
    await atualizarFilaAnalise(db, c.pos_id);
    await atualizarFilaAutorizacao(db);
  },

  async [ACOES.REENVIO](db, his, c, criar) {
    await criar([{
      dest: paciente(c.pac_id), evento: 'reenvio_solicitado', tom: 'alerta', prioridade: 1,
      titulo: 'Envie uma nova versão da prescrição',
      mensagem: comMotivo('A unidade pediu uma nova versão da sua prescrição.', his.his_detalhe) +
        ' Envie a correção pela página Minhas prescrições.',
      link: LINKS.reenvioPaciente(c.sol_id),
    }]);
    await atualizarFilaAnalise(db, c.pos_id);
  },

  async [ACOES.REENVIADA](db, his, c, criar) {
    const admins = await adminsDoPosto(db, c.pos_id);
    await criar([
      {
        dest: paciente(c.pac_id), evento: 'correcao_recebida', tom: 'info', prioridade: 2,
        titulo: 'Correção recebida',
        mensagem: 'Recebemos a nova versão da sua prescrição. Ela voltou para análise da unidade.',
        link: LINKS.prescricaoPaciente(c.sol_id),
      },
      ...admins.map((dest) => ({
        dest, evento: 'prescricao_corrigida', tom: 'info', prioridade: 1,
        titulo: 'Prescrição corrigida',
        mensagem: `${primeiroNome(c.pac_nome)} reenviou a prescrição nº ${c.sol_id} corrigida. Ela aguarda nova análise.`,
        link: LINKS.analisarAdmin(c.sol_id),
      })),
    ]);
    await atualizarFilaAnalise(db, c.pos_id);
  },

  async [ACOES.AUTORIZADA](db, his, c, criar) {
    const admins = await adminsDoPosto(db, c.pos_id);
    await criar([
      {
        dest: paciente(c.pac_id), evento: 'prescricao_autorizada', tom: 'sucesso', prioridade: 1,
        titulo: 'Prescrição autorizada',
        mensagem: `Sua prescrição de ${c.insumos} foi autorizada! A unidade vai agendar a retirada e você será avisado com a data.`,
        link: LINKS.prescricaoPaciente(c.sol_id),
      },
      ...admins.map((dest) => ({
        dest, evento: 'pronta_para_agendar', tom: 'sucesso', prioridade: 1,
        titulo: 'Prescrição autorizada',
        mensagem: `A prescrição nº ${c.sol_id} de ${primeiroNome(c.pac_nome)} foi autorizada! Já é possível agendar a coleta.`,
        link: LINKS.filaAdmin('ParaAgendar'),
      })),
    ]);
    await atualizarFilaAutorizacao(db);
  },

  async [ACOES.NAO_AUTORIZADA](db, his, c, criar) {
    const motivo = his.his_detalhe?.trim();
    const admins = await adminsDoPosto(db, c.pos_id);
    await criar([
      {
        dest: paciente(c.pac_id), evento: 'prescricao_nao_autorizada', tom: 'erro', prioridade: 1,
        titulo: 'Prescrição não autorizada',
        mensagem: comMotivo(`Sua prescrição de ${c.insumos} não foi autorizada.`, motivo) +
          ' Em caso de dúvida, fale com a unidade.',
        link: LINKS.prescricaoPaciente(c.sol_id),
      },
      ...admins.map((dest) => ({
        dest, evento: 'nao_autorizada_equipe', tom: 'erro', prioridade: 1,
        titulo: 'Prescrição não autorizada',
        mensagem: comMotivo(`A prescrição nº ${c.sol_id} de ${primeiroNome(c.pac_nome)} não foi autorizada.`, motivo) +
          ' Se for o caso, refaça o pedido com uma observação.',
        link: LINKS.naoAutorizadaAdmin(c.sol_id),
      })),
    ]);
    await atualizarFilaAutorizacao(db);
  },

  async [ACOES.REFEITA](db, his, c, criar) {
    await criar([{
      dest: paciente(c.pac_id), evento: 'prescricao_reanalise', tom: 'info', prioridade: 2,
      titulo: 'Prescrição em nova análise',
      mensagem: `A unidade enviou sua prescrição de ${c.insumos} para uma nova análise de autorização. Você será avisado do resultado.`,
      link: LINKS.prescricaoPaciente(c.sol_id),
    }]);
    await atualizarFilaAutorizacao(db);
  },

  async [ACOES.AGENDADA](db, his, c, criar) {
    await criar([{
      dest: paciente(c.pac_id), evento: 'coleta_agendada', tom: 'agenda', prioridade: 1,
      titulo: 'Coleta agendada',
      mensagem: `Sua retirada de ${c.insumos} foi agendada para ${dataBR(c.sol_data_de_coleta)} na ${c.pos_nome ?? 'unidade'}` +
        `${c.sol_protocolo ? ` (protocolo ${c.sol_protocolo})` : ''}. Confira os detalhes em Meus agendamentos.`,
      link: LINKS.agendamentoPaciente(c.sol_id),
    }]);
  },

  async [ACOES.REAGENDADA](db, his, c, criar) {
    await criar([{
      dest: paciente(c.pac_id), evento: 'coleta_reagendada', tom: 'agenda', prioridade: 1,
      titulo: 'Nova coleta agendada',
      mensagem: `Sua retirada de ${c.insumos} foi agendada novamente para ${dataBR(c.sol_data_de_coleta)} na ${c.pos_nome ?? 'unidade'}` +
        `${c.sol_protocolo ? ` (protocolo ${c.sol_protocolo})` : ''}.`,
      link: LINKS.agendamentoPaciente(c.sol_id),
    }]);
  },

  async [ACOES.REMARCADA](db, his, c, criar) {
    // "de 01/11/2026 (manhã) para 03/11/2026 (tarde)" (o turno é opcional)
    const datas = /de (\d{2}\/\d{2}\/\d{4}(?: \([^)]+\))?) para (\d{2}\/\d{2}\/\d{4}(?: \([^)]+\))?)/.exec(his.his_detalhe ?? '');
    const motivo = /Motivo:/.test(his.his_detalhe ?? '') ? motivoDoDetalhe(his.his_detalhe) : null;
    const quando = datas ? `de ${datas[1]} para ${datas[2]}` : `para ${dataBR(c.sol_data_de_coleta)}`;
    await criar([{
      dest: paciente(c.pac_id), evento: 'coleta_remarcada', tom: 'agenda', prioridade: 1,
      titulo: 'Coleta remarcada',
      mensagem: comMotivo(`Sua retirada de ${c.insumos} foi remarcada ${quando} na ${c.pos_nome ?? 'unidade'}.`, motivo),
      link: LINKS.agendamentoPaciente(c.sol_id),
    }]);
  },

  async [ACOES.RECADO](db, his, c, criar) {
    if (!his.his_detalhe || his.his_detalhe === 'Recado removido') return;
    await criar([{
      dest: paciente(c.pac_id), evento: 'recado_unidade', tom: 'info', prioridade: 2,
      titulo: 'Orientação da unidade',
      mensagem: `Sobre sua coleta de ${dataBR(c.sol_data_de_coleta)}: ${his.his_detalhe}`,
      link: LINKS.agendamentoPaciente(c.sol_id),
    }]);
  },

  async [ACOES.CANCELADA](db, his, c, criar) {
    const motivo = motivoDoDetalhe(his.his_detalhe) || c.sol_motivo_cancelamento;
    // o próprio paciente cancelou: quem precisa saber é a unidade
    if (his.his_usuario_tipo === 'PACIENTE') {
      const admins = await adminsDoPosto(db, c.pos_id);
      await criar(admins.map((dest) => ({
        dest, evento: 'cancelada_pelo_paciente', tom: 'alerta', prioridade: 2,
        titulo: 'Paciente cancelou a coleta',
        mensagem: comMotivo(
          `${primeiroNome(c.pac_nome)} cancelou a coleta de ${dataBR(c.sol_data_de_coleta)}` +
            `${c.sol_protocolo ? ` (protocolo ${c.sol_protocolo})` : ''}. O estoque reservado foi liberado.`,
          motivo,
        ),
        link: LINKS.agendaAdmin(c.sol_protocolo ?? String(c.sol_id)),
      })));
      return;
    }
    await criar([{
      dest: paciente(c.pac_id), evento: 'coleta_cancelada', tom: 'erro', prioridade: 1,
      titulo: 'Agendamento cancelado',
      mensagem: comMotivo(
        `Seu agendamento de ${dataBR(c.sol_data_de_coleta)}${c.sol_protocolo ? ` (protocolo ${c.sol_protocolo})` : ''} foi cancelado.`,
        motivo,
      ) + ' Consulte os detalhes e as próximas orientações em Meus agendamentos.',
      link: LINKS.agendamentoPaciente(c.sol_id),
    }]);
  },

  async [ACOES.OUTRA_DATA_PEDIDA](db, his, c, criar) {
    const pedido = /para (\d{2}\/\d{2}\/\d{4}(?: \([^)]+\))?)/.exec(his.his_detalhe ?? '');
    const admins = await adminsDoPosto(db, c.pos_id);
    await criar(admins.map((dest) => ({
      dest, evento: 'outra_data_pedida', tom: 'alerta', prioridade: 1,
      titulo: 'Pedido de outra data',
      mensagem: `${primeiroNome(c.pac_nome)} pediu para trocar a coleta de ${dataBR(c.sol_data_de_coleta)}` +
        `${pedido ? ` para ${pedido[1]}` : ''}. Aceite ou recuse na agenda.`,
      link: LINKS.pedidosAdmin,
    })));
  },

  async [ACOES.OUTRA_DATA_RECUSADA](db, his, c, criar) {
    await criar([{
      dest: paciente(c.pac_id), evento: 'outra_data_recusada', tom: 'alerta', prioridade: 1,
      titulo: 'Pedido de outra data não atendido',
      mensagem: comMotivo(
        `A unidade não conseguiu trocar a data da sua coleta. Ela continua em ${dataBR(c.sol_data_de_coleta)}.`,
        motivoDoDetalhe(his.his_detalhe),
      ) + ' Você pode pedir outra opção em Meus agendamentos.',
      link: LINKS.agendamentoPaciente(c.sol_id),
    }]);
  },

  async [ACOES.PRESENCA](db, his, c, criar) {
    // "vou" não gera aviso; "não vou" avisa a unidade para liberar o turno
    if (!/não vai/.test(his.his_detalhe ?? '')) return;
    const admins = await adminsDoPosto(db, c.pos_id);
    await criar(admins.map((dest) => ({
      dest, evento: 'presenca_nao_vou', tom: 'alerta', prioridade: 2,
      titulo: 'Paciente não vai à coleta',
      mensagem: `${primeiroNome(c.pac_nome)} avisou que não vai à coleta de ${dataBR(c.sol_data_de_coleta)}` +
        `${c.sol_protocolo ? ` (protocolo ${c.sol_protocolo})` : ''}. O turno pode ser liberado se a coleta for cancelada ou remarcada.`,
      link: LINKS.agendaAdmin(c.sol_protocolo ?? String(c.sol_id)),
    })));
  },

  async [ACOES.CONCLUIDA](db, his, c, criar) {
    await criar([{
      dest: paciente(c.pac_id), evento: 'coleta_concluida', tom: 'sucesso', prioridade: 2,
      titulo: 'Coleta concluída',
      mensagem: `Sua coleta foi concluída com sucesso! A entrega de ${c.insumos} foi registrada.`,
      link: LINKS.agendamentoPaciente(c.sol_id),
    }]);
  },

  async [ACOES.NAO_COMPARECEU](db, his, c, criar) {
    await criar([{
      dest: paciente(c.pac_id), evento: 'coleta_nao_realizada', tom: 'alerta', prioridade: 1,
      titulo: 'Coleta não realizada',
      mensagem: `A retirada de ${c.insumos} agendada para ${dataBR(c.sol_data_de_coleta)} não foi realizada. Fale com a unidade para combinar uma nova data.`,
      link: LINKS.agendamentoPaciente(c.sol_id),
    }]);
  },
};

/**
 * Gera as notificações de uma linha do histórico.
 * Agendar, concluir, cancelar, remarcar e "não compareceu" são gravados duas
 * vezes (no agendamento e na prescrição de origem, com de = para =
 * "Autorizado"); só a linha do agendamento gera aviso.
 */
export async function notificacoesDoEvento(db, his) {
  const regra = REGRAS[his.his_acao];
  if (!regra) return;
  if (his.his_status_anterior === 'Autorizado' && his.his_status_novo === 'Autorizado') return;

  const contexto = await carregarContexto(db, his.sol_id);
  if (!contexto) return;

  // Cada notificação individual leva a chave do evento (his_id): reprocessar
  // o mesmo evento não cria outra.
  const criar = (lista) => criarNotificacoes(db, lista.map((n) => ({
    ...n,
    sol_id: n.sol_id ?? contexto.sol_id,
    his_id: his.his_id,
    chave: `his:${his.his_id}:${n.evento}`,
  })));

  await regra(db, his, contexto, criar);
}
