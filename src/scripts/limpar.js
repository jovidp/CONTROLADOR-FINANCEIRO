/**
 * DESTRUTIVO: apaga os LANCAMENTOS, deixando o app zerado para uso real.
 *
 * Some: transacoes, aportes, metas, orcamentos e recorrentes.
 * Fica de pe: as tabelas, as CATEGORIAS e as CONTAS (com saldo_inicial zerado,
 * porque os saldos que o seed inventou -- Poupanca 5.200, Carteira 1.800 --
 * sao dado de exemplo como qualquer outro e apareceriam como dinheiro fantasma).
 *
 * Diferenca para o `db:reset`: aquele derruba o schema inteiro (DROP SCHEMA) e
 * exige rodar as migrations de novo. Este preserva a estrutura e o cadastro base.
 *
 * So roda com a confirmacao explicita CONFIRMAR=sim.
 */
import { config } from '../config.js';
import { withTransaction, closePool } from '../db.js';

const alvo = `${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`;

// Ordem importa: os filhos saem antes dos pais por causa das foreign keys.
const TABELAS = ['transacoes', 'meta_aportes', 'metas', 'orcamentos', 'recorrentes'];

function abortar() {
  console.error('\n  LIMPEZA ABORTADA — nada foi apagado.\n');
  console.error(`  Este comando apaga TODOS os lançamentos de ${alvo}:`);
  console.error(`  ${TABELAS.join(', ')}.`);
  console.error('  Também zera o saldo inicial das contas. Não há como desfazer.\n');
  console.error('  As categorias e as contas em si são preservadas.\n');
  console.error('  Se é isso mesmo que você quer, confirme pela variável de ambiente:\n');
  console.error('    PowerShell:     $env:CONFIRMAR="sim"; npm run db:limpar');
  console.error('    CMD:            set CONFIRMAR=sim && npm run db:limpar');
  console.error('    Linux/macOS:    CONFIRMAR=sim npm run db:limpar\n');
  process.exitCode = 1;
}

async function main() {
  if (process.env.CONFIRMAR !== 'sim') {
    abortar();
    return;
  }

  console.log(`\n  Limpando os lançamentos de ${alvo}...\n`);

  await withTransaction(async (client) => {
    for (const tabela of TABELAS) {
      // Nome de tabela vem da constante acima, nunca de entrada externa.
      const { rowCount } = await client.query(`DELETE FROM ${tabela}`);
      console.log(`  - ${String(rowCount).padStart(4)} removido(s) de ${tabela}`);
    }

    const { rowCount } = await client.query(
      'UPDATE contas SET saldo_inicial = 0 WHERE saldo_inicial <> 0',
    );
    console.log(`  - ${String(rowCount).padStart(4)} conta(s) com saldo inicial zerado`);

    const { rows: [r] } = await client.query(
      'SELECT (SELECT count(*) FROM categorias) AS cats, (SELECT count(*) FROM contas) AS contas',
    );
    console.log(`\n  = preservados: ${r.cats} categorias, ${r.contas} contas`);
  });

  console.log('\nOK: o app está zerado. Abra e comece a lançar seus dados reais.');
  console.log('  (para trazer os dados de exemplo de volta: npm run db:seed)\n');
}

main()
  .catch((err) => {
    console.error('\nFALHA na limpeza:', err.message);
    console.error(`  Alvo: ${alvo}\n`);
    process.exitCode = 1;
  })
  .finally(closePool);
