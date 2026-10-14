-- Insumed — migração de 13/10/2026 (cancelamento com motivo, vínculo do
-- agendamento com a prescrição, recado, WhatsApp do posto e histórico)
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

-- 3) Recado do administrador no agendamento (aparece para o paciente)
ALTER TABLE solicitacao
    ADD COLUMN IF NOT EXISTS sol_recado TEXT NULL;

-- 4) WhatsApp de cada posto (botão "Falar com a unidade").
--    Fica vazio; preencha depois, só dígitos com DDI+DDD, por exemplo:
--    UPDATE postosdesaude SET pos_whatsapp = '5524999999999' WHERE pos_id = 1;
ALTER TABLE postosdesaude
    ADD COLUMN IF NOT EXISTS pos_whatsapp TEXT NULL;

-- 5) Histórico: quem fez o quê em cada prescrição/agendamento
--    (envio, revisão, autorização, agendamento, coleta, cancelamento,
--    transferência de unidade, recado). O nome é guardado no momento da
--    ação, para continuar correto mesmo se o cadastro mudar depois.
CREATE TABLE IF NOT EXISTS historico_solicitacao (
    his_id               SERIAL PRIMARY KEY,
    sol_id               INTEGER NOT NULL REFERENCES solicitacao (sol_id) ON DELETE CASCADE,
    his_acao             TEXT NOT NULL,
    his_status_anterior  TEXT NULL,
    his_status_novo      TEXT NULL,
    his_detalhe          TEXT NULL,
    his_usuario_tipo     TEXT NULL,
    his_usuario_id       INTEGER NULL,
    his_usuario_nome     TEXT NULL,
    his_criado_em        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_historico_solicitacao_sol
    ON historico_solicitacao (sol_id, his_criado_em);

COMMIT;

-- Conferência (opcional):
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'solicitacao'
--    AND column_name IN ('sol_motivo_cancelamento', 'sol_data_cancelamento',
--                        'sol_cancelado_por', 'sol_origem_id', 'sol_recado');
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'postosdesaude' AND column_name = 'pos_whatsapp';
-- SELECT COUNT(*) FROM historico_solicitacao;
