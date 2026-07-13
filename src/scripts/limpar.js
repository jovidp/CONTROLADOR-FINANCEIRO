/**
 * DESTRUTIVO: apaga os LANCAMENTOS DE UM USUARIO, deixando a conta dele zerada
 * para uso real.
 *
 * Some: transacoes, parcelamentos, aportes, metas, orcamentos e recorrentes.
 * Fica de pe: as CATEGORIAS e as CONTAS (com saldo_inicial zerado, porque os saldos
 * que o seed inventou -- Poupanca 5.200, Carteira 1.800 -- sao dado de exemplo como
 * qualquer outro e apareceriam como dinheiro fantasma).
 *
 * Diferenca para o `db:reset`: aquele derruba o schema inteiro (DROP SCHEMA) e exige
 * rodar as migrations de novo. Este preserva a estrutura e o cadastro base.
 *
 * Exige USUARIO=<id> e CONFIRMAR=<nome do banco>. Faz backup antes de apagar.
 */
import { withTransaction, closePool } from '../db.js';
import { alvo, exigirConfirmacao, exigirUsuario, encerrarCom } from './guardas.js';
import { backup } from './backup.js';
import { sob } from '../manutencao.js';

// Ordem importa: os filhos saem antes dos pais por causa das foreign keys.
//
// `parcelamentos` estava FALTANDO nesta lista. O CASCADE vai de parcelamentos para
// transacoes, e nao o contrario: apagar as transacoes deixava a compra parcelada (o
// pai) viva no banco, sem nenhuma parcela -- e a tela passava a listar compras
// fantasma, com "0 de 12 parcelas".
const TABELAS = ['transacoes', 'parcelamentos', 'meta_aportes', 'metas', 'orcamentos', 'recorrentes'];

// meta_aportes nao tem usuario_id proprio: o dono vem da meta.
const FILTRO = {
  meta_aportes: 'DELETE FROM meta_aportes WHERE meta_id IN (SELECT id FROM metas WHERE usuario_id = $1)',
};

async function main() {
  exigirConfirmacao('db:limpar', [
    'Este comando apaga TODOS os lançamentos de UM usuário:',
    `  ${TABELAS.join(', ')}.`,
    'Também zera o saldo inicial das contas dele.',
    'As categorias e as contas em si são preservadas.',
  ]);

  const usuario = await exigirUsuario('db:limpar');

  console.log(`\n  Limpando os lançamentos de "${usuario.usuario}" (id ${usuario.id}) em ${alvo}...\n`);

  await sob(`Limpando os lançamentos de ${usuario.usuario}. Já voltamos.`, async () => {
    // Backup ANTES de tocar em qualquer coisa: se o pg_dump falhar, o `await` lanca
    // e nenhum DELETE chega a rodar.
    await backup('pre-limpar');

    await withTransaction(async (client) => {
      for (const tabela of TABELAS) {
        // Nome de tabela vem da constante acima, nunca de entrada externa.
        const sql = FILTRO[tabela] ?? `DELETE FROM ${tabela} WHERE usuario_id = $1`;
        const { rowCount } = await client.query(sql, [usuario.id]);
        console.log(`  - ${String(rowCount).padStart(4)} removido(s) de ${tabela}`);
      }

      const { rowCount } = await client.query(
        'UPDATE contas SET saldo_inicial = 0 WHERE usuario_id = $1 AND saldo_inicial <> 0',
        [usuario.id],
      );
      console.log(`  - ${String(rowCount).padStart(4)} conta(s) com saldo inicial zerado`);

      const { rows: [r] } = await client.query(
        `SELECT (SELECT count(*) FROM categorias WHERE usuario_id = $1) AS cats,
                (SELECT count(*) FROM contas     WHERE usuario_id = $1) AS contas`,
        [usuario.id],
      );
      console.log(`\n  = preservados: ${r.cats} categorias, ${r.contas} contas`);
    });
  });

  console.log(`\nOK: a conta de "${usuario.usuario}" está zerada. Os outros usuários não foram tocados.`);
  console.log('  (para trazer os dados de exemplo de volta: npm run db:seed)\n');
}

main()
  .catch((err) => encerrarCom(err, 'db:limpar'))
  .finally(closePool);
