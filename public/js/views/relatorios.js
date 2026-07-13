/**
 * View "Relatórios" — visão anual: gráfico dos 12 meses, indicadores do ano,
 * despesas por categoria e exportação das transações em CSV.
 *
 * O ano é estado LOCAL da view (não entra no state global, que só carrega mês).
 * Regra de sincronia: se o mês da topbar mudar de ANO, o relatório acompanha; se o
 * usuário escolheu um ano no seletor e o mês continua no mesmo ano, a escolha dele
 * é preservada entre remontagens (emitir() remonta a view a cada escrita).
 *
 * Nada de localStorage: tudo vem da API a cada montagem.
 */

import { api, ApiError } from '../api.js';
import { state } from '../state.js';
import {
  el,
  fmtMoeda,
  fmtData,
  fmtMesLongo,
  fmtPct,
  skeleton,
  vazio,
  toast,
} from '../ui.js';
import { barrasEmpilhadas } from '../charts.js';

const COR_ENTRADA = 'var(--in, #22c55e)';
const COR_SAIDA = 'var(--out, #ef4444)';
const CAT_PADRAO = { cor: '#94a3b8', icone: '📦' };

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Ano do mês selecionado na topbar ('AAAA-MM' -> number). */
const anoDoMes = (mes) => Number(String(mes ?? '').slice(0, 4));

// Estado local da view.
let anoEscolhido = null;
let anoDaTopbarVisto = null;

/** Corrida de rede: resposta antiga não pode sobrescrever uma tela mais nova. */
let execucao = 0;

// =====================================================================
// Montagem
// =====================================================================

export async function montar(container) {
  if (!container) return;

  const token = ++execucao;
  const anoTopbar = anoDoMes(state.mes);

  // O mês da topbar mudou de ano -> o relatório segue a topbar e descarta a escolha antiga.
  if (Number.isFinite(anoTopbar) && anoTopbar !== anoDaTopbarVisto) {
    anoDaTopbarVisto = anoTopbar;
    anoEscolhido = anoTopbar;
  }

  skeleton(container, 6);

  let anos;
  let anual;
  let categorias;

  try {
    const lista = await api.relatorios.anos();
    if (token !== execucao) return;

    anos = (Array.isArray(lista) ? lista : []).map(Number).filter(Number.isFinite);

    // O ano corrente sempre vem na lista; ainda assim, protege contra um ano
    // selecionado que sumiu (última transação daquele ano foi apagada).
    if (!anos.includes(anoEscolhido)) {
      anoEscolhido = anos.includes(anoTopbar) ? anoTopbar : (anos[0] ?? anoTopbar);
    }

    const ano = anoEscolhido;
    [anual, categorias] = await Promise.all([
      api.relatorios.anual({ ano }),
      api.relatorios.categorias({
        de: `${ano}-01-01`,
        ate: `${ano}-12-31`,
        tipo: 'despesa',
      }),
    ]);
  } catch (err) {
    if (token !== execucao) return;
    mostrarErro(container, err);
    return;
  }

  if (token !== execucao) return;

  renderizar(container, {
    anos,
    ano: anoEscolhido,
    anual: anual ?? {},
    categorias: Array.isArray(categorias) ? categorias : [],
  });
}

function mostrarErro(container, err) {
  const card = el('div', { class: 'card' });
  vazio(card, {
    ico: '⚠️',
    msg: err instanceof ApiError ? err.message : 'Não consegui carregar o relatório.',
    acao: { texto: 'Tentar de novo', onClick: () => montar(container) },
  });
  container.replaceChildren(card);
}

function renderizar(container, { anos, ano, anual, categorias }) {
  const meses = Array.isArray(anual.meses) ? anual.meses : [];

  // O gráfico precisa do nó já montado para medir no hover: cria o alvo antes.
  const alvoGrafico = el('div', { class: 'chart' });

  container.replaceChildren(
    cabecalho(container, anos, ano),
    cardGrafico(alvoGrafico, ano),
    secaoIndicadores(anual),
    cardCategorias(categorias, ano),
  );

  barrasEmpilhadas(alvoGrafico, meses, {
    vazio: `Nenhuma movimentação em ${ano}.`,
  });
}

// =====================================================================
// Cabeçalho: seletor de ano + exportar CSV
// =====================================================================

