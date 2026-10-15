// Paginação feita no banco (LIMIT/OFFSET), no formato que o frontend já usa
// em "Meus agendamentos" e "Atividades da unidade":
// { itens, total, paginaAtual, totalPaginas }.

export function lerPaginacao(query, { padrao = 20, maximo = 100 } = {}) {
  return {
    pagina: Math.max(1, Number(query.page) || 1),
    porPagina: Math.min(Math.max(Number(query.porPagina) || padrao, 1), maximo),
  };
}

/**
 * @param consulta  query knex já filtrada, SEM select/order (a contagem usa uma cópia)
 * @param montar    (qb) => qb.select(...).orderBy(...) para buscar a página
 */
export async function paginar(consulta, montar, query, opcoes) {
  const { pagina, porPagina } = lerPaginacao(query, opcoes);
  const total = Number((await consulta.clone().count({ total: '*' }).first())?.total ?? 0);
  const totalPaginas = Math.max(1, Math.ceil(total / porPagina));
  const paginaAtual = Math.min(pagina, totalPaginas);
  const itens = await consulta.clone().modify(montar).limit(porPagina).offset((paginaAtual - 1) * porPagina);
  return { itens, total, paginaAtual, totalPaginas };
}

// Filtro de busca por nome, CPF (só dígitos) ou número da solicitação
export function filtroBuscaPaciente(busca, { nome = 'pac.pac_nome', cpf = 'pac.pac_cpf', id = 'sol.sol_id' } = {}) {
  return (qb) => {
    const termo = String(busca ?? '').trim();
    if (!termo) return;
    const digitos = termo.replace(/\D/g, '');
    qb.where((w) => {
      w.whereILike(nome, `%${termo}%`);
      if (digitos) {
        w.orWhereRaw(`REPLACE(REPLACE(${cpf}, '.', ''), '-', '') LIKE ?`, [`%${digitos}%`]);
        if (digitos === termo && digitos.length <= 9) w.orWhere(id, Number(digitos));
      }
    });
  };
}
