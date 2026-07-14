import { Router } from 'express';
import {
  atividadeLogin,
  cadastrarUsuario,
  cadastroStatus,
  chaveTentativa,
  confirmar2FA,
  conferirCredenciais,
  conviteConfere,
  criarToken,
  desativar2FA,
  exige2FA,
  exigirLogin,
  gravarCookie,
  iniciar2FA,
  invalidarSessoes,
  limparCookie,
  registrarAcerto,
  registrarFalha,
  registrarLogin,
  segundosBloqueado,
  sessaoDe,
  sessaoValida,
  status2FA,
  trocarSenha,
  verificarSegundoFator,
  versaoToken,
} from '../auth.js';
import { criarFreio, ipDoCliente, problemaNaSenha } from '../seguranca.js';
import { asyncHandler, booleano, HttpError, texto } from '../http.js';

const router = Router();

/**
 * Freio do cadastro, por IP e SEPARADO do freio do login.
 *
 * O cadastro e´ publico: com o app no Funnel, ele fica a um GET de distancia de qualquer
 * bot da internet, e sem freio um script criaria contas em serie ate´ encher o banco.
 * Aqui TODA tentativa conta (inclusive as bem-sucedidas) -- o que se quer limitar e´ o
 * numero de contas que saem de uma mesma origem, e nao o numero de erros.
 *
 * A janela e´ mais larga que a do login (1min -> 30min) porque cadastrar e´ raro: quem
 * bate no teto ou digitou muito errado, ou nao e´ gente.
 */
const freioCadastro = criarFreio({
  maxFalhas: 5,
  bloqueioBaseMs: 60_000,
  bloqueioMaxMs: 30 * 60_000,
  esquecerAposMs: 60 * 60_000,
});

/**
 * Teto por IP PURO no login, alem do freio por usuario+IP.
 *
 * O freio por usuario+IP trava a forca bruta contra UMA conta. Mas um flood que varia o
 * `usuario` a cada requisicao cria uma chave nova toda vez e nunca dispara -- e cada
 * tentativa gasta um scrypt (~100ms) numa das 4 threads do libuv. De um IP so´, isso
 * prende as threads e trava o login de todo mundo (DoS). Este freio conta TODA tentativa
 * do mesmo IP e corta o flood ANTES de tocar no banco/scrypt. Teto alto (20) para nao
 * atrapalhar quem so´ erra a senha algumas vezes -- esse ja´ bate no freio usuario+IP.
 */
const freioIpLogin = criarFreio({
  maxFalhas: 20,
  bloqueioBaseMs: 5_000,
  bloqueioMaxMs: 60_000,
  esquecerAposMs: 5 * 60_000,
});

/**
 * Freio das operacoes autenticadas CARAS: trocar senha e ligar 2FA fazem hash scrypt
 * (~100ms de CPU cada; confirmar 2FA gera 8 codigos = ~900ms). Sem freio, um usuario
 * logado repetiria a rota em rajada e cada chamada congelaria a thread unica do Node,
 * degradando o app para todos (DoS que o red-team apontou). Por usuario.
 */
const freioSensivel = criarFreio({
  maxFalhas: 10,
  bloqueioBaseMs: 10_000,
  bloqueioMaxMs: 60_000,
  esquecerAposMs: 5 * 60_000,
});

function limitarSensivel(req) {
  const chave = `u${req.sessao.id}`;
  const espera = freioSensivel.segundosBloqueado(chave);
  if (espera > 0) throw new HttpError(429, `Muitas operações seguidas. Tente de novo em ${espera}s.`);
  freioSensivel.registrarFalha(chave);
}

/** O que vai para o logs/servidor.log. A senha, obviamente, nunca. */
function auditar(evento, req, usuario) {
  console.log(`[auth] ${evento} usuario=${JSON.stringify(usuario)} ip=${ipDoCliente(req)}`);
}

/**
 * Unica rota da API que responde sem sessao (junto de /api/health) -- e´ por onde
 * a sessao nasce. O freio de tentativas mora em auth.js.
 */
