-- Insumed — migração de 13/10/2026
-- Rodar no SQL Editor do Neon ANTES de publicar o backend novo.
-- Pode ser executada mais de uma vez sem erro (IF NOT EXISTS).
-- Só ADICIONA colunas/índice; nenhum registro existente é alterado ou apagado.

BEGIN;

-- 1) Motivo do cancelamento de agendamentos (preenchido pelo administrador)
ALTER TABLE solicitacao
    ADD COLUMN IF NOT EXISTS sol_motivo_cancelamento TEXT NULL;

-- Quando e por qual administrador o agendamento foi cancelado
ALTER TABLE solicitacao
    ADD COLUMN IF NOT EXISTS sol_data_cancelamento TIMESTAMPTZ NULL;

ALTER TABLE solicitacao
    ADD COLUMN IF NOT EXISTS sol_cancelado_por INTEGER NULL;

-- 2) Vínculo do agendamento com a prescrição autorizada que o originou
--    (agendamentos antigos ficam com NULL)
ALTER TABLE solicitacao
    ADD COLUMN IF NOT EXISTS sol_origem_id INTEGER NULL
    REFERENCES solicitacao (sol_id) ON DELETE SET NULL;

-- Impede, no próprio banco, dois agendamentos ativos (agendado ou concluído)
-- para a mesma prescrição autorizada, mesmo com cliques/requisições simultâneos.
-- Agendamentos cancelados não contam, então a prescrição pode ser reagendada.
CREATE UNIQUE INDEX IF NOT EXISTS ux_solicitacao_origem_ativa
    ON solicitacao (sol_origem_id)
    WHERE sol_origem_id IS NOT NULL
      AND sol_status IN ('agendado', 'concluido');

COMMIT;

-- Conferência (opcional): deve listar as 4 colunas novas
-- SELECT column_name, data_type
--   FROM information_schema.columns
--  WHERE table_name = 'solicitacao'
--    AND column_name IN ('sol_motivo_cancelamento', 'sol_data_cancelamento',
--                        'sol_cancelado_por', 'sol_origem_id');
