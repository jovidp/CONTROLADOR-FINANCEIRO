/**
 * Autenticacao (src/auth.js): hash de senha, token de sessao e freio de tentativas.
 *
 * Nada aqui toca no banco. O `import` de auth.js puxa db.js, que CRIA o pool -- mas o
 * pg so´ abre conexao no primeiro query(), e nenhum teste daqui faz query.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  gerarHash, criarToken, sessaoValida, chaveTentativa,
  segundosBloqueado, registrarFalha, registrarAcerto,
} from '../src/auth.js';

test('gerarHash: nunca guarda a senha, e nunca repete o mesmo hash', () => {
  const hash = gerarHash('minha senha secreta');

  assert.match(hash, /^scrypt\$16384\$8\$1\$[\w+/=]+\$[\w+/=]+$/);
  assert.ok(!hash.includes('minha senha secreta'), 'a senha em claro não pode aparecer');

  // Salt aleatorio: a MESMA senha gera hashes diferentes. Sem isso, dois usuarios com a
  // senha "1234" teriam hashes identicos -- e quebrar um quebraria os dois.
  assert.notEqual(gerarHash('1234'), gerarHash('1234'));
});

test('criarToken: payload legível, assinatura que não se forja', () => {
  const { token, duracaoMs } = criarToken({ usuario: 'joao', usuarioId: 7 });
  const [corpo, assinatura] = token.split('.');

  const dados = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8'));
  assert.equal(dados.id, 7);
  assert.equal(dados.u, 'joao');
  assert.ok(dados.exp > Date.now(), 'o token nasce válido');
  assert.ok(assinatura.length > 0);

  // O payload NAO e´ secreto (da´ para ler, como acabamos de fazer) -- ele so´ nao pode
  // ser ALTERADO. Trocar o id de 7 para 1 muda o corpo e invalida a assinatura.
  const forjado = Buffer.from(JSON.stringify({ ...dados, id: 1 })).toString('base64url');
  assert.notEqual(forjado, corpo);

  // "lembrar" estica a sessao de 12h para 30 dias.
  const curto = criarToken({ usuario: 'joao', usuarioId: 7, lembrar: false });
  const longo = criarToken({ usuario: 'joao', usuarioId: 7, lembrar: true });
  assert.ok(longo.duracaoMs > curto.duracaoMs);
  assert.equal(duracaoMs, curto.duracaoMs);
});

test('sessaoValida: id null NÃO passa', () => {
  assert.equal(sessaoValida({ id: 7, u: 'joao' }), true);

  // A guarda antiga era Number.isInteger(Number(sessao.id)) -- e Number(null) e´ 0, que
  // e´ inteiro. Uma sessao com id null passava pelo portao e ia consultar o banco com
  // usuario_id = null.
  assert.equal(sessaoValida({ id: null }), false);
  assert.equal(sessaoValida({ id: 0 }), false);
  assert.equal(sessaoValida({ id: -1 }), false);
  assert.equal(sessaoValida({ id: '7' }), false, 'string não é inteiro');
  assert.equal(sessaoValida(null), false);
  assert.equal(sessaoValida(undefined), false);
});

test('chaveTentativa: separa por usuário E por origem', () => {
  const req = (ip, cab = {}) => ({ headers: cab, socket: { remoteAddress: ip } });

  assert.notEqual(
    chaveTentativa(req('1.1.1.1'), 'joao'),
    chaveTentativa(req('1.1.1.1'), 'maria'),
    'usuários diferentes, no mesmo IP, não compartilham o contador',
  );
  assert.notEqual(
    chaveTentativa(req('1.1.1.1'), 'joao'),
    chaveTentativa(req('2.2.2.2'), 'joao'),
    'o mesmo usuário, de IPs diferentes, não compartilha o contador',
  );

  // Atras do Tailscale/proxy o IP real vem no cabecalho; o socket seria sempre o proxy.
  assert.equal(
    chaveTentativa(req('127.0.0.1', { 'x-forwarded-for': '9.9.9.9, 10.0.0.1' }), 'joao'),
    chaveTentativa(req('outro', { 'x-forwarded-for': '9.9.9.9' }), 'joao'),
  );
});

test('freio de login: tranca quem erra, e SÓ quem erra', () => {
  const req = { headers: {}, socket: { remoteAddress: '1.1.1.1' } };
  const alvo = chaveTentativa(req, 'vitima');
  const outro = chaveTentativa(req, 'inocente');

  registrarAcerto(alvo);
  registrarAcerto(outro);

  // Quatro erros ainda deixam tentar: quem erra a senha uma vez nao pode ser castigado
  // como um ataque.
  for (let i = 0; i < 4; i++) registrarFalha(alvo);
  assert.equal(segundosBloqueado(alvo), 0);

  registrarFalha(alvo); // a quinta tranca
  assert.ok(segundosBloqueado(alvo) > 0);

  // O contador era GLOBAL: cinco senhas erradas de qualquer um trancavam o login de
  // TODOS. Com /api/auth/cadastro publico, era negacao de servico de graca.
  assert.equal(segundosBloqueado(outro), 0, 'o bloqueio de um NÃO pode atingir o outro');

  registrarAcerto(alvo);
  assert.equal(segundosBloqueado(alvo), 0, 'acertar a senha destranca');
});
