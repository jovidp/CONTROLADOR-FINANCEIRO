/**
 * Restaura um backup por cima do banco atual.
 *
 *   npm run db:restore -- backups/controlador_financeiro_2026-07-14-10-00-00_manual.dump.enc
 *
 * Aceita o arquivo cifrado (.dump.enc) e o antigo em texto claro (.dump) -- ele descobre
 * pela assinatura, e nao pelo nome. O cifrado e´ decifrado para um arquivo TEMPORARIO,
 * que e´ apagado no fim, aconteca o que acontecer (por isso o `finally`): deixar o dump
 * em claro no disco depois de restaurar desfaria a razao de te-lo cifrado.
 *
 * `--clean` no pg_restore: APAGA os objetos antes de recriar. E´ o que faz "restaurar"
 * significar "voltar exatamente ao backup", e nao "misturar o backup com o que ja´ tem".
 * Justamente por isso, tiramos um backup do estado ATUAL antes -- se o arquivo estiver
 * errado, ainda da´ para voltar.
 */
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { decifrarArquivo } from '../cripto.js';
import { sob } from '../manutencao.js';
import { acharBinarioPg, backup } from './backup.js';

function pgRestore(arquivo) {
  const exe = acharBinarioPg('pg_restore');

  return new Promise((resolvido, rejeitado) => {
    const proc = spawn(
      exe,
      [
        '-h', config.db.host,
        '-p', String(config.db.port),
        '-U', config.db.user,
        '-d', config.db.database,
        '--clean',
        '--if-exists', // sem isto, o --clean grita em cada objeto que ainda nao existe
        '--no-owner',
        arquivo,
      ],
      { env: { ...process.env, PGPASSWORD: config.db.password }, stdio: ['ignore', 'inherit', 'inherit'] },
    );

    proc.on('error', (err) => {
      rejeitado(
        err.code === 'ENOENT'
          ? new Error(`pg_restore não encontrado (tentei "${exe}"). Instale o PostgreSQL client ou ajuste o PATH.`)
          : err,
      );
    });
    proc.on('exit', (codigo) => {
      if (codigo === 0) resolvido();
      else rejeitado(new Error(`pg_restore saiu com código ${codigo}.`));
    });
  });
}

async function restaurar(alvo) {
  if (!existsSync(alvo)) throw new Error(`Arquivo não encontrado: ${alvo}`);

  console.log('\n  Antes de restaurar, guardo o estado ATUAL — caso o arquivo não seja o que você espera.');
  await backup('antes-do-restore');

  let temporario = null;
  try {
    let paraRestaurar = alvo;

    if (alvo.endsWith('.enc')) {
      if (!config.backup.chave) {
        throw new Error('Este backup está cifrado, mas a BACKUP_CHAVE do .env está vazia.');
      }
      temporario = path.join(os.tmpdir(), `cf-restore-${crypto.randomBytes(8).toString('hex')}.dump`);
      console.log('  ... decifrando');
      await decifrarArquivo(alvo, temporario, config.backup.chave);
      paraRestaurar = temporario;
    }

    console.log('  ... restaurando');
    await pgRestore(paraRestaurar);
  } finally {
    if (temporario) await rm(temporario, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const alvo = process.argv[2];

  if (!alvo) {
    console.error('\n  Diga QUAL backup restaurar:');
    console.error('    npm run db:restore -- backups/<arquivo>.dump.enc\n');
    process.exitCode = 1;
  } else {
    // `sob`: enquanto o pg_restore roda, o app fica na pagina de manutencao. Um
    // lancamento gravado no meio de um --clean bateria numa tabela que acabou de sumir.
    sob('Restaurando um backup. Já voltamos.', () => restaurar(path.resolve(alvo)))
      .then(() => console.log('\nOK: backup restaurado.\n'))
      .catch((err) => {
        console.error(`\nFALHA no restore: ${err.message}\n`);
        process.exitCode = 1;
      });
  }
}
