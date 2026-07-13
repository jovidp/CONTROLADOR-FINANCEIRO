/**
 * Graficos em SVG puro -- sem biblioteca, sem CDN, sem build step.
 *
 * Regras que valem para todos os graficos daqui:
 *  - O SVG e desenhado num sistema de coordenadas fixo (viewBox) e escalado por CSS
 *    (width:100%; height:auto). NUNCA lemos clientWidth/offsetWidth para dimensionar:
 *    a view pode estar oculta (display:none) na hora da montagem e mediria zero.
 *  - Toda divisao e protegida (max === 0 -> altura 0). O SVG nunca recebe NaN/Infinity.
 *  - Sem dados, ou com todos os valores zerados, sai uma mensagem discreta no lugar do
 *    grafico (nunca um eixo torto ou uma barra quebrada).
 *  - O container e limpo antes de cada desenho e recebe position:relative (o tooltip e
 *    um <div> absoluto, filho do container -- nada de <title>, que tem delay do browser).
 *
 * TEMA CLARO/ESCURO
 * As cores das series saem das CSS vars (--in / --out) e o resto usa `currentColor`,
 * entao o grafico ja nasce na cor do tema. Como o SVG e estatico, trocar o tema depois
 * do desenho NAO repinta sozinho: quem trocou precisa mandar redesenhar. Duas formas,
 * as duas validas:
 *   1) o main.js remonta a view ativa (as views chamam os graficos de novo); ou
 *   2) o main.js chama `redesenhar()` daqui, que reexecuta o ultimo desenho de cada
 *      container ainda vivo no DOM, com os mesmos dados.
 *
 * Formatadores vem todos de ./ui.js -- nao existe formatador proprio neste arquivo.
 */

import { fmtMoeda, fmtMoedaCurta, fmtPct } from './ui.js';

const NS = 'http://www.w3.org/2000/svg';

const MSG_VAZIO = 'Sem movimentação no período';

// Paleta de reserva para fatias sem cor definida no banco.
const PALETA = ['#6366f1', '#0ea5e9', '#f59e0b', '#ec4899', '#14b8a6', '#a855f7', '#ef4444', '#84cc16'];

// --- Utilidades -------------------------------------------------------

/** Numero seguro: qualquer coisa nao-finita (null, undefined, NaN, string suja) vira 0. */
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Arredonda para 2 casas so para nao poluir o atributo do SVG com dizimas. */
const r2 = (v) => Math.round(v * 100) / 100;

const uid = () => `cf${Math.random().toString(36).slice(2, 9)}`;

function resolverContainer(container) {
  const alvo = typeof container === 'string' ? document.querySelector(container) : container;
  return alvo instanceof Element ? alvo : null;
}

/** Primeira CSS var preenchida da lista; se nenhuma existir, usa o fallback. */
function cssVar(nomes, fallback) {
  const estilos = getComputedStyle(document.documentElement);
  for (const nome of [].concat(nomes)) {
    const valor = estilos.getPropertyValue(nome).trim();
    if (valor) return valor;
  }
  return fallback;
}

const corEntrada = () => cssVar('--in', '#22c55e');
const corSaida = () => cssVar('--out', '#ef4444');
// A linha de saldo usa a cor de marca; o nome da var varia entre temas, entao tentamos algumas.
const corSaldo = () => cssVar(['--brand', '--accent', '--primary'], '#6366f1');

function svg(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [chave, valor] of Object.entries(attrs)) {
    if (valor === undefined || valor === null) continue;
    node.setAttribute(chave, String(valor));
  }
  return node;
}

/** Raiz do SVG: viewBox + preserveAspectRatio = escala junto com o container, sem medir nada. */
function raizSvg(viewW, viewH, rotulo) {
  const node = svg('svg', {
    viewBox: `0 0 ${viewW} ${viewH}`,
    preserveAspectRatio: 'xMidYMid meet',
    role: 'img',
    'aria-label': rotulo,
  });
  node.style.cssText = 'display:block; width:100%; height:auto; overflow:visible;';
  return node;
}

function texto(x, y, conteudo, { tamanho = 11, cor = 'currentColor', opacidade = 0.55, ancora = 'middle', peso = 400 } = {}) {
  const node = svg('text', {
    x: r2(x),
    y: r2(y),
    'text-anchor': ancora,
    'font-size': tamanho,
    'font-weight': peso,
    fill: cor,
    'fill-opacity': opacidade,
  });
  node.style.pointerEvents = 'none';
  node.textContent = conteudo;
  return node;
}

