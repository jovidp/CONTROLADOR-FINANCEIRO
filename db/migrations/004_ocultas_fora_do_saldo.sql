-- Lancamento oculto nao entra no saldo da conta.
--
-- A regra do app e´ uma so´: oculto nao conta em lugar nenhum. Se ele sumisse do
-- painel mas continuasse no saldo da conta, os dois numeros se contradiriam e o
-- usuario nao teria como saber qual acreditar.

CREATE OR REPLACE VIEW vw_saldo_contas AS
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
-- O "AND NOT t.oculta" vai no JOIN, nao num WHERE: no WHERE ele transformaria o
-- LEFT JOIN em INNER e a conta sem nenhum lancamento sumiria da lista.
LEFT JOIN transacoes t ON t.conta_id = c.id AND NOT t.oculta
GROUP BY c.id;
