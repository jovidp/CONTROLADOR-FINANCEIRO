-- Uma recorrente nao pode gerar DUAS transacoes para a mesma data.
--
-- O processarRecorrentes() se dizia idempotente, e era -- pelo caminho feliz: ao fim
-- do laco, proxima_data sempre passa de hoje, entao rodar de novo no mesmo dia nao
-- acha nada. Mas a idempotencia dependia inteiramente de proxima_data nunca andar
-- para tras, e havia um caminho, pela propria tela, em que ela andava:
--
--   1. uma recorrente com data_fim chega ao fim  -> o servico a desativa e DEIXA
--      proxima_data na ultima ocorrencia JA´ materializada (era "inofensivo", porque
--      ativa = false tira a linha do filtro);
--   2. o usuario religa o switch "ativa" na tela -> o PUT reenvia o registro inteiro,
--      com aquele proxima_data no passado;
--   3. o proximo processamento ve `ativa AND proxima_data <= hoje` e MATERIALIZA DE
--      NOVO a transacao daquela data.
--
-- Cada liga/desliga somava mais uma copia do lancamento. Um indice resolve isso de
-- uma vez, para este caminho e para qualquer outro que rebobine a data no futuro:
-- a garantia deixa de depender da aritmetica do JS estar certa.
--
-- Parcial (recorrente_id IS NOT NULL) porque lancamento avulso nao tem recorrente --
-- e nada impede alguem de lancar dois cafes no mesmo dia, na mao.
CREATE UNIQUE INDEX IF NOT EXISTS transacoes_recorrente_data_uk
  ON transacoes (recorrente_id, data)
  WHERE recorrente_id IS NOT NULL;
