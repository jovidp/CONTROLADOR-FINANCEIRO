/**
 * src/cripto.js: o que protege o backup quando ele sai da maquina.
 *
 * O teste que importa nao e´ "cifra e decifra" (isso qualquer coisa faz) -- e´ que
 * decifrar com a chave errada, ou com o arquivo adulterado, FALHA em vez de devolver
 * lixo em silencio. Um backup que "restaura" um dump corrompido e´ pior que um backup
 * que nao restaura: o erro so´ aparece com o banco ja´ apagado.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { cifrarArquivo, decifrarArquivo, cifrarTexto, decifrarTexto } from '../src/cripto.js';

const CHAVE = 'chave-de-teste-nao-usada-em-lugar-nenhum';

/** Um pouco de conteudo binario, como um pg_dump de verdade -- nao so´ texto ASCII. */
const CONTEUDO = Buffer.concat([
  Buffer.from('PGDMP\x00\x01', 'binary'),
  crypto.randomBytes(200_000), // grande o bastante para passar por varios chunks do stream
]);

async function comPasta(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cf-cripto-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('cifrarTexto/decifrarTexto: segredo TOTP em repouso (round-trip, chave errada, legado)', async () => {
  const segredo = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

  const enc = await cifrarTexto(segredo, CHAVE);
  assert.ok(enc.startsWith('enc:'), 'tem o prefixo enc:');
  assert.ok(!enc.includes(segredo), 'o texto em claro não aparece');
  assert.equal(await decifrarTexto(enc, CHAVE), segredo, 'volta idêntico');

  await assert.rejects(() => decifrarTexto(enc, 'chave-errada'), 'chave errada não decifra');

  // Sem prefixo = valor legado em claro: passa direto (compatibilidade).
  assert.equal(await decifrarTexto(segredo, CHAVE), segredo);
  // Sem chave, cifrarTexto devolve em claro (o chamador avisa/decide).
  assert.equal(await cifrarTexto(segredo, ''), segredo);
});

test('cifrar e decifrar devolve o arquivo IDÊNTICO, byte a byte', async () => {
  await comPasta(async (dir) => {
    const original = path.join(dir, 'a.dump');
    const cifrado = path.join(dir, 'a.dump.enc');
    const voltou = path.join(dir, 'b.dump');

    await writeFile(original, CONTEUDO);
    await cifrarArquivo(original, cifrado, CHAVE);

    // O cifrado nao pode conter o conteudo em claro -- e´ o minimo que se espera dele.
    const bytes = await readFile(cifrado);
    assert.ok(!bytes.includes(Buffer.from('PGDMP', 'binary')), 'o cabeçalho do dump não pode vazar');
    assert.equal(bytes.subarray(0, 5).toString(), 'CFBK1');

    await decifrarArquivo(cifrado, voltou, CHAVE);
    assert.deepEqual(await readFile(voltou), CONTEUDO);
  });
});

test('o mesmo conteúdo, cifrado duas vezes, dá arquivos diferentes', async () => {
  await comPasta(async (dir) => {
    const original = path.join(dir, 'a.dump');
    await writeFile(original, CONTEUDO);

    await cifrarArquivo(original, path.join(dir, '1.enc'), CHAVE);
    await cifrarArquivo(original, path.join(dir, '2.enc'), CHAVE);

    // Salt e IV novos a cada arquivo. Se fossem fixos, dois backups iguais gerariam
    // bytes iguais -- e quem olhasse a pasta saberia que nada mudou entre eles.
    assert.notDeepEqual(await readFile(path.join(dir, '1.enc')), await readFile(path.join(dir, '2.enc')));
  });
});

test('chave errada FALHA — não devolve lixo', async () => {
  await comPasta(async (dir) => {
    const original = path.join(dir, 'a.dump');
    const cifrado = path.join(dir, 'a.enc');

    await writeFile(original, CONTEUDO);
    await cifrarArquivo(original, cifrado, CHAVE);

    await assert.rejects(
      () => decifrarArquivo(cifrado, path.join(dir, 'saida.dump'), 'chave-errada'),
      /BACKUP_CHAVE/,
    );
  });
});

test('arquivo adulterado FALHA — o GCM percebe um byte trocado', async () => {
  await comPasta(async (dir) => {
    const original = path.join(dir, 'a.dump');
    const cifrado = path.join(dir, 'a.enc');

    await writeFile(original, CONTEUDO);
    await cifrarArquivo(original, cifrado, CHAVE);

    const bytes = await readFile(cifrado);
    bytes[bytes.length - 40] ^= 0xff; // um bit no meio do conteudo cifrado
    await writeFile(cifrado, bytes);

    await assert.rejects(() => decifrarArquivo(cifrado, path.join(dir, 'saida.dump'), CHAVE));
  });
});

test('arquivo que não é nosso é recusado antes de tentar decifrar', async () => {
  await comPasta(async (dir) => {
    const impostor = path.join(dir, 'x.enc');
    await writeFile(impostor, Buffer.alloc(100, 7)); // 100 bytes de nada

    await assert.rejects(
      () => decifrarArquivo(impostor, path.join(dir, 'saida.dump'), CHAVE),
      /CFBK1/,
    );
  });
});
