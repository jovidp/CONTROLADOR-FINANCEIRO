/**
 * View de transacoes: filtros + tabela ordenavel + paginacao real (limite/offset).
 *
 * Os filtros vivem em estado LOCAL deste modulo (nao no state global): sobrevivem
 * a remontagens da view, mas nao vazam para as outras telas.
 * Toda busca passa por carregar(): uma unica funcao, um unico request.
 */

import { api } from '../api.js';
import { state, carregarBase, emitir } from '../state.js';
import { el, fmtMoeda, fmtData, toast, skeleton, vazio } from '../ui.js';
import { excluirCom, formTransacao } from '../forms.js';

const POR_PAGINA = 25;
const DEBOUNCE_MS = 300;

/**
 * A natureza do gasto e´ derivada no backend: 'fixo' veio de um recorrente,
 * 'parcelado' e´ parcela de uma compra, 'avulso' e´ o resto. As tres comecam
 * ligadas; desligar uma esconde aquele tipo da lista E dos totais.
 */
const NATUREZAS = [
  { valor: 'avulso', rotulo: 'Avulsos', ico: '🧾' },
  { valor: 'fixo', rotulo: 'Fixos', ico: '📌' },
  { valor: 'parcelado', rotulo: 'Parcelados', ico: '💳' },
];

const TODAS_NATUREZAS = NATUREZAS.map((n) => n.valor);

const FILTROS_PADRAO = {
  q: '',
  tipo: '',
  categoria_id: '',
  conta_id: '',
  periodo: 'mes', // 'mes' | 'ano' | 'tudo'
  natureza: [...TODAS_NATUREZAS],
  ocultas: 'excluir', // 'excluir' | 'incluir'
};

/** Ordenacao padrao de cada coluna ao clicar nela pela primeira vez. */
const DIRECAO_INICIAL = { data: 'desc', valor: 'desc', descricao: 'asc' };

// --- Estado local do modulo (persiste entre remontagens) --------------
let filtros = { ...FILTROS_PADRAO };
let ordenar = 'data';
let direcao = 'desc';
let pagina = 1;

/** Contador de requisicao: descarta resposta antiga que chegou depois de uma nova. */
let reqSeq = 0;
let debounceId = null;

// Refs do DOM da montagem atual.
let raiz = null;
let areaResumo = null;
let areaLista = null;
let areaPaginacao = null;

// --- Hash -------------------------------------------------------------

/**
 * Le um filtro inicial vindo da navegacao do dashboard ('#transacoes?categoria=3').
 * Limpa o parametro com replaceState para nao disparar hashchange (evita remontagem
 * em cascata) e para que um F5 nao reaplique o filtro sem o usuario pedir.
 */
function lerFiltroDoHash() {
  const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
  const corte = hash.indexOf('?');
  if (corte < 0) return;

  const rota = hash.slice(0, corte);
  if (rota !== 'transacoes') return;

  const params = new URLSearchParams(hash.slice(corte + 1));
  const bruto = params.get('categoria');
  const idCat = Number(bruto);

  if (Number.isInteger(idCat) && idCat > 0) {
    filtros.categoria_id = String(idCat);
    // O dashboard mostra os gastos do mes selecionado; o recorte tem que bater.
    filtros.periodo = 'mes';
    pagina = 1;
  }

  history.replaceState(null, '', `#${rota}`);
}

// --- Parametros da API ------------------------------------------------

function paramsDaBusca() {
  const params = {
    ordenar,
    direcao,
    limite: POR_PAGINA,
    offset: (pagina - 1) * POR_PAGINA,
  };

  const busca = filtros.q.trim();
  if (busca) params.q = busca;
  if (filtros.tipo) params.tipo = filtros.tipo;
  if (filtros.categoria_id) params.categoria_id = filtros.categoria_id;
  if (filtros.conta_id) params.conta_id = filtros.conta_id;

  // Com as tres ligadas nao mandamos nada: "todas" e´ a ausencia de filtro.
  if (filtros.natureza.length < TODAS_NATUREZAS.length) {
    params.natureza = filtros.natureza.join(',');
  }
  if (filtros.ocultas !== 'excluir') params.ocultas = filtros.ocultas;

  if (filtros.periodo === 'mes') {
    params.mes = state.mes;
  } else if (filtros.periodo === 'ano') {
    const ano = state.mes.slice(0, 4);
    params.de = `${ano}-01-01`;
    params.ate = `${ano}-12-31`;
  }
  // 'tudo' vai sem recorte de data.

  return params;
}

