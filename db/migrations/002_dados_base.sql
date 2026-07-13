-- Categorias e conta padrao. Idempotente: pode rodar de novo sem duplicar.

INSERT INTO contas (nome, tipo, saldo_inicial, cor) VALUES
  ('Conta Corrente', 'corrente', 0, '#3b82f6')
ON CONFLICT (nome) DO NOTHING;

INSERT INTO categorias (nome, tipo, cor, icone) VALUES
  ('Salário',        'receita', '#22c55e', '💼'),
  ('Freelance',      'receita', '#10b981', '🧑‍💻'),
  ('Investimentos',  'receita', '#14b8a6', '📈'),
  ('Outras receitas','receita', '#84cc16', '➕'),

  ('Moradia',        'despesa', '#ef4444', '🏠'),
  ('Alimentação',    'despesa', '#f97316', '🍽️'),
  ('Transporte',     'despesa', '#f59e0b', '🚗'),
  ('Saúde',          'despesa', '#ec4899', '💊'),
  ('Educação',       'despesa', '#8b5cf6', '📚'),
  ('Lazer',          'despesa', '#06b6d4', '🎬'),
  ('Compras',        'despesa', '#a855f7', '🛍️'),
  ('Assinaturas',    'despesa', '#6366f1', '📺'),
  ('Contas & Taxas', 'despesa', '#64748b', '🧾'),
  ('Outras despesas','despesa', '#94a3b8', '📦')
ON CONFLICT (nome, tipo) DO NOTHING;
