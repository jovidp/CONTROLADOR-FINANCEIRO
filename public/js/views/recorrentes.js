/**
 * View: Lançamentos recorrentes (contas fixas).
 *
 * Lista as recorrentes separando ATIVAS de PAUSADAS, destaca as que ja venceram
 * e permite processar a fila na hora.
 *
 * Sobre o toggle "ativa": o contrato do PUT /api/recorrentes/:id e "mesmo body do
 * POST + ativa?" -- ou seja, descricao/valor/tipo/frequencia/proxima_data continuam
 * OBRIGATORIOS (src/routes/recorrentes.js valida o corpo inteiro). Mandar apenas
 * { ativa } devolveria 400. Entao o switch reenvia o registro completo com o campo
 * 'ativa' trocado: e a leitura mais defensiva do contrato e nao inventa rota nova.
 */

import { api, ApiError } from '../api.js';
import { carregarBase, emitir } from '../state.js';
import { el, fmtMoeda, fmtData, hoje, toast, skeleton, vazio } from '../ui.js';
import { excluirCom, formRecorrente } from '../forms.js';

const FREQUENCIA_ROTULO = {
  diaria: 'Diária',
  semanal: 'Semanal',
  mensal: 'Mensal',
  anual: 'Anual',
};

const CAT_PADRAO = { cor: '#94a3b8', icone: '📦', nome: 'Sem categoria' };

const COR_ENTRADA = 'var(--in, #22c55e)';
const COR_SAIDA = 'var(--out, #ef4444)';
const COR_ALERTA = 'var(--warn, #f59e0b)';

/** Descarta resposta antiga que chegou depois de uma remontagem. */
let execucao = 0;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// =====================================================================
// Montagem
// =====================================================================

export async function montar(container) {
  const token = ++execucao;

  container.replaceChildren();
  skeleton(container, 5);

  let recorrentes;
  try {
    recorrentes = await api.recorrentes.listar();
  } catch (err) {
    if (token !== execucao) return;
    renderErro(container, err);
    return;
  }

  if (token !== execucao) return;
  render(container, Array.isArray(recorrentes) ? recorrentes : []);
}

function render(container, lista) {
  const ativas = lista.filter((r) => r.ativa);
  const pausadas = lista.filter((r) => !r.ativa);

  const corpo = el('div', { class: 'rec-corpo' });

  if (lista.length === 0) {
    vazio(corpo, {
      ico: '🔁',
      msg: 'Nenhum lançamento fixo por aqui. Cadastre salário, aluguel e assinaturas uma vez e deixe que eles se lancem sozinhos.',
      acao: { texto: '+ Nova recorrência', onClick: () => formRecorrente() },
    });
  } else {
    corpo.append(
      secao({
        chave: 'ativas',
        titulo: 'Ativas',
        itens: ativas,
        msgVazia: 'Nenhuma recorrência ativa no momento. As pausadas estão logo abaixo.',
      }),
      // A secao de pausadas so existe quando ha alguma: senao vira ruido na tela.
      ...(pausadas.length
        ? [secao({ chave: 'pausadas', titulo: 'Pausadas', itens: pausadas, msgVazia: '' })]
        : []),
    );
  }

  container.replaceChildren(el('section', { class: 'rec-view' }, cabecalho(), corpo));
}

function cabecalho() {
  const processar = el(
    'button',
    { type: 'button', class: 'ghost-btn rec-processar' },
    '⚡ Processar agora',
  );
  processar.addEventListener('click', () => processarAgora(processar));

  return el(
    'div',
    { class: 'card rec-cabecalho' },
    el(
      'div',
      { class: 'card-head' },
      el('h2', {}, 'Lançamentos recorrentes'),
      el(
        'div',
        { class: 'btn-row' },
        processar,
        el(
          'button',
          { type: 'button', class: 'primary-btn', onclick: () => formRecorrente() },
          '+ Nova recorrência',
        ),
      ),
    ),
    el(
      'p',
      { class: 'muted mb' },
      'Lançamentos fixos viram transações automaticamente quando a data chega. ' +
        'Use "Processar agora" para lançar de uma vez tudo o que já venceu.',
    ),
  );
}

function secao({ chave, titulo, itens, msgVazia }) {
  const corpo = el('div', { class: 'table-wrap' });

  if (itens.length === 0) {
    vazio(corpo, { ico: '💤', msg: msgVazia });
  } else {
    corpo.replaceChildren(tabela(itens));
  }

  return el(
    'div',
    { class: `card rec-secao rec-secao-${chave}` },
    el(
      'div',
      { class: 'card-head' },
      el('h2', {}, titulo),
      el('span', { class: 'muted' }, itens.length === 1 ? '1 recorrência' : `${itens.length} recorrências`),
    ),
    corpo,
  );
}

