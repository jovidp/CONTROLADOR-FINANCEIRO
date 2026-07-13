-- Categorias padrao pertencem a cada usuario, nao a um unico usuario legado.
-- ON CONFLICT preserva categorias personalizadas que ja existam.

INSERT INTO categorias (usuario_id, nome, tipo, cor, icone)
SELECT u.id, c.nome, c.tipo, c.cor, c.icone
  FROM usuarios u
 CROSS JOIN (VALUES
   ('Salário',         'receita', '#22c55e', '💼'),
   ('Freelance',       'receita', '#10b981', '🧑‍💻'),
   ('Investimentos',   'receita', '#14b8a6', '📈'),
   ('Outras receitas', 'receita', '#84cc16', '➕'),
   ('Moradia',         'despesa', '#ef4444', '🏠'),
   ('Alimentação',     'despesa', '#f97316', '🍽️'),
   ('Transporte',      'despesa', '#f59e0b', '🚗'),
   ('Saúde',           'despesa', '#ec4899', '💊'),
   ('Educação',        'despesa', '#8b5cf6', '📚'),
   ('Lazer',           'despesa', '#06b6d4', '🎬'),
   ('Compras',         'despesa', '#a855f7', '🛍️'),
   ('Assinaturas',     'despesa', '#6366f1', '📺'),
   ('Contas & Taxas',  'despesa', '#64748b', '🧾'),
   ('Outras despesas', 'despesa', '#94a3b8', '📦')
 ) AS c(nome, tipo, cor, icone)
 ON CONFLICT (usuario_id, nome, tipo) DO NOTHING;