const totalPaginas = (total) => Math.max(1, Math.ceil(total / POR_PAGINA));

/** Qualquer mudanca de filtro/ordenacao volta para a pagina 1. */
function reiniciarPagina() {
  pagina = 1;
}

// --- Carregamento -----------------------------------------------------

async function carregar() {
  const meu = ++reqSeq;

  areaLista.replaceChildren();
  skeleton(areaLista, 6);

  let dados;
  try {
    dados = await api.transacoes.listar(paramsDaBusca());
  } catch (err) {
    if (meu !== reqSeq || !raiz?.isConnected) return;
    mostrarErro(err);
    return;
  }

  // Resposta fora de ordem (busca com debounce): um request mais novo ja saiu.
  if (meu !== reqSeq || !raiz?.isConnected) return;

  const total = Number(dados?.total ?? 0);
  const itens = dados?.itens ?? [];

  // Pagina orfa: excluir o ultimo item de uma pagina encolhe o total. Em vez de
  // mostrar uma pagina vazia, recua para a ultima pagina que existe.
  if (total > 0 && itens.length === 0 && pagina > totalPaginas(total)) {
    pagina = totalPaginas(total);
    carregar();
    return;
  }

  renderResumo(dados?.resumo, total, Number(dados?.ocultos ?? 0));
  renderLista(itens);
  renderPaginacao(total);
}

/** Agenda carregar() apos o debounce; usado so pela busca por texto. */
function carregarComDebounce() {
  clearTimeout(debounceId);
  debounceId = setTimeout(() => {
    debounceId = null;
    carregar();
  }, DEBOUNCE_MS);
}

function mostrarErro(err) {
  areaResumo.replaceChildren();
  areaPaginacao.replaceChildren();
  areaLista.replaceChildren(
    el(
      'div',
      { class: 'estado-erro' },
      el('p', { class: 'estado-erro-msg' }, err?.message || 'Não foi possível carregar as transações.'),
      el('button', { class: 'btn btn-primario', onclick: () => carregar() }, 'Tentar de novo'),
    ),
  );
}

// --- Filtros ----------------------------------------------------------

function opcoesCategoria() {
  const receitas = state.categorias.filter((c) => c.tipo === 'receita');
  const despesas = state.categorias.filter((c) => c.tipo === 'despesa');

  const grupo = (rotulo, lista) =>
    lista.length
      ? el(
          'optgroup',
          { label: rotulo },
          lista.map((c) => el('option', { value: String(c.id) }, `${c.icone} ${c.nome}`)),
        )
      : null;

  return [
    el('option', { value: '' }, 'Todas as categorias'),
    grupo('Receitas', receitas),
    grupo('Despesas', despesas),
  ].filter(Boolean);
}

function opcoesConta() {
  return [
    el('option', { value: '' }, 'Todas as contas'),
    ...state.contas.map((c) =>
      el('option', { value: String(c.id) }, c.arquivada ? `${c.nome} (arquivada)` : c.nome),
    ),
  ];
}