// =====================================================================
// Tabela
// =====================================================================

function tabela(itens) {
  return el(
    'table',
    { class: 'table rec-tabela' },
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', { scope: 'col' }, 'Descrição'),
        el('th', { scope: 'col' }, 'Categoria'),
        el('th', { scope: 'col' }, 'Conta'),
        el('th', { scope: 'col' }, 'Frequência'),
        el('th', { scope: 'col' }, 'Próximo lançamento'),
        el('th', { class: 'right', scope: 'col' }, 'Valor'),
        el('th', { class: 'right', scope: 'col' }, 'Ativa'),
        el('th', { class: 'right', scope: 'col' }, 'Ações'),
      ),
    ),
    el('tbody', {}, itens.map(linha)),
  );
}

function linha(rec) {
  return el(
    'tr',
    { class: `rec-linha${rec.ativa ? '' : ' rec-pausada'}` },
    el('td', { 'data-rotulo': 'Descrição' }, el('strong', { class: 'rec-desc' }, rec.descricao)),
    celulaCategoria(rec),
    el('td', { 'data-rotulo': 'Conta' }, rec.conta_nome ?? el('span', { class: 'muted' }, '—')),
    celulaFrequencia(rec),
    celulaProxima(rec),
    celulaValor(rec),
    celulaToggle(rec),
    celulaAcoes(rec),
  );
}

function celulaCategoria(rec) {
  if (!rec.categoria_id) {
    return el('td', { 'data-rotulo': 'Categoria' }, el('span', { class: 'muted' }, CAT_PADRAO.nome));
  }

  const cor = rec.categoria_cor || CAT_PADRAO.cor;
  return el(
    'td',
    { 'data-rotulo': 'Categoria' },
    el(
      'span',
      { class: 'rec-cat' },
      el(
        'span',
        { class: 'cat-ico', style: { background: `${cor}33`, border: `1px solid ${cor}` } },
        rec.categoria_icone || CAT_PADRAO.icone,
      ),
      rec.categoria_nome,
    ),
  );
}

function celulaFrequencia(rec) {
  const rotulo = FREQUENCIA_ROTULO[rec.frequencia] ?? rec.frequencia;
  return el(
    'td',
    { 'data-rotulo': 'Frequência' },
    el('span', { class: 'rec-freq' }, rotulo),
    // data_fim e opcional: so aparece quando a serie tem fim marcado.
    rec.data_fim ? el('span', { class: 'rec-fim muted' }, ` até ${fmtData(rec.data_fim)}`) : null,
  );
}

/**
 * Situacao da proxima data. So faz sentido cobrar prazo de recorrencia ATIVA:
 * uma pausada nao vai gerar nada, entao nao esta "atrasada".
 * Datas 'AAAA-MM-DD' comparam lexicograficamente na ordem cronologica.
 */
function situacao(rec) {
  if (!rec.ativa || !rec.proxima_data) return null;
  const hj = hoje();
  if (rec.proxima_data < hj) return 'atrasada';
  if (rec.proxima_data === hj) return 'vence hoje';
  return null;
}

function celulaProxima(rec) {
  const alerta = situacao(rec);

  return el(
    'td',
    { class: `rec-proxima${alerta ? ' rec-proxima-alerta' : ''}`, 'data-rotulo': 'Próximo lançamento' },
    el('span', { style: alerta ? { color: COR_ALERTA, fontWeight: '600' } : null }, fmtData(rec.proxima_data)),
    alerta
      ? el('span', { class: 'rec-selo', style: { color: COR_ALERTA, borderColor: COR_ALERTA } }, alerta)
      : null,
  );
}

function celulaValor(rec) {
  const receita = rec.tipo === 'receita';
  return el(
    'td',
    { class: 'right', 'data-rotulo': 'Valor' },
    el(
      'span',
      {
        class: `rec-valor ${receita ? 'in' : 'out'}`,
        style: { color: receita ? COR_ENTRADA : COR_SAIDA },
      },
      `${receita ? '+' : '−'} ${fmtMoeda(num(rec.valor))}`,
    ),
  );
}

// =====================================================================
// Toggle "ativa"
// =====================================================================

