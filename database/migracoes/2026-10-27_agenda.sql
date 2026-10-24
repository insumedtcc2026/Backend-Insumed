-- Insumed — migração de 27/10/2026 (etapa 3: agenda com turnos e vagas,
-- pedido de outra data, confirmação de presença e prioridade legal).
-- Rodar no SQL Editor do Neon ANTES de publicar o backend novo.
-- Pode ser executada mais de uma vez sem erro. Nada é apagado.

BEGIN;

-- @pgmem-inicio (trecho também aplicado nos testes automáticos)

-- 1) Horário de funcionamento por dia da semana (0 = domingo ... 6 = sábado)
--    e turno. Vagas vazias = sem limite. Unidade sem nenhuma linha usa o
--    padrão: segunda a sexta, manhã e tarde, sem limite.
CREATE TABLE IF NOT EXISTS posto_horario (
    phr_id          SERIAL PRIMARY KEY,
    pos_id          INTEGER NOT NULL REFERENCES postosdesaude (pos_id) ON DELETE CASCADE,
    phr_dia_semana  INTEGER NOT NULL CHECK (phr_dia_semana BETWEEN 0 AND 6),
    phr_turno       TEXT NOT NULL CHECK (phr_turno IN ('manha', 'tarde')),
    phr_abre        TEXT NOT NULL,               -- "08:00"
    phr_fecha       TEXT NOT NULL,               -- "12:00"
    phr_vagas       INTEGER NULL CHECK (phr_vagas IS NULL OR phr_vagas > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_posto_horario
    ON posto_horario (pos_id, phr_dia_semana, phr_turno);

-- 2) Dias em que a unidade não atende (feriado, reforma, campanha...)
CREATE TABLE IF NOT EXISTS posto_bloqueio (
    pbl_id      SERIAL PRIMARY KEY,
    pos_id      INTEGER NOT NULL REFERENCES postosdesaude (pos_id) ON DELETE CASCADE,
    pbl_data    DATE NOT NULL,
    pbl_motivo  TEXT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_posto_bloqueio
    ON posto_bloqueio (pos_id, pbl_data);

-- 3) Turno do agendamento (manha | tarde). Antigos ficam vazios.
ALTER TABLE solicitacao
    ADD COLUMN IF NOT EXISTS sol_turno TEXT NULL;

-- 4) Pedido de outra data feito pelo paciente
ALTER TABLE solicitacao
    ADD COLUMN IF NOT EXISTS sol_pedido_data DATE NULL;
ALTER TABLE solicitacao
    ADD COLUMN IF NOT EXISTS sol_pedido_turno TEXT NULL;
ALTER TABLE solicitacao
    ADD COLUMN IF NOT EXISTS sol_pedido_motivo TEXT NULL;
ALTER TABLE solicitacao
    ADD COLUMN IF NOT EXISTS sol_pedido_situacao TEXT NULL;      -- pedido | aceito | recusado
ALTER TABLE solicitacao
    ADD COLUMN IF NOT EXISTS sol_pedido_resposta TEXT NULL;      -- motivo da recusa
ALTER TABLE solicitacao
    ADD COLUMN IF NOT EXISTS sol_pedido_em TIMESTAMPTZ NULL;

-- 5) Confirmação de presença (vou | nao_vou; vazio = sem resposta)
ALTER TABLE solicitacao
    ADD COLUMN IF NOT EXISTS sol_presenca TEXT NULL;
ALTER TABLE solicitacao
    ADD COLUMN IF NOT EXISTS sol_presenca_em TIMESTAMPTZ NULL;

-- 6) Prioridade legal: o paciente declara deficiência ou gestação e a
--    unidade confere (NULL = ainda não conferido). A idade vem da data de
--    nascimento e não precisa de conferência.
ALTER TABLE pacientes
    ADD COLUMN IF NOT EXISTS pac_pcd BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pacientes
    ADD COLUMN IF NOT EXISTS pac_gestante BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE pacientes
    ADD COLUMN IF NOT EXISTS pac_prioridade_conferida BOOLEAN NULL;

-- @pgmem-fim

CREATE INDEX IF NOT EXISTS ix_solicitacao_posto_data_turno
    ON solicitacao (pos_id, sol_data_de_coleta, sol_turno)
    WHERE sol_status = 'agendado';

COMMIT;

-- Conferência (opcional):
-- SELECT * FROM posto_horario ORDER BY pos_id, phr_dia_semana, phr_turno;