function montarFiltros() {
  const ano = state.mes.slice(0, 4);

  const busca = el('input', {
    class: 'campo tx-busca',
    type: 'search',
    placeholder: 'Buscar na descrição...',
    'aria-label': 'Buscar por descrição',
  });
  busca.value = filtros.q;
  busca.addEventListener('input', () => {
    filtros.q = busca.value;
    reiniciarPagina();
    carregarComDebounce();
  });

  const selTipo = el(
    'select',
    { class: 'campo tx-filtro tx-filtro-tipo', 'aria-label': 'Filtrar por tipo' },
    el('option', { value: '' }, 'Tudo'),
    el('option', { value: 'receita' }, 'Só receitas'),
    el('option', { value: 'despesa' }, 'Só despesas'),
    el('option', { value: 'transferencia' }, 'Só transferências'),
  );
  selTipo.value = filtros.tipo;

  const selCategoria = el(
    'select',
    { class: 'campo tx-filtro tx-filtro-categoria', 'aria-label': 'Filtrar por categoria' },
    opcoesCategoria(),
  );
  selCategoria.value = filtros.categoria_id;
  // Categoria salva pode nao existir mais (foi removida): cai para "Todas".
  if (selCategoria.value !== filtros.categoria_id) filtros.categoria_id = '';

  selTipo.addEventListener('change', () => {
    filtros.tipo = selTipo.value;
    // Tipo e categoria brigam: categoria de despesa + tipo receita nunca devolve nada.
    const cat = state.categorias.find((c) => String(c.id) === filtros.categoria_id);
    if (filtros.tipo && cat && cat.tipo !== filtros.tipo) {
      filtros.categoria_id = '';
      selCategoria.value = '';
    }
    reiniciarPagina();
    carregar();
  });

  selCategoria.addEventListener('change', () => {
    filtros.categoria_id = selCategoria.value;
    const cat = state.categorias.find((c) => String(c.id) === filtros.categoria_id);
    if (cat && filtros.tipo && cat.tipo !== filtros.tipo) {
      filtros.tipo = cat.tipo;
      selTipo.value = cat.tipo;
    }
    reiniciarPagina();
    carregar();
  });

  const selConta = el(
    'select',
    { class: 'campo tx-filtro tx-filtro-conta', 'aria-label': 'Filtrar por conta' },
    opcoesConta(),
  );
  selConta.value = filtros.conta_id;
  if (selConta.value !== filtros.conta_id) filtros.conta_id = '';
  selConta.addEventListener('change', () => {
    filtros.conta_id = selConta.value;
    reiniciarPagina();
    carregar();
  });

  const selPeriodo = el(
    'select',
    { class: 'campo tx-filtro tx-filtro-periodo', 'aria-label': 'Filtrar por período' },
    el('option', { value: 'mes' }, 'Mês selecionado'),
    el('option', { value: 'ano' }, `Ano todo (${ano})`),
    el('option', { value: 'tudo' }, 'Tudo'),
  );
  selPeriodo.value = filtros.periodo;
  selPeriodo.addEventListener('change', () => {
    filtros.periodo = selPeriodo.value;
    reiniciarPagina();
    carregar();
  });

  const limpar = el(
    'button',
    {
      class: 'btn btn-ghost tx-limpar',
      type: 'button',
      onclick: () => {
        clearTimeout(debounceId);
        debounceId = null;
        filtros = { ...FILTROS_PADRAO, natureza: [...TODAS_NATUREZAS] };
        busca.value = '';
        selTipo.value = '';
        selCategoria.value = '';
        selConta.value = '';
        selPeriodo.value = FILTROS_PADRAO.periodo;
        reiniciarPagina();
        carregar();
        // Os chips sao redesenhados a partir de `filtros`, entao remontamos a barra.
        raiz?.querySelector('.tx-naturezas')?.replaceWith(montarNaturezas());
      },
    },
    'Limpar',
  );

  return el(
    'div',
    { class: 'tx-filtros' },
    busca,
    selTipo,
    selCategoria,
    selConta,
    selPeriodo,
    limpar,
  );
}

