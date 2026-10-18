// Gravação das notificações. Todas passam por aqui, para valerem as mesmas
// regras: uma linha por destinatário e chave única (repetir não duplica).

// Prioridade: 1 alta (exige ação), 2 média, 3 baixa.
// Tom (ícone e cor no sino): agenda | sucesso | alerta | erro | info

const limitar = (texto, max) => (texto.length > max ? `${texto.slice(0, max - 1)}…` : texto);

function linha(n) {
  return {
    not_dest_tipo: n.dest.tipo,
    not_dest_id: n.dest.id,
    not_evento: n.evento,
    not_tom: n.tom ?? 'info',
    not_titulo: limitar(n.titulo, 120),
    not_mensagem: limitar(n.mensagem, 600),
    not_prioridade: n.prioridade ?? 2,
    not_link: n.link ?? null,
    sol_id: n.sol_id ?? null,
    his_id: n.his_id ?? null,
    not_chave: n.chave,
  };
}

/**
 * Cria notificações (ignora as que já existem com a mesma chave).
 * @param db     knex ou transação
 * @param lista  [{ dest:{tipo,id}, evento, tom, titulo, mensagem, prioridade, link, sol_id, his_id, chave }]
 */
export async function criarNotificacoes(db, lista) {
  const validas = lista.filter((n) => n?.dest?.id && n.chave);
  for (const n of validas) {
    await db('notificacao')
      .insert(linha(n))
      .onConflict(['not_dest_tipo', 'not_dest_id', 'not_chave'])
      .ignore();
  }
  return validas.length;
}

/**
 * Notificação agregada (ex.: "Você tem 4 solicitações para analisar"):
 * cada pessoa tem no máximo UMA não lida daquele evento. Se ela já existe,
 * o texto é atualizado e ela volta para o topo; se já foi lida, nasce outra.
 * Com n = 0, a não lida é marcada como lida (não há mais o que fazer).
 */
export async function atualizarAgregada(db, dest, { evento, n, montar }) {
  const aberta = await db('notificacao')
    .where({ not_dest_tipo: dest.tipo, not_dest_id: dest.id, not_evento: evento })
    .whereNull('not_lida_em')
    .orderBy('not_id', 'desc')
    .first('not_id');

  if (!n) {
    if (aberta) await db('notificacao').where('not_id', aberta.not_id).update({ not_lida_em: db.fn.now() });
    return;
  }

  const dados = montar(n);
  if (aberta) {
    await db('notificacao').where('not_id', aberta.not_id).update({
      not_titulo: dados.titulo,
      not_mensagem: dados.mensagem,
      not_atualizada_em: db.fn.now(),
    });
    return;
  }

  await criarNotificacoes(db, [{
    ...dados,
    dest,
    evento,
    chave: `${evento}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
  }]);
}
