import express from 'express';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { pool, closePool } from './db.js';
import { HttpError, traduzErroPg } from './http.js';
import { exigirLogin, prepararUsuariosDados, sessaoDe, sessaoValida } from './auth.js';
import { cabecalhosSeguranca, ipDoCliente } from './seguranca.js';
import { processarRecorrentes } from './services/recorrentes.js';
import * as manutencao from './manutencao.js';

import auth from './routes/auth.js';
import categorias from './routes/categorias.js';
import contas from './routes/contas.js';
import tiposConta from './routes/tiposConta.js';
import transacoes from './routes/transacoes.js';
import parcelamentos from './routes/parcelamentos.js';
import orcamentos from './routes/orcamentos.js';
import metas from './routes/metas.js';
import recorrentes from './routes/recorrentes.js';
import relatorios from './routes/relatorios.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '../public');
const app = express();

const temSessaoValida = (req) => sessaoValida(sessaoDe(req));

// "Server: Express" numa resposta e´ so´ uma dica de graca para quem varre a internet
// procurando versao vulneravel. Nao esconde nada de quem olha de perto -- mas nao ha´
// razao para anunciar.
app.disable('x-powered-by');

/**
 * O Tailscale (Serve/Funnel) entrega a conexao ao node vindo do 127.0.0.1 e conta quem
 * era o cliente de verdade no X-Forwarded-For. Sem isto, `req.ip` seria SEMPRE
 * 127.0.0.1: o freio de tentativas veria a internet inteira como um unico visitante --
 * cinco senhas erradas de um desconhecido trancariam o login de todo mundo.
 *
 * 'loopback' e´ o ponto exato: o express confia no proxy local (que e´ nosso) e em mais
 * ninguem. Ele anda pelo X-Forwarded-For da direita para a esquerda e para no primeiro
 * endereco que nao e´ de confianca -- que e´ justamente o que o Tailscale escreveu, e
 * nao o que o cliente inventou. `trust proxy: true` (confiar em todos) devolveria o
 * bug: o cliente escolheria o proprio IP.
 */
app.set('trust proxy', 'loopback');

app.use(cabecalhosSeguranca([
  path.join(PUBLIC, 'index.html'),
  path.join(PUBLIC, 'login.html'),
  path.join(PUBLIC, 'manutencao.html'),
]));

app.use(express.json({ limit: '2mb' }));

// --- Modo de manutencao ----------------------------------------------
// Vem antes de TUDO (menos das duas rotas isentas abaixo): enquanto um script
// destrutivo roda, nenhuma escrita nova pode entrar. Um lancamento gravado no meio
// de um pg_dump nao entraria no backup; um gravado no meio de uma migration poderia
// violar a constraint que ela acabou de criar.

// Isenta: e´ como a pagina de manutencao descobre que ja´ pode voltar.
app.get('/api/manutencao', (_req, res) => {
  const emManutencao = manutencao.estado();
  res.json({
    ativo: Boolean(emManutencao),
    motivo: emManutencao?.motivo ?? null,
    desde: emManutencao?.desde ?? null,
  });
});

app.use((req, res, next) => {
  const emManutencao = manutencao.estado();
  if (!emManutencao) return next();

  // Isenta: o `ehEsteApp()` la´ embaixo usa o /api/health para saber se quem esta´
  // na porta e´ este app. Bloquear o health faria o servidor em manutencao parecer
  // "outro programa" e a segunda janela mandaria o usuario mudar o PORT.
  if (req.path === '/api/health') return next();

  // 503 + Retry-After: e´ o par que diz "volte depois", e nao "isto nao existe".
  res.set('Retry-After', '30');
  res.status(503);

  if (req.path.startsWith('/api/')) {
    return res.json({ erro: emManutencao.motivo || 'Servidor em manutenção. Tente de novo em instantes.' });
  }
  return res.sendFile(path.join(PUBLIC, 'manutencao.html'));
});

// --- Porta de entrada das PAGINAS ------------------------------------
// Sem sessao, a unica pagina que abre e a de login; com sessao, a de login sai
// da frente. CSS e JS ficam livres: nao carregam dado nenhum, e a API -- que
// carrega -- exige sessao logo abaixo. Vem ANTES do express.static, senao ele
// serviria o index.html antes de qualquer checagem.
app.get(['/', '/index.html'], (req, res, next) => {
  if (!temSessaoValida(req)) return res.redirect('/login.html');
  next();
});

app.get('/login.html', (req, res, next) => {
  if (temSessaoValida(req)) return res.redirect('/');
  next();
});

