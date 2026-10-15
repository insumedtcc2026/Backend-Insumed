// Regras de conta que valem para os três perfis (paciente, admin e autorizador).
import knex from '../database/index.js';
import { normalizarEmail } from './validacoes.js';

// O login procura o e-mail em administrador, autorizador e pacientes, nessa
// ordem. Se o mesmo e-mail existisse em dois perfis, um deles nunca
// conseguiria entrar — por isso o e-mail é único entre todos os perfis.
const TABELAS_EMAIL = [
  ['administrador', 'adm_email'],
  ['autorizador', 'aut_email'],
  ['pacientes', 'pac_email'],
];

/**
 * true se o e-mail já está em uso em qualquer perfil.
 * @param ignorar filtro opcional para não contar o próprio usuário: { tabela, filtro(qb) }
 */
export async function emailEmUso(email, ignorar = null) {
  const valor = normalizarEmail(email);
  for (const [tabela, coluna] of TABELAS_EMAIL) {
    const q = knex(tabela).whereRaw(`LOWER(${coluna}) = ?`, [valor]);
    if (ignorar?.tabela === tabela) q.whereNot(ignorar.filtro);
    if (await q.first(coluna)) return true;
  }
  return false;
}