/** Barra com os dois cantos de cima arredondados (rect+rx arredondaria os quatro). */
function barraTopo(x, y, w, h, raio) {
  const r = Math.max(0, Math.min(raio, w / 2, h));
  const [x0, y0, x1, y1] = [r2(x), r2(y), r2(x + w), r2(y + h)];
  return `M${x0} ${y1} L${x0} ${r2(y + r)} Q${x0} ${y0} ${r2(x + r)} ${y0} ` +
         `L${r2(x + w - r)} ${y0} Q${x1} ${y0} ${x1} ${r2(y + r)} L${x1} ${y1} Z`;
}

/**
 * Escala do eixo Y com marcas "redondas".
 * O passo e sempre 1/2/5 x 10^n, e min/max sao multiplos do passo -- assim a grade nunca
 * fica torta e o zero SEMPRE cai exatamente em cima de uma linha (importante porque o
 * saldo pode ser negativo e as barras precisam nascer do zero).
 */
function escalaY(minBruto, maxBruto, topo, base, alvoMarcas = 4) {
  const vazia = { min: 0, max: 0, marcas: [0], y: () => base, altura: () => 0 };

  const lo = Math.min(0, num(minBruto));
  const hi = Math.max(0, num(maxBruto));
  if (lo === 0 && hi === 0) return vazia;

  const bruto = (hi - lo) / Math.max(1, alvoMarcas);
  const expo = Math.pow(10, Math.floor(Math.log10(bruto)));
  const fator = bruto / expo;
  const passo = (fator <= 1 ? 1 : fator <= 2 ? 2 : fator <= 5 ? 5 : 10) * expo;
  if (!Number.isFinite(passo) || passo <= 0) return vazia;

  const min = Math.floor(lo / passo) * passo;
  const max = Math.ceil(hi / passo) * passo;
  const amplitude = max - min;
  if (!(amplitude > 0)) return vazia;

  const marcas = [];
  const qtd = Math.round(amplitude / passo);
  for (let i = 0; i <= qtd; i++) marcas.push(min + i * passo);

  const y = (v) => base - ((num(v) - min) / amplitude) * (base - topo);
  const altura = (v) => Math.max(0, ((num(v) - Math.max(min, 0)) / amplitude) * (base - topo));

  return { min, max, marcas, y, altura };
}

/** Grade horizontal + rotulos abreviados. A linha do zero e mais forte que as outras. */
function desenharGrade(g, escala, esq, dir, largura) {
  for (const marca of escala.marcas) {
    const y = escala.y(marca);
    const zero = marca === 0;
    g.appendChild(svg('line', {
      x1: esq,
      x2: largura - dir,
      y1: r2(y),
      y2: r2(y),
      stroke: 'currentColor',
      'stroke-opacity': zero ? 0.28 : 0.1,
      'stroke-width': 1,
      'shape-rendering': 'crispEdges',
    }));
    g.appendChild(texto(esq - 10, y + 3.5, fmtMoedaCurta(marca), { ancora: 'end', tamanho: 10.5, opacidade: 0.5 }));
  }
}

// --- Container, estado vazio e tooltip --------------------------------

/** Limpa o container e garante o position:relative que o tooltip absoluto exige. */
function prepararContainer(alvo) {
  alvo.replaceChildren();
  if (getComputedStyle(alvo).position === 'static') alvo.style.position = 'relative';
}

function estadoVazio(alvo, msg) {
  const aviso = document.createElement('p');
  aviso.className = 'chart-vazio';
  aviso.style.cssText =
    'margin:0; padding:28px 12px; text-align:center; font-size:13px; ' +
    'color:currentColor; opacity:.45; line-height:1.4;';
  aviso.textContent = msg || MSG_VAZIO;
  alvo.appendChild(aviso);
}

/**
 * Tooltip: <div> absoluto no container. Cores por CSS var com fallback embutido, para
 * o styles.css poder retematizar (--tip-bg/--tip-fg) sem brigar com o style inline.
 */
function criarTooltip(alvo) {
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.setAttribute('role', 'tooltip');
  tip.style.cssText =
    'position:absolute; left:0; top:0; z-index:5; pointer-events:none; opacity:0; visibility:hidden;' +
    'transition:opacity .12s ease; transform:translate(-50%,-118%); padding:7px 10px; border-radius:8px;' +
    'font-size:12px; line-height:1.45; white-space:nowrap; font-weight:500;' +
    'background:var(--tip-bg, rgba(15,23,42,.95)); color:var(--tip-fg, #f8fafc);' +
    'box-shadow:0 8px 24px rgba(0,0,0,.28);';
  alvo.appendChild(tip);
  return tip;
}