// O frontend não tem build step. Durante o desenvolvimento, não manter HTML,
// CSS e módulos antigos em cache evita que a interface fique diferente do
// código salvo no projeto.
app.use(express.static(PUBLIC, {
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
  },
}));

// Publica: e por aqui que a sessao nasce (o freio de tentativas mora em auth.js).
app.use('/api/auth', auth);

const LOCAIS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Publica, mas fala pouco com quem vem de fora.
 *
 * O `ehEsteApp()` la´ embaixo precisa do nome do banco para distinguir "a porta esta´
 * ocupada por MIM" de "esta´ ocupada por outro programa", e ele chama daqui mesmo, do
 * 127.0.0.1. Ja´ para a internet -- que e´ quem alcanca esta rota com o Funnel ligado --
 * o nome do banco e a versao exata do PostgreSQL nao servem a nada alem de poupar o
 * trabalho de quem procura uma versao com falha conhecida. Entao: local ve tudo, o
 * resto do mundo ve que o app esta´ vivo.
 */
app.get('/api/health', async (req, res, next) => {
  try {
    if (!LOCAIS.has(ipDoCliente(req))) {
      await pool.query('SELECT 1');
      return res.json({ ok: true });
    }
    const { rows } = await pool.query('SELECT now() AS agora, current_database() AS banco, version() AS versao');
    res.json({ ok: true, ...rows[0] });
  } catch (err) {
    next(err);
  }
});

// Daqui para baixo, nenhum dado sai sem sessao. Uma rota nova cai sob o login
// automaticamente -- esquecer de proteger deixaria de ser possivel.
app.use('/api', exigirLogin);

app.use('/api/categorias', categorias);
app.use('/api/contas', contas);
app.use('/api/tipos-conta', tiposConta);
app.use('/api/transacoes', transacoes);
app.use('/api/parcelamentos', parcelamentos);
app.use('/api/orcamentos', orcamentos);
app.use('/api/metas', metas);
app.use('/api/recorrentes', recorrentes);
app.use('/api/relatorios', relatorios);

app.use('/api', (_req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));

/**
 * Erros do express.json() (body-parser) nao sao HttpError nem erro do pg, mas ja
 * carregam o status HTTP certo. Sem traduzi-los, um JSON malformado virava 500 --
 * culpa do cliente, nao do servidor.
 */
function traduzErroBody(err) {
  const status = Number(err?.status ?? err?.statusCode);
  if (!Number.isInteger(status) || status < 400 || status > 499) return null;

  switch (err.type) {
    case 'entity.parse.failed':
      return new HttpError(400, 'Corpo da requisição não é um JSON válido.');
    case 'entity.too.large':
      return new HttpError(413, 'Corpo da requisição é grande demais.');
    default:
      return new HttpError(status, 'Requisição inválida.');
  }
}

// --- Error handler central ------------------------------------------
app.use((err, _req, res, _next) => {
  const traduzido = err instanceof HttpError ? err : (traduzErroPg(err) ?? traduzErroBody(err));
  if (traduzido) {
    return res.status(traduzido.status).json({ erro: traduzido.message, campo: traduzido.campo });
  }
  console.error('[erro]', err);
  res.status(500).json({ erro: 'Erro interno do servidor.' });
});

/**
 * O Windows deixa dois processos escutarem a mesma porta sem erro nenhum e passa
 * a sortear entre eles a cada conexao: o HTML sai daqui, o CSS sai do outro app,
 * e a tela carrega sem estilo. O `exclusive: true` do Node nao evita isso (so
 * vale para o modulo cluster) e o EADDRINUSE nunca chega. Por isso testamos a
 * porta na mao, abrindo uma conexao antes de subir o servidor.
 */
function portaEmUso(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const responder = (emUso) => { sock.destroy(); resolve(emUso); };

    sock.setTimeout(1000);
    sock.on('connect', () => responder(true));
    sock.on('timeout', () => responder(false));
    sock.on('error', () => responder(false)); // ECONNREFUSED = porta livre
  });
}

/**
 * Distingue "a porta esta ocupada por MIM (ja rodando)" de "esta ocupada por
 * outro programa". O /api/health so responde com o nome do banco se for este
 * app; qualquer outra coisa na porta cai no catch.
 */
async function ehEsteApp(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
    const corpo = await res.json();
    return corpo?.ok === true && corpo?.banco === config.db.database;
  } catch {
    return false;
  }
}

/**
 * Sai do processo sem matar o event loop no meio. Um `process.exit()` cru com o
 * pool do pg ainda aberto derruba o libuv com uma assertion nativa no Windows
 * ("UV_HANDLE_CLOSING", src\win\async.c) -- o processo morre com codigo 127 e
 * cospe um erro ilegivel em cima da mensagem que a gente acabou de escrever.
 * Fechando o pool, o node encerra sozinho com o codigo certo.
 */
