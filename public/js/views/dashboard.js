/**
 * View: Painel (dashboard). Monta todo o DOM via el() -- o container chega vazio.
 *
 * Uma unica rodada de rede (Promise.all) com o mes de referencia = state.mes.
 *
 * CONVENCAO DE NAVEGACAO COM FILTRO (documentada aqui porque nasce nesta view):
 * clicar numa categoria da legenda do donut leva para a lista de transacoes JA filtrada
 * por ela usando o proprio hash como portador do filtro inicial:
 *
 *     #transacoes?categoria=<id>
 *
 * O hash e a fonte do filtro inicial -- nada de localStorage/sessionStorage e nada de
 * campo novo no contrato do state. A view de transacoes le o parametro ao montar (e o
 * descarta depois de aplicar). Categoria nula ("Sem categoria") nao tem filtro equivalente
 * na API (categoria_id vazio e ignorado pelo backend), entao abre a lista sem filtro.
 */

import { api, ApiError } from '../api.js';
import { state } from '../state.js';
import { el, fmtMoeda, fmtDataCurta, fmtPct, hoje, skeleton, vazio } from '../ui.js';
import { barrasAgrupadas, donut } from '../charts.js';
import { formTransacao, formOrcamento } from '../forms.js';
import { CAT_PADRAO, COR_STATUS, FREQUENCIA_ROTULO, num, statusDe } from '../dominio.js';

const COR_ENTRADA = 'var(--in)';
const COR_SAIDA = 'var(--out)';
// Hex literal, e nao var(--muted): esta cor entra em `background:${cor}33`, e concatenar
// o alfa "33" num var() geraria "var(--muted)33", que o CSS descarta em silencio.
const COR_NEUTRA_HEX = '#94a3b8';

/** Uma casa decimal, pt-BR. Usado nos pontos percentuais da taxa de economia. */
const NUM1 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * Contador de montagens. Se o mes mudar (ou emitir() disparar) enquanto o fetch esta no ar,
 * a resposta velha chega depois e nao pode sobrescrever a tela nova.
 */
let execucao = 0;

