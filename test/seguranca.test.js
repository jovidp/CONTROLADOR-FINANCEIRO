/**
 * src/seguranca.js: de onde veio a requisicao, o freio e a politica de senha.
 *
 * Nada aqui toca no banco nem sobe o express.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { criarFreio, ipDoCliente, problemaNaSenha } from '../src/seguranca.js';

test('ipDoCliente: o último do X-Forwarded-For, que é o que o proxy escreveu', () => {
  const req = (cab = {}, socket = '127.0.0.1') => ({ headers: cab, socket: { remoteAddress: socket } });

  assert.equal(ipDoCliente(req({ 'x-forwarded-for': '9.9.9.9' })), '9.9.9.9');

  // O cliente pode MANDAR um X-Forwarded-For; o proxy so´ ANEXA o IP real depois. Ler o
  // primeiro item era ler o que o atacante escreveu.
  assert.equal(ipDoCliente(req({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9' })), '9.9.9.9');
  assert.equal(ipDoCliente(req({ 'x-forwarded-for': 'nem-e-um-ip, 9.9.9.9' })), '9.9.9.9');

  // Sem proxy nenhum (acesso local direto), vale o socket.
  assert.equal(ipDoCliente(req({}, '10.0.0.7')), '10.0.0.7');

  // Sob o express com `trust proxy`, o req.ip ja´ vem resolvido e tem a palavra final.
  assert.equal(ipDoCliente({ ip: '100.1.2.3', headers: { 'x-forwarded-for': '6.6.6.6' } }), '100.1.2.3');
});

test('freio: tranca depois de N falhas, e o acerto destranca', () => {
  const freio = criarFreio({ maxFalhas: 3, bloqueioBaseMs: 1000, bloqueioMaxMs: 4000 });

  freio.registrarFalha('a');
  freio.registrarFalha('a');
  assert.equal(freio.segundosBloqueado('a'), 0, 'ainda pode tentar');

  freio.registrarFalha('a');
  assert.ok(freio.segundosBloqueado('a') > 0, 'a terceira tranca');

  assert.equal(freio.segundosBloqueado('b'), 0, 'trancar "a" não pode atingir "b"');

  freio.registrarAcerto('a');
  assert.equal(freio.segundosBloqueado('a'), 0);
});

test('freio: instâncias são independentes (login não gasta a cota do cadastro)', () => {
  const login = criarFreio({ maxFalhas: 1 });
  const cadastro = criarFreio({ maxFalhas: 1 });

  login.registrarFalha('joao@1.1.1.1');

  assert.ok(login.segundosBloqueado('joao@1.1.1.1') > 0);
  assert.equal(cadastro.segundosBloqueado('joao@1.1.1.1'), 0);
});

test('freio: a poda NÃO descarta um bloqueio ativo (senão vira bypass do lockout)', () => {
  const freio = criarFreio({ maxFalhas: 2, maxChaves: 3, esquecerAposMs: 60_000 });

  // Bloqueia a vítima.
  freio.registrarFalha('vitima');
  freio.registrarFalha('vitima');
  assert.ok(freio.segundosBloqueado('vitima') > 0, 'a vítima entra bloqueada');

  // Enche o Map muito acima do teto com chaves NÃO bloqueadas, forçando a poda a rodar.
  // A versão antiga apagava por ordem de inserção e levava a vítima junto -- a próxima
  // tentativa dela voltaria com falhas=0, destravada.
  for (let i = 0; i < 50; i++) freio.registrarFalha(`ruido-${i}`);

  assert.ok(freio.segundosBloqueado('vitima') > 0, 'o bloqueio ativo sobrevive à poda');
});

test('problemaNaSenha: barra o que um bot tenta primeiro', () => {
  // Boa: longa e sem relacao com o usuario.
  assert.equal(problemaNaSenha('cavalo bateria grampo correto', 'joao'), null);

  // Curta. Era o que a regra antiga (4 caracteres) aceitava.
  assert.ok(problemaNaSenha('1234', 'joao'));
  assert.ok(problemaNaSenha('onzeletras', 'joao'), '10 caracteres ainda é pouco');

  // Longas, mas sem forca nenhuma.
  assert.ok(problemaNaSenha('123456789012', 'joao'), 'sequência óbvia');
  assert.ok(problemaNaSenha('aaaaaaaaaaaa', 'joao'), 'um caractere repetido');
  assert.ok(problemaNaSenha('controladorfinanceiro', 'joao'), 'o nome do próprio app');

  // A senha nao pode ser o login com numeros colados: quem descobre um ganha o outro.
  assert.ok(problemaNaSenha('joaozinho123456', 'joaozinho'));
  assert.ok(problemaNaSenha('JOAOZINHO123456', 'joaozinho'), 'a comparação ignora maiúsculas');

  // Mas "contem o usuario" seria longe demais: com o usuario "ana", esta senha e´ otima
  // e nao tem nada a ver com o login. A regra olha o COMECO, e nao o meio.
  assert.equal(problemaNaSenha('banana bread forever', 'ana'), null);
});