async function sair(codigo) {
  await closePool().catch(() => {});
  process.exitCode = codigo;
}

async function iniciar() {
  // SESSION_SECRET fraco assina o cookie com uma chave adivinhavel: quem cria uma conta
  // ve o proprio token (payload + HMAC), pode forcar a chave offline e depois forjar o
  // token de QUALQUER usuario. Se estiver definido, exigimos forca; se estiver vazio, o
  // auth.js sorteia um efemero forte (e todos deslogam a cada reinicio). Isto e a trava
  // que o comentario do config.js sempre prometeu e nunca teve.
  if (config.auth.segredo && config.auth.segredo.length < 32) {
    console.error('\n  SESSION_SECRET é curto demais (< 32 caracteres) — chave de sessão fraca.');
    console.error('  Gere um forte:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    console.error('  Cole no .env em SESSION_SECRET, ou remova a linha para usar um efêmero.\n');
    return sair(1);
  }

  try {
    await pool.query('SELECT 1');
  } catch (err) {
    console.error('\n  Não consegui conectar no PostgreSQL.');
    console.error(`  ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`);
    console.error(`  Detalhe: ${err.message}`);
    console.error('\n  Verifique o serviço postgresql-x64-18 e o arquivo .env.\n');
    return sair(1);
  }

  // O boot ESCREVE no banco (adota dados legados, materializa recorrentes vencidas).
  // Com uma manutencao em curso, subir o servidor nesse instante meteria escrita no
  // meio do pg_dump/da migration -- exatamente o que o modo de manutencao existe para
  // impedir. Entao o servidor sobe (para mostrar a pagina de manutencao), mas calado.
  const emManutencao = manutencao.estado();
  if (emManutencao) {
    console.log(`\n  [manutenção] ${emManutencao.motivo}`);
    console.log('  O servidor vai subir apenas para exibir a página de manutenção.');
    console.log('  Nenhuma escrita no banco será feita até a manutenção terminar.\n');
  } else {
    // Migra o historico antigo para o usuario configurado no .env e garante que
    // cada sessao tenha um usuario_id para filtrar suas consultas.
    try {
      await prepararUsuariosDados();
    } catch (err) {
      console.error('[usuarios] falha ao preparar dados:', err.message);
      return sair(1);
    }

    // Materializa lancamentos fixos cuja data ja venceu.
    try {
      const { rows: usuarios } = await pool.query('SELECT id FROM usuarios ORDER BY id');
      let gerados = 0;
      for (const usuario of usuarios) gerados += await processarRecorrentes(usuario.id);
      if (gerados > 0) console.log(`  ${gerados} lançamento(s) recorrente(s) gerado(s).`);
    } catch (err) {
      console.error('[recorrentes] falha ao processar:', err.message);
    }
  }

  if (await portaEmUso(config.port)) {
    // Abrir o .bat duas vezes e´ o jeito mais natural de "ligar o programa".
    // Se quem esta la e´ este mesmo app, isso nao e´ erro nenhum: e´ so avisar.
    if (await ehEsteApp(config.port)) {
      console.log('\n  O Controlador Financeiro já está rodando — não precisa abrir de novo.');
      console.log(`  Use a janela que já está aberta, ou acesse http://localhost:${config.port}\n`);
      return sair(0);
    }

    console.error(`\n  A porta ${config.port} já está sendo usada por OUTRO programa.`);
    console.error('  Feche o outro programa ou mude o PORT no arquivo .env.\n');
    return sair(1);
  }

  const server = app.listen(config.port, config.host, () => {
    console.log('\n  Controlador Financeiro no ar');
    console.log(`  http://localhost:${config.port}`);
    if (config.host !== '127.0.0.1') {
      console.log(`\n  ATENÇÃO: escutando em ${config.host} — o app está exposto na rede local`);
      console.log('  em HTTP puro, e a senha de quem entrar por ali trafega em texto claro.');
      console.log('  Para fechar: remova o HOST do .env (volta para 127.0.0.1).');
    }
    console.log(`\n  banco: ${config.db.database} @ ${config.db.host}:${config.db.port}\n`);
  });

  // Backstop: a checagem acima cobre o caso normal, mas outro processo pode
  // tomar a porta na fracao de segundo entre o teste e o listen.
  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  A porta ${config.port} já está sendo usada por outro programa.`);
      console.error('  Feche o outro programa ou mude o PORT no arquivo .env.\n');
      return sair(1);
    }
    throw err;
  });
}

iniciar();
