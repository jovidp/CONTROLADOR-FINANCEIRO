-- =====================================================================
--  Controlador Financeiro - schema inicial
-- =====================================================================

CREATE TABLE contas (
  id            serial PRIMARY KEY,
  nome          text NOT NULL,
  tipo          text NOT NULL DEFAULT 'corrente'
                  CHECK (tipo IN ('corrente','poupanca','carteira','credito','investimento')),
  saldo_inicial numeric(14,2) NOT NULL DEFAULT 0,
  cor           text NOT NULL DEFAULT '#64748b',
  arquivada     boolean NOT NULL DEFAULT false,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contas_nome_uk UNIQUE (nome)
);

CREATE TABLE categorias (
  id            serial PRIMARY KEY,
  nome          text NOT NULL,
  tipo          text NOT NULL CHECK (tipo IN ('receita','despesa')),
  cor           text NOT NULL DEFAULT '#64748b',
  icone         text NOT NULL DEFAULT '📦',
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT categorias_nome_tipo_uk UNIQUE (nome, tipo),
  -- alvo da chave estrangeira composta usada por transacoes/orcamentos/recorrentes:
  -- garante, no banco, que uma despesa so pode apontar para categoria de despesa.
  CONSTRAINT categorias_id_tipo_uk UNIQUE (id, tipo)
);

CREATE TABLE recorrentes (
  id             serial PRIMARY KEY,
  descricao      text NOT NULL,
  valor          numeric(14,2) NOT NULL CHECK (valor > 0),
  tipo           text NOT NULL CHECK (tipo IN ('receita','despesa')),
  categoria_id   integer,
  conta_id       integer REFERENCES contas(id) ON DELETE SET NULL,
  frequencia     text NOT NULL CHECK (frequencia IN ('diaria','semanal','mensal','anual')),
  proxima_data   date NOT NULL,
  data_fim       date,
  ativa          boolean NOT NULL DEFAULT true,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  atualizado_em  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recorrentes_categoria_fk FOREIGN KEY (categoria_id, tipo)
    REFERENCES categorias (id, tipo) ON UPDATE RESTRICT ON DELETE SET NULL (categoria_id),
  CONSTRAINT recorrentes_periodo_ck CHECK (data_fim IS NULL OR data_fim >= proxima_data)
);

CREATE TABLE transacoes (
  id            serial PRIMARY KEY,
  descricao     text NOT NULL CHECK (length(btrim(descricao)) > 0),
  valor         numeric(14,2) NOT NULL CHECK (valor > 0),
  tipo          text NOT NULL CHECK (tipo IN ('receita','despesa')),
  data          date NOT NULL,
  categoria_id  integer,
  conta_id      integer REFERENCES contas(id) ON DELETE SET NULL,
  recorrente_id integer REFERENCES recorrentes(id) ON DELETE SET NULL,
  observacao    text,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transacoes_categoria_fk FOREIGN KEY (categoria_id, tipo)
    REFERENCES categorias (id, tipo) ON UPDATE RESTRICT ON DELETE SET NULL (categoria_id)
);

CREATE INDEX transacoes_data_idx      ON transacoes (data DESC);
CREATE INDEX transacoes_tipo_data_idx ON transacoes (tipo, data DESC);
CREATE INDEX transacoes_categoria_idx ON transacoes (categoria_id);
CREATE INDEX transacoes_conta_idx     ON transacoes (conta_id);
CREATE INDEX transacoes_descricao_idx ON transacoes (lower(descricao));
-- Consultas por mes usam intervalo (data >= inicio AND data <= fim), coberto
-- por transacoes_data_idx. Um indice em date_trunc('month', data) nao e possivel:
-- sobre `date` a funcao resolve para a variante com timezone, que nao e IMMUTABLE.

-- Teto de gastos mensal por categoria de despesa.
CREATE TABLE orcamentos (
  id            serial PRIMARY KEY,
  categoria_id  integer NOT NULL,
  tipo          text NOT NULL DEFAULT 'despesa' CHECK (tipo = 'despesa'),
  limite        numeric(14,2) NOT NULL CHECK (limite > 0),
  ativo         boolean NOT NULL DEFAULT true,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT orcamentos_categoria_uk UNIQUE (categoria_id),
  CONSTRAINT orcamentos_categoria_fk FOREIGN KEY (categoria_id, tipo)
    REFERENCES categorias (id, tipo) ON UPDATE RESTRICT ON DELETE CASCADE
);

CREATE TABLE metas (
  id            serial PRIMARY KEY,
  nome          text NOT NULL,
  valor_alvo    numeric(14,2) NOT NULL CHECK (valor_alvo > 0),
  prazo         date,
  cor           text NOT NULL DEFAULT '#6366f1',
  icone         text NOT NULL DEFAULT '🏆',
  concluida     boolean NOT NULL DEFAULT false,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT metas_nome_uk UNIQUE (nome)
);

CREATE TABLE meta_aportes (
  id         serial PRIMARY KEY,
  meta_id    integer NOT NULL REFERENCES metas(id) ON DELETE CASCADE,
  valor      numeric(14,2) NOT NULL CHECK (valor <> 0),
  data       date NOT NULL DEFAULT CURRENT_DATE,
  observacao text,
  criado_em  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX meta_aportes_meta_idx ON meta_aportes (meta_id);

-- ---------------------------------------------------------------------
-- atualizado_em automatico
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_atualizado_em() RETURNS trigger AS $$
BEGIN
  NEW.atualizado_em := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER contas_touch      BEFORE UPDATE ON contas      FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();
CREATE TRIGGER categorias_touch  BEFORE UPDATE ON categorias  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();
CREATE TRIGGER transacoes_touch  BEFORE UPDATE ON transacoes  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();
CREATE TRIGGER orcamentos_touch  BEFORE UPDATE ON orcamentos  FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();
CREATE TRIGGER metas_touch       BEFORE UPDATE ON metas       FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();
CREATE TRIGGER recorrentes_touch BEFORE UPDATE ON recorrentes FOR EACH ROW EXECUTE FUNCTION set_atualizado_em();

-- ---------------------------------------------------------------------
-- Saldo consolidado por conta (saldo_inicial + receitas - despesas)
-- ---------------------------------------------------------------------
CREATE VIEW vw_saldo_contas AS
SELECT
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
LEFT JOIN transacoes t ON t.conta_id = c.id
GROUP BY c.id;
