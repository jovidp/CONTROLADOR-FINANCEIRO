-- Cadastro do primeiro usuario do aplicativo.
-- O controlador continua sendo de usuario unico.
CREATE TABLE usuarios (
  id         serial PRIMARY KEY,
  usuario    text NOT NULL UNIQUE CHECK (char_length(usuario) BETWEEN 3 AND 60),
  senha_hash text NOT NULL,
  criado_em  timestamptz NOT NULL DEFAULT now()
);
