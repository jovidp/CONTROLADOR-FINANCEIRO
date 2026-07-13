/** Divisao de uma compra parcelada em lancamentos mensais. */
import { somarMeses } from './recorrentes.js';

/**
 * Divide `valorTotal` em `n` parcelas SEM perder nem inventar centavo.
 *
 * Dividir 100,00 em 3x da´ 33,3333... Arredondar cada parcela para 33,33 faria a
 * soma dar 99,99 -- some um centavo do usuario. Entao trabalhamos em centavos
 * (inteiros) e distribuimos o resto nas PRIMEIRAS parcelas: 33,34 + 33,33 + 33,33.
 * A soma bate exatamente com o total, sempre.
 */
export function dividirParcelas(valorTotal, n) {
  const centavosTotal = Math.round(valorTotal * 100);
  const base = Math.floor(centavosTotal / n);
  const resto = centavosTotal - base * n; // 0 <= resto < n

  return Array.from({ length: n }, (_, i) => (base + (i < resto ? 1 : 0)) / 100);
}

/**
 * Monta as N parcelas de uma compra: valor de cada uma e o mes em que cai.
 * A parcela 1 cai na data da compra; a 2 um mes depois, e assim por diante.
 */
export function montarParcelas({ valorTotal, totalParcelas, dataPrimeira }) {
  const valores = dividirParcelas(valorTotal, totalParcelas);

  return valores.map((valor, i) => ({
    numero: i + 1,
    valor,
    data: somarMeses(dataPrimeira, i),
  }));
}