router.post('/login', asyncHandler(async (req, res) => {
  // Teto por IP puro ANTES de qualquer scrypt: e´ o que impede um flood de uma origem so´
  // de prender as threads de hash e derrubar o login de todos. Conta toda tentativa.
  const origem = ipDoCliente(req);
  const esperaIp = freioIpLogin.segundosBloqueado(origem);
  if (esperaIp > 0) {
    throw new HttpError(429, `Muitas tentativas de login. Tente de novo em ${esperaIp}s.`);
  }
  freioIpLogin.registrarFalha(origem);

  // O usuario e´ lido ANTES da checagem de bloqueio porque o freio e´ por usuario+IP, e
  // nao global: sem saber quem esta´ tentando, nao ha´ o que checar.
  const usuario = texto(req.body?.usuario, 'usuario', { max: 60 });
  const senha = texto(req.body?.senha, 'senha', { max: 200 });
  const lembrar = booleano(req.body?.lembrar);

  const chave = chaveTentativa(req, usuario);

  const espera = segundosBloqueado(chave);
  if (espera > 0) {
    throw new HttpError(429, `Muitas tentativas. Tente de novo em ${espera}s.`);
  }

  const credencial = await conferirCredenciais(usuario, senha);
  if (!credencial) {
    registrarFalha(chave);
    auditar('login NEGADO', req, usuario);
    // Mensagem unica de proposito: dizer "usuario nao existe" entregaria metade
    // da credencial a quem esta chutando.
    throw new HttpError(401, 'Usuário ou senha incorretos.');
  }

  // Segundo fator (2FA), se o usuario ativou. A senha ja´ passou; agora falta o codigo do
  // app autenticador -- e´ isto que protege a conta mesmo com a senha vazada.
  if (await exige2FA(credencial.id)) {
    const codigo = texto(req.body?.codigo, 'codigo', { obrigatorio: false, max: 20 });
    if (!codigo) {
      // Senha certa, mas falta o 2º fator: nao e´ erro de credencial (nao gasta o freio de
      // senha). O frontend mostra o campo de codigo e reenvia com senha + codigo.
      return res.json({ precisa_2fa: true });
    }
    if (!(await verificarSegundoFator(credencial.id, codigo))) {
      registrarFalha(chave); // codigo errado conta como tentativa (freia o chute dos 6 digitos)
      auditar('2FA NEGADO', req, credencial.usuario);
      throw new HttpError(401, 'Código de verificação inválido.', 'codigo');
    }
  }

  registrarAcerto(chave);
  freioIpLogin.registrarAcerto(origem); // login certo zera o teto por IP tambem
  // O login que DA´ CERTO tambem entra no log, e nao so´ o negado. Sem isto, uma senha
  // roubada entra sem deixar rastro nenhum: nao havia como responder "alguem alem de mim
  // entrou nesta conta?". O IP vem do ipDoCliente (o real, do proxy), entao um acesso de
  // origem estranha aparece no logs/servidor.log.
  auditar('login OK', req, credencial.usuario);
  const alerta = await registrarLogin(credencial.id, origem);
  const versao = await versaoToken(credencial.id);
  gravarCookie(res, criarToken({ lembrar, usuario: credencial.usuario, usuarioId: credencial.id, versao }), req);
  res.json({ usuario, alerta_login: alerta });
}));

router.post('/cadastro', asyncHandler(async (req, res) => {
  // O freio vem ANTES da validacao: um bot que manda lixo em rajada nao pode sair de
  // graca so´ porque o corpo dele nem chegou a ser um cadastro valido.
  const origem = ipDoCliente(req);
  const espera = freioCadastro.segundosBloqueado(origem);
  if (espera > 0) {
    throw new HttpError(429, `Muitos cadastros a partir daqui. Tente de novo em ${espera}s.`);
  }
  freioCadastro.registrarFalha(origem);

  // Convite antes de tudo: se o .env exige um codigo, quem nao o tem nao cria conta --
  // e´ isto que fecha o cadastro para a internet aberta sem fecha-lo para os convidados.
  if (!conviteConfere(req.body?.convite)) {
    throw new HttpError(403, 'Código de convite inválido. Peça um código a quem administra o app.', 'convite');
  }

  const usuario = texto(req.body?.usuario, 'usuario', { max: 60 });
  const senha = texto(req.body?.senha, 'senha', { max: 200 });
  const confirmacao = texto(req.body?.confirmacao, 'confirmacao', { max: 200 });

  if (!/^[\p{L}\p{N}._-]+(?: [\p{L}\p{N}._-]+)*$/u.test(usuario) || usuario.length < 3 || usuario.length > 60) {
    throw new HttpError(
      400,
      'Usuário deve ter de 3 a 60 caracteres, sem espaços no início/fim nem espaços repetidos.',
      'usuario',
    );
  }

  // Com o app no Funnel, esta senha e´ a unica coisa entre a internet e o extrato de
  // alguem. A regra vale so´ para senhas NOVAS -- quem ja´ tem conta continua entrando
  // com a que tem (ver problemaNaSenha).
  const problema = problemaNaSenha(senha, usuario);
  if (problema) {
    throw new HttpError(400, problema, 'senha');
  }
  if (senha !== confirmacao) {
    throw new HttpError(400, 'As senhas não são iguais.', 'confirmacao');
  }

  try {
    const criado = await cadastrarUsuario(usuario, senha);
    auditar('cadastro CRIADO', req, criado.usuario);
    res.status(201).json({ usuario: criado.usuario });
  } catch (err) {
    if (err?.code === '23505' || err?.code === 'CF_USER_EXISTS') {
      throw new HttpError(409, 'Já existe um cadastro. Entre com o usuário e a senha cadastrados.', 'usuario');
    }
    throw err;
  }
}));

