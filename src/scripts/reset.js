/**
 * DESTRUTIVO: derruba e recria o schema da aplicacao.
 * DROP SCHEMA public CASCADE + CREATE SCHEMA public -- some tudo: tabelas,
 * dados, view vw_saldo_contas e o historico em schema_migrations.
 *
 * So roda com a confirmacao explicita CONFIRMAR=sim.
 */
import { config } from '../config.js';
import { withTransaction, closePool } from '../db.js';

const alvo = `${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`;

function abortar() {
  console.error('\n  RESET ABORTADO — nada foi apagado.\n');
  console.error(`  Este comando executa DROP SCHEMA public CASCADE em ${alvo}.`);
  console.error('  Todas as tabelas, TODOS os lançamentos, orçamentos, metas e recorrentes');
  console.error('  são apagados para sempre. Não há como desfazer.\n');
  console.error('  Se é isso mesmo que você quer, confirme pela variável de ambiente:\n');
  console.error('    PowerShell:     $env:CONFIRMAR="sim"; npm run db:reset');
  console.error('    CMD:            set CONFIRMAR=sim && npm run db:reset');
  console.error('    Linux/macOS:    CONFIRMAR=sim npm run db:reset\n');
  process.exitCode = 1;
}

async function main() {
  if (process.env.CONFIRMAR !== 'sim') {
    abortar();
    return;
  }

  console.log(`\n  Apagando o schema public de ${alvo}...`);

  await withTransaction(async (client) => {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    // Quem cria o schema ja vira dono dele; o GRANT abaixo so deixa explicito.
    // CURRENT_USER e palavra-chave do SQL, nao um identificador interpolado.
    await client.query('GRANT ALL ON SCHEMA public TO CURRENT_USER');
  });

  console.log('  = schema public recriado (vazio)');
  console.log('\nOK: banco zerado. Próximos passos:');
  console.log('  npm run db:migrate    (recria as tabelas)');
  console.log('  npm run db:seed       (opcional: dados de exemplo)\n');
}

main()
  .catch((err) => {
    console.error('\nFALHA no reset:', err.message);
    console.error(`  Alvo: ${alvo}`);
    console.error('  Verifique se a role da aplicação é dona do schema public (npm run db:create).\n');
    process.exitCode = 1;
  })
  .finally(closePool);