/** Conteudo do tooltip montado com textContent -- nome de categoria e texto do usuario. */
function preencherTooltip(tip, titulo, linhas) {
  tip.replaceChildren();

  if (titulo) {
    const cabecalho = document.createElement('div');
    cabecalho.style.cssText = 'font-weight:600; margin-bottom:2px;';
    cabecalho.textContent = titulo;
    tip.appendChild(cabecalho);
  }

  for (const linha of linhas) {
    const item = document.createElement('div');
    item.style.cssText = 'display:flex; align-items:center; gap:7px;';

    if (linha.cor) {
      const ponto = document.createElement('span');
      ponto.style.cssText = `width:8px; height:8px; border-radius:2px; flex:0 0 auto; background:${linha.cor};`;
      item.appendChild(ponto);
    }

    if (linha.rotulo) {
      const nome = document.createElement('span');
      nome.style.cssText = 'opacity:.75;';
      nome.textContent = linha.rotulo;
      item.appendChild(nome);
    }

    const valor = document.createElement('strong');
    valor.style.cssText = 'margin-left:auto; font-variant-numeric:tabular-nums;';
    valor.textContent = linha.valor;
    item.appendChild(valor);

    tip.appendChild(item);
  }
}

/** Posiciona em px relativos ao container, sem deixar o tooltip vazar pelas bordas. */
function posicionarTooltip(tip, alvo, x, y) {
  const largura = alvo.clientWidth || 0;
  const meio = tip.offsetWidth / 2;
  const limitado = largura > 0 ? Math.min(Math.max(x, meio + 4), largura - meio - 4) : x;
  tip.style.left = `${r2(limitado)}px`;
  tip.style.top = `${r2(y)}px`;
}

function mostrarTooltip(tip, alvo, x, y, titulo, linhas) {
  preencherTooltip(tip, titulo, linhas);
  tip.style.visibility = 'visible';
  tip.style.opacity = '1';
  posicionarTooltip(tip, alvo, x, y);
}

function esconderTooltip(tip) {
  tip.style.opacity = '0';
  tip.style.visibility = 'hidden';
}

/**
 * Converte coordenada do viewBox para pixel dentro do container.
 * So roda no hover -- momento em que o grafico esta visivel e medir e seguro.
 */
function paraPixel(node, alvo, ux, uy, viewW, viewH) {
  const rs = node.getBoundingClientRect();
  const rc = alvo.getBoundingClientRect();
  if (!rs.width || !rs.height) return { x: 0, y: 0 };
  return {
    x: rs.left - rc.left + (ux / viewW) * rs.width,
    y: rs.top - rc.top + (uy / viewH) * rs.height,
  };
}

/** Posicao do cursor relativa ao container (donut e sparkline seguem o mouse). */
function cursorNoContainer(evento, alvo) {
  const rc = alvo.getBoundingClientRect();
  return { x: evento.clientX - rc.left, y: evento.clientY - rc.top };
}

// --- Legenda ----------------------------------------------------------

function legendaSeries(itens) {
  const legenda = document.createElement('div');
  legenda.className = 'chart-legenda';
  legenda.style.cssText =
    'display:flex; flex-wrap:wrap; gap:14px; justify-content:flex-end; margin-bottom:6px; font-size:12px; opacity:.75;';

  for (const item of itens) {
    const linha = document.createElement('span');
    linha.style.cssText = 'display:inline-flex; align-items:center; gap:6px;';

    const ponto = document.createElement('span');
    ponto.style.cssText = `width:9px; height:9px; border-radius:3px; background:${item.cor};`;

    const nome = document.createElement('span');
    nome.textContent = item.rotulo;

    linha.append(ponto, nome);
    legenda.appendChild(linha);
  }
  return legenda;
}

// --- Registro para redesenho (troca de tema) --------------------------

const registro = new Map();

function registrar(alvo, redraw) {
  // Cada remontagem de view cria um container novo. Sem esta limpeza o Map cresceria
  // sem parar (o mes muda -> a view remonta -> outro container), segurando DOM morto.
  for (const antigo of [...registro.keys()]) {
    if (!antigo.isConnected) registro.delete(antigo);
  }
  registro.set(alvo, redraw);
}

