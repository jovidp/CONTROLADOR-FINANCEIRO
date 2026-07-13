/**
 * Login de usuario unico.
 *
 * As credenciais moram no .env (AUTH_USUARIO, AUTH_SENHA_HASH, SESSION_SECRET) e
 * sao geradas por `npm run senha`. A senha em texto puro nunca e´ gravada em
 * lugar nenhum -- nem no .env, nem no banco, nem em log.
 *
 * A sessao e´ um cookie assinado (HMAC-SHA256), sem estado no servidor: reiniciar
 * o app nao desloga ninguem e nao existe tabela de sessoes para manter viva.
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';
import { pool, withTransaction } from './db.js';
import { HttpError } from './http.js';
import { garantirPadroes } from './services/categoriasPadrao.js';

const scrypt = promisify(crypto.scrypt);

const COOKIE = 'cf_sessao';
const HORAS_SESSAO = 12;
const DIAS_LEMBRAR = 30;
// Em um primeiro cadastro pelo navegador, o segredo ainda pode não existir no
// .env. Um segredo temporário mantém as sessões seguras e apenas faz o usuário
// entrar novamente quando o servidor for reiniciado.
const SEGREDO_SESSAO = config.auth.segredo || crypto.randomBytes(32).toString('hex');

// scrypt e´ lento de proposito: um hash custa ~100ms de CPU, o que torna forca
// bruta inviavel mesmo para quem ja tem o .env em maos.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

// --- Hash da senha ---------------------------------------------------

/** Formato: scrypt$N$r$p$<salt b64>$<hash b64>. Usado so pelo `npm run senha`. */
export function gerarHash(senha) {
  const salt = crypto.randomBytes(16);
  const chave = crypto.scryptSync(senha, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), chave.toString('base64')].join('$');
}

async function usuarioDoBanco(usuario) {
  const { rows } = await pool.query(
    usuario === undefined
      ? 'SELECT id, usuario, senha_hash FROM usuarios ORDER BY id LIMIT 1'
      : 'SELECT id, usuario, senha_hash FROM usuarios WHERE usuario = $1',
    usuario === undefined ? [] : [usuario],
  );
  return rows[0] ?? null;
}

async function garantirUsuarioLegado(client = pool) {
  if (!config.auth.usuario || !config.auth.senhaHash) return null;
  const { rows } = await client.query(
    `INSERT INTO usuarios (usuario, senha_hash)
     VALUES ($1, $2)
     ON CONFLICT (usuario) DO UPDATE
       SET usuario = EXCLUDED.usuario,
           senha_hash = EXCLUDED.senha_hash
     RETURNING id, usuario, senha_hash`,
    [config.auth.usuario, config.auth.senhaHash],
  );
  return rows[0] ?? (await usuarioDoBanco(config.auth.usuario));
}

export async function prepararUsuariosDados() {
  return withTransaction(async (client) => {
    const legado = await garantirUsuarioLegado(client);
    if (!legado) return null;
    for (const tabela of [
      'contas', 'categorias', 'recorrentes', 'transacoes',
      'orcamentos', 'metas', 'parcelamentos',
    ]) {
      await client.query(`UPDATE ${tabela} SET usuario_id = $1 WHERE usuario_id IS NULL`, [legado.id]);
    }
    return legado;
  });
}