/** Barra de chips: quais tipos de gasto entram na lista e nos totais. */
function montarNaturezas() {
  const chips = NATUREZAS.map((n) => {
    const ativo = filtros.natureza.includes(n.valor);
    const sozinho = ativo && filtros.natureza.length === 1;

    const botao = el(
      'button',
      {
        class: `chip tx-chip${ativo ? ' chip-ativo' : ''}`,
        type: 'button',
        title: sozinho
          ? 'Pelo menos um tipo precisa ficar visível.'
          : ativo
            ? `Ocultar ${n.rotulo.toLowerCase()}`
            : `Mostrar ${n.rotulo.toLowerCase()}`,
        onclick: () => {
          // Desligar o ultimo deixaria a lista vazia sem explicar o porque.
          if (sozinho) return;

          filtros.natureza = ativo
            ? filtros.natureza.filter((v) => v !== n.valor)
            : [...filtros.natureza, n.valor];

          reiniciarPagina();
          carregar();
          raiz?.querySelector('.tx-naturezas')?.replaceWith(montarNaturezas());
        },
      },
      el('span', { 'aria-hidden': 'true' }, n.ico),
      n.rotulo,
    );
    botao.setAttribute('aria-pressed', String(ativo));
    return botao;
  });

  const verOcultos = filtros.ocultas === 'incluir';
  const olho = el(
    'button',
    {
      class: `chip tx-chip tx-chip-ocultos${verOcultos ? ' chip-ativo' : ''}`,
      type: 'button',
      title: verOcultos ? 'Voltar a esconder os ocultos' : 'Mostrar também os lançamentos ocultos',
      onclick: () => {
        filtros.ocultas = verOcultos ? 'excluir' : 'incluir';
        reiniciarPagina();
        carregar();
        raiz?.querySelector('.tx-naturezas')?.replaceWith(montarNaturezas());
      },
    },
    el('span', { 'aria-hidden': 'true' }, verOcultos ? '👁️' : '🙈'),
    'Ocultos',
  );
  olho.setAttribute('aria-pressed', String(verOcultos));

  return el(
    'div',
    { class: 'tx-naturezas', role: 'group', 'aria-label': 'Tipo de gasto' },
    el('span', { class: 'tx-naturezas-rotulo' }, 'Tipo de gasto:'),
    ...chips,
    olho,
  );
}

const temFiltroAtivo = () =>
  filtros.q.trim() !== '' ||
  filtros.tipo !== '' ||
  filtros.categoria_id !== '' ||
  filtros.conta_id !== '' ||
  filtros.periodo !== FILTROS_PADRAO.periodo ||
  filtros.natureza.length < TODAS_NATUREZAS.length;

// --- Resumo do filtro -------------------------------------------------

function bloco(rotulo, valor, classe) {
  return el(
    'div',
    { class: 'tx-resumo-item' },
    el('span', { class: 'tx-resumo-rotulo' }, rotulo),
    el('strong', { class: `tx-resumo-valor ${classe}` }, valor),
  );
}

function renderResumo(resumo, total, ocultos) {
  const receitas = Number(resumo?.receitas ?? 0);
  const despesas = Number(resumo?.despesas ?? 0);
  const saldo = Number(resumo?.saldo ?? 0);

  areaResumo.replaceChildren(
    bloco('Receitas', fmtMoeda(receitas), 'valor-receita'),
    bloco('Despesas', fmtMoeda(despesas), 'valor-despesa'),
    bloco('Saldo', fmtMoeda(saldo), saldo < 0 ? 'valor-despesa' : 'valor-receita'),
    el(
      'div',
      { class: 'tx-resumo-item tx-resumo-contagem' },
      el('span', { class: 'tx-resumo-rotulo' }, 'Registros'),
      el('strong', { class: 'tx-resumo-valor' }, total === 1 ? '1 transação' : `${total} transações`),
    ),
  );

  // Um total que exclui lancamentos sem dizer nada e´ um total que mente. O
  // oculto nunca soma -- nem quando a lista o revela --, entao o aviso aparece
  // nos dois modos, so´ mudando o que ele oferece: revelar ou esconder de novo.
  if (ocultos === 0) return;

  const quantos = ocultos === 1 ? '1 lançamento oculto' : `${ocultos} lançamentos ocultos`;
  const revelando = filtros.ocultas === 'incluir';

  areaResumo.appendChild(
    el(
      'button',
      {
        class: 'tx-aviso-ocultos',
        type: 'button',
        onclick: () => {
          filtros.ocultas = revelando ? 'excluir' : 'incluir';
          reiniciarPagina();
          carregar();
          raiz?.querySelector('.tx-naturezas')?.replaceWith(montarNaturezas());
        },
      },
      revelando
        ? `🙈 ${quantos} ${ocultos === 1 ? 'aparece riscado' : 'aparecem riscados'} e não ${ocultos === 1 ? 'soma' : 'somam'} no total. Esconder de novo.`
        : `🙈 ${quantos} ${ocultos === 1 ? 'não está' : 'não estão'} somando aqui. Mostrar.`,
    ),
  );
}

