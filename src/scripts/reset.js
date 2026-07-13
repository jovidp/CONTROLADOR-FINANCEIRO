/**
 * DESTRUTIVO: derruba e recria o schema da aplicacao.
 * DROP SCHEMA public CASCADE + CREATE SCHEMA public -- some tudo: tabelas, dados,
 * TODOS os usuarios, a view vw_saldo_contas e o historico em schema_migrations.
 *
 * Exige CONFIRMAR=<nome do banco>. Faz backup antes de derrubar -- e aborta se o
 * backup falhar, porque este e´ o comando mais irreversivel do projeto.
 */
import { withTransaction, closePool } from '../db.js';
import { alvo, exigirConfirmacao, encerrarCom } from './guardas.js';
import { backup } from './backup.js';
import { sob } from '../manutencao.js';

async function main() {
  exigirConfirmacao('db:reset', [
    'Este comando executa DROP SCHEMA public CASCADE.',
    'Todas as tabelas, TODOS os usuários, lançamentos, orçamentos, metas',
    'e recorrentes são apagados. O banco fica vazio.',
  ]);

  console.log(`\n  Apagando o schema public de ${alvo}...\n`);

  await sob('Recriando o banco do zero. Já voltamos.', async () => {
    // Se o pg_dump falhar, o `await` lanca e o DROP SCHEMA nunca roda.
    await backup('pre-reset');

    await withTransaction(async (client) => {
      await client.query('DROP SCHEMA IF EXISTS public CASCADE');
      await client.query('CREATE SCHEMA public');
      // Quem cria o schema ja vira dono dele; o GRANT abaixo so deixa explicito.
      // CURRENT_USER e palavra-chave do SQL, nao um identificador interpolado.
      await client.query('GRANT ALL ON SCHEMA public TO CURRENT_USER');
    });
  });

  console.log('  = schema public recriado (vazio)');
  console.log('\nOK: banco zerado. Próximos passos:');
  console.log('  npm run db:migrate    (recria as tabelas)');
  console.log('  npm run db:seed       (opcional: dados de exemplo)');
  console.log('\n  Mudou de ideia? O backup de antes do reset está em backups/:');
  console.log('  pg_restore -h localhost -U fin_app -d <banco> --clean backups/<arquivo>.dump\n');
}

main()
  .catch((err) => {
    if (err.message?.includes('schema')) {
      console.error('  Verifique se a role da aplicação é dona do schema public (npm run db:create).');
    }
    encerrarCom(err, 'db:reset');
  })
  .finally(closePool);
