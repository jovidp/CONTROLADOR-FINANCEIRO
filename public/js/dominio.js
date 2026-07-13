/**
 * Vocabulario do dominio, num lugar so´.
 *
 * Cada uma destas constantes estava copiada em 4 a 8 views -- e as copias JA´ tinham
 * divergido: o COR_STATUS.ok do painel lia `var(--ok)` e o dos orcamentos lia `var(--in)`.
 * As duas variaveis sao verdes no CSS de hoje, entao ninguem percebeu; no dia em que uma
 * delas mudasse, a mesma barra "no controle" teria cores diferentes em duas telas.
 *
 * Isto NAO e´ um `utils.js`: e´ o vocabulario que o app usa para falar de dinheiro
 * (status de orcamento, frequencia de lancamento fixo, a categoria que sobrou sem nome).
 * O que e´ mecanica de UI (montar elemento, formatar numero) fica no `ui.js`.
 */

/** Numero seguro: o que nao for numero vira 0, e nao NaN espalhado pela tela. */
export const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * O lugar de quem perdeu a categoria. Acontece de verdade: apagar uma categoria faz
 * ON DELETE SET NULL nas transacoes dela (o lancamento e´ preservado -- o dinheiro saiu
 * mesmo), e a transferencia nasce sem categoria por definicao.
 *
 * A cor e´ hex literal, e nao `var(--muted)`: ela entra em `background:${cor}33`, e
 * concatenar o alfa "33" num var() geraria "var(--muted)33" -- CSS invalido, que o
 * navegador descarta em silencio.
 */
export const CAT_PADRAO = { cor: '#94a3b8', icone: '📦', nome: 'Sem categoria' };

export const FREQUENCIA_ROTULO = {
  diaria: 'Diária',
  semanal: 'Semanal',
  mensal: 'Mensal',
  anual: 'Anual',
};

/** Cores do tema, com fallback para o caso de a variavel nao existir no CSS. */
export const COR_STATUS = {
  ok: 'var(--ok, #22c55e)',
  atencao: 'var(--warn, #f59e0b)',
  estourado: 'var(--out, #ef4444)',
};

export const ROTULO_STATUS = {
  ok: 'No controle',
  atencao: 'Atenção',
  estourado: 'Estourado',
};

/** Status conhecido, ou 'ok'. Status desconhecido nao pode pintar a barra de transparente. */
export const statusDe = (o) => (COR_STATUS[o?.status] ? o.status : 'ok');

/**
 * Fundo suave a partir da cor da categoria.
 *
 * O teste de hex nao e´ paranoia: `cor` vem do banco e vai direto para um atributo
 * `style`. O backend so´ aceita hexadecimal (RE_COR nas rotas), mas se um valor torto
 * chegasse aqui -- por um dado antigo, ou por uma rota nova que esquecesse de validar --
 * ele viraria injecao de CSS. Sem hex valido, o fundo simplesmente nao existe.
 */
export const corSuave = (cor) =>
  (/^#[0-9a-f]{6}$/i.test(String(cor ?? '')) ? `${cor}22` : 'transparent');

/** Concordancia: "1 lançamento" / "3 lançamentos". */
export const plural = (n, singular, pluralPalavra) =>
  `${n} ${n === 1 ? singular : pluralPalavra}`;
