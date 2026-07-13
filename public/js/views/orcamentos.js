/**
 * View "Orçamentos" — teto de gastos mensal por categoria de despesa.
 *
 * O acompanhamento sempre usa o mes selecionado na topbar (state.mes): o backend
 * recalcula 'gasto' para o intervalo pedido, entao a mesma lista muda de numeros
 * conforme o mes. Nada e guardado aqui: mutou -> emitir() -> main.js remonta.
 */

import { api } from '../api.js';
import { state } from '../state.js';
import { excluirCom, formOrcamento } from '../forms.js';
import {
  el,
  fmtMoeda,
  fmtMesLongo,
  fmtPct,
  skeleton,
  vazio,
} from '../ui.js';
import { COR_STATUS, ROTULO_STATUS, corSuave, num, plural, statusDe } from '../dominio.js';

// =====================================================================
// Montagem
// =====================================================================

export async function montar(container) {
  if (!container) return;

  skeleton(container, 4);

  let orcamentos;
  try {
    orcamentos = await api.orcamentos.listar({ mes: state.mes });
  } catch (err) {
    mostrarErro(container, err);
    return;
  }

  renderizar(container, Array.isArray(orcamentos) ? orcamentos : []);
}

function mostrarErro(container, err) {
  const card = el('div', { class: 'card' });
  vazio(card, {
    ico: '⚠️',
    msg: err?.message || 'Não foi possível carregar os orçamentos.',
    acao: { texto: 'Tentar de novo', onClick: () => montar(container) },
  });
  container.replaceChildren(card);
}

function renderizar(container, orcamentos) {
  // Categorias que ja tem orcamento: o form nao pode oferece-las de novo
  // (o banco tem UNIQUE em categoria_id e devolveria 409).
  const idsOrcados = orcamentos.map((o) => o.categoria_id);
  const abrirNovo = () => formOrcamento(undefined, idsOrcados);

  const partes = [cabecalho(abrirNovo)];

  if (orcamentos.length === 0) {
    const card = el('div', { class: 'card' });
    vazio(card, {
      ico: '🎯',
      msg:
        'Um orçamento é um teto de gastos mensal para uma categoria de despesa. ' +
        'Defina o limite e acompanhe quanto já foi usado no mês, antes de estourar.',
      acao: { texto: '+ Criar meu primeiro orçamento', onClick: abrirNovo },
    });
    partes.push(card);
    container.replaceChildren(...partes);
    return;
  }

  // Do mais critico para o menos. O status deriva do percentual no backend, entao
  // ordenar por percentual desc ja agrupa estourado > atencao > ok.
  const ordenados = [...orcamentos].sort(
    (a, b) =>
      num(b.percentual) - num(a.percentual) ||
      String(a.categoria_nome).localeCompare(String(b.categoria_nome), 'pt-BR'),
  );

  partes.push(cardTotais(ordenados));
  partes.push(
    el(
      'div',
      { class: ['budget-list', 'big'] },
      ordenados.map((o) => cartao(o, orcamentos)),
    ),
  );

  container.replaceChildren(...partes);
}

// =====================================================================
// Pedacos
// =====================================================================

function cabecalho(abrirNovo) {
  return el(
    'div',
    { class: ['card', 'view-head'] },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        {},
        el('h2', {}, 'Limites por categoria'),
        el('p', { class: 'muted' }, `Acompanhamento de ${fmtMesLongo(state.mes)}.`),
      ),
      el('button', { class: 'primary-btn', type: 'button', onclick: abrirNovo }, '+ Novo orçamento'),
    ),
  );
}