/**
 * Redesenha todo grafico ainda montado no DOM, relendo as CSS vars.
 * Chamar no main.js depois de alternar o tema (alternativa a remontar a view).
 */
export function redesenhar() {
  for (const [alvo, redraw] of [...registro]) {
    if (!alvo.isConnected) {
      registro.delete(alvo);
      continue;
    }
    try {
      redraw();
    } catch (err) {
      console.error('[charts] falha ao redesenhar:', err);
    }
  }
}

// =====================================================================
//  barrasAgrupadas -- receitas x despesas por periodo
//  dados: [{ rotulo, receitas, despesas }]
// =====================================================================

export function barrasAgrupadas(container, dados, opts = {}) {
  const alvo = resolverContainer(container);
  if (!alvo) return;

  registrar(alvo, () => barrasAgrupadas(alvo, dados, opts));
  prepararContainer(alvo);

  const itens = (Array.isArray(dados) ? dados : []).map((d) => ({
    rotulo: String(d?.rotulo ?? ''),
    receitas: Math.max(0, num(d?.receitas)),
    despesas: Math.max(0, num(d?.despesas)),
  }));

  const temMovimento = itens.some((d) => d.receitas > 0 || d.despesas > 0);
  if (!itens.length || !temMovimento) return estadoVazio(alvo, opts.vazio);

  const rotuloA = opts.rotulos?.receitas ?? 'Receitas';
  const rotuloB = opts.rotulos?.despesas ?? 'Despesas';
  const cores = { a: corEntrada(), b: corSaida() };

  if (opts.legenda !== false) {
    alvo.appendChild(legendaSeries([
      { cor: cores.a, rotulo: rotuloA },
      { cor: cores.b, rotulo: rotuloB },
    ]));
  }

  const VIEW_W = 760;
  const VIEW_H = 300;
  const ESQ = 64;
  const DIR = 14;
  const TOPO = 14;
  const BAIXO = 34;
  const BASE = VIEW_H - BAIXO;

  const node = raizSvg(VIEW_W, VIEW_H, `${rotuloA} e ${rotuloB} por período`);
  const tip = criarTooltip(alvo);

  const maximo = Math.max(...itens.map((d) => Math.max(d.receitas, d.despesas)));
  const escala = escalaY(0, maximo, TOPO, BASE);
  desenharGrade(node, escala, ESQ, DIR, VIEW_W);

  const plot = VIEW_W - ESQ - DIR;
  const largGrupo = plot / itens.length;
  const largBarra = Math.min(26, Math.max(4, largGrupo * 0.3));
  const folga = Math.min(6, largGrupo * 0.06);
  // Mostra 1 rotulo a cada N quando ha muitos grupos, para o eixo X nao virar sopa de letras.
  const passoRotulo = Math.ceil(itens.length / 12);

  itens.forEach((item, i) => {
    const centro = ESQ + largGrupo * (i + 0.5);
    const xA = centro - largBarra - folga / 2;
    const xB = centro + folga / 2;

    const realce = svg('rect', {
      x: r2(ESQ + largGrupo * i),
      y: TOPO,
      width: r2(largGrupo),
      height: r2(BASE - TOPO),
      fill: 'currentColor',
      'fill-opacity': 0,
      rx: 6,
    });
    realce.style.transition = 'fill-opacity .12s ease';
    node.appendChild(realce);

    const alturaA = escala.altura(item.receitas);
    const alturaB = escala.altura(item.despesas);

    if (alturaA > 0) {
      node.appendChild(svg('path', {
        d: barraTopo(xA, BASE - alturaA, largBarra, alturaA, 4),
        fill: cores.a,
      }));
    }
    if (alturaB > 0) {
      node.appendChild(svg('path', {
        d: barraTopo(xB, BASE - alturaB, largBarra, alturaB, 4),
        fill: cores.b,
      }));
    }

    if (i % passoRotulo === 0) {
      node.appendChild(texto(centro, VIEW_H - 12, item.rotulo, { tamanho: 11, opacidade: 0.6 }));
    }

    // Area de captura do hover: o grupo inteiro, nao so a barra (bem mais facil de acertar).
    const captura = svg('rect', {
      x: r2(ESQ + largGrupo * i),
      y: TOPO,
      width: r2(largGrupo),
      height: r2(BASE - TOPO),
      fill: 'transparent',
    });
    captura.style.cursor = 'default';

    captura.addEventListener('mouseenter', () => {
      realce.setAttribute('fill-opacity', '0.06');
      const topoBarra = BASE - Math.max(alturaA, alturaB);
      const ponto = paraPixel(node, alvo, centro, topoBarra, VIEW_W, VIEW_H);
      mostrarTooltip(tip, alvo, ponto.x, ponto.y, item.rotulo, [
        { cor: cores.a, rotulo: rotuloA, valor: fmtMoeda(item.receitas) },
        { cor: cores.b, rotulo: rotuloB, valor: fmtMoeda(item.despesas) },
      ]);
    });
    captura.addEventListener('mouseleave', () => {
      realce.setAttribute('fill-opacity', '0');
      esconderTooltip(tip);
    });

    node.appendChild(captura);
  });

  alvo.appendChild(node);
}

