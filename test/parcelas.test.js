/**
 * Parcelamento (src/services/parcelas.js) e aritmetica de data (services/recorrentes.js).
 *
 * Os dois lugares onde um bug custa dinheiro de verdade: um centavo que some na divisao,
 * ou uma parcela que cai no mes errado. Sao funcoes puras -- nao tocam no banco.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dividirParcelas, montarParcelas } from '../src/services/parcelas.js';
import { somarMeses, proximaData } from '../src/services/recorrentes.js';

/** Soma em CENTAVOS: somar floats aqui reintroduziria o erro que estamos testando. */
const soma = (valores) => valores.reduce((t, v) => t + Math.round(v * 100), 0) / 100;

test('dividirParcelas: a soma das parcelas bate EXATAMENTE com o total', () => {
  // O caso classico: 100/3 = 33,3333... Arredondar cada parcela para 33,33 daria 99,99
  // e sumiria com um centavo do usuario. O resto vai nas PRIMEIRAS parcelas.
  assert.deepEqual(dividirParcelas(100, 3), [33.34, 33.33, 33.33]);
  assert.equal(soma(dividirParcelas(100, 3)), 100);

  assert.deepEqual(dividirParcelas(10, 3), [3.34, 3.33, 3.33]);
  assert.deepEqual(dividirParcelas(1200, 12), Array(12).fill(100), 'divisão exata não inventa resto');

  // Varre uma faixa larga: nenhum total, em nenhum número de parcelas, pode perder
  // ou inventar centavo.
  for (let n = 1; n <= 24; n++) {
    for (const total of [0.03, 1, 9.99, 100, 1234.56, 99999.99]) {
      const parcelas = dividirParcelas(total, n);
      assert.equal(parcelas.length, n);
      assert.equal(soma(parcelas), total, `total ${total} em ${n}x não fecha`);
    }
  }
});

test('dividirParcelas: as parcelas maiores vêm primeiro', () => {
  // Cobrar a diferenca na PRIMEIRA parcela e´ a convencao do mercado (e o que o cliente
  // espera ver na fatura). Uma parcela final maior que as outras pareceria erro.
  const p = dividirParcelas(100, 3);
  assert.ok(p[0] >= p[1] && p[1] >= p[2], 'parcelas devem ser decrescentes');
});

test('somarMeses: grampeia o dia no último dia do mês de destino', () => {
  // Sem o grampo, o Date do JS "normaliza": 31/01 + 1 mes viraria 03/03 -- a parcela
  // pularia fevereiro inteiro e cairia em marco.
  assert.equal(somarMeses('2026-01-31', 1), '2026-02-28');
  assert.equal(somarMeses('2024-01-31', 1), '2024-02-29', 'bissexto');
  assert.equal(somarMeses('2024-02-29', 12), '2025-02-28');
  assert.equal(somarMeses('2026-03-31', 1), '2026-04-30');

  assert.equal(somarMeses('2026-12-15', 1), '2027-01-15', 'atravessa o ano');
  assert.equal(somarMeses('2026-07-13', 0), '2026-07-13');
});

test('montarParcelas: parcela 1 na data da compra, uma por mês, sem drift', () => {
  const p = montarParcelas({ valorTotal: 100, totalParcelas: 3, dataPrimeira: '2026-01-31' });

  assert.deepEqual(p.map((x) => x.data), ['2026-01-31', '2026-02-28', '2026-03-31']);
  assert.equal(soma(p.map((x) => x.valor)), 100);
  assert.deepEqual(p.map((x) => x.numero), [1, 2, 3]);

  // Cada data e´ calculada a partir da data ORIGINAL (somarMeses(dataPrimeira, i)), e nao
  // encadeada a partir da anterior. Encadeando, o grampo de 31->28 se propagaria: a
  // parcela 3 cairia em 28/03 em vez de 31/03, e a compra "andaria" para tras.
  assert.equal(p[2].data, '2026-03-31', 'a parcela 3 volta ao dia 31 (sem drift)');
});

test('proximaData: as quatro frequências', () => {
  assert.equal(proximaData('2026-07-13', 'diaria'), '2026-07-14');
  assert.equal(proximaData('2026-07-13', 'semanal'), '2026-07-20');
  assert.equal(proximaData('2026-07-13', 'mensal'), '2026-08-13');
  assert.equal(proximaData('2026-07-13', 'anual'), '2027-07-13');

  assert.equal(proximaData('2026-12-31', 'diaria'), '2027-01-01', 'vira o ano');
  assert.equal(proximaData('2026-01-31', 'mensal'), '2026-02-28', 'usa o mesmo grampo');

  assert.throws(() => proximaData('2026-07-13', 'quinzenal'), 'frequência fora da whitelist');
  assert.throws(() => proximaData('13/07/2026', 'mensal'), 'data em formato inválido');
});
