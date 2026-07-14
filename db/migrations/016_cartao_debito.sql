-- =====================================================================
--  "Cartão de débito" entra no kit de tipos de conta.
--  Ate´ aqui so´ havia "Cartão de crédito"; quem paga no débito nao tinha um
--  tipo proprio para separar o gasto do cartao de debito do da conta corrente.
-- =====================================================================
--
-- Da´ o tipo a TODO usuario que ja´ existe (os novos ja´ nascem com ele pelo kit
-- padrao em src/services/categoriasPadrao.js).
--
-- O WHERE NOT EXISTS cobre os DOIS uniques da tabela (chave E rotulo): rodar de
-- novo nao duplica, e nao estoura se alguem ja´ tiver criado um tipo com essa
-- chave ou com esse rotulo na mao.

INSERT INTO tipos_conta (usuario_id, chave, rotulo, icone)
SELECT u.id, 'cartao-debito', 'Cartão de débito', '💳'
  FROM usuarios u
 WHERE NOT EXISTS (
   SELECT 1 FROM tipos_conta t
    WHERE t.usuario_id = u.id
      AND (t.chave = 'cartao-debito' OR t.rotulo = 'Cartão de débito')
 );