// =====================================================================
//  donut -- composicao por categoria
//  fatias: [{ rotulo, valor, cor }]
// =====================================================================

export function donut(container, fatias, opts = {}) {
  const alvo = resolverContainer(container);
  if (!alvo) return;

  registrar(alvo, () => donut(alvo, fatias, opts));
  prepararContainer(alvo);

  const limpas = (Array.isArray(fatias) ? fatias : [])
    .map((f, i) => ({
      rotulo: String(f?.rotulo ?? 'Sem categoria'),
      valor: num(f?.valor),
      cor: f?.cor || PALETA[i % PALETA.length],
    }))
    .filter((f) => f.valor > 0)
    .sort((a, b) => b.valor - a.valor);

  const total = limpas.reduce((soma, f) => soma + f.valor, 0);
  if (!limpas.length || total <= 0) return estadoVazio(alvo, opts.vazio);

  // Fatia com menos de 2% do total vira um cisco ilegivel: agrupa tudo em "Outros".
  const LIMIAR = 0.02;
  const grandes = limpas.filter((f) => f.valor / total >= LIMIAR);
  const miudas = limpas.filter((f) => f.valor / total < LIMIAR);
  const dados = [...grandes];
  if (miudas.length) {
    dados.push({
      rotulo: miudas.length === 1 ? miudas[0].rotulo : 'Outros',
      valor: miudas.reduce((soma, f) => soma + f.valor, 0),
      cor: miudas.length === 1 ? miudas[0].cor : cssVar('--muted', '#94a3b8'),
    });
  }

  const VIEW = 200;
  const CX = 100;
  const CY = 100;
  const RAIO = 70;
  const ESPESSURA = 26;
  const CIRC = 2 * Math.PI * RAIO;
  // Respiro entre fatias, em unidades de arco. Some quando ha uma fatia so (senao abriria um talho).
  const VAO = dados.length > 1 ? 2.5 : 0;

  const moldura = document.createElement('div');
  moldura.style.cssText = 'display:flex; flex-wrap:wrap; align-items:center; gap:18px;';

  const caixa = document.createElement('div');
  caixa.style.cssText = 'flex:1 1 180px; max-width:220px; margin:0 auto;';

  const node = raizSvg(VIEW, VIEW, opts.aria || 'Composição por categoria');
  const tip = criarTooltip(alvo);

  const anel = svg('g', { transform: `rotate(-90 ${CX} ${CY})` });

  // Trilho de fundo: evita "buraco" visual quando o arredondamento deixa sobra de 1px.
  anel.appendChild(svg('circle', {
    cx: CX, cy: CY, r: RAIO,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-opacity': 0.07,
    'stroke-width': ESPESSURA,
  }));

  const arcos = [];
  const linhasLegenda = [];
  let acumulado = 0;

  dados.forEach((fatia, i) => {
    const comprimento = (fatia.valor / total) * CIRC;
    const visivel = Math.max(1, comprimento - VAO);

    // stroke-dasharray num circle e bem mais robusto que path com arco: sem calculo de
    // seno/cosseno, sem flag de arco maior, e sem risco de gerar "d" invalido.
    const arco = svg('circle', {
      cx: CX, cy: CY, r: RAIO,
      fill: 'none',
      stroke: fatia.cor,
      'stroke-width': ESPESSURA,
      'stroke-dasharray': `${r2(visivel)} ${r2(CIRC - visivel)}`,
      'stroke-dashoffset': r2(-acumulado),
    });
    arco.style.cssText = 'transition:stroke-width .12s ease; cursor:default;';
    anel.appendChild(arco);
    arcos.push(arco);

    acumulado += comprimento;

    const pct = (fatia.valor / total) * 100;

    const destacar = (ligado, evento) => {
      arco.setAttribute('stroke-width', ligado ? ESPESSURA + 5 : ESPESSURA);
      linhasLegenda[i].style.background = ligado ? 'rgba(127,127,127,.12)' : 'transparent';
      if (!ligado) return esconderTooltip(tip);
      const ponto = evento
        ? cursorNoContainer(evento, alvo)
        : paraPixel(node, alvo, CX, CY, VIEW, VIEW);
      mostrarTooltip(tip, alvo, ponto.x, ponto.y, fatia.rotulo, [
        { cor: fatia.cor, rotulo: fmtPct(pct), valor: fmtMoeda(fatia.valor) },
      ]);
    };

    arco.addEventListener('mouseenter', (e) => destacar(true, e));
    arco.addEventListener('mousemove', (e) => {
      const ponto = cursorNoContainer(e, alvo);
      posicionarTooltip(tip, alvo, ponto.x, ponto.y);
    });
    arco.addEventListener('mouseleave', () => destacar(false));

    const linha = document.createElement('div');
    linha.style.cssText =
      'display:flex; align-items:center; gap:8px; font-size:12.5px; padding:3px 5px;' +
      'border-radius:6px; transition:background .12s ease; cursor:default; background:transparent;';

    const ponto = document.createElement('span');
    ponto.style.cssText = `width:10px; height:10px; border-radius:3px; flex:0 0 auto; background:${fatia.cor};`;

    const nome = document.createElement('span');
    nome.style.cssText = 'flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
    nome.textContent = fatia.rotulo;

    const valor = document.createElement('span');
    valor.style.cssText = 'font-weight:600; font-variant-numeric:tabular-nums;';
    valor.textContent = fmtMoeda(fatia.valor);

    const percentual = document.createElement('span');
    percentual.style.cssText = 'opacity:.55; font-size:11.5px; min-width:46px; text-align:right; font-variant-numeric:tabular-nums;';
    percentual.textContent = fmtPct(pct);

    linha.append(ponto, nome, valor, percentual);
    linha.addEventListener('mouseenter', (e) => destacar(true, e));
    linha.addEventListener('mouseleave', () => destacar(false));

    linhasLegenda.push(linha);
  });

  node.appendChild(anel);

  // Buraco central: o total por extenso. fmtMoeda longo demais nao cabe -> usa a versao curta.
  const totalLongo = fmtMoeda(total);
  const totalTexto = totalLongo.length > 12 ? fmtMoedaCurta(total) : totalLongo;
  node.appendChild(texto(CX, CY - 6, opts.centroRotulo ?? 'Total', { tamanho: 11, opacidade: 0.5 }));
  node.appendChild(texto(CX, CY + 13, totalTexto, { tamanho: 17, opacidade: 0.95, peso: 700 }));

  caixa.appendChild(node);
  moldura.appendChild(caixa);

  if (opts.legenda !== false) {
    const legenda = document.createElement('div');
    legenda.style.cssText = 'flex:1 1 200px; min-width:180px; display:flex; flex-direction:column; gap:2px;';
    legenda.append(...linhasLegenda);
    moldura.appendChild(legenda);
  }

  alvo.appendChild(moldura);
}

