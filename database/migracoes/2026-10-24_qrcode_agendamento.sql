-- Insumed — migração de 24/10/2026 (leitor de QR Code do comprovante).
-- Rodar no SQL Editor do Neon ANTES de publicar o backend novo.
-- Pode ser executada mais de uma vez sem erro.
-- Só cria uma coluna e preenche o código dos agendamentos que já existem.

BEGIN;

-- @pgmem-inicio (trecho também aplicado nos testes automáticos)

-- Código secreto e aleatório de cada agendamento. O QR Code do comprovante
-- passa a ser "INSUMED:AG000042:<código>": o protocolo é sequencial e fácil
-- de adivinhar, o código não (UUID v4, 122 bits aleatórios).
ALTER TABLE solicitacao
    ADD COLUMN IF NOT EXISTS sol_codigo_qr UUID NULL;

-- agendamentos já criados (inclusive comprovantes já salvos pelos pacientes;
-- os QR antigos, só com o protocolo, continuam sendo aceitos pelo leitor)
UPDATE solicitacao
   SET sol_codigo_qr = gen_random_uuid()
 WHERE sol_codigo_qr IS NULL
   AND sol_status IN ('agendado', 'concluido', 'cancelado', 'nao_compareceu');

CREATE UNIQUE INDEX IF NOT EXISTS ux_solicitacao_codigo_qr
    ON solicitacao (sol_codigo_qr);

-- @pgmem-fim

-- novos agendamentos já nascem com o código (o backend também o envia)
ALTER TABLE solicitacao
    ALTER COLUMN sol_codigo_qr SET DEFAULT gen_random_uuid();

COMMIT;
