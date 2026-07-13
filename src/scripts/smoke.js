/**
 * Testes de fumaca contra o banco real. Nao usa mocks: bate no PostgreSQL,
 * confere as regras de integridade e desfaz tudo com ROLLBACK.
 */
import { pool, closePool } from '../db.js';

let ok = 0;
let falhas = 0;

function checar(nome, condicao, detalhe = '') {
  if (condicao) {
    console.log(`  PASS  ${nome}`);
    ok++;
  } else {
    console.log(`  FAIL  ${nome} ${detalhe}`);
    falhas++;
  }
}

async function esperaErro(client, sql, params, nome) {
  await client.query('SAVEPOINT sp');
  try {
    await client.query(sql, params);
    await client.query('ROLLBACK TO SAVEPOINT sp');
    checar(nome, false, '(o banco aceitou, mas deveria ter rejeitado)');
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT sp');
    checar(nome, true, `(rejeitado: ${err.code})`);
  }
}

const client = await pool.connect();
try {
  await client.query('BEGIN');

  const { rows: cats } = await client.query(
    `SELECT id, tipo FROM categorias WHERE nome = ANY($1)`,
    [['Salário', 'Moradia']],
  );
  const receita = cats.find((c) => c.tipo === 'receita');
  const despesa = cats.find((c) => c.tipo === 'despesa');
  checar('categorias base semeadas (Salário + Moradia)', !!receita && !!despesa);

  await esperaErro(
    client,
    `INSERT INTO transacoes (descricao, valor, tipo, data, categoria_id)
     VALUES ('x', 10, 'despesa', CURRENT_DATE, $1)`,
    [receita.id],
    'despesa NAO pode usar categoria de receita (FK composta)',
  );

  await esperaErro(
    client,
    `INSERT INTO transacoes (descricao, valor, tipo, data) VALUES ('x', -5, 'despesa', CURRENT_DATE)`,
    [],
    'valor negativo e rejeitado (CHECK valor > 0)',
  );

  await esperaErro(
    client,
    `INSERT INTO transacoes (descricao, valor, tipo, data) VALUES ('   ', 5, 'despesa', CURRENT_DATE)`,
    [],
    'descricao em branco e rejeitada',
  );

  await esperaErro(
    client,
    `INSERT INTO transacoes (descricao, valor, tipo, data) VALUES ('x', 5, 'investimento', CURRENT_DATE)`,
    [],
    'tipo fora de (receita, despesa) e rejeitado',
  );

  await esperaErro(
    client,
    `INSERT INTO orcamentos (categoria_id, limite) VALUES ($1, 100)`,
    [receita.id],
    'orcamento NAO pode apontar para categoria de receita',
  );

  const { rows: ins } = await client.query(
    `INSERT INTO transacoes (descricao, valor, tipo, data, categoria_id)
     VALUES ('almoço', 42.5, 'despesa', CURRENT_DATE, $1) RETURNING id, valor, data`,
    [despesa.id],
  );
  checar('despesa valida e aceita', ins.length === 1);
  checar('numeric volta como Number, nao string', typeof ins[0].valor === 'number', `(veio ${typeof ins[0].valor})`);
  checar('DATE volta como string AAAA-MM-DD (sem shift de fuso)',
    typeof ins[0].data === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ins[0].data), `(veio ${ins[0].data})`);

  const { rows: orc } = await client.query(
    `INSERT INTO orcamentos (categoria_id, limite) VALUES ($1, 900) RETURNING id`,
    [despesa.id],
  );
  await esperaErro(
    client,
    `INSERT INTO orcamentos (categoria_id, limite) VALUES ($1, 500)`,
    [despesa.id],
    'orcamento duplicado por categoria e rejeitado (UNIQUE)',
  );

  // ON DELETE SET NULL (categoria_id): apagar a categoria preserva a transacao
  await client.query('SAVEPOINT del');
  await client.query('DELETE FROM categorias WHERE id = $1', [despesa.id]);
  const { rows: orfa } = await client.query('SELECT categoria_id, tipo FROM transacoes WHERE id = $1', [ins[0].id]);
  checar('apagar categoria mantem a transacao com categoria_id NULL',
    orfa[0].categoria_id === null && orfa[0].tipo === 'despesa');
  const { rows: orcCount } = await client.query('SELECT count(*)::int AS n FROM orcamentos WHERE id = $1', [orc[0].id]);
  checar('apagar categoria remove o orcamento em cascata', orcCount[0].n === 0);
  await client.query('ROLLBACK TO SAVEPOINT del');

  const { rows: saldo } = await client.query('SELECT * FROM vw_saldo_contas LIMIT 1');
  checar('view vw_saldo_contas responde', saldo.length >= 0);

  await client.query('ROLLBACK'); // nada e persistido
} finally {
  client.release();
  await closePool();
}

console.log(`\n${ok} passaram, ${falhas} falharam.`);
process.exitCode = falhas ? 1 : 0;
