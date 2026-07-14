-- =====================================================================
--  2FA (TOTP) + alertas de login.
-- =====================================================================
--
-- Segurança avançada para o app exposto no Funnel: um segundo fator (código do
-- app autenticador) e o registro dos acessos para "seu último login foi em...".

-- Segredo TOTP por usuário. `totp_ativo` só vira true DEPOIS que a pessoa confirma
-- o primeiro código — assim um segredo gerado e nunca confirmado não tranca o login.
ALTER TABLE usuarios
  ADD COLUMN totp_segredo text,
  ADD COLUMN totp_ativo   boolean NOT NULL DEFAULT false;

-- Códigos de recuperação (para quem perde o celular): guardados como HASH scrypt,
-- um por linha, marcados quando usados (cada um serve UMA vez).
CREATE TABLE totp_recuperacao (
  id          serial PRIMARY KEY,
  usuario_id  integer NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  codigo_hash text NOT NULL,
  usado_em    timestamptz,
  criado_em   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX totp_recuperacao_usuario_idx ON totp_recuperacao (usuario_id);

-- Histórico de logins bem-sucedidos: alimenta "último acesso", a detecção de IP
-- novo e a lista de atividade recente.
CREATE TABLE login_eventos (
  id         serial PRIMARY KEY,
  usuario_id integer NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  ip         text,
  criado_em  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_eventos_usuario_idx ON login_eventos (usuario_id, criado_em DESC);