function cabecalho(container, anos, ano) {
  const select = el(
    'select',
    {
      class: 'input',
      'aria-label': 'Ano do relatório',
      onchange: () => {
        const escolhido = Number(select.value);
        if (!Number.isFinite(escolhido) || escolhido === anoEscolhido) return;
        anoEscolhido = escolhido;
        montar(container);
      },
    },
    anos.map((a) => el('option', { value: String(a) }, String(a))),
  );
  select.value = String(ano);

  const btnCsv = el(
    'button',
    { class: 'primary-btn', type: 'button' },
    '⬇️ Exportar CSV',
  );
  btnCsv.addEventListener('click', () => exportarCsv(ano, btnCsv));

  return el(
    'div',
    { class: ['card', 'view-head'] },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        {},
        el('h2', {}, 'Relatório anual'),
        el('p', { class: 'muted' }, `Consolidado de janeiro a dezembro de ${ano}.`),
      ),
      el('div', { class: 'head-acoes' }, select, btnCsv),
    ),
  );
}

// =====================================================================
// Gráfico anual
// =====================================================================

function cardGrafico(alvo, ano) {
  return el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el('h2', {}, `Receitas e despesas mês a mês (${ano})`),
      el(
        'div',
        { class: 'legend' },
        el('span', { class: 'dot in', style: { background: COR_ENTRADA } }),
        'Receitas',
        el('span', { class: 'dot out', style: { background: COR_SAIDA } }),
        'Despesas',
      ),
    ),
    alvo,
  );
}

// =====================================================================
// Indicadores do ano
// =====================================================================

function secaoIndicadores(anual) {
  const receitas = num(anual?.totais?.receitas);
  const despesas = num(anual?.totais?.despesas);
  const saldo = num(anual?.totais?.saldo);
  const mediaReceitas = num(anual?.media?.receitas);
  const mediaDespesas = num(anual?.media?.despesas);

  // Sem receita no ano, a taxa de economia é 0 (mesma regra do /relatorios/resumo).
  const taxa = receitas > 0 ? ((receitas - despesas) / receitas) * 100 : 0;

  return el(
    'div',
    { class: 'cards' },
    indicador({
      rotulo: 'Receitas do ano',
      ico: '📥',
      valor: fmtMoeda(receitas),
      cor: COR_ENTRADA,
      rodape: `média de ${fmtMoeda(mediaReceitas)}/mês`,
    }),
    indicador({
      rotulo: 'Despesas do ano',
      ico: '📤',
      valor: fmtMoeda(despesas),
      cor: COR_SAIDA,
      rodape: `média de ${fmtMoeda(mediaDespesas)}/mês`,
    }),
    indicador({
      rotulo: 'Saldo do ano',
      ico: '⚖️',
      valor: fmtMoeda(saldo),
      cor: saldo < 0 ? COR_SAIDA : COR_ENTRADA,
      rodape: `taxa de economia: ${fmtPct(taxa)}`,
    }),
    indicadorMes({
      rotulo: 'Melhor mês',
      ico: '🏆',
      mes: anual?.melhor_mes,
      cor: COR_ENTRADA,
    }),
    indicadorMes({
      rotulo: 'Pior mês',
      ico: '🥀',
      mes: anual?.pior_mes,
      cor: COR_SAIDA,
    }),
  );
}

function indicador({ rotulo, ico, valor, cor, rodape }) {
  return el(
    'div',
    { class: ['card', 'kpi'] },
    el(
      'div',
      { class: 'kpi-top' },
      el('span', { class: 'kpi-label' }, rotulo),
      el('span', { class: 'kpi-ico' }, ico),
    ),
    el('div', { class: 'kpi-value', style: cor ? { color: cor } : null }, valor),
    el('div', { class: ['kpi-foot', 'muted'] }, rodape),
  );
}

/**
 * melhor_mes / pior_mes vêm como { mes, rotulo, saldo } ou null quando o ano
 * inteiro não tem transação nenhuma. Nesse caso, mostra '—' em vez de inventar mês.
 */
function indicadorMes({ rotulo, ico, mes, cor }) {
  if (!mes || !mes.mes) {
    return indicador({
      rotulo,
      ico,
      valor: '—',
      cor: null,
      rodape: 'sem movimentação no ano',
    });
  }

  const saldo = num(mes.saldo);
  return indicador({
    rotulo,
    ico,
    valor: fmtMesLongo(mes.mes),
    cor: saldo < 0 ? COR_SAIDA : cor,
    rodape: `saldo de ${fmtMoeda(saldo)}`,
  });
}

