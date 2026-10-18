-- Insumed — migração de 18/10/2026 (notificações no sino, id do
-- administrador, remarcação de agendamento e "refazer pedido").
-- Rodar no SQL Editor do Neon ANTES de publicar o backend novo.
-- Pode ser executada mais de uma vez sem erro.
-- Nenhum registro existente é apagado ou alterado (só colunas/tabelas novas).

BEGIN;

-- 1) Identificador fixo do administrador. Até agora o admin era reconhecido
--    só pelo e-mail, que pode mudar no perfil; as notificações precisam de
--    um número que não muda. SERIAL preenche os administradores já cadastrados.
ALTER TABLE administrador
    ADD COLUMN IF NOT EXISTS adm_id SERIAL;

-- @pgmem-inicio (trecho também aplicado nos testes automáticos)

CREATE UNIQUE INDEX IF NOT EXISTS ux_administrador_id
    ON administrador (adm_id);

-- 2) Remarcação do agendamento (mesma linha, nova data): a data anterior
--    fica guardada para o aviso "remarcado" no cartão do paciente.
ALTER TABLE solicitacao
    ADD COLUMN IF NOT EXISTS sol_data_anterior DATE NULL;

-- 3) Observação da unidade ao refazer um pedido não autorizado
--    (aparece para o autorizador na nova análise).
ALTER TABLE solicitacao
    ADD COLUMN IF NOT EXISTS sol_observacao_equipe TEXT NULL;

-- 4) Notificações entregues a cada pessoa (paciente, admin, autorizador).
--    not_dest_tipo + not_dest_id dizem de quem é; not_chave impede
--    duplicatas (repetir uma requisição ou reprocessar um evento não cria
--    outra notificação). not_lida_em NULL = não lida.
CREATE TABLE IF NOT EXISTS notificacao (
    not_id             SERIAL PRIMARY KEY,
    not_dest_tipo      TEXT NOT NULL,
    not_dest_id        INTEGER NOT NULL,
    not_evento         TEXT NOT NULL,
    not_tom            TEXT NOT NULL DEFAULT 'info',
    not_titulo         TEXT NOT NULL,
    not_mensagem       TEXT NOT NULL,
    not_prioridade     INTEGER NOT NULL DEFAULT 2,
    not_link           TEXT NULL,
    sol_id             INTEGER NULL REFERENCES solicitacao (sol_id) ON DELETE CASCADE,
    his_id             INTEGER NULL,
    not_chave          TEXT NOT NULL,
    not_criada_em      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    not_atualizada_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    not_lida_em        TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_notificacao_chave
    ON notificacao (not_dest_tipo, not_dest_id, not_chave);

CREATE INDEX IF NOT EXISTS ix_notificacao_dest_data
    ON notificacao (not_dest_tipo, not_dest_id, not_atualizada_em);

-- 5) Controle do processamento: cada linha do histórico vira notificação
--    uma única vez. Falhas ficam registradas aqui para nova tentativa.
CREATE TABLE IF NOT EXISTS notificacao_evento (
    his_id         INTEGER PRIMARY KEY,
    nev_token      TEXT NOT NULL,
    nev_status     TEXT NOT NULL DEFAULT 'processando',   -- processando | ok | erro
    nev_tentativas INTEGER NOT NULL DEFAULT 1,
    nev_erro       TEXT NULL,
    nev_atualizado TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_notificacao_evento_status
    ON notificacao_evento (nev_status);

-- @pgmem-fim

-- Contagem rápida das não lidas (índice parcial: só no Postgres/Neon)
CREATE INDEX IF NOT EXISTS ix_notificacao_nao_lidas
    ON notificacao (not_dest_tipo, not_dest_id) WHERE not_lida_em IS NULL;

-- O histórico que já existe NÃO gera notificações (só o que acontecer
-- depois da publicação).
INSERT INTO notificacao_evento (his_id, nev_token, nev_status)
SELECT his_id, 'migracao', 'ok' FROM historico_solicitacao
ON CONFLICT (his_id) DO NOTHING;

COMMIT;

-- Conferência (opcional):
-- SELECT adm_id, adm_email FROM administrador ORDER BY adm_id;   -- todos com número
-- SELECT COUNT(*) FROM notificacao;                             -- 0
-- SELECT COUNT(*) FROM notificacao_evento;                      -- = linhas do histórico
