-- A conta padrao tambem pertence a cada usuario.
-- ON CONFLICT preserva contas personalizadas com o mesmo nome.

INSERT INTO contas (usuario_id, nome, tipo, saldo_inicial, cor)
SELECT u.id, 'Conta Corrente', 'corrente', 0, '#3b82f6'
  FROM usuarios u
 ON CONFLICT (usuario_id, nome) DO NOTHING;
