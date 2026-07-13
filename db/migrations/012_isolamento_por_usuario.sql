-- Termina a migracao multiusuario que a 006 deixou pela metade.
--
-- A 006 adicionou usuario_id "nullable durante a migracao" e nunca voltou para
-- fechar o servico. O resultado, com quatro pessoas cadastradas:
--
--   1) usuario_id aceitava NULL. Uma linha orfa fica INVISIVEL para o app (toda
--      consulta filtra usuario_id = $1), mas continua entrando em qualquer
--      DELETE sem WHERE. Pior: as uniques (usuario_id, nome) nao valem nada com
--      NULL -- em SQL, NULL nunca conflita com NULL -- entao dava para criar
--      infinitas "Conta Corrente" orfas.
--
--   2) As foreign keys ignoravam o usuario_id: `transacoes_conta_id_fkey` so´
--      exigia que a conta EXISTISSE, nao que fosse SUA. O banco aceitava, de bom
--      grado, uma transacao do usuario A apontando para a conta do usuario B.
--      O unico guarda era o validarVinculos() do JS -- e uma rota nova que
--      esquecesse de chama-lo vazaria dados entre pessoas, sem o banco reclamar.
--
-- Depois desta migration, o isolamento passa a ser garantido pelo BANCO: um
-- vinculo cruzado vira erro 23503, e nao um vazamento silencioso.

-- --------------------------------------------------------------------
-- 0. Trava de seguranca: nao ha´ o que adotar?
-- --------------------------------------------------------------------
-- Se sobrou alguma linha orfa, o SET NOT NULL la´ embaixo falharia no meio com uma
-- mensagem cifrada do Postgres. Melhor abortar aqui, dizendo exatamente o que fazer.
DO $$
DECLARE orfas bigint;
BEGIN
  SELECT count(*) INTO orfas FROM (
    SELECT 1 FROM contas        WHERE usuario_id IS NULL
    UNION ALL SELECT 1 FROM categorias    WHERE usuario_id IS NULL
    UNION ALL SELECT 1 FROM recorrentes   WHERE usuario_id IS NULL
    UNION ALL SELECT 1 FROM transacoes    WHERE usuario_id IS NULL
    UNION ALL SELECT 1 FROM orcamentos    WHERE usuario_id IS NULL
    UNION ALL SELECT 1 FROM metas         WHERE usuario_id IS NULL
    UNION ALL SELECT 1 FROM parcelamentos WHERE usuario_id IS NULL
  ) x;

  IF orfas > 0 THEN
    RAISE EXCEPTION
      'Existem % linha(s) sem dono (usuario_id IS NULL). Suba o servidor uma vez para o prepararUsuariosDados() adota-las, ou defina o dono na mao, e rode a migration de novo.', orfas;
  END IF;
END $$;

-- --------------------------------------------------------------------
-- 1. meta_aportes ganha dono proprio
-- --------------------------------------------------------------------
-- Era a unica tabela de dominio sem usuario_id: o dono vinha indiretamente, pela
-- meta. Com a coluna propria, a FK composta abaixo passa a impedir, no banco, que
-- um aporte caia na meta de outra pessoa.
ALTER TABLE meta_aportes ADD COLUMN IF NOT EXISTS usuario_id integer;

UPDATE meta_aportes a
   SET usuario_id = m.usuario_id
  FROM metas m
 WHERE m.id = a.meta_id
   AND a.usuario_id IS DISTINCT FROM m.usuario_id;

ALTER TABLE meta_aportes ALTER COLUMN usuario_id SET NOT NULL;

-- --------------------------------------------------------------------
-- 2. usuario_id passa a ser obrigatorio
-- --------------------------------------------------------------------
ALTER TABLE contas        ALTER COLUMN usuario_id SET NOT NULL;
ALTER TABLE categorias    ALTER COLUMN usuario_id SET NOT NULL;
ALTER TABLE recorrentes   ALTER COLUMN usuario_id SET NOT NULL;
ALTER TABLE transacoes    ALTER COLUMN usuario_id SET NOT NULL;
ALTER TABLE orcamentos    ALTER COLUMN usuario_id SET NOT NULL;
ALTER TABLE metas         ALTER COLUMN usuario_id SET NOT NULL;
ALTER TABLE parcelamentos ALTER COLUMN usuario_id SET NOT NULL;

-- O indice paliativo da 007 so´ existia para tolerar orcamentos com usuario_id NULL
-- (a unique (usuario_id, categoria_id) nao os pegava). Sem NULL, virou peso morto.
DROP INDEX IF EXISTS orcamentos_categoria_sem_usuario_uk;

-- --------------------------------------------------------------------
-- 3. Alvos das FKs compostas
-- --------------------------------------------------------------------
-- Uma FK composta so´ pode apontar para uma UNIQUE que cubra exatamente as mesmas
-- colunas. Como (id) ja´ e´ PK, estas uniques sao redundantes em termos de unicidade
-- -- existem para dar um alvo valido as FKs de baixo.
ALTER TABLE contas        ADD CONSTRAINT contas_usuario_id_uk        UNIQUE (usuario_id, id);
ALTER TABLE categorias    ADD CONSTRAINT categorias_usuario_id_tipo_uk UNIQUE (usuario_id, id, tipo);
ALTER TABLE recorrentes   ADD CONSTRAINT recorrentes_usuario_id_uk   UNIQUE (usuario_id, id);
ALTER TABLE parcelamentos ADD CONSTRAINT parcelamentos_usuario_id_uk UNIQUE (usuario_id, id);
ALTER TABLE metas         ADD CONSTRAINT metas_usuario_id_uk         UNIQUE (usuario_id, id);