// =====================================================================
//  barrasEmpilhadas -- relatorio anual: 12 meses, receita x despesa + linha de saldo
//  dados: [{ mes, rotulo, receitas, despesas, saldo }]
// =====================================================================

export function barrasEmpilhadas(container, dados, opts = {}) {
  const alvo = resolverContainer(container);
  if (!alvo) return;

  registrar(alvo, () => barrasEmpilhadas(alvo, dados, opts));
  prepararContainer(alvo);

  const itens = (Array.isArray(dados) ? dados : []).map((d) => ({
    rotulo: String(d?.rotulo ?? d?.mes ?? ''),
    receitas: Math.max(0, num(d?.receitas)),
    despesas: Math.max(0, num(d?.despesas)),
    saldo: num(d?.saldo),
  }));

  const temMovimento = itens.some((d) => d.receitas > 0 || d.despesas > 0 || d.saldo !== 0);
  if (!itens.length || !temMovimento) return estadoVazio(alvo, opts.vazio);

  const cores = { a: corEntrada(), b: corSaida(), linha: corSaldo() };

  if (opts.legenda !== false) {
    alvo.appendChild(legendaSeries([
      { cor: cores.a, rotulo: 'Receitas' },
      { cor: cores.b, rotulo: 'Despesas' },
      { cor: cores.linha, rotulo: 'Saldo' },
    ]));
  }

  const VIEW_W = 960;
  const VIEW_H = 320;
  const ESQ = 66;
  const DIR = 16;
  const TOPO = 18;
  const BAIXO = 34;
  const BASE = VIEW_H - BAIXO;

  const node = raizSvg(VIEW_W, VIEW_H, 'Receitas, despesas e saldo por mês');
  const tip = criarTooltip(alvo);

  // O saldo pode ser negativo e pode estourar o topo das barras: a escala cobre os dois.
  const maximo = Math.max(...itens.map((d) => Math.max(d.receitas, d.despesas, d.saldo)));
  const minimo = Math.min(0, ...itens.map((d) => d.saldo));
  const escala = escalaY(minimo, maximo, TOPO, BASE, 5);
  const yZero = escala.y(0);

  desenharGrade(node, escala, ESQ, DIR, VIEW_W);

  const plot = VIEW_W - ESQ - DIR;
  const largGrupo = plot / itens.length;
  const largBarra = Math.min(22, Math.max(4, largGrupo * 0.3));
  const folga = Math.min(5, largGrupo * 0.05);

  const pontos = [];

  itens.forEach((item, i) => {
    const centro = ESQ + largGrupo * (i + 0.5);

    const realce = svg('rect', {
      x: r2(ESQ + largGrupo * i),
      y: TOPO,
      width: r2(largGrupo),
      height: r2(BASE - TOPO),
      fill: 'currentColor',
      'fill-opacity': 0,
      rx: 6,
    });
    realce.style.transition = 'fill-opacity .12s ease';
    node.appendChild(realce);

    const alturaA = escala.altura(item.receitas);
    const alturaB = escala.altura(item.despesas);

    if (alturaA > 0) {
      node.appendChild(svg('path', {
        d: barraTopo(centro - largBarra - folga / 2, yZero - alturaA, largBarra, alturaA, 3.5),
        fill: cores.a,
      }));
    }
    if (alturaB > 0) {
      node.appendChild(svg('path', {
        d: barraTopo(centro + folga / 2, yZero - alturaB, largBarra, alturaB, 3.5),
        fill: cores.b,
      }));
    }

    node.appendChild(texto(centro, VIEW_H - 12, item.rotulo, { tamanho: 11, opacidade: 0.6 }));

    pontos.push({ x: centro, y: escala.y(item.saldo), item, realce });
  });

  // Linha do saldo por cima das barras.
  if (pontos.length > 1) {
    node.appendChild(svg('polyline', {
      points: pontos.map((p) => `${r2(p.x)},${r2(p.y)}`).join(' '),
      fill: 'none',
      stroke: cores.linha,
      'stroke-width': 2.5,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
    }));
  }

  for (const p of pontos) {
    node.appendChild(svg('circle', {
      cx: r2(p.x), cy: r2(p.y), r: 3.5,
      fill: cores.linha,
      stroke: cssVar(['--card', '--bg'], '#ffffff'),
      'stroke-width': 1.5,
    }));
  }

  itens.forEach((item, i) => {
    const { x, y, realce } = pontos[i];
    const captura = svg('rect', {
      x: r2(ESQ + largGrupo * i),
      y: TOPO,
      width: r2(largGrupo),
      height: r2(BASE - TOPO),
      fill: 'transparent',
    });
    captura.style.cursor = 'default';

    captura.addEventListener('mouseenter', () => {
      realce.setAttribute('fill-opacity', '0.06');
      const alto = Math.min(y, yZero - Math.max(escala.altura(item.receitas), escala.altura(item.despesas)));
      const ponto = paraPixel(node, alvo, x, alto, VIEW_W, VIEW_H);
      mostrarTooltip(tip, alvo, ponto.x, ponto.y, item.rotulo, [
        { cor: cores.a, rotulo: 'Receitas', valor: fmtMoeda(item.receitas) },
        { cor: cores.b, rotulo: 'Despesas', valor: fmtMoeda(item.despesas) },
        { cor: cores.linha, rotulo: 'Saldo', valor: fmtMoeda(item.saldo) },
      ]);
    });
    captura.addEventListener('mouseleave', () => {
      realce.setAttribute('fill-opacity', '0');
      esconderTooltip(tip);
    });

    node.appendChild(captura);
  });

  alvo.appendChild(node);
}

