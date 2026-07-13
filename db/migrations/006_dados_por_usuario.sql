-- Cada cadastro possui o seu proprio espaco de dados.
-- A coluna fica nullable durante a migracao para permitir que o servidor
-- atribua os dados antigos ao usuario legado configurado no .env.

ALTER TABLE contas         ADD COLUMN usuario_id integer REFERENCES usuarios(id) ON DELETE CASCADE;
ALTER TABLE categorias     ADD COLUMN usuario_id integer REFERENCES usuarios(id) ON DELETE CASCADE;
ALTER TABLE recorrentes    ADD COLUMN usuario_id integer REFERENCES usuarios(id) ON DELETE CASCADE;
ALTER TABLE transacoes     ADD COLUMN usuario_id integer REFERENCES usuarios(id) ON DELETE CASCADE;
ALTER TABLE orcamentos     ADD COLUMN usuario_id integer REFERENCES usuarios(id) ON DELETE CASCADE;
ALTER TABLE metas          ADD COLUMN usuario_id integer REFERENCES usuarios(id) ON DELETE CASCADE;
ALTER TABLE parcelamentos  ADD COLUMN usuario_id integer REFERENCES usuarios(id) ON DELETE CASCADE;

ALTER TABLE contas     DROP CONSTRAINT IF EXISTS contas_nome_uk;
ALTER TABLE categorias DROP CONSTRAINT IF EXISTS categorias_nome_tipo_uk;
ALTER TABLE orcamentos DROP CONSTRAINT IF EXISTS orcamentos_categoria_uk;
ALTER TABLE metas      DROP CONSTRAINT IF EXISTS metas_nome_uk;

ALTER TABLE contas
  ADD CONSTRAINT contas_usuario_nome_uk UNIQUE (usuario_id, nome);
ALTER TABLE categorias
  ADD CONSTRAINT categorias_usuario_nome_tipo_uk UNIQUE (usuario_id, nome, tipo);
ALTER TABLE orcamentos
  ADD CONSTRAINT orcamentos_usuario_categoria_uk UNIQUE (usuario_id, categoria_id);
ALTER TABLE metas
  ADD CONSTRAINT metas_usuario_nome_uk UNIQUE (usuario_id, nome);

CREATE INDEX contas_usuario_idx        ON contas (usuario_id);
CREATE INDEX categorias_usuario_idx    ON categorias (usuario_id);
CREATE INDEX recorrentes_usuario_idx   ON recorrentes (usuario_id);
CREATE INDEX transacoes_usuario_idx    ON transacoes (usuario_id);
CREATE INDEX orcamentos_usuario_idx    ON orcamentos (usuario_id);
CREATE INDEX metas_usuario_idx         ON metas (usuario_id);
CREATE INDEX parcelamentos_usuario_idx ON parcelamentos (usuario_id);

DROP VIEW vw_saldo_contas;
CREATE VIEW vw_saldo_contas AS
SELECT
  c.usuario_id,
  c.id,
  c.nome,
  c.tipo,
  c.cor,
  c.arquivada,
  c.saldo_inicial,
  COALESCE(SUM(t.valor) FILTER (WHERE t.tipo = 'receita'), 0) AS receitas,
  COALESCE(SUM(t.valor) FILTER (WHERE t.tipo = 'despesa'), 0) AS despesas,
  c.saldo_inicial
    + COALESCE(SUM(t.valor) FILTER (WHERE t.tipo = 'receita'), 0)
    - COALESCE(SUM(t.valor) FILTER (WHERE t.tipo = 'despesa'), 0) AS saldo
FROM contas c
LEFT JOIN transacoes t
  ON t.conta_id = c.id
 AND t.usuario_id = c.usuario_id
 AND NOT t.oculta
GROUP BY c.usuario_id, c.id;
