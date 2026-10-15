-- Insumed — migração de 15/10/2026 (reenvio na mesma solicitação, cadastro
-- com gênero/raça opcionais, matrícula única e índices para listas longas).
-- Rodar no SQL Editor do Neon ANTES de publicar o backend novo.
-- Pode ser executada mais de uma vez sem erro.
-- Nenhum registro existente é apagado; só restrições e tamanhos são ajustados.

BEGIN;

-- 1) Gênero e cor/raça opcionais no cadastro do paciente.
--    Remove restrições CHECK antigas dessas colunas (se existirem), aceita
--    NULL e garante espaço para "Prefiro não responder". Os valores aceitos
--    passam a ser conferidos pelo backend (mesma lista do formulário).
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
     WHERE rel.relname = 'pacientes'
       AND con.contype = 'c'
       AND (pg_get_constraintdef(con.oid) ILIKE '%pac_sexo%'
         OR pg_get_constraintdef(con.oid) ILIKE '%pac_raca%')
  LOOP
    EXECUTE format('ALTER TABLE pacientes DROP CONSTRAINT %I', r.conname);
  END LOOP;

  -- gênero guarda uma letra (M, F, O, N); só muda o tipo se for ENUM.
  -- cor/raça do tipo ENUM ou curta demais vira VARCHAR(30) (valores mantidos)
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'pacientes' AND column_name = 'pac_sexo'
                AND data_type = 'USER-DEFINED') THEN
    ALTER TABLE pacientes ALTER COLUMN pac_sexo TYPE VARCHAR(30) USING pac_sexo::text;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'pacientes' AND column_name = 'pac_raca'
                AND (data_type = 'USER-DEFINED' OR COALESCE(character_maximum_length, 30) < 30)) THEN
    ALTER TABLE pacientes ALTER COLUMN pac_raca TYPE VARCHAR(30) USING pac_raca::text;
  END IF;
END $$;

ALTER TABLE pacientes ALTER COLUMN pac_sexo DROP NOT NULL;
ALTER TABLE pacientes ALTER COLUMN pac_raca DROP NOT NULL;

-- 2) Matrícula do administrador única (ignorando maiúsculas, espaços e
--    pontuação). Se já houver matrículas repetidas no banco, o índice NÃO é
--    criado e aparece um aviso (NOTICE) — o backend continua bloqueando
--    novas repetições mesmo assim. Para ver as repetidas, use a consulta
--    do final do arquivo.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM administrador
     WHERE adm_matricula IS NOT NULL
     GROUP BY UPPER(regexp_replace(adm_matricula, '[^A-Za-z0-9]', '', 'g'))
    HAVING COUNT(*) > 1
  ) THEN
    RAISE NOTICE 'Há matrículas repetidas em administrador; índice único não criado.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS ux_administrador_matricula
        ON administrador (UPPER(regexp_replace(adm_matricula, '[^A-Za-z0-9]', '', 'g')));
  END IF;
END $$;

-- @pgmem-inicio (trecho também aplicado nos testes automáticos)

-- 3) Versões anteriores da prescrição. Quando a unidade pede reenvio e o
--    paciente corrige, a solicitação continua a MESMA (mesmo sol_id e
--    histórico); o arquivo antigo é guardado aqui antes de ser substituído.
CREATE TABLE IF NOT EXISTS prescricao_versao (
    ver_id               SERIAL PRIMARY KEY,
    sol_id               INTEGER NOT NULL REFERENCES solicitacao (sol_id) ON DELETE CASCADE,
    ver_numero           INTEGER NOT NULL,
    ver_prescricao       BYTEA NULL,
    ver_prescricao_tipo  TEXT NULL,
    ver_observacao       TEXT NULL,
    ver_motivo_reenvio   TEXT NULL,
    ver_enviada_em       TIMESTAMPTZ NULL,
    ver_substituida_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_prescricao_versao_sol
    ON prescricao_versao (sol_id, ver_numero);

-- 4) Índices para as listas paginadas (por paciente, por posto e status)
CREATE INDEX IF NOT EXISTS ix_solicitacao_paciente
    ON solicitacao (pac_id, sol_data_solicitacao);

CREATE INDEX IF NOT EXISTS ix_solicitacao_posto_status
    ON solicitacao (pos_id, sol_status);

CREATE INDEX IF NOT EXISTS ix_historico_solicitacao_data
    ON historico_solicitacao (his_criado_em);

-- @pgmem-fim

COMMIT;

-- Conferência (opcional):
-- SELECT column_name, data_type, character_maximum_length, is_nullable
--   FROM information_schema.columns
--  WHERE table_name = 'pacientes' AND column_name IN ('pac_sexo', 'pac_raca');
-- SELECT COUNT(*) FROM prescricao_versao;              -- 0 (tabela criada)
-- SELECT indexname FROM pg_indexes WHERE indexname = 'ux_administrador_matricula';
-- Matrículas repetidas (se o índice não foi criado):
-- SELECT UPPER(regexp_replace(adm_matricula, '[^A-Za-z0-9]', '', 'g')) AS matricula, COUNT(*)
--   FROM administrador GROUP BY 1 HAVING COUNT(*) > 1;