/** 'AAAA-MM' -> mes anterior. UTC so para a aritmetica de calendario, nunca para "hoje". */
function mesAnterior(mes) {
  const [ano, m] = String(mes).split('-').map(Number);
  const d = new Date(Date.UTC(ano, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export async function montar(container) {
  const token = ++execucao;
  const mes = state.mes;

  container.replaceChildren();
  skeleton(container, 6);

  let dados;
  try {
    const [resumo, evolucao, categorias, orcamentos, transacoes, recorrentes, metas, contas] = await Promise.all([
      api.relatorios.resumo({ mes }),
      api.relatorios.evolucao({ meses: 6, ate: mes }),
      api.relatorios.categorias({ mes, tipo: 'despesa' }),
      api.orcamentos.listar({ mes }),
      api.transacoes.listar({ mes, limite: 8 }),
      api.recorrentes.listar(),
      api.metas.listar(),
      api.contas.listar(),
    ]);
    dados = { resumo, evolucao, categorias, orcamentos, transacoes, recorrentes, metas, contas };
  } catch (err) {
    if (token !== execucao) return;
    renderErro(container, err);
    return;
  }

  if (token !== execucao) return;
  render(container, mes, dados);
}

function render(container, mes, { resumo, evolucao, categorias, orcamentos, transacoes, recorrentes, metas, contas }) {
  const serie = Array.isArray(evolucao) ? evolucao : [];
  const fatias = Array.isArray(categorias) ? categorias : [];
  const orcs = Array.isArray(orcamentos) ? orcamentos : [];
  const itens = Array.isArray(transacoes?.itens) ? transacoes.itens : [];
  const recs = Array.isArray(recorrentes) ? recorrentes : [];
  const metasLista = Array.isArray(metas) ? metas : [];
  const contasLista = Array.isArray(contas) ? contas : [];
  const alertas = montarAlertas(recs, orcs, metasLista, contasLista);

  // Os graficos precisam do no ja no documento para medir/desenhar: monta a arvore primeiro.
  const alvoBarras = el('div', { class: 'chart' });
  const alvoDonut = el('div', { class: 'chart-donut' });

  container.replaceChildren(
    secaoKpis(resumo, serie, mes),
    cardAlertas(alertas),
    el(
      'div',
      { class: 'grid-2' },
      cardEvolucao(alvoBarras),
      cardCategorias(alvoDonut, fatias, num(resumo?.despesas)),
    ),
    el('div', { class: 'grid-2' }, cardOrcamentos(orcs), cardUltimas(itens)),
    cardRecorrentes(recs),
  );

  barrasAgrupadas(
    alvoBarras,
    serie.map((m) => ({ rotulo: m.rotulo, receitas: num(m.receitas), despesas: num(m.despesas) })),
  );

  if (fatias.length) {
    donut(
      alvoDonut,
      fatias.map((c) => ({ rotulo: c.nome, valor: num(c.total), cor: c.cor || CAT_PADRAO.cor })),
    );
  }
}

// =====================================================================
// 1. KPIs
// =====================================================================

function secaoKpis(resumo, serie, mes) {
  const receitas = num(resumo?.receitas);
  const despesas = num(resumo?.despesas);
  const saldo = num(resumo?.saldo);
  const taxa = num(resumo?.taxa_economia);
  const variacao = resumo?.variacao ?? {};

  const kpiSaldo = cardKpi({
    classe: 'kpi-balance',
    rotulo: 'Saldo do mês',
    ico: '⚖️',
    valor: fmtMoeda(saldo),
    corValor: saldo < 0 ? COR_SAIDA : null,
    rodape: [
      variacaoChip(variacao.saldo_pct, { subirEhBom: true }),
      el('div', { class: 'kpi-sub muted' }, `acumulado: ${fmtMoeda(num(resumo?.saldo_acumulado))}`),
    ],
  });

  const kpiReceitas = cardKpi({
    classe: 'kpi-in',
    rotulo: 'Receitas',
    ico: '📥',
    valor: fmtMoeda(receitas),
    // Receita subindo e bom.
    rodape: [variacaoChip(variacao.receitas_pct, { subirEhBom: true })],
  });

  const kpiDespesas = cardKpi({
    classe: 'kpi-out',
    rotulo: 'Despesas',
    ico: '📤',
    valor: fmtMoeda(despesas),
    // Despesa subindo e ruim: a mesma seta ▲ que fica verde na receita fica vermelha aqui.
    rodape: [variacaoChip(variacao.despesas_pct, { subirEhBom: false })],
  });

  const kpiTaxa = cardKpi({
    classe: 'kpi-rate',
    rotulo: 'Taxa de economia',
    ico: '🐖',
    valor: fmtPct(taxa),
    corValor: taxa < 0 ? COR_SAIDA : null,
    rodape: [taxaRodape(taxa, serie, mes)],
  });

  return el('div', { class: 'cards' }, kpiSaldo, kpiReceitas, kpiDespesas, kpiTaxa);
}

function cardKpi({ classe, rotulo, ico, valor, corValor, rodape }) {
  const attrsValor = { class: 'kpi-value' };
  if (corValor) attrsValor.style = `color:${corValor}`;

  return el(
    'div',
    { class: `card kpi ${classe}` },
    el(
      'div',
      { class: 'kpi-top' },
      el('span', { class: 'kpi-label' }, rotulo),
      el('span', { class: 'kpi-ico' }, ico),
    ),
    el('div', attrsValor, valor),
    rodape,
  );
}

/**
 * Chip de variacao vs. mes anterior.
 * `subirEhBom` decide a COR, nunca a seta: a seta sempre aponta para onde o numero foi.
 * pct null (mes anterior zerado) -> '—' + 'sem base de comparação'. Jamais 'Infinity%'/'NaN'.
 */
function variacaoChip(pct, { subirEhBom }) {
  const n = Number(pct);
  if (pct === null || pct === undefined || !Number.isFinite(n)) return semBase();
  if (n === 0) return neutro('estável vs. mês anterior');

  const subiu = n > 0;
  const bom = subiu === subirEhBom;

  return el(
    'div',
    {
      class: `kpi-foot ${bom ? 'pos' : 'neg'}`,
      style: `color:${bom ? COR_ENTRADA : COR_SAIDA}`,
    },
    el('span', { class: 'seta' }, subiu ? '▲' : '▼'),
    ` ${fmtPct(Math.abs(n))} vs. mês anterior`,
  );
}

/**
 * A taxa de economia nao tem variacao no /relatorios/resumo (o contrato so traz
 * receitas_pct, despesas_pct e saldo_pct). Em vez de inventar campo, derivamos a
 * diferenca em PONTOS PERCENTUAIS a partir do mes anterior que ja vem em /evolucao
 * -- comparar duas porcentagens em "%" seria enganoso.
 */
function taxaRodape(taxaAtual, serie, mes) {
  const anterior = serie.find((m) => m.mes === mesAnterior(mes));
  const receitasAnt = num(anterior?.receitas);
  if (!anterior || receitasAnt <= 0) return semBase();

  const taxaAnt = ((receitasAnt - num(anterior.despesas)) / receitasAnt) * 100;
  const delta = Math.round((taxaAtual - taxaAnt) * 10) / 10;
  if (delta === 0) return neutro('estável vs. mês anterior');

  const subiu = delta > 0;
  return el(
    'div',
    {
      class: `kpi-foot ${subiu ? 'pos' : 'neg'}`,
      style: `color:${subiu ? COR_ENTRADA : COR_SAIDA}`,
    },
    el('span', { class: 'seta' }, subiu ? '▲' : '▼'),
    ` ${NUM1.format(Math.abs(delta))} p.p. vs. mês anterior`,
  );
}

const semBase = () => el('div', { class: 'kpi-foot muted' }, '— sem base de comparação');
const neutro = (texto) => el('div', { class: 'kpi-foot muted' }, `= ${texto}`);

// =====================================================================
// 2. Evolucao (6 meses)
// =====================================================================

function cardEvolucao(alvo) {
  return el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el('h2', {}, 'Evolução (6 meses)'),
      el(
        'div',
        { class: 'legend' },
        el('span', { class: 'dot in', style: `background:${COR_ENTRADA}` }),
        'Receitas',
        el('span', { class: 'dot out', style: `background:${COR_SAIDA}` }),
        'Despesas',
      ),
    ),
    alvo,
  );
}

// =====================================================================
// 3. Despesas por categoria (donut + legenda clicavel)
// =====================================================================

function cardCategorias(alvo, fatias, totalDespesas) {
  const corpo = fatias.length
    ? el('div', { class: 'donut-wrap' }, alvo, legendaCategorias(fatias))
    : el('div');

  if (!fatias.length) {
    vazio(corpo, { ico: '🍩', msg: 'Nenhuma despesa lançada neste mês.' });
  }

  return el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el('h2', {}, 'Despesas por categoria'),
      el('span', { class: 'muted' }, fatias.length ? fmtMoeda(totalDespesas) : ''),
    ),
    corpo,
  );
}

