/**
 * Define (ou troca) o usuario e a senha do login e grava no .env.
 *
 * O que vai para o arquivo e o HASH scrypt -- a senha digitada nao e´ escrita em
 * lugar nenhum. Toda execucao sorteia um SESSION_SECRET novo, entao trocar a
 * senha derruba na hora as sessoes abertas em qualquer navegador.
 *
 * Nao depende do banco: pode rodar antes do `npm run setup`.
 */
import crypto from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { gerarHash } from '../auth.js';

const ENV = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env');

const REQUISITOS_SENHA = /^.{4,60}$/;
const RE_USUARIO = /^[\p{L}\p{N}._-]+(?: [\p{L}\p{N}._-]+)*$/u;

// --- Entrada no terminal ---------------------------------------------

let escondendo = false;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

// Sem isto, a senha aparece por inteiro na tela enquanto e´ digitada -- e fica na
// rolagem do console depois. Enquanto `escondendo`, o eco do readline e´ engolido
// por inteiro (como no `sudo`: nem asterisco), inclusive o Enter -- quem escreve a
// quebra de linha e´ o perguntar(), para a saida nao depender de como cada versao
// do Node ecoa o Enter. O rotulo da pergunta nao passa por aqui: vai direto ao stdout.
rl._writeToOutput = (texto) => {
  if (!escondendo) {
    process.stdout.write(texto);
    return;
  }

  // A senha continua protegida, mas os asteriscos deixam claro que o campo
  // recebeu a digitacao. Enter e escrito por perguntar() uma unica vez.
  const caracteres = texto.replace(/[\r\n]/g, '').length;
  if (caracteres > 0) process.stdout.write('*'.repeat(caracteres));
};

/**
 * Fila de linhas em vez de rl.question().
 *
 * Com a entrada vinda de um pipe (`echo ... | npm run senha`), o stdin acaba de
 * uma vez: o readline despeja todas as linhas e fecha na hora. Um question()
 * registrado DEPOIS disso -- e ele sempre e´, porque cada pergunta espera a
 * anterior -- nunca receberia sua linha, e o script sairia calado, com codigo 0
 * e sem gravar nada. Guardando as linhas assim que chegam, tanto faz quem chegou
 * primeiro; e quando a entrada termina cedo demais, o erro e´ explicito.
 */
const linhas = [];
const espera = [];
let fim = null;

rl.on('line', (linha) => (espera.shift()?.ok(linha) ?? linhas.push(linha)));
rl.on('close', () => {
  fim = new Error('A entrada terminou antes de todas as respostas.');
  while (espera.length) espera.shift().falha(fim);
});

const proximaLinha = () => new Promise((ok, falha) => {
  if (linhas.length) return ok(linhas.shift());
  if (fim) return falha(fim);
  espera.push({ ok, falha });
});

async function perguntar(rotulo, { senha = false } = {}) {
  process.stdout.write(rotulo);
  escondendo = senha;
  try {
    return await proximaLinha();
  } finally {
    escondendo = false;
    if (senha) process.stdout.write('\n'); // o Enter mascarado nao ecoou sozinho
  }
}

const perguntarSenha = (rotulo) => perguntar(rotulo, { senha: true });

// --- .env ------------------------------------------------------------

async function lerEnv() {
  try {
    return await readFile(ENV, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

function valorAtual(conteudo, chave) {
  const achado = conteudo.match(new RegExp(`^${chave}=(.*)$`, 'm'));
  return achado ? achado[1].trim() : '';
}

/** Reescreve a chave se ela ja existe; senao, acrescenta no fim. Preserva o resto. */
function definir(conteudo, chave, valor) {
  const linha = `${chave}=${valor}`;
  const re = new RegExp(`^${chave}=.*$`, 'm');
  return re.test(conteudo) ? conteudo.replace(re, linha) : `${conteudo.replace(/\s*$/, '')}\n${linha}\n`;
}

// --- Fluxo -----------------------------------------------------------

async function main() {
  const antes = await lerEnv();
  const usuarioAtual = valorAtual(antes, 'AUTH_USUARIO');
  const trocando = Boolean(usuarioAtual && valorAtual(antes, 'AUTH_SENHA_HASH'));

  console.log(trocando
    ? `\n  Trocando a senha do login (usuário atual: ${usuarioAtual}).`
    : '\n  Vamos criar o login do Controlador Financeiro.');
  console.log('  A senha não fica salva em texto — só um hash dela.\n');

  const digitado = (await perguntar(`  Usuário [${usuarioAtual || 'admin'}]: `)).trim();
  const usuario = digitado || usuarioAtual || 'admin';

  if (usuario.length < 3 || usuario.length > 60 || !RE_USUARIO.test(usuario)) {
    throw new Error('Usuário deve ter de 3 a 60 caracteres, sem espaços no início/fim nem espaços repetidos.');
  }

  const senha = await perguntarSenha('  Senha nova: ');
  if (!REQUISITOS_SENHA.test(senha)) {
    throw new Error('A senha deve ter de 4 a 60 caracteres.');
  }

  const confirmacao = await perguntarSenha('  Repita a senha: ');
  if (senha !== confirmacao) {
    throw new Error('As duas senhas não são iguais. Rode de novo.');
  }

  let depois = definir(antes, 'AUTH_USUARIO', usuario);
  depois = definir(depois, 'AUTH_SENHA_HASH', await gerarHash(senha));
  // Segredo novo a cada troca: e´ o que invalida os cookies de sessao antigos.
  depois = definir(depois, 'SESSION_SECRET', crypto.randomBytes(32).toString('hex'));

  await writeFile(ENV, depois, 'utf8');

  console.log(`\nOK: login gravado no .env (usuário: ${usuario}).`);
  if (trocando) console.log('  As sessões abertas em outros navegadores foram encerradas.');
  console.log('  Reinicie o Controlador Financeiro para valer.\n');
}

main()
  .catch((err) => {
    console.error(`\nFALHA: ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => rl?.close());
