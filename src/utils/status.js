// Status gravados em solicitacao.sol_status.
// A mesma tabela guarda prescrições (Pendente, Reenvio, Revisado/Aprovado,
// Autorizado, Nao Autorizado) e agendamentos (os status abaixo).

// Todos os status de agendamento ("nao_compareceu": a data passou há mais
// de 7 dias sem conclusão nem remarcação; marcado pela tarefa diária).
export const STATUS_AGENDAMENTO = ['agendado', 'concluido', 'cancelado', 'nao_compareceu'];

// Agendamento "ativo" = ainda conta como atendimento daquela prescrição.
export const STATUS_AGENDAMENTO_ATIVO = ['agendado', 'concluido'];

// Agendamentos encerrados sem entrega (a prescrição pode ser agendada de novo)
export const STATUS_AGENDAMENTO_SEM_ENTREGA = ['cancelado', 'nao_compareceu'];

// Protocolo de atendimento a partir do sol_id, ex: sol_id 42 -> "AG000042"
export const gerarProtocolo = (sol_id) => `AG${String(sol_id).padStart(6, '0')}`;

// Data (DATE do Postgres, que chega como Date ou texto) -> "YYYY-MM-DD"
export function isoData(valor) {
    if (!valor) return null;
    if (valor instanceof Date) return valor.toISOString().slice(0, 10);
    return String(valor).slice(0, 10);
}

// "YYYY-MM-DD" -> "DD/MM/YYYY"
export const dataBR = (valor) => {
    const iso = isoData(valor);
    return iso ? iso.split('-').reverse().join('/') : '';
};

// Soma dias a uma data "YYYY-MM-DD" (sem passar por fuso)
export function somarDias(iso, dias) {
    const [a, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
}

// Prescrição vencida = tem vencimento e ele é anterior a hoje (Brasília)
export const prescricaoVencida = (vencimento, hoje) => {
    const iso = isoData(vencimento);
    return Boolean(iso && iso < hoje);
};
