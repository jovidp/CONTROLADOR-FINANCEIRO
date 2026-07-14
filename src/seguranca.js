/**
 * O que protege o app quando ele deixa de ser "so´ na minha maquina".
 *
 * Dentro do tailnet, quem alcanca a porta ja´ foi autenticado pelo Tailscale. Com o
 * Funnel ligado, qualquer um na internet alcanca a porta -- e a partir dai´ o login e´
 * a UNICA parede. Este arquivo cuida das tres coisas que essa parede precisa: saber de
 * ONDE veio a requisicao (para o freio de tentativas), o proprio FREIO, e os cabecalhos
 * que dizem ao navegador o que ele nao deve deixar a pagina fazer.
 */
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

// --- De onde veio a requisicao ---------------------------------------

/**
 * O IP do cliente, do jeito que NAO da´ para mentir.
 *
 * Atras do Tailscale o socket e´ sempre 127.0.0.1, entao o IP real so´ existe no
 * X-Forwarded-For. O problema: o X-Forwarded-For e´ uma LISTA que cada proxy vai
 * ANEXANDO -- e o primeiro item pode ter vindo do proprio cliente. Um atacante que
 * manda `X-Forwarded-For: <aleatorio>` a cada tentativa ganha uma chave nova no freio
 * toda vez, e o bloqueio de 5 tentativas nunca fecha. Era exatamente o que acontecia
 * aqui: o codigo antigo fazia `.split(',')[0]`.
 *
 * Quem escreve o item mais a DIREITA e´ o proxy mais proximo de nos -- o Tailscale, que
 * o cliente nao controla. O `trust proxy` do express (ligado no server.js) resolve isso
 * andando da direita para a esquerda e parando no primeiro endereco nao-confiavel: e´ o
 * `req.ip`. O fallback existe para quem chama esta funcao fora do express (os testes).
 */
export function ipDoCliente(req) {
  if (req.ip) return req.ip;

  const encaminhado = req.headers?.['x-forwarded-for'];
  if (encaminhado) {
    const lista = String(encaminhado).split(',').map((p) => p.trim()).filter(Boolean);
    if (lista.length > 0) return lista[lista.length - 1];
  }
  return req.socket?.remoteAddress || 'local';
}

// --- Freio de tentativas ---------------------------------------------
//
// Em memoria e POR CHAVE (quem + de onde), nunca global: um contador global deixaria
// qualquer um trancar o login de todo mundo errando cinco senhas de proposito.
//
// Reiniciar o servidor zera o freio. Quem chega ao console ja´ tem o .env em maos, entao
// nao ha´ o que proteger nesse cenario.

/**
 * Cria um freio independente. Login e cadastro usam instancias SEPARADAS: sao ataques
 * diferentes (adivinhar a senha de alguem vs. criar contas em massa) e nao faz sentido
 * que o erro de um consuma a cota do outro.
 */
export function criarFreio({
  maxFalhas = 5,
  bloqueioBaseMs = 30_000,
  bloqueioMaxMs = 5 * 60_000,
  esquecerAposMs = 15 * 60_000,
  maxChaves = 1000,
} = {}) {
  /** chave -> { falhas, bloqueadoAte, ultimaFalha } */
  const tentativas = new Map();

  /** Impede que um ataque com chaves aleatorias faca o Map crescer sem limite. */
  function podar() {
    if (tentativas.size <= maxChaves) return;
    const agora = Date.now();
    for (const [chave, t] of tentativas) {
      if (agora - t.ultimaFalha > esquecerAposMs && t.bloqueadoAte <= agora) tentativas.delete(chave);
    }
    // Ainda cheio (ataque em curso): descarta as mais antigas -- mas NUNCA um bloqueio
    // ativo. Descartar uma chave que ainda esta´ bloqueada zeraria o castigo do atacante
    // (a chave voltaria com falhas=0 na proxima tentativa): a poda viraria o bypass do
    // proprio lockout. Se todas as candidatas estiverem bloqueadas, o Map passa do teto
    // por ora -- limitado ao numero de origens atacando, e melhor que soltar um bloqueio.
    if (tentativas.size > maxChaves) {
      const agoraP = Date.now();
      for (const [chave, t] of tentativas) {
        if (tentativas.size <= maxChaves) break;
        if (t.bloqueadoAte > agoraP) continue;
        tentativas.delete(chave);
      }
    }
  }

  return {
    /** Segundos restantes de bloqueio para esta chave (0 = liberado). */
    segundosBloqueado(chave) {
      const t = tentativas.get(chave);
      if (!t) return 0;
      const restante = t.bloqueadoAte - Date.now();
      return restante > 0 ? Math.ceil(restante / 1000) : 0;
    },

    registrarFalha(chave) {
      const agora = Date.now();
      const t = tentativas.get(chave) ?? { falhas: 0, bloqueadoAte: 0, ultimaFalha: 0 };

      // Um periodo sem errar zera a conta. Sem isso, um erro de digitacao hoje somaria
      // com os de semanas atras e mandaria o dono da casa esperar 5 minutos -- castigo
      // de ataque, aplicado a quem so´ trocou uma tecla. O ataque de verdade e´ rapido,
      // e nessa janela o contador nao decai.
      if (t.ultimaFalha && agora - t.ultimaFalha > esquecerAposMs) t.falhas = 0;

      t.falhas += 1;
      t.ultimaFalha = agora;

      if (t.falhas >= maxFalhas) {
        // Dobra a espera a cada falha extra, ate´ o teto.
        const espera = Math.min(bloqueioMaxMs, bloqueioBaseMs * 2 ** (t.falhas - maxFalhas));
        t.bloqueadoAte = agora + espera;
      }

      tentativas.set(chave, t);
      podar();
    },

    registrarAcerto(chave) {
      tentativas.delete(chave);
    },
  };
}

