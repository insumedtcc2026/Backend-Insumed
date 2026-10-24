// Registro de "quem fez o quê" em cada prescrição/agendamento.
// Deve ser chamado com a MESMA transação da ação, para a ação e o registro
// serem gravados juntos (ou nenhum dos dois).

import knex from '../database/index.js';

// Ações registradas (o texto amigável fica no frontend)
export const ACOES = {
  ENVIADA: 'enviada',                    // paciente enviou a prescrição
  REVISADA: 'revisada',                  // admin enviou para o autorizador
  REENVIO: 'reenvio_solicitado',         // admin pediu nova foto/documento
  REENVIADA: 'reenviada',                // paciente corrigiu e reenviou na mesma solicitação
  AUTORIZADA: 'autorizada',              // autorizador autorizou
  NAO_AUTORIZADA: 'nao_autorizada',      // autorizador não autorizou
  AGENDADA: 'agendada',                  // admin criou o agendamento
  REAGENDADA: 'reagendada',              // novo agendamento depois de um cancelamento
  CONCLUIDA: 'concluida',                // coleta entregue
  CANCELADA: 'cancelada',                // agendamento cancelado
  TRANSFERIDA: 'transferida',            // mudou de unidade (função removida; só registros antigos)
  RECADO: 'recado',                      // admin deixou/alterou o recado
  REMARCADA: 'remarcada',                // admin mudou a data do agendamento (mesmo protocolo)
  REFEITA: 'pedido_refeito',             // admin reenviou ao autorizador uma prescrição não autorizada
  NAO_COMPARECEU: 'nao_compareceu',      // sistema: data passou há mais de 7 dias sem retirada
  OUTRA_DATA_PEDIDA: 'outra_data_pedida',     // paciente pediu outra data/turno
  OUTRA_DATA_RECUSADA: 'outra_data_recusada', // unidade recusou o pedido (aceito = REMARCADA)
  PRESENCA: 'presenca_respondida',       // paciente respondeu "vou" ou "não vou"
};

// Como achar quem está logado em cada tabela. A tabela "administrador" não
// tem coluna de id: o admin é identificado pelo e-mail que vai no token.
const TABELA_USUARIO = {
  ADMIN: { tabela: 'administrador', nome: 'adm_nome', filtro: (qb, s) => qb.whereRaw('LOWER(adm_email) = ?', [String(s.email ?? '').toLowerCase()]) },
  AUTORIZADOR: { tabela: 'autorizador', nome: 'aut_nome', filtro: (qb, s) => qb.where('aut_id', s.id) },
  PACIENTE: { tabela: 'pacientes', nome: 'pac_nome', filtro: (qb, s) => qb.where('pac_id', s.id) },
};

// Nome de quem está logado, guardado junto com a ação (assinatura).
// Se não der para identificar, a ação é gravada mesmo assim, sem o nome.
export async function nomeDoUsuario(db, sessao) {
  const t = TABELA_USUARIO[sessao?.tipo];
  if (!t) return null;
  if (sessao.tipo === 'ADMIN' ? !sessao.email : sessao.id == null) return null;
  const linha = await db(t.tabela).modify((qb) => t.filtro(qb, sessao)).first(t.nome);
  return linha?.[t.nome] ?? null;
}

/**
 * Grava uma linha de histórico.
 * @param db      knex ou transação (trx)
 * @param sessao  req.session (tipo e id de quem fez); null = sistema
 */
export async function registrarHistorico(db, sessao, { sol_id, acao, de = null, para = null, detalhe = null }) {
  await db('historico_solicitacao').insert({
    sol_id,
    his_acao: acao,
    his_status_anterior: de,
    his_status_novo: para,
    his_detalhe: detalhe,
    his_usuario_tipo: sessao?.tipo ?? null,
    his_usuario_id: sessao?.id ?? null,
    his_usuario_nome: sessao ? await nomeDoUsuario(db, sessao) : null,
  });
}

// Linha do tempo de uma solicitação, da mais antiga para a mais nova.
// Para o paciente, o nome de quem fez na unidade não é exibido (só o papel).
export async function linhaDoTempo(sol_ids, { ocultarNomesDaEquipe = false } = {}) {
  const ids = [].concat(sol_ids);
  const linhas = await knex('historico_solicitacao')
    .whereIn('sol_id', ids)
    .orderBy([{ column: 'his_criado_em', order: 'asc' }, { column: 'his_id', order: 'asc' }]);

  // Agendar, concluir e cancelar gravam o mesmo evento no agendamento e na
  // prescrição de origem (mesma transação, mesmo texto). Ao juntar os dois
  // na mesma linha do tempo, cada acontecimento aparece uma vez só.
  const ultimoVisto = new Map();
  const unicos = linhas.filter((h) => {
    const chave = `${h.his_acao}|${h.his_detalhe ?? ''}`;
    const quando = new Date(h.his_criado_em).getTime();
    const anterior = ultimoVisto.get(chave);
    if (anterior !== undefined && Math.abs(quando - anterior) < 5000) return false;
    ultimoVisto.set(chave, quando);
    return true;
  });

  return unicos.map((h) => ({
    his_id: h.his_id,
    sol_id: h.sol_id,
    acao: h.his_acao,
    de: h.his_status_anterior,
    para: h.his_status_novo,
    detalhe: h.his_detalhe,
    quando: h.his_criado_em,
    usuario_tipo: h.his_usuario_tipo,
    usuario_nome:
      ocultarNomesDaEquipe && h.his_usuario_tipo !== 'PACIENTE' ? null : h.his_usuario_nome,
  }));
}
