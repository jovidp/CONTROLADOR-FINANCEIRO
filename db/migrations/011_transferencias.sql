-- =====================================================================
--  Transferencia entre contas.
--
--  Uma transferencia MOVE dinheiro entre duas contas suas. Ela nao e´ receita
--  (nao entrou dinheiro no seu patrimonio) nem despesa (nao saiu). Lancar como
--  despesa+receita inflaria os dois lados do mes com dinheiro que nunca existiu.
--
--  MODELAGEM: UMA linha, com conta_id (origem) + conta_destino_id (destino).
--
--  Por que uma linha, e nao duas pernas ligadas (partida dobrada):
--  todas as agregacoes de dinheiro do sistema -- KPIs do painel, evolucao,
--  relatorio por categoria, relatorio anual, resumo do periodo e o gasto do
--  orcamento -- filtram por `tipo = 'receita'` ou `tipo = 'despesa'`. Um tipo
--  NOVO fica de fora delas POR CONSTRUCAO, sem tocar em uma linha sequer.
--  Com duas pernas seria o contrario: cada uma dessas somas passaria a contar a
--  transferencia como receita/despesa fantasma, e a correcao dependeria de
--  lembrar de um `AND transferencia_id IS NULL` em cada lugar. Esquecer um so´
--  nao quebra nada visivelmente -- so´ mente sobre o seu dinheiro.
--
--  O preco dessa escolha e´ que a view de saldo, que ate´ aqui olhava so´ para
--  conta_id, agora precisa olhar para os dois lados. E´ o que ela faz abaixo.
-- =====================================================================

ALTER TABLE transacoes ADD COLUMN conta_destino_id integer;

-- RESTRICT (e nao SET NULL como em conta_id): zerar o destino de uma
-- transferencia faria o dinheiro sair da origem e nao chegar em lugar nenhum.
ALTER TABLE transacoes
  ADD CONSTRAINT transacoes_conta_destino_fk
  FOREIGN KEY (conta_destino_id) REFERENCES contas (id) ON DELETE RESTRICT;

CREATE INDEX transacoes_conta_destino_idx ON transacoes (conta_destino_id);

-- O CHECK antigo (001_init) e´ auto-nomeado pelo Postgres.
ALTER TABLE transacoes DROP CONSTRAINT transacoes_tipo_check;
ALTER TABLE transacoes
  ADD CONSTRAINT transacoes_tipo_check
  CHECK (tipo IN ('receita', 'despesa', 'transferencia'));

-- As regras que fazem uma transferencia ser coerente. A API valida antes e
-- devolve mensagem boa; isto aqui e´ a rede de seguranca do banco.
--   - so´ transferencia tem destino;
--   - transferencia exige as DUAS contas, e distintas (senao o dinheiro anda em circulo);
--   - transferencia nao tem categoria: "Mercado" nao classifica um dinheiro que
--     continua sendo seu. (A FK composta (categoria_id, tipo) -> categorias(id, tipo)
--     ja´ impediria uma categoria de tipo 'transferencia' de existir, mas o CHECK
--     torna a regra explicita em vez de acidental.)
ALTER TABLE transacoes
  ADD CONSTRAINT transacoes_transferencia_ck CHECK (
    CASE WHEN tipo = 'transferencia'
      THEN conta_id IS NOT NULL
       AND conta_destino_id IS NOT NULL
       AND conta_destino_id <> conta_id
       AND categoria_id IS NULL
      ELSE conta_destino_id IS NULL
    END
  );


-- =====================================================================
--  vw_saldo_contas: agora uma conta e´ tocada por transacoes onde ela e´ a
--  ORIGEM (conta_id) ou o DESTINO (conta_destino_id) -- por isso o JOIN passa a
--  casar os dois lados, e cada FILTER diz explicitamente de qual lado esta´
--  falando. Sem isso, uma receita da conta A seria contada tambem na conta B
--  quando B fosse destino de alguma transferencia de A.
--
--  `NOT t.oculta` continua no ON (e nao no WHERE): no WHERE o LEFT JOIN viraria
--  INNER e conta sem lancamento sumiria da lista. Mesmo motivo da migration 004.
-- =====================================================================

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

  COALESCE(SUM(t.valor) FILTER (WHERE t.tipo = 'receita' AND t.conta_id = c.id), 0) AS receitas,
  COALESCE(SUM(t.valor) FILTER (WHERE t.tipo = 'despesa' AND t.conta_id = c.id), 0) AS despesas,

  COALESCE(SUM(t.valor) FILTER (
    WHERE t.tipo = 'transferencia' AND t.conta_destino_id = c.id), 0) AS transferido_entrada,
  COALESCE(SUM(t.valor) FILTER (
    WHERE t.tipo = 'transferencia' AND t.conta_id = c.id), 0) AS transferido_saida,

  c.saldo_inicial
    + COALESCE(SUM(t.valor) FILTER (WHERE t.tipo = 'receita' AND t.conta_id = c.id), 0)
    - COALESCE(SUM(t.valor) FILTER (WHERE t.tipo = 'despesa' AND t.conta_id = c.id), 0)
    + COALESCE(SUM(t.valor) FILTER (
        WHERE t.tipo = 'transferencia' AND t.conta_destino_id = c.id), 0)
    - COALESCE(SUM(t.valor) FILTER (
        WHERE t.tipo = 'transferencia' AND t.conta_id = c.id), 0)
    AS saldo

FROM contas c
LEFT JOIN transacoes t
  ON (t.conta_id = c.id OR t.conta_destino_id = c.id)
 AND t.usuario_id = c.usuario_id
 AND NOT t.oculta
GROUP BY c.usuario_id, c.id;
