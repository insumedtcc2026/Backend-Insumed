-- Insumed — migração de 28/10/2026 (etapa 4: pessoas autorizadas a retirar
-- e registro de quem retirou a coleta).
-- Rodar no SQL Editor do Neon ANTES de publicar o backend novo.
-- Pode ser executada mais de uma vez sem erro. Nada é apagado.

BEGIN;

-- @pgmem-inicio (trecho também aplicado nos testes automáticos)

-- 1) Pessoas que podem retirar os insumos no lugar do paciente
--    (familiar, cuidador). Cadastradas pela unidade, na ficha do paciente.
--    Remover só desativa (pau_ativo = false): o histórico de quem retirou
--    continua apontando para a pessoa.
CREATE TABLE IF NOT EXISTS paciente_autorizado (
    pau_id          SERIAL PRIMARY KEY,
    pac_id          INTEGER NOT NULL REFERENCES pacientes (pac_id) ON DELETE CASCADE,
    pau_nome        TEXT NOT NULL,
    pau_cpf         TEXT NOT NULL,                -- 000.000.000-00
    pau_parentesco  TEXT NULL,                    -- "filha", "cuidador"...
    pau_telefone    TEXT NULL,
    pau_ativo       BOOLEAN NOT NULL DEFAULT TRUE,
    pau_criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    pau_criado_por  TEXT NULL                     -- nome de quem cadastrou
);

CREATE INDEX IF NOT EXISTS ix_paciente_autorizado_pac
    ON paciente_autorizado (pac_id);

-- 2) Quem retirou a coleta (vazio = o próprio paciente ou coleta antiga)
ALTER TABLE solicitacao
    ADD COLUMN IF NOT EXISTS sol_retirado_por INTEGER NULL;   -- pau_id
ALTER TABLE solicitacao
    ADD COLUMN IF NOT EXISTS sol_retirado_por_nome TEXT NULL;

-- @pgmem-fim

-- a mesma pessoa (CPF) só uma vez entre os autorizados ativos do paciente
CREATE UNIQUE INDEX IF NOT EXISTS ux_paciente_autorizado_cpf_ativo
    ON paciente_autorizado (pac_id, pau_cpf)
    WHERE pau_ativo;

COMMIT;

-- Conferência (opcional):
-- SELECT * FROM paciente_autorizado ORDER BY pac_id, pau_id;