function cardTotais(orcamentos) {
  const limite = orcamentos.reduce((soma, o) => soma + num(o.limite), 0);
  const gasto = orcamentos.reduce((soma, o) => soma + num(o.gasto), 0);
  const sobra = limite - gasto;
  const percentual = limite > 0 ? (gasto / limite) * 100 : 0;

  let geral = 'ok';
  if (percentual >= 100) geral = 'estourado';
  else if (percentual >= 75) geral = 'atencao';

  return el(
    'div',
    { class: ['card', 'orc-totais'] },
    el(
      'div',
      { class: 'card-head' },
      el('h2', {}, 'Total orçado'),
      el('span', { class: 'muted' }, plural(orcamentos.length, 'categoria', 'categorias')),
    ),
    el(
      'div',
      { class: 'stat-list' },
      stat('Limite total', fmtMoeda(limite)),
      stat('Já gasto', fmtMoeda(gasto), 'out'),
      sobra >= 0
        ? stat('Ainda pode gastar', fmtMoeda(sobra), 'in')
        : stat('Passou do limite em', fmtMoeda(Math.abs(sobra)), 'out'),
    ),
    barra(percentual, geral),
    el(
      'p',
      { class: 'muted' },
      `${fmtPct(percentual)} do total orçado já foi usado em ${fmtMesLongo(state.mes)}.`,
    ),
  );
}

function stat(rotulo, valor, tom) {
  return el(
    'div',
    { class: 'stat' },
    el('span', { class: 'stat-label' }, rotulo),
    el('strong', { class: ['stat-value', tom ? `stat-${tom}` : null] }, valor),
  );
}

/**
 * Barra de progresso. A largura GRAMPEIA em 100% (uma barra de 143% vazaria do
 * cartao); o texto do cartao continua mostrando o percentual real.
 */
function barra(percentual, situacao) {
  const real = num(percentual);
  const largura = Math.min(Math.max(real, 0), 100);

  return el(
    'div',
    {
      class: ['bar', `bar-${situacao}`],
      role: 'progressbar',
      'aria-valuenow': String(Math.round(real)),
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-label': `${fmtPct(real)} do limite`,
    },
    el('div', {
      class: 'bar-fill',
      style: { width: `${largura}%`, background: COR_STATUS[situacao] },
    }),
  );
}

function cartao(orc, todos) {
  const situacao = statusDe(orc);
  const restante = num(orc.restante);
  const estourou = restante < 0;

  const editar = () =>
    // Na edicao, a propria categoria do orcamento nao entra na lista de "ja orcadas".
    formOrcamento(orc, todos.filter((o) => o.id !== orc.id).map((o) => o.categoria_id));

  return el(
    'article',
    { class: ['budget', `budget-${situacao}`] },
    el(
      'div',
      { class: 'budget-top' },
      el(
        'span',
        { class: 'budget-ico', style: { background: corSuave(orc.categoria_cor) } },
        orc.categoria_icone || '📦',
      ),
      el(
        'div',
        { class: 'budget-id' },
        el('strong', {}, orc.categoria_nome || 'Sem categoria'),
        el('span', { class: 'muted' }, `${fmtMoeda(orc.gasto)} de ${fmtMoeda(orc.limite)}`),
      ),
      el(
        'div',
        { class: 'budget-meta' },
        el('span', { class: ['budget-pct', `txt-${situacao}`] }, fmtPct(orc.percentual)),
        el('span', { class: ['tag', `tag-${situacao}`] }, ROTULO_STATUS[situacao]),
      ),
      el(
        'div',
        { class: 'budget-acoes' },
        el(
          'button',
          { class: 'icon-btn', type: 'button', title: 'Editar orçamento', 'aria-label': `Editar orçamento de ${orc.categoria_nome}`, onclick: editar },
          '✏️',
        ),
        el(
          'button',
          {
            class: 'icon-btn',
            type: 'button',
            title: 'Excluir orçamento',
            'aria-label': `Excluir orçamento de ${orc.categoria_nome}`,
            onclick: () => excluir(orc),
          },
          '🗑️',
        ),
      ),
    ),
    barra(orc.percentual, situacao),
    el(
      'div',
      { class: 'budget-foot' },
      estourou
        ? el('span', { class: 'txt-estourado' }, `Estourou ${fmtMoeda(Math.abs(restante))}`)
        : el('span', { class: 'muted' }, `Faltam ${fmtMoeda(restante)} para o limite`),
    ),
  );
}

// =====================================================================
// Acoes
// =====================================================================

function excluir(orc) {
  return excluirCom({
    titulo: 'Excluir orçamento',
    msg: `O limite de ${orc.categoria_nome} será removido. As transações da categoria não são apagadas.`,
    acao: () => api.orcamentos.remover(orc.id),
    sucesso: 'Orçamento excluído.',
    // Sem recarregar: orcamento nao entra no cache do state (nem mexe em conta/categoria).
  });
}
