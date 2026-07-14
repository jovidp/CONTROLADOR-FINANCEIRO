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

// A chave e´ o que contas.tipo guarda; o rotulo e o icone o usuario edita quando quiser.
// (Os cinco primeiros vieram da 010_tipos_conta.sql; o cartao de debito, da 016.)
export const TIPOS_CONTA_PADRAO = [
  ['corrente', 'Conta corrente', '🏦'],
  ['poupanca', 'Poupança', '🐖'],
  ['carteira', 'Carteira', '👛'],
  ['cartao-debito', 'Cartão de débito', '💳'],
  ['credito', 'Cartão de crédito', '💳'],
  ['investimento', 'Investimento', '📈'],
];

export async function inserirTiposContaPadrao(cliente, usuarioId) {
  for (const [chave, rotulo, icone] of TIPOS_CONTA_PADRAO) {
    await cliente.query(
      `INSERT INTO tipos_conta (usuario_id, chave, rotulo, icone)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (usuario_id, chave) DO NOTHING`,
      [usuarioId, chave, rotulo, icone],
    );
  }
}

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

/**
 * Devolve um tipo de conta que EXISTE para este usuario.
 *
 * A conta padrao nasce com o tipo 'corrente', e contas.tipo tem FK para tipos_conta.
 * Mas o usuario pode apagar os tipos que quiser -- e havia um caminho, todo ele
 * permitido pela API, que trancava a pessoa para fora da propria conta:
 *
 *   1. apaga todas as contas          (permitido: so´ barra se houver transferencia)
 *   2. apaga o tipo 'corrente'        (permitido: o guard so´ olha se ha´ CONTAS usando)
 *   3. faz login
 *
 * No passo 3 o garantirPadroes via "0 contas" e tentava recriar a Conta Corrente com
 * o tipo 'corrente' -- que nao existia mais. A FK estourava (23503), o traduzErroPg
 * transformava em 409 e o LOGIN respondia "Registro vinculado a outros dados".
 * Consertar exigia estar logado. Sem acesso ao banco, a conta estava perdida.
 */
async function tipoValido(cliente, usuarioId, preferido) {
  const { rows: existe } = await cliente.query(
    'SELECT chave FROM tipos_conta WHERE usuario_id = $1 AND chave = $2',
    [usuarioId, preferido],
  );
  if (existe[0]) return preferido;

  // Sobrou algum outro tipo? Serve: melhor uma conta com o tipo "errado" do que um
  // usuario que nao consegue mais entrar.
  const { rows: qualquer } = await cliente.query(
    'SELECT chave FROM tipos_conta WHERE usuario_id = $1 ORDER BY id LIMIT 1',
    [usuarioId],
  );
  if (qualquer[0]) return qualquer[0].chave;

  // Nenhum tipo: devolve o kit padrao e usa o preferido, que agora existe.
  await inserirTiposContaPadrao(cliente, usuarioId);
  return preferido;
}

export async function inserirContasPadrao(cliente, usuarioId) {
  for (const [nome, tipo, saldoInicial, cor] of CONTAS_PADRAO) {
    await cliente.query(
      `INSERT INTO contas (usuario_id, nome, tipo, saldo_inicial, cor)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (usuario_id, nome) DO NOTHING`,
      [usuarioId, nome, await tipoValido(cliente, usuarioId, tipo), saldoInicial, cor],
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
    `SELECT (SELECT count(*) FROM contas      WHERE usuario_id = $1) AS contas,
            (SELECT count(*) FROM categorias  WHERE usuario_id = $1) AS categorias,
            (SELECT count(*) FROM tipos_conta WHERE usuario_id = $1) AS tipos_conta`,
    [usuarioId],
  );

  if (Number(n.categorias) === 0) await inserirCategoriasPadrao(cliente, usuarioId);

  // Os tipos vem ANTES das contas: contas.tipo tem FK para tipos_conta, entao a conta
  // padrao ('corrente') so´ entra se o tipo 'corrente' ja´ existir para este usuario.
  if (Number(n.tipos_conta) === 0) await inserirTiposContaPadrao(cliente, usuarioId);
  if (Number(n.contas) === 0) await inserirContasPadrao(cliente, usuarioId);
}