-- --------------------------------------------------------------------
-- 4. FKs recriadas com o usuario_id dentro
-- --------------------------------------------------------------------
-- MATCH SIMPLE (o padrao) mantem o comportamento atual: se a coluna opcional for
-- NULL -- transferencia nao tem categoria, "sem conta" e´ permitido -- a FK nao e´
-- checada. E o `SET NULL (coluna)` zera SO´ a coluna citada, preservando o
-- usuario_id, que agora e´ NOT NULL e nao pode ser zerado junto.

-- transacoes
ALTER TABLE transacoes DROP CONSTRAINT transacoes_categoria_fk;
ALTER TABLE transacoes ADD  CONSTRAINT transacoes_categoria_fk
  FOREIGN KEY (usuario_id, categoria_id, tipo) REFERENCES categorias (usuario_id, id, tipo)
  ON UPDATE RESTRICT ON DELETE SET NULL (categoria_id);

ALTER TABLE transacoes DROP CONSTRAINT transacoes_conta_id_fkey;
ALTER TABLE transacoes ADD  CONSTRAINT transacoes_conta_fk
  FOREIGN KEY (usuario_id, conta_id) REFERENCES contas (usuario_id, id)
  ON DELETE SET NULL (conta_id);

ALTER TABLE transacoes DROP CONSTRAINT transacoes_conta_destino_fk;
ALTER TABLE transacoes ADD  CONSTRAINT transacoes_conta_destino_fk
  FOREIGN KEY (usuario_id, conta_destino_id) REFERENCES contas (usuario_id, id)
  ON DELETE RESTRICT;

ALTER TABLE transacoes DROP CONSTRAINT transacoes_recorrente_id_fkey;
ALTER TABLE transacoes ADD  CONSTRAINT transacoes_recorrente_fk
  FOREIGN KEY (usuario_id, recorrente_id) REFERENCES recorrentes (usuario_id, id)
  ON DELETE SET NULL (recorrente_id);

ALTER TABLE transacoes DROP CONSTRAINT transacoes_parcelamento_id_fkey;
ALTER TABLE transacoes ADD  CONSTRAINT transacoes_parcelamento_fk
  FOREIGN KEY (usuario_id, parcelamento_id) REFERENCES parcelamentos (usuario_id, id)
  ON DELETE CASCADE;

-- orcamentos
ALTER TABLE orcamentos DROP CONSTRAINT orcamentos_categoria_fk;
ALTER TABLE orcamentos ADD  CONSTRAINT orcamentos_categoria_fk
  FOREIGN KEY (usuario_id, categoria_id, tipo) REFERENCES categorias (usuario_id, id, tipo)
  ON UPDATE RESTRICT ON DELETE CASCADE;

-- recorrentes
ALTER TABLE recorrentes DROP CONSTRAINT recorrentes_categoria_fk;
ALTER TABLE recorrentes ADD  CONSTRAINT recorrentes_categoria_fk
  FOREIGN KEY (usuario_id, categoria_id, tipo) REFERENCES categorias (usuario_id, id, tipo)
  ON UPDATE RESTRICT ON DELETE SET NULL (categoria_id);

ALTER TABLE recorrentes DROP CONSTRAINT recorrentes_conta_id_fkey;
ALTER TABLE recorrentes ADD  CONSTRAINT recorrentes_conta_fk
  FOREIGN KEY (usuario_id, conta_id) REFERENCES contas (usuario_id, id)
  ON DELETE SET NULL (conta_id);

-- parcelamentos
ALTER TABLE parcelamentos DROP CONSTRAINT parcelamentos_categoria_fk;
ALTER TABLE parcelamentos ADD  CONSTRAINT parcelamentos_categoria_fk
  FOREIGN KEY (usuario_id, categoria_id, tipo) REFERENCES categorias (usuario_id, id, tipo)
  ON UPDATE RESTRICT ON DELETE SET NULL (categoria_id);

ALTER TABLE parcelamentos DROP CONSTRAINT parcelamentos_conta_id_fkey;
ALTER TABLE parcelamentos ADD  CONSTRAINT parcelamentos_conta_fk
  FOREIGN KEY (usuario_id, conta_id) REFERENCES contas (usuario_id, id)
  ON DELETE SET NULL (conta_id);

-- meta_aportes
ALTER TABLE meta_aportes DROP CONSTRAINT meta_aportes_meta_id_fkey;
ALTER TABLE meta_aportes ADD  CONSTRAINT meta_aportes_meta_fk
  FOREIGN KEY (usuario_id, meta_id) REFERENCES metas (usuario_id, id)
  ON DELETE CASCADE;

ALTER TABLE meta_aportes ADD CONSTRAINT meta_aportes_usuario_id_fkey
  FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS meta_aportes_usuario_idx ON meta_aportes (usuario_id);