// --- Tabela -----------------------------------------------------------

function cabecalhoOrdenavel(coluna, rotulo, classeCol) {
  const ativo = ordenar === coluna;
  const indicador = ativo ? (direcao === 'asc' ? '▲' : '▼') : '';

  const botao = el(
    'button',
    {
      class: `th-ord${ativo ? ' th-ord-ativo' : ''}`,
      type: 'button',
      onclick: () => {
        if (ordenar === coluna) {
          direcao = direcao === 'asc' ? 'desc' : 'asc';
        } else {
          ordenar = coluna;
          direcao = DIRECAO_INICIAL[coluna];
        }
        reiniciarPagina();
        carregar();
      },
    },
    rotulo,
    el('span', { class: 'th-ord-ind', 'aria-hidden': 'true' }, indicador),
  );

  const th = el('th', { class: `${classeCol} th-ordenavel`, scope: 'col' }, botao);
  th.setAttribute('aria-sort', ativo ? (direcao === 'asc' ? 'ascending' : 'descending') : 'none');
  return th;
}

/** Selo do tipo de gasto. O avulso nao ganha selo: seria ruido na maioria das linhas. */
function seloNatureza(tx) {
  if (tx.natureza === 'parcelado') {
    const selo = el(
      'span',
      { class: 'tx-selo tx-selo-parcela' },
      `💳 ${tx.parcela_num}/${tx.total_parcelas}`,
    );
    if (tx.parcelamento_total != null) {
      selo.title = `Parcela ${tx.parcela_num} de ${tx.total_parcelas} — compra de ${fmtMoeda(tx.parcelamento_total)}`;
    }
    return selo;
  }

  if (tx.natureza === 'fixo') {
    return el(
      'span',
      { class: 'tx-selo tx-selo-fixo', title: 'Gerado por um lançamento recorrente' },
      '📌 Fixo',
    );
  }

  return null;
}

function celulaDescricao(tx) {
  const ponto = el('span', { class: 'tx-icone', 'aria-hidden': 'true' }, tx.categoria_icone || '📦');
  ponto.style.setProperty('--cor', tx.categoria_cor || 'var(--borda, #64748b)');

  const nome = el('span', { class: 'tx-descricao-nome' }, tx.descricao);

  const selos = [seloNatureza(tx)];
  if (tx.oculta) {
    selos.push(el('span', { class: 'tx-selo tx-selo-oculta', title: 'Não soma nos totais' }, '🙈 Oculto'));
  }

  const linhaTopo = el('div', { class: 'tx-descricao-topo' }, nome, ...selos.filter(Boolean));

  const partes = [linhaTopo];
  if (tx.observacao) partes.push(el('span', { class: 'tx-descricao-obs' }, tx.observacao));

  const texto = el('div', { class: 'tx-descricao-texto' }, partes);

  return el('td', { class: 'col-descricao', 'data-rotulo': 'Descrição' },
    el('div', { class: 'tx-descricao' }, ponto, texto),
  );
}

function celulaCategoria(tx) {
  // Transferencia nao tem categoria por definicao (o backend a zera). Dizer "Sem
  // categoria" aqui pareceria um cadastro incompleto -- e nao e´: e´ o certo.
  if (tx.tipo === 'transferencia') {
    return el('td', { class: 'col-categoria', 'data-rotulo': 'Categoria' },
      el('span', { class: 'tx-tag tx-tag-transferencia' }, '⇄ Transferência'),
    );
  }

  if (!tx.categoria_id) {
    return el('td', { class: 'col-categoria', 'data-rotulo': 'Categoria' },
      el('span', { class: 'tx-sem-categoria' }, 'Sem categoria'),
    );
  }

  const tag = el('span', { class: 'tx-tag' }, tx.categoria_nome);
  tag.style.setProperty('--cor', tx.categoria_cor || '#64748b');
  return el('td', { class: 'col-categoria', 'data-rotulo': 'Categoria' }, tag);
}

