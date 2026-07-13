-- =====================================================================
--  Tipos de conta viram DADO do usuario, e nao um CHECK no schema.
--  Assim da´ para criar "Vale-alimentacao", "Cripto", "Cofre da vovo".
-- =====================================================================
--
-- contas.tipo continua guardando a CHAVE (texto), e nao um id: tudo que ja´ le
-- conta.tipo (a view de saldos, os cartoes da tela de configuracoes, o form)
-- segue funcionando sem tradução. Quem passa a garantir a integridade e´ a FK
-- composta (usuario_id, tipo) -> tipos_conta (usuario_id, chave), no lugar do
-- CHECK com a lista fixa.
--
-- Renomear um tipo mexe so´ no rotulo; a chave nunca muda -- por isso nenhuma
-- conta precisa ser reescrita quando voce troca "Carteira" por "Dinheiro vivo".

CREATE TABLE tipos_conta (
  id         serial PRIMARY KEY,
  usuario_id integer NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  chave      text NOT NULL CHECK (chave ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  rotulo     text NOT NULL CHECK (length(btrim(rotulo)) > 0),
  icone      text NOT NULL DEFAULT '🏦',
  criado_em  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tipos_conta_usuario_chave_uk  UNIQUE (usuario_id, chave),
  CONSTRAINT tipos_conta_usuario_rotulo_uk UNIQUE (usuario_id, rotulo)
);

CREATE INDEX tipos_conta_usuario_idx ON tipos_conta (usuario_id);

-- Todo usuario que ja´ existe comeca com os cinco tipos que viviam no CHECK
-- (mesmas chaves, mesmos rotulos e icones que o frontend ja´ desenhava).
INSERT INTO tipos_conta (usuario_id, chave, rotulo, icone)
SELECT u.id, t.chave, t.rotulo, t.icone
  FROM usuarios u
  CROSS JOIN (VALUES
    ('corrente',     'Conta corrente',    '🏦'),
    ('poupanca',     'Poupança',          '🐖'),
    ('carteira',     'Carteira',          '👛'),
    ('credito',      'Cartão de crédito', '💳'),
    ('investimento', 'Investimento',      '📈')
  ) AS t(chave, rotulo, icone)
 ON CONFLICT (usuario_id, chave) DO NOTHING;

ALTER TABLE contas DROP CONSTRAINT IF EXISTS contas_tipo_check;

-- A 006 ja´ atribuiu toda conta a um usuario. Se alguma tivesse usuario_id NULL,
-- a FK composta (MATCH SIMPLE) simplesmente nao a checaria -- nao quebra nada.
ALTER TABLE contas
  ADD CONSTRAINT contas_tipo_fk FOREIGN KEY (usuario_id, tipo)
    REFERENCES tipos_conta (usuario_id, chave)
    ON UPDATE CASCADE ON DELETE RESTRICT;
