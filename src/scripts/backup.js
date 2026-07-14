/**
 * Backup do banco com pg_dump, no formato custom (-F c): comprimido e restauravel
 * tabela a tabela com pg_restore.
 *
 *   npm run db:backup
 *
 * Tambem e´ importado pelos scripts destrutivos (limpar, reset, seed), que fazem um
 * backup ANTES de apagar qualquer coisa -- e abortam se o backup falhar. Um comando
 * irreversivel sem rede embaixo e´ o tipo de coisa que so´ da´ errado uma vez.
 *
 * Com BACKUP_CHAVE preenchida no .env, o dump sai CIFRADO (.dump.enc) e o texto claro e´
 * apagado -- ver src/cripto.js. Restaurar, nos dois casos:
 *
 *   npm run db:restore -- backups/<arquivo>
 */
import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { cifrarArquivo, EXTENSAO } from '../cripto.js';
import { sob } from '../manutencao.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(RAIZ, 'backups');

// Quantos dumps guardar. Sem poda, um backup por reset/limpar/seed enche o disco
// com copias de um banco que cabe num e-mail.
const MANTER = 20;

/**
 * O instalador do PostgreSQL no Windows NAO poe os binarios no PATH. Chamar
 * `pg_dump` cru funciona no Linux e falha na maquina onde este app roda -- entao
 * procuramos o .exe no lugar de sempre antes de desistir.
 *
 * Exportado porque o restore precisa achar o `pg_restore` exatamente do mesmo jeito.
 */
export function acharBinarioPg(nome) {
  if (process.platform !== 'win32') return nome;

  const base = 'C:/Program Files/PostgreSQL';
  if (existsSync(base)) {
    // Versao mais nova primeiro (18 antes de 16).
    const versoes = readdirSync(base).sort((a, b) => Number(b) - Number(a));
    for (const v of versoes) {
      const exe = path.join(base, v, 'bin', `${nome}.exe`);
      if (existsSync(exe)) return exe;
    }
  }
  return nome; // Ultima tentativa: quem sabe esta´ no PATH.
}

async function podar() {
  const arquivos = (await readdir(DIR))
    // `.dump` e `.dump.enc` entram na MESMA poda: sao a mesma coisa, cifrada ou nao, e
    // contar so´ um dos dois deixaria os antigos acumulando para sempre depois que a
    // BACKUP_CHAVE fosse ligada.
    .filter((f) => f.endsWith('.dump') || f.endsWith(`.dump${EXTENSAO}`))
    .map((f) => path.join(DIR, f));
  if (arquivos.length <= MANTER) return;

  const comData = await Promise.all(
    arquivos.map(async (f) => ({ f, t: (await stat(f)).mtimeMs })),
  );
  comData.sort((a, b) => b.t - a.t);

  for (const { f } of comData.slice(MANTER)) {
    await rm(f, { force: true });
    console.log(`  - backup antigo removido: ${path.basename(f)}`);
  }
}

/** Gera o dump e devolve o caminho. Lanca se o pg_dump falhar. */
export async function backup(motivo = 'manual') {
  await mkdir(DIR, { recursive: true });

  const carimbo = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const arquivo = path.join(DIR, `${config.db.database}_${carimbo}_${motivo}.dump`);
  const pgDump = acharBinarioPg('pg_dump');

  console.log(`  ... gerando backup (${motivo})`);

  await new Promise((resolvido, rejeitado) => {
    const proc = spawn(
      pgDump,
      [
        '-h', config.db.host,
        '-p', String(config.db.port),
        '-U', config.db.user,
        '-d', config.db.database,
        '-F', 'c', // formato custom: comprimido e restauravel seletivamente
        '-f', arquivo,
      ],
      // A senha vai por PGPASSWORD e nao por -W: assim o pg_dump nao para pedindo
      // senha no terminal (e travaria um script rodando pela Tarefa Agendada).
      { env: { ...process.env, PGPASSWORD: config.db.password }, stdio: ['ignore', 'inherit', 'inherit'] },
    );

    proc.on('error', (err) => {
      rejeitado(
        err.code === 'ENOENT'
          ? new Error(`pg_dump não encontrado (tentei "${pgDump}"). Instale o PostgreSQL client ou ajuste o PATH.`)
          : err,
      );
    });
    proc.on('exit', (codigo) => {
      if (codigo === 0) resolvido();
      else rejeitado(new Error(`pg_dump saiu com código ${codigo} — backup NÃO foi gerado.`));
    });
  });

  // Cifra o dump e APAGA o texto claro. A ordem importa: enquanto o .dump original
  // existir, o .enc ao lado nao protege nada.
  let final = arquivo;
  if (config.backup.chave) {
    final = `${arquivo}${EXTENSAO}`;
    try {
      await cifrarArquivo(arquivo, final, config.backup.chave);
    } catch (err) {
      // O .enc pela metade seria pior que backup nenhum: parece um backup e nao e´.
      await rm(final, { force: true });
      throw new Error(`falha ao cifrar o backup: ${err.message}`);
    }
    await rm(arquivo, { force: true });
  } else {
    console.warn('  ! BACKUP_CHAVE vazia no .env: este backup está em TEXTO CLARO.');
  }

  const { size } = await stat(final);
  console.log(`  = backup salvo: backups/${path.basename(final)} (${(size / 1024).toFixed(0)} KB)`);

  await podar();
  return final;
}

// Rodado direto (`npm run db:backup`), e nao importado por outro script.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  sob('Fazendo backup do banco. Já voltamos.', () => backup('manual'))
    .then(() => console.log('\nOK: backup concluído.\n'))
    .catch((err) => {
      console.error(`\nFALHA no backup: ${err.message}\n`);
      process.exitCode = 1;
    });
}
