// Quem recebe cada notificação.
import { idDoAdmin } from '../utils/contas.js';

// Destinatário = a pessoa logada ({ tipo, id }), sempre tirada do token.
export async function destinatarioDaSessao(sessao) {
  if (sessao?.tipo === 'PACIENTE' || sessao?.tipo === 'AUTORIZADOR') {
    return sessao.id ? { tipo: sessao.tipo, id: Number(sessao.id) } : null;
  }
  if (sessao?.tipo === 'ADMIN') {
    const id = await idDoAdmin(sessao);
    return id ? { tipo: 'ADMIN', id } : null;
  }
  return null;
}

// Administradores do posto + os universais (que veem todas as unidades)
export async function adminsDoPosto(db, pos_id) {
  const linhas = await db('administrador')
    .whereNotNull('adm_id')
    .where((w) => w.where('pos_id', pos_id ?? null).orWhere('tp_universal', true))
    .select('adm_id', 'pos_id', 'tp_universal');
  return linhas.map((a) => ({ tipo: 'ADMIN', id: Number(a.adm_id), pos_id: a.pos_id, universal: Boolean(a.tp_universal) }));
}

// Todos os autorizadores (não há atribuição: a fila de análise é única)
export async function todosAutorizadores(db) {
  const linhas = await db('autorizador').select('aut_id');
  return linhas.map((a) => ({ tipo: 'AUTORIZADOR', id: Number(a.aut_id) }));
}

export const paciente = (pac_id) => ({ tipo: 'PACIENTE', id: Number(pac_id) });

