/**
 * Cria dois usuarios no banco do CI, com o kit padrao de cada um.
 *
 * Sao DOIS, e nao um, de proposito: o smoke tem uma bateria que so´ faz sentido com mais
 * de uma pessoa no banco -- a que prova que o PostgreSQL RECUSA uma transacao de A
 * apontando para a categoria ou a conta de B (migration 012). Com um usuario so´, esses
 * testes viram SKIP e o CI passaria sem nunca exercitar o isolamento, que e´ justamente
 * a garantia mais importante do schema.
 *
 * Roda so´ no GitHub Actions, contra um Postgres descartavel.
 */
import { pool, closePool } from '../../src/db.js';
import { gerarHash } from '../../src/auth.js';
import { garantirPadroes } from '../../src/services/categoriasPadrao.js';

const USUARIOS = ['ci_um', 'ci_dois'];

try {
  for (const nome of USUARIOS) {
    const { rows } = await pool.query(
      `INSERT INTO usuarios (usuario, senha_hash) VALUES ($1, $2)
       ON CONFLICT (usuario) DO UPDATE SET usuario = EXCLUDED.usuario
       RETURNING id`,
      [nome, gerarHash('senha-de-teste-do-ci')],
    );
    await garantirPadroes(pool, rows[0].id);
    console.log(`  + usuario ${nome} (id ${rows[0].id}) com o kit padrao`);
  }
} finally {
  await closePool();
}
