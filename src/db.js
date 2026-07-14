import pg from 'pg';
import { config } from './config.js';

const { Pool, types } = pg;

// --- Parsers de tipo -------------------------------------------------
// Sem isto, o driver devolve numeric como string ("1234.50") e DATE como
// objeto Date convertido para o fuso local -- o que faz uma transacao de
// 2026-07-01 aparecer como 2026-06-30. Ambos causam bugs silenciosos.
types.setTypeParser(types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
types.setTypeParser(types.builtins.INT8, (v) => (v === null ? null : Number(v)));
types.setTypeParser(types.builtins.DATE, (v) => v); // mantem 'YYYY-MM-DD' cru

export const pool = new Pool({
  ...config.db,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  // Teto por query: o Postgres cancela sozinho o que passar de 15s. Sem isto, uma
  // consulta cara (relatorio com intervalo enorme, busca com curinga a esquerda) podia
  // segurar uma das 10 conexoes indefinidamente e, repetida, esgotar o pool -- travando
  // a API para todos. 15s e´ folgado para o uso normal e curto para um abuso.
  statement_timeout: 15_000,
  application_name: 'controlador-financeiro',
});

pool.on('error', (err) => {
  console.error('[db] erro em conexao ociosa:', err.message);
});

export function query(text, params) {
  return pool.query(text, params);
}

/** Executa `fn` dentro de uma transacao, com COMMIT/ROLLBACK automatico. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool() {
  await pool.end();
}