function legendaCategorias(fatias) {
  return el(
    'ul',
    { class: 'donut-legend' },
    fatias.map((c) =>
      el(
        'li',
        {},
        el(
          'button',
          {
            type: 'button',
            class: 'legend-item',
            title: `Ver transações de ${c.nome}`,
            onclick: () => irParaTransacoes(c.categoria_id),
          },
          el('span', { class: 'dot', style: `background:${c.cor || CAT_PADRAO.cor}` }),
          el('span', { class: 'legend-nome' }, `${c.icone || CAT_PADRAO.icone} ${c.nome}`),
          el('span', { class: 'legend-valor' }, fmtMoeda(num(c.total))),
          el('span', { class: 'legend-pct muted' }, fmtPct(num(c.percentual))),
        ),
      ),
    ),
  );
}

/** Filtro inicial viaja no hash: '#transacoes?categoria=<id>'. Ver cabecalho do arquivo. */
function irParaTransacoes(categoriaId) {
  location.hash = categoriaId == null ? '#transacoes' : `#transacoes?categoria=${categoriaId}`;
}

// =====================================================================
// 4. Alertas
// =====================================================================

function diasAte(data) {
  const alvo = /^\d{4}-\d{2}-\d{2}$/.test(String(data ?? ''))
    ? Date.UTC(...String(data).split('-').map(Number).map((valor, indice) => indice === 1 ? valor - 1 : valor))
    : NaN;
  const agora = Date.UTC(...hoje().split('-').map(Number).map((valor, indice) => indice === 1 ? valor - 1 : valor));
  return Number.isFinite(alvo) ? Math.round((alvo - agora) / 86_400_000) : null;
}

