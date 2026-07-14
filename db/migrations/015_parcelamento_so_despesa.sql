-- Parcelamento e´ coisa de DESPESA.
--
-- "Receita em 3x" nao existe: dinheiro que entra em tres vezes sao tres entradas, cada
-- uma no dia em que cai -- ou tres lancamentos, ou um lancamento fixo. O que a coluna
-- `tipo` de parcelamentos aceitava era 'receita' tambem (a FK composta com categorias
-- exige que ela exista, mas nunca restringiu o valor), e o formulario oferecia a opcao.
-- Um parcelamento de receita nao significa nada e ainda apareceria na tela de compras
-- parceladas, misturado com as compras de verdade.
--
-- O CHECK e´ a mesma regra do TIPOS de routes/parcelamentos.js, dita no lugar onde ela
-- nao depende de ninguem lembrar dela: uma rota nova, um script, um UPDATE na mao -- todos
-- passam por aqui.
--
-- Nao ha´ o que converter: os parcelamentos existentes sao todos 'despesa'. Se algum dia
-- houver, esta migration falha alto (e´ o que se quer) em vez de apagar dado.
ALTER TABLE parcelamentos
  ADD CONSTRAINT parcelamentos_tipo_ck CHECK (tipo = 'despesa');