// =====================================================================
//  sparkline -- mini linha suavizada, sem eixos
//  valores: number[]
// =====================================================================

/** Catmull-Rom convertido para bezier cubica: curva suave que passa por todos os pontos. */
function caminhoSuave(pts) {
  let d = `M${r2(pts[0].x)} ${r2(pts[0].y)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${r2(c1x)} ${r2(c1y)}, ${r2(c2x)} ${r2(c2y)}, ${r2(p2.x)} ${r2(p2.y)}`;
  }
  return d;
}

export function sparkline(container, valores) {
  const alvo = resolverContainer(container);
  if (!alvo) return;

  registrar(alvo, () => sparkline(alvo, valores));
  prepararContainer(alvo);

  const serie = (Array.isArray(valores) ? valores : []).map(num);
  if (!serie.length || serie.every((v) => v === 0)) return estadoVazio(alvo, MSG_VAZIO);

  const VIEW_W = 160;
  const VIEW_H = 44;
  const PAD_X = 3;
  const PAD_Y = 5;

  // Tendencia define a cor: terminou acima de onde comecou -> entrada; caiu -> saida.
  const cor = serie[serie.length - 1] >= serie[0] ? corEntrada() : corSaida();

  const node = raizSvg(VIEW_W, VIEW_H, 'Tendência do período');
  const tip = criarTooltip(alvo);

  const maximo = Math.max(...serie);
  const minimo = Math.min(...serie);
  const amplitude = maximo - minimo;
  const alturaUtil = VIEW_H - PAD_Y * 2;
  const larguraUtil = VIEW_W - PAD_X * 2;

  // Serie constante (amplitude 0) -> linha reta no meio, sem divisao por zero.
  const y = (v) => (amplitude > 0 ? PAD_Y + alturaUtil - ((v - minimo) / amplitude) * alturaUtil : VIEW_H / 2);
  const x = (i) => (serie.length > 1 ? PAD_X + (i / (serie.length - 1)) * larguraUtil : VIEW_W / 2);

  const pts = serie.map((v, i) => ({ x: x(i), y: y(v) }));

  if (pts.length === 1) {
    node.appendChild(svg('circle', { cx: r2(pts[0].x), cy: r2(pts[0].y), r: 3, fill: cor }));
    alvo.appendChild(node);
    return;
  }

  const d = caminhoSuave(pts);
  const idGradiente = uid();

  const defs = svg('defs');
  const gradiente = svg('linearGradient', { id: idGradiente, x1: '0', y1: '0', x2: '0', y2: '1' });
  gradiente.appendChild(svg('stop', { offset: '0%', 'stop-color': cor, 'stop-opacity': 0.28 }));
  gradiente.appendChild(svg('stop', { offset: '100%', 'stop-color': cor, 'stop-opacity': 0 }));
  defs.appendChild(gradiente);
  node.appendChild(defs);

  node.appendChild(svg('path', {
    d: `${d} L${r2(pts[pts.length - 1].x)} ${VIEW_H} L${r2(pts[0].x)} ${VIEW_H} Z`,
    fill: `url(#${idGradiente})`,
    stroke: 'none',
  }));

  node.appendChild(svg('path', {
    d,
    fill: 'none',
    stroke: cor,
    'stroke-width': 2,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  }));

  const marcador = svg('circle', {
    cx: 0, cy: 0, r: 3,
    fill: cor,
    stroke: cssVar(['--card', '--bg'], '#ffffff'),
    'stroke-width': 1.5,
    opacity: 0,
  });
  node.appendChild(marcador);

  const fatia = larguraUtil / Math.max(1, serie.length - 1);
  serie.forEach((valor, i) => {
    const captura = svg('rect', {
      x: r2(Math.max(0, pts[i].x - fatia / 2)),
      y: 0,
      width: r2(fatia),
      height: VIEW_H,
      fill: 'transparent',
    });
    captura.addEventListener('mouseenter', () => {
      marcador.setAttribute('cx', r2(pts[i].x));
      marcador.setAttribute('cy', r2(pts[i].y));
      marcador.setAttribute('opacity', '1');
      const ponto = paraPixel(node, alvo, pts[i].x, pts[i].y, VIEW_W, VIEW_H);
      mostrarTooltip(tip, alvo, ponto.x, ponto.y, null, [{ cor, valor: fmtMoeda(valor) }]);
    });
    captura.addEventListener('mouseleave', () => {
      marcador.setAttribute('opacity', '0');
      esconderTooltip(tip);
    });
    node.appendChild(captura);
  });

  alvo.appendChild(node);
}