function celulaToggle(rec) {
  const input = el('input', {
    type: 'checkbox',
    class: 'switch-input',
    checked: Boolean(rec.ativa),
    'aria-label': `${rec.ativa ? 'Pausar' : 'Ativar'} ${rec.descricao}`,
  });

  input.addEventListener('change', () => alternarAtiva(rec, input));

  return el(
    'td',
    { class: 'right', 'data-rotulo': 'Ativa' },
    el(
      'label',
      { class: 'switch', title: rec.ativa ? 'Pausar recorrência' : 'Ativar recorrência' },
      input,
      el('span', { class: 'switch-track', 'aria-hidden': 'true' }, el('span', { class: 'switch-thumb' })),
    ),
  );
}

/**
 * Corpo completo exigido pelo PUT (ver comentario do topo do arquivo).
 * Reenviar os proprios valores da linha e seguro: eles ja passaram pelas
 * constraints do banco (inclusive data_fim >= proxima_data).
 */
function corpoCompleto(rec, extras) {
  return {
    descricao: rec.descricao,
    valor: num(rec.valor),
    tipo: rec.tipo,
    frequencia: rec.frequencia,
    proxima_data: rec.proxima_data,
    data_fim: rec.data_fim,
    categoria_id: rec.categoria_id,
    conta_id: rec.conta_id,
    ...extras,
  };
}

async function alternarAtiva(rec, input) {
  const desejado = input.checked;
  input.disabled = true;

  try {
    await api.recorrentes.atualizar(rec.id, corpoCompleto(rec, { ativa: desejado }));
  } catch (err) {
    // Desfaz o switch: o banco nao mudou, a tela nao pode fingir que mudou.
    input.checked = !desejado;
    input.disabled = false;
    toast(err?.message || 'Não foi possível alterar a recorrência.', 'erro');
    return;
  }

  toast(desejado ? 'Recorrência ativada.' : 'Recorrência pausada.', 'ok');
  // Nao reabilita o input: emitir() remonta a view e este DOM e descartado.
  emitir();
}

// =====================================================================
// Ações
// =====================================================================

function celulaAcoes(rec) {
  return el(
    'td',
    { class: 'right', 'data-rotulo': 'Ações' },
    el(
      'div',
      { class: 'btn-row rec-acoes' },
      el(
        'button',
        {
          type: 'button',
          class: 'icon-btn',
          title: 'Editar',
          'aria-label': `Editar ${rec.descricao}`,
          onclick: () => formRecorrente(rec),
        },
        '✏️',
      ),
      el(
        'button',
        {
          type: 'button',
          class: 'icon-btn',
          title: 'Excluir',
          'aria-label': `Excluir ${rec.descricao}`,
          onclick: () => excluir(rec),
        },
        '🗑️',
      ),
    ),
  );
}

function excluir(rec) {
  return excluirCom({
    titulo: 'Excluir recorrência',
    msg:
      `Excluir "${rec.descricao}"? As transações que ela já gerou PERMANECEM no histórico — ` +
      'elas apenas deixam de estar vinculadas a esta recorrência. ' +
      'O que para é a geração de novos lançamentos. Esta ação não pode ser desfeita.',
    okLabel: 'Excluir',
    acao: () => api.recorrentes.remover(rec.id),
    sucesso: 'Recorrência excluída.',
    // Sem recarregar: excluir a recorrente nao gera nem apaga transacao, entao
    // saldo de conta e cache de categoria seguem valendo.
  });
}

async function processarAgora(botao) {
  const rotulo = botao.textContent;
  botao.disabled = true;
  botao.textContent = 'Processando...';

  let gerados;
  try {
    const resposta = await api.recorrentes.processar();
    gerados = num(resposta?.gerados);
  } catch (err) {
    botao.disabled = false;
    botao.textContent = rotulo;
    toast(err?.message || 'Não foi possível processar as recorrências.', 'erro');
    return;
  }

  if (gerados > 0) {
    toast(`${gerados} lançamento(s) gerado(s)`, 'ok');
  } else {
    toast('Nenhum lançamento pendente', 'info');
  }

  // Gerar transacao mexe no saldo das contas (vw_saldo_contas): recarrega a base
  // antes de avisar o app. emitir() remonta esta view, entao o botao some junto.
  //
  // O try/catch importa: os lancamentos JA´ foram gerados no banco. Uma falha ao reler
  // a base pulava o emitir(), a tela nao remontava, e o usuario via "3 lançamentos
  // gerados" com a lista intacta -- e clicava de novo. Mesmo motivo de depoisDeSalvar().
  try {
    await carregarBase();
  } catch {
    // A view remontada mostra o erro; aqui, engolir e´ o certo.
  }
  emitir();
}

// =====================================================================
// Erro
// =====================================================================

function renderErro(container, err) {
  const msg =
    err instanceof ApiError
      ? err.message
      : 'Não consegui carregar os lançamentos recorrentes. Tente novamente.';

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
