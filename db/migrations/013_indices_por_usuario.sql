-- Indices alinhados com as consultas que o app REALMENTE faz.
--
-- Todas elas comecam filtrando usuario_id -- e nenhum indice composto comecava por
-- ele. Os indices herdados da epoca de usuario unico (data DESC), (tipo, data DESC)
-- eram inuteis na pratica: o Postgres nao consegue usar um indice por (data) para
-- resolver `usuario_id = 5 AND data BETWEEN ...` sem varrer o que nao e´ do usuario.
-- Resultado: Seq Scan na lista de transacoes, a tela mais aberta do app.
--
-- Quase todos sao PARCIAIS (WHERE NOT oculta): as transacoes ocultas ficam de fora
-- do saldo e dos relatorios (migration 004), entao nao precisam nem entrar no indice.
-- Indice menor = mais paginas em cache = busca mais rapida.

-- Lista de transacoes (a tela mais usada) e o grosso dos relatorios.
-- O (data DESC, id DESC) casa exatamente com o ORDER BY do listar, entao o Postgres
-- pega as linhas ja´ na ordem certa e pula o passo de ordenacao.
CREATE INDEX IF NOT EXISTS transacoes_usuario_visivel_data_idx
  ON transacoes (usuario_id, data DESC, id DESC) WHERE NOT oculta;

-- A tela deixa escolher "incluir ocultas" / "apenas ocultas": esse caminho nao passa
-- pelo indice parcial acima e precisa de um indice completo.
CREATE INDEX IF NOT EXISTS transacoes_usuario_data_idx
  ON transacoes (usuario_id, data DESC, id DESC);

-- Resumo do mes, evolucao, anual, relatorio por categoria: todos filtram por tipo.
CREATE INDEX IF NOT EXISTS transacoes_usuario_tipo_data_idx
  ON transacoes (usuario_id, tipo, data) WHERE NOT oculta;

-- Gasto do orcamento: o LATERAL de orcamentos.js roda UMA VEZ POR ORCAMENTO na tela.
CREATE INDEX IF NOT EXISTS transacoes_usuario_categoria_data_idx
  ON transacoes (usuario_id, categoria_id, data) WHERE NOT oculta;

-- Extrato por conta. Sao dois indices porque, desde as transferencias (011), o filtro
-- por conta casa dos DOIS lados: conta_id (saiu) OU conta_destino_id (entrou).
CREATE INDEX IF NOT EXISTS transacoes_usuario_conta_data_idx
  ON transacoes (usuario_id, conta_id, data DESC) WHERE conta_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS transacoes_usuario_conta_destino_data_idx
  ON transacoes (usuario_id, conta_destino_id, data DESC) WHERE conta_destino_id IS NOT NULL;

-- FK sem indice: apagar UMA recorrente (ON DELETE SET NULL) obrigava o Postgres a
-- varrer a tabela de transacoes inteira para achar quem a referenciava.
CREATE INDEX IF NOT EXISTS transacoes_recorrente_idx
  ON transacoes (recorrente_id) WHERE recorrente_id IS NOT NULL;

-- processarRecorrentes(): roda no boot, uma vez para CADA usuario.
CREATE INDEX IF NOT EXISTS recorrentes_usuario_proxima_idx
  ON recorrentes (usuario_id, proxima_data) WHERE ativa;

-- --------------------------------------------------------------------
-- Indices que deixaram de fazer sentido
-- --------------------------------------------------------------------
-- Nenhuma consulta filtra data ou tipo SEM antes filtrar o usuario. Os dois indices
-- abaixo viraram peso morto: custam escrita em todo INSERT/UPDATE e nunca sao lidos.
DROP INDEX IF EXISTS transacoes_data_idx;
DROP INDEX IF EXISTS transacoes_tipo_data_idx;

-- Indice em lower(descricao) que NUNCA foi usado: a busca da tela aplica
-- translate(lower(descricao), 'aa´a~...', 'aaa...') -- expressao DIFERENTE da indexada,
-- entao o planejador nem cogita este indice. E, mesmo que fosse igual, um
-- LIKE '%termo%' (com curinga na frente) nao consegue usar um btree.
--
-- Indexar a busca de verdade pediria `CREATE EXTENSION pg_trgm` + indice GIN, e criar
-- extensao exige superusuario -- a role fin_app nao e´. Como a busca roda sobre as
-- transacoes de UM usuario num periodo (ja´ podadas pelos indices de cima), o filtro
-- em memoria da´ conta. Fica registrado aqui caso o volume mude isso um dia.
DROP INDEX IF EXISTS transacoes_descricao_idx;
