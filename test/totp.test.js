/**
 * src/totp.js conferido contra os VETORES DE TESTE OFICIAIS do RFC 6238 (Appendix B).
 *
 * Se o algoritmo estiver certo, o segredo conhecido nos instantes conhecidos produz os
 * códigos conhecidos. É a prova de que um Google Authenticator de verdade vai gerar
 * exatamente o que o servidor espera.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  base32Encode, base32Decode, gerarSegredo,
  codigoParaContador, contadorAgora, verificar, verificarContador, otpauthURI,
} from '../src/totp.js';

// O segredo do RFC (ASCII "12345678901234567890") em base32.
const SEGREDO_ASCII = '12345678901234567890';
const SEGREDO_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('base32: encode bate com o valor do RFC e o round-trip volta idêntico', () => {
  assert.equal(base32Encode(Buffer.from(SEGREDO_ASCII)), SEGREDO_B32);
  assert.equal(base32Decode(SEGREDO_B32).toString(), SEGREDO_ASCII);

  // Round-trip com bytes aleatórios.
  const original = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual(base32Decode(base32Encode(original)), original);
});

test('RFC 6238 Appendix B: os códigos de 6 dígitos batem exatamente', () => {
  // [epoch em segundos, código de 6 dígitos esperado (SHA1)]
  const vetores = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];
  for (const [t, esperado] of vetores) {
    assert.equal(
      codigoParaContador(SEGREDO_B32, contadorAgora(t)),
      esperado,
      `T=${t} deveria gerar ${esperado}`,
    );
  }
});

test('verificar: aceita o código certo na hora certa, recusa o errado', () => {
  const t = 1111111109;
  assert.equal(verificar(SEGREDO_B32, '081804', t), true, 'código correto na janela atual');
  assert.equal(verificar(SEGREDO_B32, '000000', t), false, 'código errado');
  assert.equal(verificar(SEGREDO_B32, '81804', t), false, 'menos de 6 dígitos');
  assert.equal(verificar(SEGREDO_B32, 'abcdef', t), false, 'não numérico');
  assert.equal(verificar(SEGREDO_B32, '', t), false, 'vazio');
});

test('verificar: a janela de ±1 tolera relógio um pouco fora, mas não muito', () => {
  const t = 1111111109;
  // Um passo (30s) para trás e para frente ainda vale (relógio do celular defasado).
  const passoAntes = codigoParaContador(SEGREDO_B32, contadorAgora(t) - 1);
  const passoDepois = codigoParaContador(SEGREDO_B32, contadorAgora(t) + 1);
  assert.equal(verificar(SEGREDO_B32, passoAntes, t), true, '30s atrás vale');
  assert.equal(verificar(SEGREDO_B32, passoDepois, t), true, '30s à frente vale');

  // Dois passos (60s) fora NÃO vale — a janela não é frouxa demais.
  const doisAntes = codigoParaContador(SEGREDO_B32, contadorAgora(t) - 2);
  assert.equal(verificar(SEGREDO_B32, doisAntes, t), false, '60s atrás não vale');
});

test('verificarContador: devolve o contador que bateu (anti-replay), ou null', () => {
  const t = 1111111109;
  const contador = contadorAgora(t);
  assert.equal(verificarContador(SEGREDO_B32, '081804', t), contador, 'código certo -> o contador dele');
  assert.equal(verificarContador(SEGREDO_B32, '000000', t), null, 'código errado -> null');
  // O contador cresce com o tempo: é comparável (>) para barrar reuso.
  assert.ok(verificarContador(SEGREDO_B32, codigoParaContador(SEGREDO_B32, contador + 5), t + 150) === contador + 5);
});

test('gerarSegredo: base32 válido e diferente a cada chamada', () => {
  const a = gerarSegredo();
  const b = gerarSegredo();
  assert.match(a, /^[A-Z2-7]+$/);
  assert.notEqual(a, b);
  assert.equal(base32Decode(a).length, 20, '20 bytes de entropia');
});

test('otpauthURI: monta a URI que o app do autenticador entende', () => {
  const uri = otpauthURI(SEGREDO_B32, 'joao');
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.match(uri, new RegExp(`secret=${SEGREDO_B32}`));
  assert.match(uri, /issuer=Controlador\+Financeiro/);
  assert.match(uri, /digits=6/);
  assert.match(uri, /period=30/);
});