function montarAlertas(recs, orcs, metas, contas) {
  const alertas = [];

  for (const rec of recs) {
    if (!rec.ativa) continue;
    const dias = diasAte(rec.proxima_data);
    if (dias === null || dias > 7) continue;
    const prazo = dias < 0
      ? `atrasada há ${Math.abs(dias)} dia(s)`
      : dias === 0
        ? 'vence hoje'
        : `vence em ${dias} dia(s)`;
    alertas.push({
      icone: '🔁',
      titulo: rec.descricao,
      detalhe: `Recorrência ${prazo} · ${fmtMoeda(num(rec.valor))}`,
      cor: dias < 0 ? 'var(--out)' : 'var(--warn)',
      acao: () => (location.hash = '#recorrentes'),
    });
  }

  for (const orc of orcs) {
    const percentual = num(orc.percentual);
    if (percentual < 75) continue;
    alertas.push({
      icone: '🎯',
      titulo: orc.categoria_nome || 'Orçamento',
      detalhe: percentual >= 100
        ? `Orçamento estourado · ${fmtPct(percentual)}`
        : `Orçamento quase estourado · ${fmtPct(percentual)}`,
      cor: percentual >= 100 ? 'var(--out)' : 'var(--warn)',
      acao: () => (location.hash = '#orcamentos'),
    });
  }

  for (const meta of metas) {
    const dias = diasAte(meta.prazo);
    if (meta.concluida || dias === null || dias >= 0) continue;
    alertas.push({
      icone: '🏆',
      titulo: meta.nome,
      detalhe: `Meta atrasada há ${Math.abs(dias)} dia(s)`,
      cor: 'var(--out)',
      acao: () => (location.hash = '#metas'),
    });
  }

  for (const conta of contas) {
    const saldo = num(conta.saldo);
    if (saldo > 100) continue;
    alertas.push({
      icone: '💰',
      titulo: conta.nome,
      detalhe: `Saldo baixo · ${fmtMoeda(saldo)}`,
      cor: saldo < 0 ? 'var(--out)' : 'var(--warn)',
      acao: () => (location.hash = '#config'),
    });
  }

  return alertas;
}

function cardAlertas(alertas) {
  const corpo = el('div', { class: 'alertas-list' });
  if (!alertas.length) {
    vazio(corpo, { ico: '✅', msg: 'Nenhum alerta no momento.' });
  } else {
    corpo.append(...alertas.map(linhaAlerta));
  }

  return el(
    'div',
    { class: 'card card-alertas' },
    el(
      'div',
      { class: 'card-head' },
      el('h2', {}, 'Alertas'),
      alertas.length ? el('span', { class: 'muted' }, `${alertas.length} aviso(s)`) : null,
    ),
    corpo,
  );
}

function linhaAlerta(alerta) {
  return el(
    'button',
    { type: 'button', class: 'tx-item alerta-item', onclick: alerta.acao },
    el(
      'span',
      { class: 'tx-ico alerta-ico', style: `--cor:${alerta.cor};color:${alerta.cor}` },
      alerta.icone,
    ),
    el(
      'span',
      { class: 'tx-info' },
      el('strong', { class: 'tx-desc' }, alerta.titulo),
      el('span', { class: 'tx-meta muted' }, alerta.detalhe),
    ),
    el('span', { class: 'alerta-seta', 'aria-hidden': 'true' }, '→'),
  );
}