async function conferirHash(senha, hash) {
  const partes = String(hash).split('$');
  if (partes.length !== 6 || partes[0] !== 'scrypt') return false;

  const [, N, r, p, saltB64, chaveB64] = partes;
  const esperado = Buffer.from(chaveB64, 'base64');
  if (esperado.length === 0) return false;

  let calculado;
  try {
    calculado = await scrypt(senha, Buffer.from(saltB64, 'base64'), esperado.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
  } catch {
    // Hash corrompido/parametros absurdos no .env: e´ "senha errada", nao 500.
    return false;
  }
  return crypto.timingSafeEqual(calculado, esperado);
}

/** Compara sem vazar, pelo tempo de resposta, quantos caracteres bateram. */
function igual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

export async function conferirCredenciais(usuario, senha) {
  const cadastrado = await usuarioDoBanco(usuario);
  if (cadastrado) {
    const senhaOk = await conferirHash(senha, cadastrado.senha_hash);
    if (!senhaOk) return null;
    // Autocura no login: quem entra sem NENHUMA conta ou categoria (o legado do
    // .env, que pula o cadastro) recebe o kit padrao em vez de encarar um app
    // com os selects de conta e categoria vazios.
    await garantirPadroes(pool, cadastrado.id);
    return { id: cadastrado.id, usuario: cadastrado.usuario };
  }

  // Compatibilidade com instalações antigas que ainda usam AUTH_* no .env.
  const usuarioOk = igual(usuario, config.auth.usuario);
  const senhaOk = await conferirHash(senha, config.auth.senhaHash);
  if (!usuarioOk || !senhaOk) return null;
  const legado = await garantirUsuarioLegado();
  if (!legado) return null;
  await garantirPadroes(pool, legado.id);
  return { id: legado.id, usuario: legado.usuario };
}

export async function cadastroStatus() {
  const cadastrado = await usuarioDoBanco();
  return {
    cadastrado: Boolean(cadastrado),
    usuario: cadastrado?.usuario ?? null,
    legado: Boolean(config.auth.usuario && config.auth.senhaHash),
  };
}

export async function cadastrarUsuario(usuario, senha) {
  const hash = gerarHash(senha);
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      'INSERT INTO usuarios (usuario, senha_hash) VALUES ($1, $2) RETURNING id, usuario, criado_em',
      [usuario, hash],
    );
    await garantirPadroes(client, rows[0].id);
    return rows[0];
  });
}

// --- Token de sessao -------------------------------------------------

const assinar = (corpo) =>
  crypto.createHmac('sha256', SEGREDO_SESSAO).update(corpo).digest('base64url');

/**
 * Token = <payload base64url>.<assinatura>. O payload nao e´ secreto (so guarda
 * o usuario e o vencimento), mas nao pode ser forjado sem o SESSION_SECRET.
 */
export function criarToken({ lembrar = false, usuario = config.auth.usuario, usuarioId = null } = {}) {
  const duracaoMs = lembrar ? DIAS_LEMBRAR * 86_400_000 : HORAS_SESSAO * 3_600_000;
  const corpo = Buffer.from(
    JSON.stringify({ id: usuarioId, u: usuario, exp: Date.now() + duracaoMs }),
  ).toString('base64url');

  return { token: `${corpo}.${assinar(corpo)}`, duracaoMs };
}

function lerToken(token) {
  if (typeof token !== 'string') return null;

  const ponto = token.indexOf('.');
  if (ponto <= 0) return null;

  const corpo = token.slice(0, ponto);
  if (!igual(token.slice(ponto + 1), assinar(corpo))) return null;

  let dados;
  try {
    dados = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!dados || typeof dados.exp !== 'number' || dados.exp <= Date.now()) return null;
  return dados;
}

// --- Cookie ----------------------------------------------------------

/** Parser proprio: cookie-parser seria uma dependencia a mais para 10 linhas. */
function cookies(req) {
  const bruto = req.headers?.cookie;
  if (!bruto) return {};

  const fora = {};
  for (const parte of bruto.split(';')) {
    const igualdade = parte.indexOf('=');
    if (igualdade < 1) continue;
    const nome = parte.slice(0, igualdade).trim();
    try {
      fora[nome] = decodeURIComponent(parte.slice(igualdade + 1).trim());
    } catch {
      // Cookie com %-encoding quebrado: ignora em vez de derrubar a requisicao.
    }
  }
  return fora;
}

/** Sessao valida do request, ou null. */
export const sessaoDe = (req) => lerToken(cookies(req)[COOKIE]);