/** Uma bolinha da cor da conta + o nome. */
function marcaConta(nome, cor) {
  const ponto = el('span', { class: 'tx-conta-ponto', 'aria-hidden': 'true' });
  ponto.style.setProperty('--cor', cor || '#64748b');
  return el('span', { class: 'tx-conta' }, ponto, nome);
}

function celulaConta(tx) {
  // Uma transferencia tem DUAS contas: mostrar so´ a origem esconderia metade do fato.
  if (tx.tipo === 'transferencia') {
    return el('td', { class: 'col-conta', 'data-rotulo': 'Conta' },
      el('span', { class: 'tx-transferencia-contas' },
        marcaConta(tx.conta_nome, tx.conta_cor),
        el('span', { class: 'tx-transferencia-seta', 'aria-label': 'para' }, '→'),
        marcaConta(tx.conta_destino_nome, tx.conta_destino_cor),
      ),
    );
  }

  if (!tx.conta_id) {
    return el('td', { class: 'col-conta', 'data-rotulo': 'Conta' },
      el('span', { class: 'tx-sem-conta' }, '—'),
    );
  }

  return el('td', { class: 'col-conta', 'data-rotulo': 'Conta' }, marcaConta(tx.conta_nome, tx.conta_cor));
}

function celulaValor(tx) {
  // Transferencia nao ganha sinal nem cor: nao entrou nem saiu dinheiro do seu bolso,
  // so´ mudou de conta. Pintar de verde/vermelho diria que voce ganhou/perdeu algo.
  if (tx.tipo === 'transferencia') {
    return el('td', { class: 'col-valor', 'data-rotulo': 'Valor' },
      el('span', { class: 'tx-valor valor-transferencia' }, fmtMoeda(tx.valor)),
    );
  }

  const receita = tx.tipo === 'receita';
  const valor = `${receita ? '+' : '-'} ${fmtMoeda(tx.valor)}`;
  return el('td', { class: 'col-valor', 'data-rotulo': 'Valor' },
    el('span', { class: `tx-valor ${receita ? 'valor-receita' : 'valor-despesa'}` }, valor),
  );
}

function excluir(tx) {
  return excluirCom({
    titulo: 'Excluir transação',
    msg: `Excluir "${tx.descricao}" (${fmtMoeda(tx.valor)})? Esta ação não pode ser desfeita.`,
    acao: () => api.transacoes.remover(tx.id),
    sucesso: 'Transação excluída.',
    // Mexe no saldo das contas (vw_saldo_contas): recarrega a base e avisa o app.
    // O main.js remonta esta view, entao nao chamamos carregar() aqui (request duplicado).
    recarregar: true,
  });
}

/** Esconder nao apaga: a linha continua no banco, so´ para de somar. Reversivel. */
async function alternarOculta(tx) {
  try {
    await api.transacoes.ocultar(tx.id, !tx.oculta);
  } catch (err) {
    toast(err?.message || 'Não foi possível ocultar o lançamento.', 'erro');
    return;
  }

  toast(tx.oculta ? 'Lançamento voltou a contar.' : 'Lançamento oculto: saiu dos totais.', 'ok');

  // Sai do saldo das contas (vw_saldo_contas) e dos graficos: a base envelheceu.
  // O try/catch nao e´ decorativo: o PATCH ja´ foi gravado, e uma falha ao RELER a base
  // (rede caiu, sessao expirou) pulava o emitir() -- a view nao remontava e a linha
  // ficava na tela do jeito antigo, embaixo de um toast verde dizendo que deu certo.
  // Mesmo motivo do try/catch em depoisDeSalvar().
  try {
    await carregarBase();
  } catch {
    // A view remontada mostra o erro; aqui, engolir e´ o certo.
  }
  emitir();
}

