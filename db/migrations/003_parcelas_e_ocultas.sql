-- Parcelamentos, natureza do gasto (avulso/fixo/parcelado) e lancamentos ocultos.

-- A compra parcelada e´ o "pai": guarda o total e em quantas vezes foi dividido.
-- Cada parcela vira uma transacao normal, no mes em que cai -- e´ o que faz o
-- orcamento mensal ficar honesto (12x de 100 nao pode virar 1200 em julho).
CREATE TABLE parcelamentos (
  id             serial PRIMARY KEY,
  descricao      text NOT NULL CHECK (length(btrim(descricao)) > 0),
  valor_total    numeric(14,2) NOT NULL CHECK (valor_total > 0),
  total_parcelas integer NOT NULL CHECK (total_parcelas BETWEEN 2 AND 120),
  tipo           text NOT NULL CHECK (tipo IN ('receita','despesa')),
  categoria_id   integer,
  conta_id       integer REFERENCES contas(id) ON DELETE SET NULL,
  data_primeira  date NOT NULL,
  observacao     text,
  criado_em      timestamptz NOT NULL DEFAULT now(),
  atualizado_em  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT parcelamentos_categoria_fk FOREIGN KEY (categoria_id, tipo)
    REFERENCES categorias (id, tipo) ON UPDATE RESTRICT ON DELETE SET NULL (categoria_id)
);

ALTER TABLE transacoes
  -- CASCADE: apagar a compra apaga as parcelas dela. Sem isso sobrariam
  -- lancamentos orfaos de uma compra que o usuario acha que ja removeu.
  ADD COLUMN parcelamento_id integer REFERENCES parcelamentos(id) ON DELETE CASCADE,
  ADD COLUMN parcela_num     integer,
  -- Gasto escondido: continua no banco (nada e´ apagado), mas sai da lista e
  -- dos totais. Serve para o lancamento que voce nao quer contando na analise.
  ADD COLUMN oculta          boolean NOT NULL DEFAULT false;

ALTER TABLE transacoes
  -- parcelamento_id e parcela_num andam sempre juntos: ou ambos nulos, ou ambos preenchidos.
  ADD CONSTRAINT transacoes_parcela_ck CHECK (
    (parcelamento_id IS NULL AND parcela_num IS NULL)
    OR (parcelamento_id IS NOT NULL AND parcela_num >= 1)
  ),
  -- Nao existe "parcela 3 de 12" duas vezes na mesma compra.
  ADD CONSTRAINT transacoes_parcela_uk UNIQUE (parcelamento_id, parcela_num);

-- Os filtros da tela de Transacoes batem nestas colunas.
CREATE INDEX transacoes_parcelamento_idx ON transacoes (parcelamento_id);
CREATE INDEX transacoes_oculta_idx       ON transacoes (oculta) WHERE oculta;
