export const CATEGORIAS_PADRAO = [
  ['Salário', 'receita', '#22c55e', '💼'],
  ['Freelance', 'receita', '#10b981', '🧑‍💻'],
  ['Investimentos', 'receita', '#14b8a6', '📈'],
  ['Outras receitas', 'receita', '#84cc16', '➕'],
  ['Moradia', 'despesa', '#ef4444', '🏠'],
  ['Alimentação', 'despesa', '#f97316', '🍽️'],
  ['Transporte', 'despesa', '#f59e0b', '🚗'],
  ['Saúde', 'despesa', '#ec4899', '💊'],
  ['Educação', 'despesa', '#8b5cf6', '📚'],
  ['Lazer', 'despesa', '#06b6d4', '🎬'],
  ['Compras', 'despesa', '#a855f7', '🛍️'],
  ['Assinaturas', 'despesa', '#6366f1', '📺'],
  ['Contas & Taxas', 'despesa', '#64748b', '🧾'],
  ['Outras despesas', 'despesa', '#94a3b8', '📦'],
];

export const CONTAS_PADRAO = [
  ['Conta Corrente', 'corrente', 0, '#3b82f6'],
];

export async function inserirCategoriasPadrao(cliente, usuarioId) {
  for (const [nome, tipo, cor, icone] of CATEGORIAS_PADRAO) {
    await cliente.query(
      `INSERT INTO categorias (usuario_id, nome, tipo, cor, icone)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (usuario_id, nome, tipo) DO NOTHING`,
      [usuarioId, nome, tipo, cor, icone],
    );
  }
}

export async function inserirContasPadrao(cliente, usuarioId) {
  for (const [nome, tipo, saldoInicial, cor] of CONTAS_PADRAO) {
    await cliente.query(
      `INSERT INTO contas (usuario_id, nome, tipo, saldo_inicial, cor)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (usuario_id, nome) DO NOTHING`,
      [usuarioId, nome, tipo, saldoInicial, cor],
    );
  }
}

/**
 * Da´ o kit padrao a quem esta´ com a lista VAZIA -- e so´ a quem esta´ vazia.
 *
 * O "vazia" e´ deliberado, e nao "faltando alguma": semear por nome toda vez
 * ressuscitaria, a cada login, a categoria que o usuario apagou de proposito.
 * Lista vazia nao tem essa ambiguidade -- ou e´ conta nova, ou e´ uma conta
 * antiga que nunca recebeu os padroes (o usuario legado do .env, que nasce
 * direto no INSERT de garantirUsuarioLegado e nunca passou pelo cadastro).
 */
export async function garantirPadroes(cliente, usuarioId) {
  const { rows: [n] } = await cliente.query(
    `SELECT (SELECT count(*) FROM contas     WHERE usuario_id = $1) AS contas,
            (SELECT count(*) FROM categorias WHERE usuario_id = $1) AS categorias`,
    [usuarioId],
  );

  if (Number(n.categorias) === 0) await inserirCategoriasPadrao(cliente, usuarioId);
  if (Number(n.contas) === 0) await inserirContasPadrao(cliente, usuarioId);
}