// httpOnly: o JS da pagina nao le o cookie, entao um XSS nao consegue roubar a
// sessao. sameSite lax: outro site nao dispara POST/PUT/DELETE autenticado
// (CSRF), mas o link direto para o app continua abrindo ja logado.
const OPCOES_COOKIE = { httpOnly: true, sameSite: 'lax', path: '/' };

/**
 * `secure` conforme o protocolo da requisicao, e nao fixo.
 *
 * Este app atende nas DUAS pontas: http://localhost:3001 na maquina e
 * https://...ts.net pelo Tailscale Serve (ver servidor-oculto.vbs). Um `secure`
 * fixo em true faria o Firefox descartar o cookie no acesso local (so o Chrome
 * abre excecao para localhost); fixo em false mandaria o cookie em claro se um
 * dia o app sair do tailnet. Entao: HTTPS -> secure; localhost -> nao.
 *
 * O Tailscale entrega a conexao ao node em HTTP, avisando o protocolo original
 * no X-Forwarded-Proto -- por isso olhamos o cabecalho, e nao req.secure.
 */
function porHttps(req) {
  return req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
}

export function gravarCookie(res, { token, duracaoMs }, req) {
  res.cookie(COOKIE, token, { ...OPCOES_COOKIE, secure: porHttps(req), maxAge: duracaoMs });
}

export function limparCookie(res, req) {
  // Os atributos precisam bater com os da gravacao, senao o navegador limpa
  // "outro" cookie (que nao existe) e a sessao continua de pe.
  res.clearCookie(COOKIE, { ...OPCOES_COOKIE, secure: porHttps(req) });
}

// --- Freio de tentativas ---------------------------------------------
// Em memoria e global: e´ um app de um usuario so, nao ha o que separar por IP.
// Reiniciar o servidor zera o freio -- quem tem acesso ao console ja tem acesso
// ao .env, entao nao ha nada a proteger nesse cenario.

const MAX_FALHAS = 5;
const BLOQUEIO_BASE_MS = 30_000;
const BLOQUEIO_MAX_MS = 5 * 60_000;
const ESQUECER_APOS_MS = 15 * 60_000;

let falhas = 0;
let bloqueadoAte = 0;
let ultimaFalha = 0;

/** Segundos restantes de bloqueio (0 = liberado). */
export function segundosBloqueado() {
  const restante = bloqueadoAte - Date.now();
  return restante > 0 ? Math.ceil(restante / 1000) : 0;
}

export function registrarFalha() {
  // Quinze minutos sem errar zera a conta. Sem isso, um erro de digitacao hoje
  // somaria com os de semanas atras e mandaria o dono da casa esperar 5 minutos
  // -- castigo de ataque, aplicado a quem so trocou uma tecla. O ataque de
  // verdade e´ rapido, e nessa janela o contador nao decai.
  if (ultimaFalha && Date.now() - ultimaFalha > ESQUECER_APOS_MS) falhas = 0;

  falhas += 1;
  ultimaFalha = Date.now();
  if (falhas < MAX_FALHAS) return;

  // Dobra a espera a cada falha extra: 30s, 1min, 2min... ate 5min.
  const espera = Math.min(BLOQUEIO_MAX_MS, BLOQUEIO_BASE_MS * 2 ** (falhas - MAX_FALHAS));
  bloqueadoAte = Date.now() + espera;
}

export function registrarAcerto() {
  falhas = 0;
  bloqueadoAte = 0;
  ultimaFalha = 0;
}

// --- Middleware ------------------------------------------------------

/** Barra a requisicao sem sessao valida. 401 = o frontend manda para o login. */
export function exigirLogin(req, _res, next) {
  const sessao = sessaoDe(req);
  if (!sessao || !Number.isInteger(Number(sessao.id))) {
    return next(new HttpError(401, 'Sessão expirada. Faça login de novo.'));
  }
  req.sessao = sessao;
  next();
}
