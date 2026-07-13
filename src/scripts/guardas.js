/**
 * Guardas dos scripts destrutivos (limpar, reset, seed).
 *
 * Duas travas, porque as duas ja´ falharam de formas diferentes:
 *
 * 1) CONFIRMAR tem de ser o NOME DO BANCO, e nao "sim". No PowerShell,
 *    `$env:CONFIRMAR="sim"` vale pela SESSAO INTEIRA: depois do primeiro reset,
 *    qualquer `npm run db:limpar` digitado por engano na mesma janela executava
 *    direto, sem perguntar nada. Digitar o nome do banco e´ especifico demais para
 *    sobrar de um comando anterior, e obriga a ler qual banco vai ser atingido.
 *
 * 2) USUARIO e´ obrigatorio em tudo que apaga LANCAMENTO. O app virou multiusuario
 *    na migration 006, mas estes scripts continuaram fazendo `DELETE FROM transacoes`
 *    sem WHERE -- ou seja, apagando a vida financeira de TODOS os cadastrados. Sem um
 *    usuario escolhido, o script agora se recusa a rodar.
 */
import { pool } from '../db.js';
import { config } from '../config.js';

export const alvo = `${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`;

export class Abortado extends Error {}

/** Trava 1: CONFIRMAR=<nome do banco>. */
export function exigirConfirmacao(comando, oQueFaz) {
  if (process.env.CONFIRMAR === config.db.database) return;

  console.error(`\n  ${comando.toUpperCase()} ABORTADO — nada foi apagado.\n`);
  for (const linha of oQueFaz) console.error(`  ${linha}`);
  console.error(`\n  Alvo: ${alvo}`);
  console.error('  Não há como desfazer (mas um backup automático é gerado antes).\n');
  console.error('  Para confirmar, repita o NOME DO BANCO na variável CONFIRMAR:\n');
  console.error(`    PowerShell:   $env:CONFIRMAR="${config.db.database}"; npm run ${comando}`);
  console.error(`    CMD:          set CONFIRMAR=${config.db.database} && npm run ${comando}`);
  console.error(`    Linux/macOS:  CONFIRMAR=${config.db.database} npm run ${comando}\n`);

  throw new Abortado('confirmação ausente');
}

/** Trava 2: USUARIO=<id> existente. Devolve { id, usuario }. */
export async function exigirUsuario(comando) {
  const { rows: usuarios } = await pool.query('SELECT id, usuario FROM usuarios ORDER BY id');
  const pedido = Number(process.env.USUARIO);
  const escolhido = usuarios.find((u) => u.id === pedido);
  if (escolhido) return escolhido;

  console.error(`\n  ${comando.toUpperCase()} ABORTADO — nada foi apagado.\n`);
  if (!process.env.USUARIO) {
    console.error('  Este comando apaga LANÇAMENTOS, e o banco tem mais de um usuário.');
    console.error('  Sem escolher um, ele atingiria a vida financeira de TODOS.\n');
  } else {
    console.error(`  Não existe usuário com id ${process.env.USUARIO}.\n`);
  }

  console.error('  Usuários cadastrados:\n');
  for (const u of usuarios) console.error(`    USUARIO=${u.id}  →  ${u.usuario}`);

  // O exemplo usa um id que EXISTE: sugerir "USUARIO=1" num banco cujos ids comecam
  // em 5 e´ mandar o usuario copiar um comando que ja´ nasce quebrado.
  const exemplo = usuarios[0]?.id ?? 1;
  console.error('\n  Escolha um e repita o comando:\n');
  console.error(`    PowerShell:   $env:USUARIO="${exemplo}"; $env:CONFIRMAR="${config.db.database}"; npm run ${comando}`);
  console.error(`    Linux/macOS:  USUARIO=${exemplo} CONFIRMAR=${config.db.database} npm run ${comando}\n`);

  throw new Abortado('usuário não escolhido');
}

/** Encerra o script: silencioso se foi guarda (ja´ explicou), ruidoso se foi erro. */
export function encerrarCom(err, comando) {
  if (!(err instanceof Abortado)) {
    console.error(`\nFALHA no ${comando}: ${err.message}`);
    console.error(`  Alvo: ${alvo}\n`);
  }
  process.exitCode = 1;
}