// =====================================================================
// 5. Orcamentos do mes
// =====================================================================

function cardOrcamentos(orcs) {
  const corpo = el('div', { class: 'budget-list' });

  if (!orcs.length) {
    vazio(corpo, {
      ico: '🎯',
      msg: 'Nenhum orçamento definido. Defina um teto de gastos por categoria.',
      acao: { texto: '+ Criar orçamento', onClick: () => formOrcamento() },
    });
  } else {
    // Os mais criticos primeiro: 5 linhas so cabem o que realmente importa olhar.
    const top = [...orcs].sort((a, b) => num(b.percentual) - num(a.percentual)).slice(0, 5);
    corpo.append(...top.map(linhaOrcamento));
  }

  return el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el('h2', {}, 'Orçamentos do mês'),
      el(
        'button',
        { type: 'button', class: 'link-btn', onclick: () => (location.hash = '#orcamentos') },
        'gerenciar →',
      ),
    ),
    corpo,
  );
}

function linhaOrcamento(o) {
  const pct = num(o.percentual);
  const status = statusDe(o);
  const largura = Math.max(0, Math.min(100, pct)); // percentual pode passar de 100; a barra nao.
  const restante = num(o.restante);

  const rodape = [`${fmtMoeda(num(o.gasto))} de ${fmtMoeda(num(o.limite))}`];
  if (status === 'estourado') rodape.push(` · estourou ${fmtMoeda(Math.abs(restante))}`);

  return el(
    'div',
    { class: `budget ${status}` },
    el(
      'div',
      { class: 'budget-top' },
      el(
        'span',
        { class: 'budget-cat' },
        el(
          'span',
          { class: 'cat-ico', style: `background:${o.categoria_cor || CAT_PADRAO.cor}33` },
          o.categoria_icone || CAT_PADRAO.icone,
        ),
        o.categoria_nome ?? CAT_PADRAO.nome,
      ),
      el('span', { class: 'budget-pct', style: `color:${COR_STATUS[status]}` }, fmtPct(pct)),
    ),
    el(
      'div',
      {
        class: 'bar',
        role: 'progressbar',
        'aria-valuenow': String(Math.round(largura)),
        'aria-valuemin': '0',
        'aria-valuemax': '100',
      },
      el('div', {
        class: `bar-fill ${status}`,
        style: `width:${largura}%;background:${COR_STATUS[status]}`,
      }),
    ),
    el('div', { class: 'budget-foot muted' }, rodape.join('')),
  );
}

// =====================================================================
// 5. Ultimas transacoes
// =====================================================================

function cardUltimas(itens) {
  const corpo = el('div', { class: 'tx-list' });

  if (!itens.length) {
    vazio(corpo, {
      ico: '🗂️',
      msg: 'Nenhuma transação neste mês.',
      acao: { texto: '+ Adicionar transação', onClick: () => formTransacao() },
    });
  } else {
    corpo.append(...itens.map(linhaTransacao));
  }

  return el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el('h2', {}, 'Últimas transações'),
      el(
        'button',
        { type: 'button', class: 'link-btn', onclick: () => (location.hash = '#transacoes') },
        'ver todas →',
      ),
    ),
    corpo,
  );
}

