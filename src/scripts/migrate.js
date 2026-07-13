/**
 * Aplica os arquivos .sql de db/migrations em ordem alfabetica.
 * Cada migration roda dentro de uma transacao e e´ registrada em schema_migrations,
 * entao rodar de novo e´ seguro (no-op).
 *
 * Sobe a pagina de manutencao enquanto trabalha: uma migration que mexe em constraint
 * (a 012 mexe) nao pode competir com o app gravando lancamento no meio.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool, withTransaction, closePool } from '../db.js';
import { sob } from '../manutencao.js';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations');

// Trava ENTRE PROCESSOS. Sem ela, dois `npm run db:migrate` disparados juntos liam a
// lista de aplicadas antes de qualquer um gravar -- e os dois aplicavam a mesma
// migration. O advisory lock e´ do proprio Postgres e cai sozinho se o processo morrer.
const LOCK = "SELECT pg_advisory_lock(hashtext('controlador-financeiro:migrations'))";
const UNLOCK = "SELECT pg_advisory_unlock(hashtext('controlador-financeiro:migrations'))";

async function aplicarPendentes() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      nome        text PRIMARY KEY,
      aplicada_em timestamptz NOT NULL DEFAULT now()
    )`);

  await pool.query(LOCK);
  try {
    const { rows } = await pool.query('SELECT nome FROM schema_migrations');
    const aplicadas = new Set(rows.map((r) => r.nome));

    const arquivos = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();
    let novas = 0;

    for (const arquivo of arquivos) {
      if (aplicadas.has(arquivo)) {
        console.log(`  = ${arquivo} (ja aplicada)`);
        continue;
      }
      const sql = await readFile(path.join(DIR, arquivo), 'utf8');
      await withTransaction(async (client) => {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (nome) VALUES ($1)', [arquivo]);
      });
      console.log(`  + ${arquivo} aplicada`);
      novas++;
    }

    return novas;
  } finally {
    await pool.query(UNLOCK);
  }
}

async function main() {
  const novas = await sob('Atualizando a estrutura do banco. Já voltamos.', aplicarPendentes);
  console.log(novas ? `\nOK: ${novas} migration(s) aplicada(s).` : '\nOK: banco ja estava atualizado.');
}

main()
  .catch((err) => {
    console.error('\nFALHA na migration:', err.message);
    console.error('  Nada ficou pela metade: cada migration roda dentro de uma transação.\n');
    process.exitCode = 1;
  })
  .finally(closePool);
