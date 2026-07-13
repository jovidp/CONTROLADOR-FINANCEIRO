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

  // ===================================================================
  //  TRANSFERENCIA ENTRE CONTAS (migration 011)
  //
  //  O que importa aqui nao e´ "a API aceitou": e´ que o DINHEIRO BATE.
  //  Uma transferencia tem que sair de uma conta, entrar na outra, o total
  //  somado das duas nao mudar, e ela nao pode aparecer como receita nem
  //  como despesa em lugar nenhum.
  // ===================================================================
  const { rows: us } = await client.query('SELECT id FROM usuarios ORDER BY id LIMIT 1');

  if (!us.length) {
    console.log('  SKIP  transferencia (nenhum usuario cadastrado)');
  } else {
    const usuarioId = us[0].id;
    const { rows: tc } = await client.query(
      'SELECT chave FROM tipos_conta WHERE usuario_id = $1 ORDER BY id LIMIT 1',
      [usuarioId],
    );
    const tipoConta = tc[0].chave;

    const novaConta = async (nome, inicial) => {
      const { rows } = await client.query(
        `INSERT INTO contas (usuario_id, nome, tipo, saldo_inicial)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [usuarioId, nome, tipoConta, inicial],
      );
      return rows[0].id;
    };

    const saldoDe = async (id) => {
      const { rows } = await client.query(
        'SELECT saldo, receitas, despesas FROM vw_saldo_contas WHERE id = $1 AND usuario_id = $2',
        [id, usuarioId],
      );
      return rows[0];
    };

    const origem = await novaConta('__smoke origem', 1000);
    const destino = await novaConta('__smoke destino', 100);

    // --- integridade: o que o banco tem que RECUSAR ---
    await esperaErro(
      client,
      `INSERT INTO transacoes (usuario_id, descricao, valor, tipo, data, conta_id)
       VALUES ($1, 'sem destino', 50, 'transferencia', CURRENT_DATE, $2)`,
      [usuarioId, origem],
      'transferencia SEM conta de destino e rejeitada',
    );

    await esperaErro(
      client,
      `INSERT INTO transacoes (usuario_id, descricao, valor, tipo, data, conta_id, conta_destino_id)
       VALUES ($1, 'circular', 50, 'transferencia', CURRENT_DATE, $2, $2)`,
      [usuarioId, origem],
      'transferencia da conta PARA ELA MESMA e rejeitada',
    );

    await esperaErro(
      client,
      `INSERT INTO transacoes (usuario_id, descricao, valor, tipo, data, conta_id, conta_destino_id, categoria_id)
       VALUES ($1, 'com categoria', 50, 'transferencia', CURRENT_DATE, $2, $3, $4)`,
      [usuarioId, origem, destino, despesa.id],
      'transferencia COM categoria e rejeitada (nao ha´ o que classificar)',
    );

    await esperaErro(
      client,
      `INSERT INTO transacoes (usuario_id, descricao, valor, tipo, data, conta_id, conta_destino_id)
       VALUES ($1, 'despesa com destino', 50, 'despesa', CURRENT_DATE, $2, $3)`,
      [usuarioId, origem, destino],
      'despesa comum NAO pode ter conta de destino',
    );

    // --- o dinheiro anda, e anda certo ---
    const antesOrigem = await saldoDe(origem);
    const antesDestino = await saldoDe(destino);
    checar('saldo inicial da origem = 1000', Number(antesOrigem.saldo) === 1000, `(veio ${antesOrigem.saldo})`);
    checar('saldo inicial do destino = 100', Number(antesDestino.saldo) === 100, `(veio ${antesDestino.saldo})`);

    await client.query(
      `INSERT INTO transacoes (usuario_id, descricao, valor, tipo, data, conta_id, conta_destino_id)
       VALUES ($1, 'guardar na poupanca', 300, 'transferencia', CURRENT_DATE, $2, $3)`,
      [usuarioId, origem, destino],
    );

    const depoisOrigem = await saldoDe(origem);
    const depoisDestino = await saldoDe(destino);

    checar('transferencia de 300 TIRA 300 da origem (1000 -> 700)',
      Number(depoisOrigem.saldo) === 700, `(veio ${depoisOrigem.saldo})`);
    checar('transferencia de 300 POE 300 no destino (100 -> 400)',
      Number(depoisDestino.saldo) === 400, `(veio ${depoisDestino.saldo})`);
    checar('o total somado das duas contas NAO muda (1100 antes, 1100 depois)',
      Number(depoisOrigem.saldo) + Number(depoisDestino.saldo) === 1100,
      `(veio ${Number(depoisOrigem.saldo) + Number(depoisDestino.saldo)})`);

    // --- e ela NAO VAZA como receita/despesa ---
    checar('transferencia nao vira DESPESA na conta de origem',
      Number(depoisOrigem.despesas) === 0, `(veio ${depoisOrigem.despesas})`);
    checar('transferencia nao vira RECEITA na conta de destino',
      Number(depoisDestino.receitas) === 0, `(veio ${depoisDestino.receitas})`);

    // O mesmo SUM ... FILTER que alimenta os KPIs do painel, a evolucao, o donut,
    // o relatorio anual e o resumo do periodo. Se a transferencia entrasse aqui,
    // ela inflaria o mes inteiro com dinheiro que nunca existiu.
    const { rows: kpi } = await client.query(
      `SELECT COALESCE(SUM(valor) FILTER (WHERE tipo = 'receita'), 0) AS receitas,
              COALESCE(SUM(valor) FILTER (WHERE tipo = 'despesa'), 0) AS despesas
         FROM transacoes
        WHERE usuario_id = $1 AND NOT oculta
          AND (conta_id IN ($2, $3) OR conta_destino_id IN ($2, $3))`,
      [usuarioId, origem, destino],
    );
    checar('transferencia nao entra nos KPIs (receitas do periodo = 0)',
      Number(kpi[0].receitas) === 0, `(veio ${kpi[0].receitas})`);
    checar('transferencia nao entra nos KPIs (despesas do periodo = 0)',
      Number(kpi[0].despesas) === 0, `(veio ${kpi[0].despesas})`);

    // --- oculta continua fora do saldo, tambem para transferencia ---
    await client.query(
      `UPDATE transacoes SET oculta = true
        WHERE usuario_id = $1 AND tipo = 'transferencia' AND conta_id = $2`,
      [usuarioId, origem],
    );
    const ocultaOrigem = await saldoDe(origem);
    const ocultaDestino = await saldoDe(destino);
    checar('transferencia OCULTA sai do saldo dos dois lados (volta a 1000 / 100)',
      Number(ocultaOrigem.saldo) === 1000 && Number(ocultaDestino.saldo) === 100,
      `(veio ${ocultaOrigem.saldo} / ${ocultaDestino.saldo})`);
  }

  await client.query('ROLLBACK'); // nada e persistido
} finally {
  client.release();
  await closePool();
}

console.log(`\n${ok} passaram, ${falhas} falharam.`);
process.exitCode = falhas ? 1 : 0;
