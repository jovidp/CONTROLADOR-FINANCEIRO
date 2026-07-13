CREATE UNIQUE INDEX orcamentos_categoria_sem_usuario_uk
  ON orcamentos (categoria_id) WHERE usuario_id IS NULL;
