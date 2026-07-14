/**
 * TOTP (RFC 6238) — o código de 6 dígitos do Google Authenticator / Authy.
 *
 * Segredo compartilhado entre o servidor e o app do celular. A cada 30s os dois
 * calculam, do MESMO segredo e da hora atual, o mesmo código de 6 dígitos. Ninguém
 * transmite o segredo pela rede depois do cadastro inicial, e o código expira sozinho —
 * por isso, mesmo que a senha vaze, quem não tem o app não entra.
 *
 * Implementado só com node:crypto (HMAC-SHA1), sem dependência. Conferido contra os
 * vetores de teste do RFC 6238 em test/totp.test.js.
 */
import crypto from 'node:crypto';

const ALFABETO32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // base32 RFC 4648
const PASSO_S = 30; // janela de 30 segundos, o padrão dos apps
const DIGITOS = 6;

// --- Base32 (o formato em que os apps recebem o segredo) -------------

export function base32Encode(buffer) {
  let bits = 0;
  let valor = 0;
  let saida = '';
  for (const byte of buffer) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      saida += ALFABETO32[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) saida += ALFABETO32[(valor << (5 - bits)) & 31];
  return saida;
}

export function base32Decode(texto) {
  const limpo = String(texto).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let valor = 0;
  const bytes = [];
  for (const ch of limpo) {
    const idx = ALFABETO32.indexOf(ch);
    if (idx === -1) throw new Error('Segredo base32 inválido.');
    valor = (valor << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// --- Núcleo TOTP -----------------------------------------------------

/** Segredo novo: 20 bytes aleatórios em base32 (o tamanho que o RFC recomenda para SHA1). */
export function gerarSegredo() {
  return base32Encode(crypto.randomBytes(20));
}

/** O código de 6 dígitos para um CONTADOR (= floor(epoch / 30)). */
export function codigoParaContador(segredoBase32, contador) {
  const chave = base32Decode(segredoBase32);

  // Contador em 8 bytes big-endian.
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(contador));

  const hmac = crypto.createHmac('sha1', chave).update(buf).digest();

  // "Dynamic truncation" do RFC 4226: o último nibble aponta onde começar a ler.
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binario = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);

  return String(binario % 10 ** DIGITOS).padStart(DIGITOS, '0');
}

/** Contador atual a partir de um epoch em SEGUNDOS. */
export function contadorAgora(epochSegundos) {
  return Math.floor(epochSegundos / PASSO_S);
}

/**
 * Confere um código digitado contra a hora atual.
 *
 * `janela` = quantos passos de 30s antes/depois também valem — 1 cobre o relógio do
 * celular um pouco adiantado/atrasado e o usuário que digita na virada do minuto, sem
 * abrir a porta a mais que ~90s de códigos. A comparação é constante no tempo.
 */
export function verificar(segredoBase32, codigo, epochSegundos, janela = 1) {
  return verificarContador(segredoBase32, codigo, epochSegundos, janela) !== null;
}

/**
 * Como verificar(), mas devolve o CONTADOR do código que bateu (ou null se nenhum).
 * O contador serve ao anti-replay: guardando o maior já aceito, o mesmo código não
 * entra duas vezes, nem em um replay dentro da janela de validade.
 */
export function verificarContador(segredoBase32, codigo, epochSegundos, janela = 1) {
  const limpo = String(codigo ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(limpo)) return null;

  const atual = contadorAgora(epochSegundos);
  for (let i = -janela; i <= janela; i++) {
    const contador = atual + i;
    const esperado = codigoParaContador(segredoBase32, contador);
    // timingSafeEqual exige o mesmo tamanho; ambos têm 6 dígitos.
    if (crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(limpo))) return contador;
  }
  return null;
}

/**
 * URI otpauth:// que o app do autenticador entende (por QR ou "chave de configuração").
 * O rótulo leva o nome do app e o usuário; o issuer é o que aparece na lista do app.
 */
export function otpauthURI(segredoBase32, usuario, emissor = 'Controlador Financeiro') {
  const rotulo = encodeURIComponent(`${emissor}:${usuario}`);
  const params = new URLSearchParams({
    secret: segredoBase32,
    issuer: emissor,
    algorithm: 'SHA1',
    digits: String(DIGITOS),
    period: String(PASSO_S),
  });
  return `otpauth://totp/${rotulo}?${params.toString()}`;
}
