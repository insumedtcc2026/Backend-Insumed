-- Insumed — migração de 26/10/2026 (etapa 2: prescrição com vários
-- insumos e retirada recorrente para uso contínuo).
-- Rodar no SQL Editor do Neon ANTES de publicar o backend novo.
-- Pode ser executada mais de uma vez sem erro.
-- Nada é apagado: as colunas antigas (solicitacao.ins_id e
-- sol_insumo_quant) continuam com o primeiro item de cada prescrição.

BEGIN;

-- @pgmem-inicio (trecho também aplicado nos testes automáticos)

-- 1) Itens da prescrição (quantidade por retirada)
CREATE TABLE IF NOT EXISTS solicitacao_item (
    sit_id          SERIAL PRIMARY KEY,
    sol_id          INTEGER NOT NULL REFERENCES solicitacao (sol_id) ON DELETE CASCADE,
    ins_id          INTEGER NOT NULL REFERENCES insumo (ins_id),
    sit_quantidade  INTEGER NOT NULL CHECK (sit_quantidade > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_solicitacao_item
    ON solicitacao_item (sol_id, ins_id);

-- 2) Retirada recorrente: frequência na prescrição (vazio = retirada
--    única) e número do ciclo em cada agendamento (1 = primeira retirada)
ALTER TABLE solicitacao
    ADD COLUMN IF NOT EXISTS sol_periodicidade_dias INTEGER NULL;
ALTER TABLE solicitacao
    ADD COLUMN IF NOT EXISTS sol_ciclo INTEGER NOT NULL DEFAULT 1;

-- @pgmem-fim

-- 3) Prescrições já revisadas: o insumo antigo vira o primeiro item
INSERT INTO solicitacao_item (sol_id, ins_id, sit_quantidade)
SELECT sol.sol_id, sol.ins_id, sol.sol_insumo_quant
  FROM solicitacao sol
  JOIN insumo ins ON ins.ins_id = sol.ins_id
 WHERE sol.sol_origem_id IS NULL
   AND sol.sol_insumo_quant > 0
   AND sol.sol_status IN ('Revisado', 'Aprovado', 'Autorizado', 'Nao Autorizado')
ON CONFLICT (sol_id, ins_id) DO NOTHING;

-- 4) Um agendamento por ciclo. Antes era um por prescrição; com a
--    retirada recorrente, cada ciclo tem o seu (o 2º só depois do 1º).
--    Continua valendo: só um agendamento "agendado" por prescrição.
DROP INDEX IF EXISTS ux_solicitacao_origem_ativa;

CREATE UNIQUE INDEX IF NOT EXISTS ux_solicitacao_origem_ciclo
    ON solicitacao (sol_origem_id, sol_ciclo)
    WHERE sol_origem_id IS NOT NULL
      AND sol_status IN ('agendado', 'concluido');

CREATE UNIQUE INDEX IF NOT EXISTS ux_solicitacao_origem_agendada
    ON solicitacao (sol_origem_id)
    WHERE sol_origem_id IS NOT NULL
      AND sol_status = 'agendado';

COMMIT;

-- Conferência (opcional):
-- SELECT COUNT(*) FROM solicitacao_item;
-- SELECT indexname FROM pg_indexes WHERE indexname LIKE 'ux_solicitacao_origem%';
