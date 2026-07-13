import express from 'express';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { pool, closePool } from './db.js';
import { HttpError, traduzErroPg } from './http.js';
import { exigirLogin, prepararUsuariosDados, sessaoDe } from './auth.js';
import { processarRecorrentes } from './services/recorrentes.js';

import auth from './routes/auth.js';
import categorias from './routes/categorias.js';
import contas from './routes/contas.js';
import transacoes from './routes/transacoes.js';
import parcelamentos from './routes/parcelamentos.js';
import orcamentos from './routes/orcamentos.js';
import metas from './routes/metas.js';
import recorrentes from './routes/recorrentes.js';
import relatorios from './routes/relatorios.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const temSessaoValida = (req) => {
  const sessao = sessaoDe(req);
  return Boolean(sessao && Number.isInteger(Number(sessao.id)));
};

app.use(express.json({ limit: '2mb' }));

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
app.use(express.static(path.join(__dirname, '../public'), {
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
  },
}));

// Publica: e por aqui que a sessao nasce (o freio de tentativas mora em auth.js).
app.use('/api/auth', auth);

app.get('/api/health', async (_req, res, next) => {
  try {
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
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    console.error('\n  Não consegui conectar no PostgreSQL.');
    console.error(`  ${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`);
    console.error(`  Detalhe: ${err.message}`);
    console.error('\n  Verifique o serviço postgresql-x64-18 e o arquivo .env.\n');
    return sair(1);
  }

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

  const server = app.listen(config.port, () => {
    console.log('\n  Controlador Financeiro no ar');
    console.log(`  http://localhost:${config.port}`);
    console.log(`  banco: ${config.db.database} @ ${config.db.host}:${config.db.port}\n`);
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