function celulaAcoes(tx) {
  return el('td', { class: 'col-acoes', 'data-rotulo': 'Ações' },
    el('div', { class: 'tx-acoes' },
      el('button', {
        class: 'btn-icone tx-ocultar',
        type: 'button',
        title: tx.oculta ? 'Voltar a contar nos totais' : 'Ocultar: some da lista e dos totais',
        'aria-label': `${tx.oculta ? 'Reexibir' : 'Ocultar'} ${tx.descricao}`,
        onclick: () => alternarOculta(tx),
      }, tx.oculta ? '👁️' : '🙈'),
      el('button', {
        class: 'btn-icone tx-editar',
        type: 'button',
        title: 'Editar',
        'aria-label': `Editar ${tx.descricao}`,
        onclick: () => formTransacao(tx),
      }, '✏️'),
      el('button', {
        class: 'btn-icone tx-excluir',
        type: 'button',
        title: 'Excluir',
        'aria-label': `Excluir ${tx.descricao}`,
        onclick: () => excluir(tx),
      }, '🗑️'),
    ),
  );
}

function linha(tx) {
  return el('tr', { class: `tx-linha${tx.oculta ? ' tx-linha-oculta' : ''}` },
    el('td', { class: 'col-data', 'data-rotulo': 'Data' }, fmtData(tx.data)),
    celulaDescricao(tx),
    celulaCategoria(tx),
    celulaConta(tx),
    celulaValor(tx),
    celulaAcoes(tx),
  );
}

function renderLista(itens) {
  areaLista.replaceChildren();

  if (itens.length === 0) {
    vazio(areaLista, {
      ico: temFiltroAtivo() ? '🔍' : '🧾',
      msg: temFiltroAtivo()
        ? 'Nenhuma transação encontrada com esses filtros.'
        : 'Nenhuma transação neste período.',
      acao: { texto: 'Adicionar transação', onClick: () => formTransacao() },
    });
    return;
  }

  const tabela = el('table', { class: 'tabela tx-tabela' },
    el('thead', {},
      el('tr', {},
        cabecalhoOrdenavel('data', 'Data', 'col-data'),
        cabecalhoOrdenavel('descricao', 'Descrição', 'col-descricao'),
        el('th', { class: 'col-categoria', scope: 'col' }, 'Categoria'),
        el('th', { class: 'col-conta', scope: 'col' }, 'Conta'),
        cabecalhoOrdenavel('valor', 'Valor', 'col-valor'),
        el('th', { class: 'col-acoes', scope: 'col' }, 'Ações'),
      ),
    ),
    el('tbody', {}, itens.map(linha)),
  );

  areaLista.replaceChildren(tabela);
}

// --- Paginacao --------------------------------------------------------

function renderPaginacao(total) {
  const paginas = totalPaginas(total);

  if (total === 0) {
    areaPaginacao.replaceChildren();
    return;
  }

  const anterior = el('button', {
    class: 'btn btn-ghost tx-pag-btn',
    type: 'button',
    onclick: () => {
      if (pagina <= 1) return;
      pagina -= 1;
      carregar();
    },
  }, '‹ Anterior');
  anterior.disabled = pagina <= 1;

  const proxima = el('button', {
    class: 'btn btn-ghost tx-pag-btn',
    type: 'button',
    onclick: () => {
      if (pagina >= paginas) return;
      pagina += 1;
      carregar();
    },
  }, 'Próxima ›');
  proxima.disabled = pagina >= paginas;

  areaPaginacao.replaceChildren(
    anterior,
    el('span', { class: 'tx-pag-info' }, `Página ${pagina} de ${paginas}`),
    proxima,
  );
}

// --- Montagem ---------------------------------------------------------

export async function montar(container) {
  // Um debounce pendente da montagem anterior apontaria para o DOM velho.
  clearTimeout(debounceId);
  debounceId = null;
  reqSeq += 1;

  lerFiltroDoHash();

  areaResumo = el('div', { class: 'tx-resumo' });
  areaLista = el('div', { class: 'tx-lista' });
  areaPaginacao = el('div', { class: 'tx-paginacao' });

  raiz = el('section', { class: 'tx-view' },
    el('header', { class: 'tx-cabecalho' },
      el('h2', { class: 'titulo-view' }, 'Transações'),
      el('button', {
        class: 'btn btn-primario tx-nova',
        type: 'button',
        onclick: () => formTransacao(),
      }, '+ Nova transação'),
    ),
    montarFiltros(),
    montarNaturezas(),
    areaResumo,
    areaLista,
    areaPaginacao,
  );

  container.replaceChildren(raiz);

  await carregar();
}
