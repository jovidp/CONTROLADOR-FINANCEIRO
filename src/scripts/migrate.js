/**
 * Aplica os arquivos .sql de db/migrations em ordem alfabetica.
 * Cada migration roda dentro de uma transacao e e registrada em
 * schema_migrations, entao rodar de novo e seguro (no-op).
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool, withTransaction, closePool } from '../db.js';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations');

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      nome        text PRIMARY KEY,
      aplicada_em timestamptz NOT NULL DEFAULT now()
    )`);

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

  console.log(novas ? `\nOK: ${novas} migration(s) aplicada(s).` : '\nOK: banco ja estava atualizado.');
}

main()
  .catch((err) => {
    console.error('\nFALHA na migration:', err.message);
    process.exitCode = 1;
  })
  .finally(closePool);
