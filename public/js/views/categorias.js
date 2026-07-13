/**
 * View: Categorias. Duas seções (Receitas e Despesas), grade de cartões.
 *
 * O cartão inteiro abre a edição; o botão de lixeira exclui. Por isso o cartão é
 * um <div> com um <button> dentro (e não um <button> aninhado em outro, que é
 * HTML inválido e quebra o clique/teclado).
 *
 * A exclusão é o ponto delicado desta tela: o DELETE não apaga transação nenhuma
 * (a FK é ON DELETE SET NULL sobre categoria_id) -- a confirmação diz isso com
 * todas as letras, porque "excluir categoria" soa como "excluir os gastos dela".
 */

import { api, ApiError } from '../api.js';
import { el, skeleton, vazio } from '../ui.js';
import { excluirCom, formCategoria } from '../forms.js';

const COR_PADRAO = '#64748b';
const ICONE_PADRAO = '📦';

/** Descarta resposta antiga que chegou depois de uma remontagem. */
let execucao = 0;

// =====================================================================
// Montagem
// =====================================================================

export async function montar(container) {
  const token = ++execucao;

  container.replaceChildren();
  skeleton(container, 4);

  let categorias;
  try {
    // Busca direto na API (e nao no state) para ler o 'em_uso' mais recente:
    // ele muda a cada transacao criada/excluida.
    categorias = await api.categorias.listar();
  } catch (err) {
    if (token !== execucao) return;
    renderErro(container, err);
    return;
  }

  if (token !== execucao) return;
  render(container, Array.isArray(categorias) ? categorias : []);
}

function render(container, categorias) {
  const receitas = categorias.filter((c) => c.tipo === 'receita');
  const despesas = categorias.filter((c) => c.tipo === 'despesa');

  container.replaceChildren(
    el(
      'section',
      { class: 'cat-view' },
      cabecalho(),
      secao({
        titulo: 'Receitas',
        ico: '📥',
        itens: receitas,
        msgVazia: 'Nenhuma categoria de receita. Crie uma para organizar de onde vem o dinheiro.',
        tipo: 'receita',
      }),
      secao({
        titulo: 'Despesas',
        ico: '📤',
        itens: despesas,
        msgVazia: 'Nenhuma categoria de despesa. Crie uma para saber para onde vai o dinheiro.',
        tipo: 'despesa',
      }),
      // Nao ha secao "sem tipo": o CHECK do banco so permite receita|despesa.
    ),
  );
}

function cabecalho() {
  return el(
    'div',
    { class: 'card cat-cabecalho' },
    el(
      'div',
      { class: 'card-head' },
      el('h2', {}, 'Categorias'),
      el(
        'button',
        { type: 'button', class: 'primary-btn', onclick: () => formCategoria() },
        '+ Nova categoria',
      ),
    ),
    el(
      'p',
      { class: 'muted mb' },
      'Categorias organizam seus lançamentos. Uma categoria de despesa só pode ser usada em despesas (e o mesmo vale para receitas).',
    ),
  );
}

function secao({ titulo, ico, itens, msgVazia, tipo }) {
  const grade = el('div', { class: 'cat-grid' });

  if (itens.length === 0) {
    vazio(grade, {
      ico,
      msg: msgVazia,
      // formCategoria(cat) so aceita uma Categoria real (docs/FRONTEND.md): chamamos sem
      // argumento para "criar". Passar um {tipo} solto seria inventar convencao -- o form
      // poderia ler isso como edicao e disparar um PUT sem id.
      acao: { texto: '+ Nova categoria', onClick: () => formCategoria() },
    });
  } else {
    grade.append(...itens.map(cartao));
  }

  return el(
    'div',
    { class: `card cat-secao cat-secao-${tipo}` },
    el(
      'div',
      { class: 'card-head' },
      el('h2', {}, `${ico} ${titulo}`),
      el('span', { class: 'muted' }, itens.length === 1 ? '1 categoria' : `${itens.length} categorias`),
    ),
    grade,
  );
}

// =====================================================================
// Cartão
// =====================================================================

function cartao(cat) {
  const cor = cat.cor || COR_PADRAO;
  const icone = cat.icone || ICONE_PADRAO;

  const abrir = el(
    'button',
    {
      type: 'button',
      class: 'cat-abrir',
      title: `Editar ${cat.nome}`,
      'aria-label': `Editar categoria ${cat.nome}`,
      onclick: () => formCategoria(cat),
    },
    el(
      'span',
      {
        class: 'cat-ico-grande',
        'aria-hidden': 'true',
        style: { background: `${cor}22`, border: `1px solid ${cor}` },
      },
      icone,
    ),
    el('span', { class: 'cat-nome' }, cat.nome),
    cat.em_uso
      ? el('span', { class: 'cat-selo muted', title: 'Existem transações usando esta categoria' }, 'em uso')
      : null,
  );

  const excluirBtn = el(
    'button',
    {
      type: 'button',
      class: 'icon-btn cat-excluir',
      title: 'Excluir',
      'aria-label': `Excluir categoria ${cat.nome}`,
      onclick: () => excluir(cat),
    },
    '🗑️',
  );

  return el(
    'div',
    { class: `cat-card${cat.em_uso ? ' cat-card-em-uso' : ''}` },
    // Faixa da cor da categoria.
    el('span', { class: 'cat-faixa', 'aria-hidden': 'true', style: { background: cor } }),
    abrir,
    excluirBtn,
  );
}

// =====================================================================
// Exclusão
// =====================================================================

/**
 * Texto da confirmacao. Diz o efeito REAL, que nao e obvio:
 *  - transacoes vinculadas NAO somem: ficam com categoria_id = null;
 *  - um orcamento da categoria some junto (FK ON DELETE CASCADE em orcamentos)
 *    -- e so despesa tem orcamento, por isso a frase e condicional ao tipo.
 */
function msgExclusao(cat) {
  const partes = [];

  if (cat.em_uso) {
    partes.push(
      `Excluir a categoria "${cat.nome}"? Esta categoria está EM USO. ` +
        'As transações desta categoria não serão apagadas; elas ficarão sem categoria.',
    );
  } else {
    partes.push(
      `Excluir a categoria "${cat.nome}"? Nenhuma transação usa esta categoria no momento. ` +
        'De todo modo, esta ação nunca apaga transações: elas apenas ficariam sem categoria.',
    );
  }

  if (cat.tipo === 'despesa') {
    partes.push('Se houver um orçamento definido para ela, o orçamento também será removido.');
  }

  return partes.join(' ');
}

function excluir(cat) {
  return excluirCom({
    titulo: 'Excluir categoria',
    msg: msgExclusao(cat),
    okLabel: 'Excluir',
    acao: () => api.categorias.remover(cat.id),
    sucesso: 'Categoria excluída.',
    // Mexeu em categoria: o cache do state precisa ser refeito ANTES de avisar o app,
    // senao as outras telas remontam com uma categoria que nao existe mais.
    recarregar: true,
  });
}

// =====================================================================
// Erro
// =====================================================================

function renderErro(container, err) {
  const msg =
    err instanceof ApiError ? err.message : 'Não consegui carregar as categorias. Tente novamente.';

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