// =====================================================================
// Despesas por categoria no ano
// =====================================================================

function cardCategorias(categorias, ano) {
  const card = el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'card-head' },
      el('h2', {}, `Despesas por categoria em ${ano}`),
      el('span', { class: 'muted' }, `${categorias.length} categoria(s)`),
    ),
  );

  if (!categorias.length) {
    const corpo = el('div');
    vazio(corpo, { ico: '📊', msg: `Nenhuma despesa lançada em ${ano}.` });
    card.appendChild(corpo);
    return card;
  }

  // O backend já devolve ordenado por total desc; reordenar aqui garante a regra
  // mesmo que a origem mude.
  const linhas = [...categorias].sort((a, b) => num(b.total) - num(a.total));

  const total = linhas.reduce((soma, c) => soma + num(c.total), 0);
  const transacoes = linhas.reduce((soma, c) => soma + num(c.transacoes), 0);

  card.appendChild(
    el(
      'div',
      { class: 'tabela-wrap' },
      el(
        'table',
        { class: 'tabela' },
        el(
          'thead',
          {},
          el(
            'tr',
            {},
            el('th', {}, 'Categoria'),
            el('th', { class: 'num' }, 'Total'),
            el('th', { class: 'col-pct' }, '% do total'),
            el('th', { class: 'num' }, 'Média/mês'),
            el('th', { class: 'num' }, 'Transações'),
          ),
        ),
        el('tbody', {}, linhas.map(linhaCategoria)),
        el(
          'tfoot',
          {},
          el(
            'tr',
            {},
            el('th', {}, 'TOTAL'),
            el('td', { class: 'num' }, el('strong', {}, fmtMoeda(total))),
            el('td', { class: 'col-pct' }, el('strong', {}, fmtPct(total > 0 ? 100 : 0))),
            el('td', { class: 'num' }, el('strong', {}, fmtMoeda(total / 12))),
            el('td', { class: 'num' }, el('strong', {}, String(transacoes))),
          ),
        ),
      ),
    ),
  );

  return card;
}

function linhaCategoria(cat) {
  const cor = cat.cor || CAT_PADRAO.cor;
  const totalCat = num(cat.total);
  const pct = num(cat.percentual);
  const largura = Math.max(0, Math.min(100, pct));

  return el(
    'tr',
    {},
    el(
      'td',
      {},
      el(
        'span',
        { class: 'cat-chip' },
        el('span', { class: 'cat-ico', style: { background: `${cor}33` } }, cat.icone || CAT_PADRAO.icone),
        cat.nome ?? 'Sem categoria',
      ),
    ),
    el('td', { class: 'num' }, fmtMoeda(totalCat)),
    el(
      'td',
      { class: 'col-pct' },
      el(
        'div',
        { class: 'pct-cel' },
        el(
          'div',
          {
            class: ['bar', 'bar-mini'],
            role: 'progressbar',
            'aria-valuenow': String(Math.round(largura)),
            'aria-valuemin': '0',
            'aria-valuemax': '100',
          },
          el('div', { class: 'bar-fill', style: { width: `${largura}%`, background: cor } }),
        ),
        el('span', { class: 'pct-txt' }, fmtPct(pct)),
      ),
    ),
    // A média divide por 12 (o ano inteiro), não pelos meses em que houve gasto:
    // é o "quanto essa categoria pesa por mês no orçamento anual".
    el('td', { class: 'num' }, fmtMoeda(totalCat / 12)),
    el('td', { class: 'num' }, String(num(cat.transacoes))),
  );
}

// =====================================================================
// Exportar CSV
// =====================================================================

const LIMITE_PAGINA = 500; // máximo aceito por GET /api/transacoes
const MAX_PAGINAS = 200; // trava de segurança: 100 mil transações

// BOM (U+FEFF) exigido pelo Excel pt-BR para ler UTF-8. Montado por fromCharCode:
// um caractere invisível colado no código some no primeiro reformat/lint e o bug
// (acentos quebrados no Excel) reapareceria sem ninguém entender por quê.
const BOM = String.fromCharCode(0xfeff);

const CABECALHO_CSV = ['Data', 'Descrição', 'Tipo', 'Valor', 'Categoria', 'Conta', 'Observação'];

