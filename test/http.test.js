/**
 * Validadores de entrada (src/http.js).
 *
 * Sao a unica coisa entre o corpo cru de um POST e o INSERT. Nao dependem de banco,
 * entao rodam em milissegundos, sem PostgreSQL no ar -- o `npm test` funciona numa
 * maquina limpa e no CI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  texto, dinheiro, data, enumerado, idOpcional, idParam, booleano,
  mesParaIntervalo, traduzErroPg, HttpError,
} from '../src/http.js';

/** Executa `fn` e devolve o HttpError que ela lancou (falha se nao lancar). */
function erroDe(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof HttpError, `esperava HttpError, veio ${err?.constructor?.name}`);
    return err;
  }
  assert.fail('deveria ter lançado');
}

test('texto: apara espaços e exige o obrigatório', () => {
  assert.equal(texto('  Mercado  ', 'descricao'), 'Mercado');
  assert.equal(texto('', 'descricao', { obrigatorio: false }), null);
  assert.equal(texto('   ', 'descricao', { obrigatorio: false }), null, 'só espaços = vazio');

  assert.equal(erroDe(() => texto('', 'descricao')).status, 400);
  assert.equal(erroDe(() => texto(undefined, 'descricao')).campo, 'descricao');
  assert.equal(erroDe(() => texto('x'.repeat(201), 'descricao')).status, 400);
});

test('dinheiro: arredonda para centavos e recusa o que não é dinheiro', () => {
  assert.equal(dinheiro('42.5', 'valor'), 42.5, 'string numérica do JSON vira número');
  assert.equal(dinheiro(10.999, 'valor'), 11, 'arredonda para 2 casas');
  assert.equal(dinheiro(0.014, 'valor'), 0.01);

  // Zero e negativo sao dinheiro invalido: o CHECK do banco (valor > 0) tambem barra,
  // mas aqui a mensagem diz QUAL campo, e o usuario ve isso no formulario.
  assert.equal(erroDe(() => dinheiro(0, 'valor')).status, 400);
  assert.equal(erroDe(() => dinheiro(-5, 'valor')).status, 400);
  assert.equal(erroDe(() => dinheiro('abc', 'valor')).status, 400);
  assert.equal(erroDe(() => dinheiro(Infinity, 'valor')).status, 400);
  assert.equal(erroDe(() => dinheiro(1e12, 'valor')).status, 400, 'grande demais');
});

test('data: só aceita AAAA-MM-DD que EXISTE no calendário', () => {
  assert.equal(data('2026-07-13', 'data'), '2026-07-13');
  assert.equal(data('2024-02-29', 'data'), '2024-02-29', '2024 é bissexto');

  // O perigo aqui e´ o Date do JS "consertar" a data em silencio: new Date(2026,1,31)
  // vira 03/03. O validador tem que RECUSAR, nao normalizar.
  assert.equal(erroDe(() => data('2026-02-30', 'data')).status, 400);
  assert.equal(erroDe(() => data('2025-02-29', 'data')).status, 400, '2025 não é bissexto');
  assert.equal(erroDe(() => data('2026-13-01', 'data')).status, 400);
  assert.equal(erroDe(() => data('13/07/2026', 'data')).status, 400, 'formato brasileiro não passa');
});

test('enumerado: whitelist', () => {
  assert.equal(enumerado('despesa', 'tipo', ['receita', 'despesa']), 'despesa');
  assert.equal(erroDe(() => enumerado('investimento', 'tipo', ['receita', 'despesa'])).status, 400);
});

test('idOpcional e idParam: recusam id que não é inteiro positivo', () => {
  assert.equal(idOpcional('7', 'conta_id'), 7);
  assert.equal(idOpcional('', 'conta_id'), null);
  assert.equal(idOpcional('null', 'conta_id'), null, 'o front manda a string "null"');
  assert.equal(erroDe(() => idOpcional('0', 'conta_id')).status, 400);
  assert.equal(erroDe(() => idOpcional('1.5', 'conta_id')).status, 400);

  assert.equal(idParam('42'), 42);
  assert.equal(erroDe(() => idParam('abc')).status, 400);
  assert.equal(erroDe(() => idParam('-1')).status, 400);
});

test('booleano: aceita as formas que chegam de verdade (JSON e querystring)', () => {
  assert.equal(booleano(true), true);
  assert.equal(booleano('true'), true);
  assert.equal(booleano('1'), true);
  assert.equal(booleano('false'), false);
  assert.equal(booleano(undefined, true), true, 'ausente usa o padrão');
});

test('mesParaIntervalo: fecha o mês no último dia certo', () => {
  assert.deepEqual(mesParaIntervalo('2026-07'), { inicio: '2026-07-01', fim: '2026-07-31' });
  assert.deepEqual(mesParaIntervalo('2026-02'), { inicio: '2026-02-01', fim: '2026-02-28' });
  assert.deepEqual(mesParaIntervalo('2024-02'), { inicio: '2024-02-01', fim: '2024-02-29' }, 'bissexto');
  assert.equal(erroDe(() => mesParaIntervalo('2026-13')).status, 400);
  assert.equal(erroDe(() => mesParaIntervalo('julho')).status, 400);
});

test('traduzErroPg: erro do banco vira mensagem que o usuário entende', () => {
  assert.equal(traduzErroPg({ code: '23505' }).status, 409, 'nome duplicado');
  assert.equal(traduzErroPg({ code: '23514' }).status, 400, 'CHECK violado');

  // not_null_violation vira 400 generico e NAO ecoa o nome da coluna: o identificador
  // interno do banco (usuario_id, tipo_id...) desenharia o schema para quem sonda a API.
  const nulo = traduzErroPg({ code: '23502', column: 'usuario_id' });
  assert.equal(nulo.status, 400);
  assert.equal(nulo.campo, undefined, 'não vaza o nome da coluna');
  assert.ok(!nulo.message.includes('usuario_id'), 'a mensagem não contém o nome interno');

  // O isolamento por usuario (migration 012) fez as FKs compostas passarem a
  // disparar 23503 quando alguem tenta usar a categoria/conta de OUTRO usuario.
  assert.equal(traduzErroPg({ code: '23503', constraint: 'transacoes_categoria_fk' }).status, 409);

  assert.equal(traduzErroPg({ code: '42P01' }), null, 'erro que não sabemos traduzir vira 500');
});
