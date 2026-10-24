-- Insumed — migração de 25/10/2026 (etapa 1: cadastro da equipe por
-- convite, contas desativáveis e senha provisória).
-- Rodar no SQL Editor do Neon ANTES de publicar o backend novo.
-- Pode ser executada mais de uma vez sem erro.
-- Nenhum registro existente é apagado; as contas atuais continuam ativas.

BEGIN;

-- @pgmem-inicio (trecho também aplicado nos testes automáticos)

-- 1) Conta ativa/desativada e senha provisória (cadastro feito pelo admin
--    universal). Quem está desativado não entra e perde o acesso na hora.
ALTER TABLE administrador
    ADD COLUMN IF NOT EXISTS adm_ativo BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE administrador
    ADD COLUMN IF NOT EXISTS adm_senha_provisoria BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE autorizador
    ADD COLUMN IF NOT EXISTS aut_ativo BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE autorizador
    ADD COLUMN IF NOT EXISTS aut_senha_provisoria BOOLEAN NOT NULL DEFAULT FALSE;

-- 2) Convites para cadastro de administrador e autorizador. O código
--    só existe no link entregue ao funcionário; aqui fica o hash (SHA-256).
--    Uso único e validade de 7 dias.
CREATE TABLE IF NOT EXISTS convite_equipe (
    cnv_id            SERIAL PRIMARY KEY,
    cnv_perfil        TEXT NOT NULL,              -- ADMIN | AUTORIZADOR
    pos_id            INTEGER NULL REFERENCES postosdesaude (pos_id) ON DELETE CASCADE,
    cnv_codigo_hash   TEXT NOT NULL,
    cnv_expira_em     TIMESTAMPTZ NOT NULL,
    cnv_criado_por    INTEGER NULL,               -- adm_id de quem convidou
    cnv_criado_em     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cnv_usado_em      TIMESTAMPTZ NULL,
    cnv_usado_email   TEXT NULL,
    cnv_cancelado_em  TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_convite_equipe_codigo
    ON convite_equipe (cnv_codigo_hash);

-- 3) Estoque reservado: soma dos itens das coletas agendadas por insumo
CREATE INDEX IF NOT EXISTS ix_coleta_insumo
    ON coleta (ins_id, sol_id);

-- @pgmem-fim

COMMIT;

-- Conferência (opcional):
-- SELECT adm_email, adm_ativo, adm_senha_provisoria FROM administrador;
-- SELECT aut_email, aut_ativo, aut_senha_provisoria FROM autorizador;
-- SELECT COUNT(*) FROM convite_equipe;   -- 0