// Mapa explicito em vez de `tipo === 'receita' ? 'Receita' : 'Despesa'`: aquele ternario
// rotulava QUALQUER coisa que nao fosse receita como "Despesa" -- e uma transferencia
// sairia mentindo no arquivo exportado.
const ROTULO_TIPO_CSV = {
  receita: 'Receita',
  despesa: 'Despesa',
  transferencia: 'Transferência',
};

/**
 * Escapa um campo para CSV pt-BR (separador ';').
 *
 * Além das aspas, neutraliza fórmula: um texto começando com '=', '+', '-' ou '@'
 * seria interpretado como fórmula pelo Excel (CSV injection). O prefixo com apóstrofo
 * faz o Excel tratar como texto.
 */
function campoCsv(valor) {
  let s = valor === null || valor === undefined ? '' : String(valor);

  const viraFormula = /^[=+\-@\t\r]/.test(s);
  if (viraFormula) s = `'${s}`;

  // Aspas duplicadas + campo entre aspas quando há ';', quebra de linha ou aspas.
  if (viraFormula || /[";\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;

  return s;
}

/** 1234.5 -> "1234,50" (decimal com vírgula, sem separador de milhar). */
function numeroCsv(valor) {
  return num(valor).toFixed(2).replace('.', ',');
}

/** Busca TODAS as transações do ano, paginando de 500 em 500. */
async function buscarTransacoesDoAno(ano) {
  const de = `${ano}-01-01`;
  const ate = `${ano}-12-31`;

  const itens = [];
  let offset = 0;

  for (let pagina = 0; pagina < MAX_PAGINAS; pagina++) {
    const resposta = await api.transacoes.listar({
      de,
      ate,
      limite: LIMITE_PAGINA,
      offset,
      ordenar: 'data',
      direcao: 'asc',
    });

    const lote = Array.isArray(resposta?.itens) ? resposta.itens : [];
    itens.push(...lote);

    // Página incompleta = acabou. (Também encerra se o lote vier vazio.)
    if (lote.length < LIMITE_PAGINA) break;

    const total = Number(resposta?.total);
    if (Number.isFinite(total) && itens.length >= total) break;

    offset += LIMITE_PAGINA;
  }

  return itens;
}

function montarCsv(transacoes) {
  const linhas = [CABECALHO_CSV.join(';')];

  for (const tx of transacoes) {
    linhas.push(
      [
        campoCsv(fmtData(tx.data)),
        campoCsv(tx.descricao),
        campoCsv(ROTULO_TIPO_CSV[tx.tipo] ?? tx.tipo),
        // Valor sempre positivo: o sinal está na coluna Tipo (regra do domínio).
        campoCsv(numeroCsv(tx.valor)),
        campoCsv(tx.categoria_nome ?? 'Sem categoria'),
        // Na transferência a conta sozinha esconde metade do fato: vão as duas pontas.
        campoCsv(
          tx.tipo === 'transferencia'
            ? `${tx.conta_nome} -> ${tx.conta_destino_nome}`
            : tx.conta_nome ?? 'Sem conta',
        ),
        campoCsv(tx.observacao ?? ''),
      ].join(';'),
    );
  }

  // BOM + CRLF: sem o BOM, o Excel pt-BR le o UTF-8 como latin1 e quebra os acentos.
  return BOM + linhas.join('\r\n') + '\r\n';
}

function baixarArquivo(conteudo, nome) {
  const blob = new Blob([conteudo], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = el('a', { href: url, download: nome, style: { display: 'none' } });
  document.body.appendChild(link);
  link.click();
  link.remove();

  // Revoga só depois que o browser já pegou o blob (revogar no mesmo tick
  // cancela o download em alguns navegadores).
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function exportarCsv(ano, botao) {
  if (botao.disabled) return;

  const rotulo = botao.textContent;
  botao.disabled = true;
  botao.textContent = 'Exportando...';

  try {
    const transacoes = await buscarTransacoesDoAno(ano);

    if (!transacoes.length) {
      toast(`Nenhuma transação em ${ano} para exportar.`, 'info');
      return;
    }

    baixarArquivo(montarCsv(transacoes), `transacoes-${ano}.csv`);
    toast(`${transacoes.length} transação(ões) exportada(s).`, 'ok');
  } catch (err) {
    toast(err?.message || 'Não foi possível exportar o CSV.', 'erro');
  } finally {
    botao.disabled = false;
    botao.textContent = rotulo;
  }
}