router.post('/logout', (req, res) => {
  limparCookie(res, req);
  res.status(204).end();
});

/** Usada pelo frontend no boot: 200 sempre, com ou sem sessao. */
router.get('/sessao', (req, res) => {
  const sessao = sessaoDe(req);
  const valida = sessaoValida(sessao);
  res.json({
    autenticado: valida,
    usuario: valida ? sessao.u : null,
    expira_em: valida ? new Date(sessao.exp).toISOString() : null,
  });
});

router.get('/status', asyncHandler(async (_req, res) => {
  // Rota PUBLICA (vem antes do exigirLogin). Devolve so o booleano: o frontend so usa
  // 'cadastrado' para escolher entre a tela de login e a de cadastro. Devolver aqui o
  // NOME do usuario entregava metade da credencial a quem chuta senha -- anulando a
  // mensagem unica do /login, que existe justamente para nao dizer qual metade errou.
  // O nome so sai autenticado, pelo /sessao.
  const { cadastrado, conviteExigido } = await cadastroStatus();
  res.json({ cadastrado, convite_exigido: conviteExigido });
}));

/**
 * Troca de senha. Autenticada (exigirLogin proprio, ja que /api/auth vem antes do
 * exigirLogin global) e exige a senha ATUAL: um cookie roubado nao troca a senha sem
 * conhece-la. Sem freio proprio -- quem chega aqui ja tem sessao valida.
 */
router.post('/senha', exigirLogin, asyncHandler(async (req, res) => {
  limitarSensivel(req);
  const senhaAtual = texto(req.body?.senha_atual, 'senha_atual', { max: 200 });
  const senhaNova = texto(req.body?.senha_nova, 'senha_nova', { max: 200 });
  const confirmacao = texto(req.body?.confirmacao, 'confirmacao', { max: 200 });

  const problema = problemaNaSenha(senhaNova, req.sessao.u);
  if (problema) throw new HttpError(400, problema, 'senha_nova');
  if (senhaNova !== confirmacao) throw new HttpError(400, 'As senhas não são iguais.', 'confirmacao');
  if (senhaNova === senhaAtual) throw new HttpError(400, 'A senha nova é igual à atual.', 'senha_nova');

  const { token_versao } = await trocarSenha(req.sessao.id, senhaAtual, senhaNova);
  auditar('senha TROCADA', req, req.sessao.u);
  // A troca subiu a versão e derrubou TODAS as sessões (inclusive uma roubada). Reemite
  // o cookie de quem trocou, já na versão nova, para não deslogar a própria pessoa.
  gravarCookie(res, criarToken({ usuario: req.sessao.u, usuarioId: req.sessao.id, versao: token_versao }), req);
  res.json({ ok: true });
}));

/** Sair de todos os dispositivos: sobe a versão (derruba as outras sessões) e mantém esta. */
router.post('/sair-todos', exigirLogin, asyncHandler(async (req, res) => {
  const versao = await invalidarSessoes(req.sessao.id);
  auditar('sair de todos', req, req.sessao.u);
  gravarCookie(res, criarToken({ usuario: req.sessao.u, usuarioId: req.sessao.id, versao }), req);
  res.json({ ok: true });
}));

// --- 2FA (verificação em duas etapas) --------------------------------
// Todas autenticadas (exigirLogin próprio, já que /api/auth vem antes do exigirLogin
// global). Configurar o 2FA já exige estar logado.

router.get('/2fa/status', exigirLogin, asyncHandler(async (req, res) => {
  res.json(await status2FA(req.sessao.id));
}));

/** Passo 1: gera o segredo e devolve a chave + URI para o app autenticador. */
router.post('/2fa/iniciar', exigirLogin, asyncHandler(async (req, res) => {
  limitarSensivel(req);
  res.json(await iniciar2FA(req.sessao.id, req.sessao.u));
}));

/** Passo 2: confirma o primeiro código, ativa o 2FA e devolve os códigos de recuperação. */
router.post('/2fa/confirmar', exigirLogin, asyncHandler(async (req, res) => {
  limitarSensivel(req);
  const codigo = texto(req.body?.codigo, 'codigo', { max: 20 });
  res.json(await confirmar2FA(req.sessao.id, codigo));
}));

/** Desliga o 2FA (exige a senha E um fator atual). */
router.post('/2fa/desativar', exigirLogin, asyncHandler(async (req, res) => {
  const senha = texto(req.body?.senha, 'senha', { max: 200 });
  const codigo = texto(req.body?.codigo, 'codigo', { max: 20 });
  res.json(await desativar2FA(req.sessao.id, senha, codigo));
}));

/** Atividade recente de login, para a tela de Segurança. */
router.get('/atividade', exigirLogin, asyncHandler(async (req, res) => {
  res.json({ eventos: await atividadeLogin(req.sessao.id) });
}));

export default router;