// --- Cabecalhos de seguranca -----------------------------------------

/**
 * Hashes dos <script> escritos DENTRO do HTML.
 *
 * A CSP abaixo bloqueia todo script inline -- e´ o que faz um XSS nao virar codigo
 * rodando. Mas o login.html tem um <script> inline de proposito (aplica o tema antes da
 * primeira pintura; num modulo, a tela piscaria branca). A saida e´ liberar por HASH:
 * o navegador roda o script cujo sha256 esta´ na lista, e nenhum outro. Um script
 * injetado tem outro conteudo, logo outro hash, logo nao roda.
 *
 * Calculado do ARQUIVO, no boot: editar o inline sem lembrar de atualizar um hash
 * fixo no codigo quebraria a pagina em producao e funcionaria em localhost.
 */
function hashesDosInline(arquivos) {
  const hashes = new Set();

  for (const arquivo of arquivos) {
    let html;
    try {
      html = readFileSync(arquivo, 'utf8');
    } catch {
      continue; // Pagina opcional (manutencao.html pode nem ser servida).
    }
    // Sem atributo src = script inline. O `[^>]*` nao casa com ">" justamente para
    // nao passar de um <script ...> para o proximo.
    for (const achado of html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      const corpo = achado[1];
      if (!corpo) continue;
      hashes.add(`'sha256-${crypto.createHash('sha256').update(corpo, 'utf8').digest('base64')}'`);
    }
  }
  return [...hashes];
}

/**
 * Middleware com os cabecalhos que o navegador obedece.
 *
 * Nada aqui substitui o login: sao a segunda linha, para o caso de uma falha nossa.
 * O `style-src` aceita inline (ha´ atributos style="" nas paginas) -- e´ a unica folga,
 * e ela custa pouco: sem `innerHTML` em lugar nenhum (o ESLint barra no public/), nao
 * existe por onde injetar CSS.
 */
export function cabecalhosSeguranca(arquivosHtml) {
  const scriptSrc = ["'self'", ...hashesDosInline(arquivosHtml)].join(' ');

  const csp = [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:", // o favicon e´ um SVG embutido em data:
    "connect-src 'self'",
    "font-src 'self'",
    "base-uri 'none'", // <base> injetado reescreveria todo caminho relativo da pagina
    "object-src 'none'",
    "form-action 'self'", // um <form> injetado nao consegue postar sua senha para fora
    "frame-ancestors 'none'", // ninguem embute este app num iframe (clickjacking)
  ].join('; ');

  return (req, res, next) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY'); // frame-ancestors ja´ cobre; isto e´ para navegador velho
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=(), usb=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

    // HSTS so´ faz sentido (e so´ e´ obedecido) sobre HTTPS. Mandar sempre gravaria
    // "so´ me acesse por HTTPS" tambem a partir do http://localhost -- e o acesso local,
    // que nao tem certificado, deixaria de abrir.
    if (req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}

// --- Politica de senha -----------------------------------------------

const MIN_SENHA = 12;
const MAX_SENHA = 200;

/**
 * Senhas que um bot tenta ANTES de tentar qualquer outra coisa. A lista e´ curta de
 * proposito: ela nao existe para "medir forca" (isso e´ o tamanho minimo que faz), e sim
 * para barrar o punhado de senhas que aparecem em toda tentativa automatizada.
 */
const OBVIAS = new Set([
  'senha', 'senha123', 'password', 'password123', 'p@ssw0rd', 'qwerty', 'qwertyuiop',
  '123456', '1234567', '12345678', '123456789', '1234567890', '123456789012',
  'admin', 'admin123', 'administrador', 'controlador', 'financeiro',
  'controladorfinanceiro', 'iloveyou', 'abc123', 'letmein', 'welcome', 'monkey',
]);

/**
 * Devolve o PROBLEMA da senha (string) ou null se ela serve.
 *
 * So´ vale para senhas NOVAS (cadastro e troca). O login continua aceitando o que ja´
 * esta´ no banco -- endurecer a regra nao pode trancar do lado de fora quem se cadastrou
 * quando ela era outra.
 */
export function problemaNaSenha(senha, usuario = '') {
  const s = String(senha ?? '');

  if (s.length < MIN_SENHA) return `A senha deve ter pelo menos ${MIN_SENHA} caracteres.`;
  if (s.length > MAX_SENHA) return `A senha deve ter no máximo ${MAX_SENHA} caracteres.`;

  const minuscula = s.toLowerCase();
  if (OBVIAS.has(minuscula)) return 'Essa senha é uma das primeiras que um invasor tenta. Escolha outra.';

  // Um unico caractere repetido ("aaaaaaaaaaaa") tem 12 caracteres e nenhuma forca.
  if (/^(.)\1+$/.test(s)) return 'A senha não pode ser um único caractere repetido.';

  // A senha nao pode ser o usuario, nem o usuario com uns numeros no fim ("joao123456").
  //
  // "Contem o usuario" seria facil de escrever e errado: com o usuario "ana", a senha
  // "banana bread forever" -- que e´ boa -- seria recusada por causa das tres letras no
  // meio de "banana". O que se quer barrar e´ a senha CONSTRUIDA a partir do login, e
  // essa comeca por ele.
  const u = String(usuario ?? '').trim().toLowerCase();
  if (u && (minuscula === u || (u.length >= 4 && minuscula.startsWith(u)))) {
    return 'A senha não pode ser o seu nome de usuário com algo colado no fim.';
  }

  return null;
}

export const REQUISITOS_SENHA = `A senha deve ter de ${MIN_SENHA} a ${MAX_SENHA} caracteres.`;
