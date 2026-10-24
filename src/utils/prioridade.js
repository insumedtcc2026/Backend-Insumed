// Prioridade legal na fila de análise (Estatuto da Pessoa Idosa e Lei
// 10.048/2000): primeiro 80 anos ou mais; depois 60 ou mais, pessoa com
// deficiência e gestante; depois os demais. Dentro de cada grupo, pela data
// de envio. Deficiência e gestação são declaradas pelo paciente e só contam
// depois que a unidade confere (pac_prioridade_conferida = true).

import knex from '../database/index.js';
import { isoData } from './status.js';

const anosAtras = (hoje, anos) => `${Number(hoje.slice(0, 4)) - anos}${hoje.slice(4)}`;

// Colunas do paciente que a prioridade usa (junte com "pacientes as pac")
export const COLUNAS_PRIORIDADE = ['pac.pac_data_nasc', 'pac.pac_pcd', 'pac.pac_gestante', 'pac.pac_prioridade_conferida'];

// ORDER BY do grupo (1, 2 ou 3), para usar antes da data de envio
export function ordemPrioridade(hoje, alias = 'pac') {
  return knex.raw(
    `CASE WHEN ${alias}.pac_data_nasc IS NOT NULL AND ${alias}.pac_data_nasc <= ? THEN 1 ` +
    `WHEN (${alias}.pac_data_nasc IS NOT NULL AND ${alias}.pac_data_nasc <= ?) ` +
    `OR (${alias}.pac_prioridade_conferida = TRUE AND (${alias}.pac_pcd = TRUE OR ${alias}.pac_gestante = TRUE)) THEN 2 ELSE 3 END`,
    [anosAtras(hoje, 80), anosAtras(hoje, 60)],
  );
}

/**
 * { grupo: 1 | 2 | 3, motivo: '80+' | '60+' | 'pcd' | 'gestante' | null,
 *   aguardando_conferencia: boolean } de um paciente.
 */
export function prioridadeDoPaciente(p, hoje) {
  const nasc = isoData(p.pac_data_nasc);
  const conferida = p.pac_prioridade_conferida === true;
  const declarada = Boolean(p.pac_pcd || p.pac_gestante);
  const aguardando = declarada && p.pac_prioridade_conferida == null;
  if (nasc && nasc <= anosAtras(hoje, 80)) return { grupo: 1, motivo: '80+', aguardando_conferencia: aguardando };
  if (nasc && nasc <= anosAtras(hoje, 60)) return { grupo: 2, motivo: '60+', aguardando_conferencia: aguardando };
  if (conferida && p.pac_pcd) return { grupo: 2, motivo: 'pcd', aguardando_conferencia: false };
  if (conferida && p.pac_gestante) return { grupo: 2, motivo: 'gestante', aguardando_conferencia: false };
  return { grupo: 3, motivo: null, aguardando_conferencia: aguardando };
}

// Acrescenta `prioridade` e tira as colunas de apoio da resposta
export const comPrioridade = (linhas, hoje) => linhas.map((l) => {
  const { pac_data_nasc, pac_pcd, pac_gestante, pac_prioridade_conferida, ...resto } = l;
  return { ...resto, prioridade: prioridadeDoPaciente({ pac_data_nasc, pac_pcd, pac_gestante, pac_prioridade_conferida }, hoje) };
});