function linhaTransacao(tx) {
  const transferencia = tx.tipo === 'transferencia';
  const receita = tx.tipo === 'receita';
  const cor = transferencia ? COR_NEUTRA_HEX : tx.categoria_cor || CAT_PADRAO.cor;

  const meta = transferencia
    ? [fmtDataCurta(tx.data), `${tx.conta_nome} → ${tx.conta_destino_nome}`].join(' · ')
    : [
        fmtDataCurta(tx.data),
        tx.categoria_nome ?? CAT_PADRAO.nome,
        tx.conta_nome ?? 'Sem conta',
      ].join(' · ');

  // Sem sinal e sem verde/vermelho: a transferencia nao somou nem subtraiu nada do
  // seu dinheiro, so´ o moveu de conta. Um "− R$ 300" vermelho aqui seria mentira.
  const valor = transferencia
    ? el('span', { class: 'tx-valor' }, fmtMoeda(num(tx.valor)))
    : el(
        'span',
        {
          class: `tx-valor ${receita ? 'in' : 'out'}`,
          style: `color:${receita ? COR_ENTRADA : COR_SAIDA}`,
        },
        `${receita ? '+' : '−'} ${fmtMoeda(num(tx.valor))}`,
      );

  return el(
    'button',
    {
      type: 'button',
      class: 'tx-item',
      title: 'Editar transação',
      onclick: () => formTransacao(tx),
    },
    el(
      'span',
      { class: 'tx-ico', style: `background:${cor}33;border:1px solid ${cor}` },
      transferencia ? '⇄' : tx.categoria_icone || CAT_PADRAO.icone,
    ),
    el(
      'span',
      { class: 'tx-info' },
      el('strong', { class: 'tx-desc' }, tx.descricao),
      el('span', { class: 'tx-meta muted' }, meta),
    ),
    valor,
  );
}

// =====================================================================
// 6. Lancamentos recorrentes ativos
// =====================================================================

function cardRecorrentes(lista) {
  const ativas = lista.filter((rec) => rec.ativa).slice(0, 5);
  const corpo = el('div', { class: 'tx-list' });

  if (!ativas.length) {
    vazio(corpo, {
      ico: '🔁',
      msg: 'Nenhum lançamento recorrente ativo.',
      acao: { texto: '+ Criar recorrência', onClick: () => (location.hash = '#recorrentes') },
    });
  } else {
    corpo.append(...ativas.map(linhaRecorrente));
  }

  return el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el('h2', {}, 'Lançamentos recorrentes'),
      el(
        'button',
        { type: 'button', class: 'link-btn', onclick: () => (location.hash = '#recorrentes') },
        'ver todos →',
      ),
    ),
    corpo,
  );
}

function linhaRecorrente(rec) {
  const receita = rec.tipo === 'receita';
  const cor = rec.categoria_cor || CAT_PADRAO.cor;
  const meta = [
    FREQUENCIA_ROTULO[rec.frequencia] ?? rec.frequencia,
    `próximo: ${fmtDataCurta(rec.proxima_data)}`,
    rec.categoria_nome ?? CAT_PADRAO.nome,
  ].join(' · ');

  return el(
    'button',
    {
      type: 'button',
      class: 'tx-item',
      title: 'Ver lançamentos recorrentes',
      onclick: () => (location.hash = '#recorrentes'),
    },
    el(
      'span',
      { class: 'tx-ico', style: `background:${cor}33;border:1px solid ${cor}` },
      rec.categoria_icone || CAT_PADRAO.icone,
    ),
    el(
      'span',
      { class: 'tx-info' },
      el('strong', { class: 'tx-desc' }, rec.descricao),
      el('span', { class: 'tx-meta muted' }, meta),
    ),
    el(
      'span',
      {
        class: `tx-valor ${receita ? 'in' : 'out'}`,
        style: `color:${receita ? COR_ENTRADA : COR_SAIDA}`,
      },
      `${receita ? '+' : '−'} ${fmtMoeda(num(rec.valor))}`,
    ),
  );
}

// =====================================================================
// Erro
// =====================================================================

function renderErro(container, err) {
  const msg =
    err instanceof ApiError ? err.message : 'Não consegui carregar o painel. Tente novamente.';

  container.replaceChildren(
    el(
      'div',
      { class: 'card' },
      el(
        'div',
        { class: 'empty' },
        el('div', { class: 'empty-ico' }, '⚠️'),
        el('p', {}, msg),
        el(
          'button',
          { type: 'button', class: 'primary-btn', onclick: () => montar(container) },
          'Tentar de novo',
        ),
      ),
    ),
  );
}
