/**
 * Criptografia dos backups.
 *
 * O banco em si nao e´ cifrado, e nao deve ser: os valores precisam ser SOMADOS pelo
 * PostgreSQL (a `vw_saldo_contas` deriva o saldo das transacoes), e um numero cifrado
 * nao soma. Alem disso nao protegeria de nada -- quem chega ao seu Windows chega ao
 * .env, onde a chave estaria.
 *
 * O backup e´ outra historia: e´ o UNICO lugar onde os seus dados saem da maquina
 * inteiros, num arquivo so´, que vai para um pendrive, um e-mail ou uma nuvem. E´ ele
 * que vale cifrar.
 *
 * AES-256-GCM: cifra E autentica. Um .enc adulterado nao decifra "quase certo" -- ele
 * FALHA, alto e claro, na hora de conferir a etiqueta (tag). A chave nao e´ a senha em
 * si: e´ derivada dela com scrypt, com um salt novo a cada arquivo, para que dois
 * backups da mesma chave nao compartilhem a mesma chave real.
 *
 * Formato: "CFBK1" | salt(16) | iv(12) | <cifrado> | tag(16)
 * A tag vai no FIM porque o GCM so´ a conhece depois de cifrar o ultimo byte.
 */
import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';

const MAGIC = Buffer.from('CFBK1', 'utf8');
const TAM_SALT = 16;
const TAM_IV = 12;
const TAM_TAG = 16;
const TAM_CABECALHO = MAGIC.length + TAM_SALT + TAM_IV;

export const EXTENSAO = '.enc';

const SCRYPT = { N: 16384, r: 8, p: 1 };

// scrypt ASSINCRONO (threadpool do libuv). A versao Sync custa ~100ms de CPU e, num app
// single-thread, o hash de UM usuario segurava as requisicoes de TODOS (DoS de event loop).
const scrypt = promisify(crypto.scrypt);
const derivar = (chave, salt) => scrypt(chave, salt, 32, SCRYPT);

// --- Cifra de string curta (segredo TOTP em repouso) -----------------
//
// Diferente dos backups (arquivos, em stream), aqui e´ um texto curto. Formato do
// resultado: "enc:" + base64(salt|iv|cifrado|tag). O prefixo distingue um valor
// cifrado de um legado em claro -- assim a leitura sabe se precisa decifrar.

const PREFIXO = 'enc:';

/** Cifra um texto. Sem chave, devolve o texto em claro (o chamador decide se aceita). */
export async function cifrarTexto(texto, chave) {
  if (!chave) return texto;
  const salt = crypto.randomBytes(TAM_SALT);
  const iv = crypto.randomBytes(TAM_IV);
  const cifra = crypto.createCipheriv('aes-256-gcm', await derivar(chave, salt), iv);
  const corpo = Buffer.concat([cifra.update(String(texto), 'utf8'), cifra.final()]);
  const pacote = Buffer.concat([salt, iv, corpo, cifra.getAuthTag()]);
  return PREFIXO + pacote.toString('base64');
}

/** Decifra o que cifrarTexto gerou. Um valor sem o prefixo e´ tratado como texto legado. */
export async function decifrarTexto(valor, chave) {
  if (typeof valor !== 'string' || !valor.startsWith(PREFIXO)) return valor;
  if (!chave) throw new Error('BACKUP_CHAVE ausente: não há como decifrar o segredo.');

  const pacote = Buffer.from(valor.slice(PREFIXO.length), 'base64');
  const salt = pacote.subarray(0, TAM_SALT);
  const iv = pacote.subarray(TAM_SALT, TAM_SALT + TAM_IV);
  const tag = pacote.subarray(pacote.length - TAM_TAG);
  const corpo = pacote.subarray(TAM_SALT + TAM_IV, pacote.length - TAM_TAG);

  const decifra = crypto.createDecipheriv('aes-256-gcm', await derivar(chave, salt), iv);
  decifra.setAuthTag(tag);
  return Buffer.concat([decifra.update(corpo), decifra.final()]).toString('utf8');
}

/** Cifra `entrada` em `saida`. Devolve o caminho de saida. */
export async function cifrarArquivo(entrada, saida, chave) {
  if (!chave) throw new Error('BACKUP_CHAVE vazia: não há com o que cifrar.');

  const salt = crypto.randomBytes(TAM_SALT);
  const iv = crypto.randomBytes(TAM_IV);
  const cifra = crypto.createCipheriv('aes-256-gcm', await derivar(chave, salt), iv);

  const destino = createWriteStream(saida);
  destino.write(MAGIC);
  destino.write(salt);
  destino.write(iv);

  // `end: false` porque ainda falta a tag: deixar o pipeline fechar o arquivo aqui
  // gravaria um .enc sem etiqueta -- e ele nao decifraria nunca mais.
  await pipeline(createReadStream(entrada), cifra, destino, { end: false });

  destino.end(cifra.getAuthTag());
  await once(destino, 'finish');

  return saida;
}

/**
 * Decifra `entrada` em `saida`.
 *
 * Lanca se a chave estiver errada OU se o arquivo tiver sido adulterado -- o GCM nao
 * distingue os dois casos, e e´ bom que nao distinga: ambos significam "nao confie
 * neste conteudo".
 */
export async function decifrarArquivo(entrada, saida, chave) {
  if (!chave) throw new Error('BACKUP_CHAVE vazia: não há com o que decifrar.');

  const { size } = await stat(entrada);
  if (size < TAM_CABECALHO + TAM_TAG) {
    throw new Error('Arquivo pequeno demais para ser um backup cifrado (truncado?).');
  }

  const arquivo = await open(entrada, 'r');
  let cabecalho;
  let tag;
  try {
    cabecalho = Buffer.alloc(TAM_CABECALHO);
    await arquivo.read(cabecalho, 0, TAM_CABECALHO, 0);

    tag = Buffer.alloc(TAM_TAG);
    await arquivo.read(tag, 0, TAM_TAG, size - TAM_TAG);
  } finally {
    await arquivo.close();
  }

  if (!cabecalho.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('Isto não é um backup cifrado por este app (assinatura CFBK1 ausente).');
  }

  const salt = cabecalho.subarray(MAGIC.length, MAGIC.length + TAM_SALT);
  const iv = cabecalho.subarray(MAGIC.length + TAM_SALT);

  const decifra = crypto.createDecipheriv('aes-256-gcm', await derivar(chave, salt), iv);
  decifra.setAuthTag(tag);

  try {
    await pipeline(
      // `end` do createReadStream e´ INCLUSIVO: o ultimo byte do cifrado e´ o que vem
      // logo antes da tag.
      createReadStream(entrada, { start: TAM_CABECALHO, end: size - TAM_TAG - 1 }),
      decifra,
      createWriteStream(saida),
    );
  } catch (err) {
    // A mensagem crua do OpenSSL ("Unsupported state or unable to authenticate data")
    // nao diz a ninguem o que fazer.
    throw new Error(
      'Não consegui decifrar o backup: a BACKUP_CHAVE do .env não é a mesma usada '
      + `para gerá-lo, ou o arquivo foi corrompido. (${err.message})`,
    );
  }

  return saida;
}
