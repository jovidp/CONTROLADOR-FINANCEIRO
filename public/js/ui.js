/**
 * ui.js — camada de UI compartilhada: DOM, formatadores, toast, confirmacao,
 * modal de formulario e estados de carregando/vazio.
 *
 * Regras:
 *  - nunca innerHTML com dado do banco (el() usa textNode, que ja escapa);
 *  - datas circulam como string 'AAAA-MM-DD' / 'AAAA-MM' e sao formatadas sem
 *    passar por new Date(string), que o JS interpreta como UTC e, em fuso
 *    negativo (America/Sao_Paulo), imprime o dia ANTERIOR;
 *  - "hoje" vem sempre do relogio LOCAL, nunca de toISOString().
 */

// =====================================================================
// el() — construtor de elementos
// =====================================================================

/**
 * el('div', { class: 'card', onclick: fn }, 'texto', outroNode, [lista])
 * attrs: class (string|array), dataset (objeto), style (objeto|string),
 *        on* (listener), aria-x e role (atributo), demais viram propriedade
 *        direta quando existir no elemento (value, checked, type, disabled...).
 * filhos: string, number, Node, array (achatado), null/false/undefined (ignorados).
 */
export function el(tag, attrs, ...filhos) {
  const node = document.createElement(tag);

  for (const [chave, valor] of Object.entries(attrs || {})) {
    if (valor === null || valor === undefined) continue;

    if (chave === 'class' || chave === 'className') {
      const classes = Array.isArray(valor) ? valor.filter(Boolean) : String(valor).split(/\s+/);
      for (const c of classes) if (c) node.classList.add(c);
    } else if (chave === 'dataset') {
      Object.assign(node.dataset, valor);
    } else if (chave === 'style') {
      if (typeof valor === 'object') {
        for (const [prop, v] of Object.entries(valor)) {
          if (v === null || v === undefined) continue;
          // Custom properties (--cor) so entram via setProperty: Object.assign
          // no CSSStyleDeclaration as ignora silenciosamente.
          if (prop.startsWith('--')) node.style.setProperty(prop, String(v));
          else node.style[prop] = v;
        }
      } else {
        node.setAttribute('style', String(valor));
      }
    } else if (chave.startsWith('on') && typeof valor === 'function') {
      node.addEventListener(chave.slice(2).toLowerCase(), valor);
    } else if (chave === 'for') {
      node.htmlFor = valor;
    } else if (chave in node) {
      node[chave] = valor;
    } else {
      node.setAttribute(chave, valor === true ? '' : String(valor));
    }
  }

  anexar(node, filhos);
  return node;
}

function anexar(pai, filhos) {
  for (const filho of filhos) {
    if (filho === null || filho === undefined || filho === false || filho === true) continue;
    if (Array.isArray(filho)) anexar(pai, filho);
    else if (filho instanceof Node) pai.appendChild(filho);
    else pai.appendChild(document.createTextNode(String(filho)));
  }
}

// =====================================================================
// Formatadores (instanciados UMA vez: criar Intl dentro de loop de render e caro)
// =====================================================================

const FMT_MOEDA = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const FMT_INTEIRO = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const FMT_1CASA = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 1 });
const FMT_MES_LONGO = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' });

// Abreviacoes manuais: o Intl com { month: 'short' } devolve "jul." (com ponto)
// em versoes recentes do ICU, e o contrato pede "13 jul" / "jul/26".
const MESES_CURTOS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);

/** 1234.5 -> "R$ 1.234,50" */
export function fmtMoeda(n) {
  return FMT_MOEDA.format(num(n));
}

/** 1234.5 -> "R$ 1,2 mil"  (rotulos de eixo de grafico) */
export function fmtMoedaCurta(n) {
  const v = num(n);
  const abs = Math.abs(v);
  const sinal = v < 0 ? '-' : '';

  const compacto = (divisor, sufixo) => {
    const reduzido = abs / divisor;
    // 1 casa decimal, sem ",0" pendurado
    const texto = FMT_1CASA.format(Math.round(reduzido * 10) / 10);
    return `${sinal}R$ ${texto} ${sufixo}`;
  };

  if (abs >= 1_000_000_000) return compacto(1_000_000_000, 'bi');
  if (abs >= 1_000_000) return compacto(1_000_000, 'mi');
  if (abs >= 1_000) return compacto(1_000, 'mil');
  return `${sinal}R$ ${FMT_INTEIRO.format(Math.round(abs))}`;
}

/** Quebra 'AAAA-MM-DD' sem passar por new Date(string) (que seria lido como UTC). */
function partesData(iso) {
  const s = String(iso ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [ano, mes, dia] = s.split('-').map(Number);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  return { ano, mes, dia };
}

function partesMes(mes) {
  const s = String(mes ?? '').slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(s)) return null;
  const [ano, m] = s.split('-').map(Number);
  if (m < 1 || m > 12) return null;
  return { ano, mes: m };
}

/** "2026-07-13" -> "13/07/2026" */
export function fmtData(iso) {
  const p = partesData(iso);
  if (!p) return '';
  return `${String(p.dia).padStart(2, '0')}/${String(p.mes).padStart(2, '0')}/${p.ano}`;
}

/** "2026-07-13" -> "13 jul" */
export function fmtDataCurta(iso) {
  const p = partesData(iso);
  if (!p) return '';
  return `${String(p.dia).padStart(2, '0')} ${MESES_CURTOS[p.mes - 1]}`;
}

/** "2026-07" -> "julho de 2026" */
export function fmtMesLongo(mes) {
  const p = partesMes(mes);
  if (!p) return '';
  // Data local (ano, mes-1, 1): nunca new Date('2026-07'), que seria UTC.
  return FMT_MES_LONGO.format(new Date(p.ano, p.mes - 1, 1));
}

/** "2026-07" -> "jul/26" */
export function fmtMesCurto(mes) {
  const p = partesMes(mes);
  if (!p) return '';
  return `${MESES_CURTOS[p.mes - 1]}/${String(p.ano).slice(2)}`;
}

/** 42.5 -> "42,5%" */
export function fmtPct(n) {
  return `${FMT_1CASA.format(num(n))}%`;
}

/** 'AAAA-MM-DD' do dia de hoje no fuso LOCAL. */
export function hoje() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 'AAAA-MM' do mes corrente no fuso LOCAL. */
export function mesAtual() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// =====================================================================
// Paletas usadas pelos campos 'cor' e 'icone'
// =====================================================================

export const CORES = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#22c55e', '#10b981', '#14b8a6', '#06b6d4',
  '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899',
];

export const ICONES = [
  '💰', '💵', '💳', '🏦', '💼', '📈',
  '🏠', '💡', '🔧', '🛒', '🍔', '🍽️',
  '🚗', '⛽', '🚌', '✈️', '💊', '🏥',
  '🎓', '📚', '👕', '🎁', '🎮', '🎬',
];

// =====================================================================
// Toast
// =====================================================================

const ICONE_TOAST = { ok: '✅', erro: '⛔', info: 'ℹ️' };
const DURACAO_TOAST = 3500;

function containerToasts() {
  let box = document.getElementById('toasts');
  if (!box) {
    box = el('div', { id: 'toasts', class: 'toasts' });
    document.body.appendChild(box);
  }
  return box;
}

/** toast('Salvo!', 'ok') — empilha, some sozinho em ~3.5s, tem botao de fechar. */
export function toast(msg, tipo = 'info') {
  const t = ICONE_TOAST[tipo] ? tipo : 'info';
  const box = containerToasts();

  let temporizador;
  const remover = () => {
    clearTimeout(temporizador);
    if (!item.isConnected) return;
    item.classList.add('toast-saindo');
    // Espera a transicao de saida; se o CSS nao tiver transicao, some do mesmo jeito.
    setTimeout(() => item.remove(), 220);
  };

  const item = el(
    'div',
    { class: ['toast', `toast-${t}`], role: 'status', 'aria-live': 'polite' },
    el('span', { class: 'toast-ico' }, ICONE_TOAST[t]),
    el('span', { class: 'toast-msg' }, String(msg ?? '')),
    el('button', { class: 'toast-fechar', type: 'button', 'aria-label': 'Fechar', onclick: remover }, '✕'),
  );

  box.appendChild(item);
  temporizador = setTimeout(remover, DURACAO_TOAST);
  return item;
}

// =====================================================================
// Confirmacao
// =====================================================================

let confirmAberto = null; // { encerrar }

/** confirmar({ titulo, msg }) -> Promise<boolean>. ESC e clique fora = false. */
export function confirmar({ titulo = 'Confirmar', msg = '', okLabel = 'Confirmar', cancelLabel = 'Cancelar' } = {}) {
  const overlay = document.getElementById('confirm');
  const elTitulo = document.getElementById('confirmTitle');
  const elMsg = document.getElementById('confirmMsg');
  const btnSim = document.getElementById('confirmYes');
  const btnNao = document.getElementById('confirmNo');

  // Sem o markup no HTML nao ha como confirmar visualmente: nega por seguranca.
  if (!overlay || !btnSim || !btnNao) {
    console.error('[ui] #confirm nao encontrado no HTML.');
    return Promise.resolve(false);
  }

  // Uma confirmacao por vez: fecha a anterior (respondendo false) antes de abrir.
  if (confirmAberto) confirmAberto.encerrar(false);

  if (elTitulo) elTitulo.textContent = titulo;
  if (elMsg) elMsg.textContent = msg;
  btnSim.textContent = okLabel;
  btnNao.textContent = cancelLabel;

  return new Promise((resolve) => {
    const responder = (valor) => () => encerrar(valor);
    const sim = responder(true);
    const nao = responder(false);

    // So´ ESC. Enter NAO confirma por atalho: confirmar() so´ guarda acao destrutiva e
    // irreversivel, e a auto-repeticao de um Enter segurado no botao 🗑️ chegava aqui e
    // respondia "sim" antes de o dialogo ser lido. Quem quer confirmar pelo teclado ja´
    // tem o Enter nativo do botao -- o btnSim.focus() la´ embaixo poe o foco nele.
    const noEsc = (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        encerrar(false);
      }
    };

    const noOverlay = (ev) => {
      if (ev.target === overlay) encerrar(false);
    };

    function encerrar(valor) {
      // Remove TUDO que registramos: sem isso, cada confirmacao deixaria um
      // listener de ESC vivo no document.
      btnSim.removeEventListener('click', sim);
      btnNao.removeEventListener('click', nao);
      overlay.removeEventListener('click', noOverlay);
      document.removeEventListener('keydown', noEsc, true);
      overlay.classList.add('hidden');
      confirmAberto = null;
      resolve(valor);
    }

    btnSim.addEventListener('click', sim);
    btnNao.addEventListener('click', nao);
    overlay.addEventListener('click', noOverlay);
    document.addEventListener('keydown', noEsc, true);

    confirmAberto = { encerrar };
    overlay.classList.remove('hidden');
    btnSim.focus();
  });
}

// =====================================================================
// Modal de formulario
// =====================================================================

const TIPOS_CAMPO = new Set([
  'texto', 'numero', 'dinheiro', 'data', 'mes',
  'select', 'textarea', 'cor', 'icone', 'checkbox', 'segmentado',
]);

let modalAberto = null; // { fechar(salvou) }

function refsModal() {
  const overlay = document.getElementById('modal');
  if (!overlay) return null;
  return {
    overlay,
    form: document.getElementById('modalForm'),
    titulo: document.getElementById('modalTitle'),
    fechar: document.getElementById('modalClose'),
    cancelar: document.getElementById('modalCancel'),
    salvar: overlay.querySelector('.modal-foot button[type="submit"]') || document.getElementById('modalSave'),
  };
}

/** Regra de campo: `true`, `false` ou `(valores) => bool` reavaliada a cada mudanca. */
function avaliar(regra, valores, padrao) {
  if (typeof regra === 'function') return Boolean(regra(valores));
  if (regra === null || regra === undefined) return padrao;
  return Boolean(regra);
}

/**
 * abrirModal({ titulo, campos, valores, onSubmit, okLabel }) -> Promise<boolean>
 * Resolve true se onSubmit rodou sem erro (modal fechou salvando), false se o
 * usuario cancelou/fechou.
 *
 * Campo: { name, label, tipo, opcoes?, obrigatorio?, visivel?, disabled?, step?, min?,
 *          max?, placeholder?, dica?, dicaClasse?, rows?, largura?, onChange? }
 * largura: 'meio' | 'cheio' (default 'cheio') — grid de 2 colunas.
 *
 * obrigatorio / visivel / disabled aceitam bool OU (valores) => bool, reavaliado depois
 * de QUALQUER mudanca no formulario. E aqui que mora "categoria some quando o tipo e
 * transferencia": no proprio campo, declarado. Nao existe versao imperativa disso no
 * handle de proposito — duas fontes de verdade para "este campo esta visivel?" e como o
 * formulario volta a divergir de si mesmo.
 *
 * onChange(valor, campos) — para o que NAO cabe num predicado (repovoar um select,
 * trocar um rotulo, escrever uma previa). campos = handle do formulario inteiro:
 *   valores()               -> { nome: valor } como os controles estao AGORA
 *   set(nome, v)            -> escreve num campo sem disparar onChange (nao ha eco)
 *   repovoar(nome, opcoes)  -> troca as <option> de um select, preservando a selecao se ela sobreviver
 *   rotulo(nome, texto)     -> troca so o texto do <label> (o ' *' de obrigatorio e um irmao e fica)
 *   dica(nome, texto)       -> escreve/limpa a linha de dica embaixo do campo
 *
 * onChange dispara TAMBEM uma vez na abertura, com o valor inicial do campo: e o que faz o
 * formulario nascer coerente (categoria ja filtrada pelo tipo, destino da transferencia ja
 * visivel na edicao) sem um passo de "ajeitar" DEPOIS do abrirModal — que era exatamente de
 * onde vinham os listeners presos no #modalForm.
 *
 * No submit, campo invisivel vale null. Nao e cosmetico: o backend recusa transferencia COM
 * categoria_id, e um <select> escondido continua tendo valor — o formulario precisa ESQUECER
 * o campo, nao so parar de desenha-lo.
 */
export function abrirModal({ titulo = '', campos = [], valores = {}, onSubmit, okLabel = 'Salvar' } = {}) {
  const ref = refsModal();
  if (!ref || !ref.form) {
    console.error('[ui] #modal/#modalForm nao encontrados no HTML.');
    return Promise.resolve(false);
  }

  // Fecha um modal anterior antes de abrir outro (senao acumula listener de ESC).
  if (modalAberto) modalAberto.fechar(false);

  const { overlay, form, salvar } = ref;
  if (ref.titulo) ref.titulo.textContent = titulo;
  if (salvar) salvar.textContent = okLabel;

  form.replaceChildren();
  form.classList.add('form-grid');
  form.noValidate = false;

  const alerta = el('div', { class: ['form-alerta', 'campo-cheio', 'hidden'], role: 'alert' });
  form.appendChild(alerta);

  const usados = campos.filter((c) => c && c.name);
  const controles = new Map(); // name -> controle montado por montarCampo()

  const lerTudo = () => {
    const v = {};
    for (const [nome, ctrl] of controles) v[nome] = ctrl.ler();
    return v;
  };

  const handle = {
    valores: lerTudo,
    set: (nome, valor) => controles.get(nome)?.escrever(valor),
    repovoar: (nome, opcoes) => controles.get(nome)?.repovoar(opcoes),
    rotulo: (nome, texto) => controles.get(nome)?.rotulo(texto),
    dica: (nome, texto) => controles.get(nome)?.dica(texto),
  };

  function sincronizar() {
    const v = lerTudo();
    for (const campo of usados) {
      const ctrl = controles.get(campo.name);
      if (!ctrl) continue;

      const visivel = avaliar(campo.visivel, v, true);
      ctrl.mostrar(visivel);

      // required SO enquanto visivel: um required em display:none faz o reportValidity()
      // tentar focar o que nao da para focar — o submit morre em silencio e o Chrome so
      // resmunga "not focusable" no console.
      ctrl.exigir(visivel && avaliar(campo.obrigatorio, v, false));

      // Escondido tambem vai desabilitado: campo desabilitado e barrado da validacao
      // nativa, entao um "12 vezes" fora da faixa nao trava o submit depois que o
      // usuario desmarcou o parcelamento e nem ve mais o campo.
      ctrl.desabilitar(!visivel || avaliar(campo.disabled, v, false));
    }
  }

  // Todo evento de campo entra por aqui: avisa quem pediu e reavalia o formulario inteiro.
  const notificar = (campo, valor) => {
    campo.onChange?.(valor, handle);
    sincronizar();
  };

  for (const campo of usados) {
    form.appendChild(montarCampo(campo, valores?.[campo.name], controles, notificar));
  }

  sincronizar();
  for (const campo of usados) {
    if (typeof campo.onChange === 'function') notificar(campo, controles.get(campo.name)?.ler());
  }

  return new Promise((resolve) => {
    let finalizado = false;
    let salvando = false;

    // Um unico abort() derruba tudo que este modal pendurou nos nos PERMANENTES do
    // index.html (#modal, #modalForm, document). Sem ele, cada listener novo tinha que ser
    // lembrado no fechar() na mao — e quem esquecia deixava handler vivo para sempre,
    // rodando a cada clique sobre um DOM que o modal seguinte ja tinha substituido.
    const parar = new AbortController();
    const { signal } = parar;

    const noEsc = (ev) => {
      if (ev.key === 'Escape' && !salvando) {
        ev.preventDefault();
        fechar(false);
      }
    };

    const noOverlay = (ev) => {
      if (ev.target === overlay && !salvando) fechar(false);
    };

    const cancelar = (ev) => {
      ev.preventDefault();
      if (!salvando) fechar(false);
    };

    function fechar(salvou) {
      if (finalizado) return;
      finalizado = true;
      parar.abort();
      overlay.classList.add('hidden');
      form.replaceChildren();
      modalAberto = null;
      resolve(Boolean(salvou));
    }

    async function enviar(ev) {
      ev.preventDefault();
      if (salvando) return;
      if (!form.checkValidity()) {
        form.reportValidity();
        return;
      }

      esconderAlerta();
      for (const ctrl of controles.values()) ctrl.limparErro();

      const dados = {};
      for (const [nome, ctrl] of controles) dados[nome] = ctrl.visivel() ? ctrl.ler() : null;

      if (typeof onSubmit !== 'function') {
        fechar(true);
        return;
      }

      salvando = true;
      const rotulo = salvar?.textContent;
      travarBotoes(true, 'Salvando...');

      try {
        await onSubmit(dados);
        fechar(true);
      } catch (err) {
        // ApiError (duck typing: nao importamos api.js para nao acoplar ui->api).
        const msg = err?.message || 'Não foi possível salvar. Tente de novo.';
        const alvo = err?.campo && controles.get(err.campo);
        if (alvo && alvo.visivel()) {
          alvo.erro(msg);
          alvo.focar();
        } else {
          mostrarAlerta(msg);
        }
      } finally {
        salvando = false;
        travarBotoes(false, rotulo);
      }
    }

    function travarBotoes(travado, rotulo) {
      if (salvar) {
        salvar.disabled = travado;
        if (rotulo) salvar.textContent = rotulo;
      }
      if (ref.cancelar) ref.cancelar.disabled = travado;
      if (ref.fechar) ref.fechar.disabled = travado;
    }

    function mostrarAlerta(msg) {
      alerta.textContent = msg;
      alerta.classList.remove('hidden');
    }

    function esconderAlerta() {
      alerta.textContent = '';
      alerta.classList.add('hidden');
    }

    form.addEventListener('submit', enviar, { signal });
    overlay.addEventListener('click', noOverlay, { signal });
    document.addEventListener('keydown', noEsc, { capture: true, signal });
    ref.fechar?.addEventListener('click', cancelar, { signal });
    ref.cancelar?.addEventListener('click', cancelar, { signal });

    modalAberto = { fechar };
    travarBotoes(false, okLabel);
    overlay.classList.remove('hidden');

    // Foco no primeiro campo que o usuario realmente ve (o primeiro pode estar escondido
    // por predicado — a conta de destino fora da transferencia, por exemplo).
    for (const campo of usados) {
      const ctrl = controles.get(campo.name);
      if (ctrl?.visivel()) {
        ctrl.focar();
        break;
      }
    }
  });
}

/** Fecha o modal aberto (equivale a cancelar). */
export function fecharModal() {
  if (modalAberto) {
    modalAberto.fechar(false);
    return;
  }
  document.getElementById('modal')?.classList.add('hidden');
}

/** Fecha uma confirmação que tenha ficado aberta durante uma troca de aba. */
export function fecharConfirmacao() {
  if (confirmAberto) {
    confirmAberto.encerrar(false);
    return;
  }
  document.getElementById('confirm')?.classList.add('hidden');
}

// --- construcao de cada campo ----------------------------------------

function montarCampo(campo, valorInicial, controles, notificar) {
  const tipo = TIPOS_CAMPO.has(campo.tipo) ? campo.tipo : 'texto';
  const largura = campo.largura === 'meio' ? 'campo-meio' : 'campo-cheio';
  const wrap = el('div', { class: ['campo', largura], 'data-campo': campo.name });
  const id = `campo-${campo.name}`;

  const erroBox = el('small', { class: ['campo-erro', 'hidden'] });

  // A dica existe sempre, mesmo vazia: e o alvo do dica() do handle (a previa do
  // parcelamento escreve nela). Vazia ela some — senao o margin-top da .parcela-previa
  // abriria um buraco embaixo de todo campo que nao tem dica nenhuma.
  const dicaBox = el('small', { class: ['campo-dica', campo.dicaClasse || null, 'hidden'] });

  const definirDica = (texto) => {
    const s = String(texto ?? '');
    dicaBox.textContent = s;
    dicaBox.classList.toggle('hidden', s === '');
  };

  let feito;
  let visivel = true;
  let controlePrincipal = null;

  const marcarErro = (msg) => {
    erroBox.textContent = msg;
    erroBox.classList.remove('hidden');
    wrap.classList.add('campo-invalido');
    controlePrincipal?.setAttribute('aria-invalid', 'true');
  };

  const limparErro = () => {
    erroBox.textContent = '';
    erroBox.classList.add('hidden');
    wrap.classList.remove('campo-invalido');
    controlePrincipal?.removeAttribute('aria-invalid');
  };

  // Unico caminho de saida de um evento de campo: limpa o erro e devolve o valor ao modal,
  // que chama o onChange e reavalia os predicados. Todo listener nasce e morre com o form.
  const aoEditar = (valor) => {
    limparErro();
    // undefined = o controle nao sabe dizer o valor no evento (input de texto/numero,
    // cujo 'input' dispara a cada tecla): perguntamos a ele.
    notificar(campo, valor === undefined ? feito?.ler() : valor);
  };

  const rotuloTexto = document.createTextNode(campo.label || campo.name);

  if (tipo === 'checkbox') {
    const input = el('input', {
      type: 'checkbox',
      id,
      name: campo.name,
      checked: Boolean(valorInicial),
      onchange: () => aoEditar(input.checked),
    });
    controlePrincipal = input;
    wrap.appendChild(el('label', { class: 'campo-check', for: id }, input, el('span', {}, rotuloTexto)));

    feito = {
      ler: () => input.checked,
      foco: input,
      escrever: (v) => { input.checked = Boolean(v); },
      exigir: () => {}, // "obrigatorio" num checkbox seria "tem que marcar"; ninguem pede isso
      desabilitar: (v) => { input.disabled = v; },
      repovoar: () => {},
    };
  } else {
    // O ' *' nasce escondido e quem o acende e o exigir(): o obrigatorio pode depender de
    // outro campo (a conta de origem so e obrigatoria na transferencia).
    const marcaObrig = el('span', { class: ['campo-obrig', 'hidden'], 'aria-hidden': 'true' }, ' *');
    wrap.appendChild(el('label', { class: 'campo-label', for: id }, rotuloTexto, marcaObrig));

    feito = montarControle(tipo, campo, valorInicial, id, aoEditar);
    controlePrincipal = feito.foco;
    wrap.appendChild(feito.node);
    feito.marcaObrig = marcaObrig;
  }

  wrap.appendChild(dicaBox);
  wrap.appendChild(erroBox);
  definirDica(campo.dica);

  controles.set(campo.name, {
    ler: () => feito.ler(),
    escrever: (v) => feito.escrever(v),
    repovoar: (opcoes) => feito.repovoar(opcoes),
    erro: marcarErro,
    limparErro,
    focar: () => feito.foco?.focus(),
    rotulo: (t) => { rotuloTexto.textContent = String(t ?? ''); },
    dica: definirDica,
    visivel: () => visivel,
    mostrar: (v) => {
      visivel = Boolean(v);
      wrap.classList.toggle('hidden', !visivel);
    },
    exigir: (v) => {
      feito.marcaObrig?.classList.toggle('hidden', !v);
      feito.exigir(Boolean(v));
    },
    desabilitar: (v) => feito.desabilitar(Boolean(v)),
  });

  return wrap;
}

/**
 * Devolve { node, foco, ler, escrever, repovoar, exigir, desabilitar } para cada tipo.
 * `required` NAO e definido aqui: quem manda nele e o sincronizar() do abrirModal, que
 * sabe se o campo esta visivel e se o predicado de obrigatorio deu true agora.
 */
function montarControle(tipo, campo, valorInicial, id, aoEditar) {
  const comum = {
    id,
    name: campo.name,
    placeholder: campo.placeholder ?? null,
    oninput: () => aoEditar(undefined),
  };

  const texto = (v) => (v === null || v === undefined ? '' : String(v));
  const vazioOuNulo = (v) => (String(v).trim() === '' ? null : String(v).trim());

  /** Entrada de texto/numero/data/textarea: todas reagem igual a escrever/exigir/desabilitar. */
  const entrada = (node, ler) => ({
    node,
    foco: node,
    ler,
    escrever: (v) => { node.value = texto(v); },
    exigir: (v) => { node.required = v; },
    desabilitar: (v) => { node.disabled = v; },
    repovoar: () => {},
  });

  /** Grupos de botao (cor/icone/segmentado): a selecao vive em JS, o DOM so reflete. */
  const grupoBotoes = (node, botoes, chave, obterAtual, definirAtual) => {
    const pintar = () => {
      const atual = obterAtual();
      for (const b of botoes) {
        const marcado = b.dataset[chave] === atual;
        b.classList.toggle('ativo', marcado);
        b.setAttribute('aria-checked', String(marcado));
      }
    };
    for (const b of botoes) node.appendChild(b);
    pintar();
    return {
      node,
      foco: botoes[0],
      pintar,
      escrever: (v) => {
        if (definirAtual(texto(v))) pintar();
      },
      exigir: () => {}, // sempre tem um selecionado: nao ha estado invalido para o navegador barrar
      desabilitar: (v) => { for (const b of botoes) b.disabled = v; },
      repovoar: () => {},
    };
  };

  switch (tipo) {
    case 'numero':
    case 'dinheiro': {
      const dinheiro = tipo === 'dinheiro';
      const input = el('input', {
        ...comum,
        class: 'input',
        type: 'number',
        inputmode: 'decimal',
        step: campo.step ?? (dinheiro ? '0.01' : '1'),
        min: campo.min ?? (dinheiro ? '0.01' : null),
        max: campo.max ?? null,
        value: texto(valorInicial),
      });
      return entrada(input, () => (input.value.trim() === '' ? null : Number(input.value)));
    }

    case 'data':
    case 'mes': {
      const input = el('input', {
        ...comum,
        class: 'input',
        type: tipo === 'data' ? 'date' : 'month',
        value: texto(valorInicial),
      });
      return entrada(input, () => vazioOuNulo(input.value));
    }

    case 'textarea': {
      const area = el('textarea', {
        ...comum,
        class: 'input',
        rows: campo.rows ?? 3,
      }, texto(valorInicial));
      area.value = texto(valorInicial);
      return entrada(area, () => vazioOuNulo(area.value));
    }

    case 'select': {
      // Mantem o tipo original do valor (numero de categoria_id continua numero). O Map e
      // MUTAVEL de proposito: o repovoar() troca o conteudo dele, e o ler() ja fecha em cima.
      const porChave = new Map();

      // O <option> vazio aparece quando o campo NAO e obrigatorio-sempre. Com predicado
      // (a conta de destino so vale na transferencia) ele tem que existir: fora da
      // transferencia o usuario precisa poder estar em "nenhuma".
      const temVazio = campo.obrigatorio !== true;

      const select = el('select', {
        id,
        name: campo.name,
        class: 'input',
        onchange: () => aoEditar(porChave.has(select.value) ? porChave.get(select.value) : null),
      });

      const repovoar = (opcoes) => {
        const lista = Array.isArray(opcoes) ? opcoes : [];
        const antes = select.value;
        const filhos = temVazio
          ? [el('option', { value: '' }, campo.placeholder || '— nenhuma —')]
          : [];

        porChave.clear();
        for (const o of lista) {
          porChave.set(String(o.valor), o.valor);
          filhos.push(el('option', { value: String(o.valor) }, o.icone ? `${o.icone} ${o.rotulo}` : o.rotulo));
        }
        select.replaceChildren(...filhos);

        // A lista nova pode nao ter mais o que estava escolhido (a categoria era de despesa
        // e o tipo virou receita): a selecao cai fora em vez de virar um id incompativel.
        select.value = porChave.has(antes) ? antes : '';
      };

      repovoar(campo.opcoes);
      const inicial = texto(valorInicial);
      select.value = porChave.has(inicial) ? inicial : '';

      return {
        node: select,
        foco: select,
        repovoar,
        ler: () => (porChave.has(select.value) ? porChave.get(select.value) : null),
        escrever: (v) => {
          const s = texto(v);
          select.value = porChave.has(s) ? s : '';
        },
        exigir: (v) => { select.required = v; },
        desabilitar: (v) => { select.disabled = v; },
      };
    }

    case 'cor': {
      const cores = Array.isArray(campo.opcoes) && campo.opcoes.length
        ? campo.opcoes.map((o) => (typeof o === 'string' ? o : o.valor))
        : CORES;
      let atual = texto(valorInicial) || cores[0];

      const paleta = el('div', { class: 'paleta', id, role: 'radiogroup' });
      const botoes = cores.map((cor) =>
        el('button', {
          type: 'button',
          class: 'paleta-cor',
          style: { background: cor },
          title: cor,
          role: 'radio',
          dataset: { cor },
          onclick: () => {
            atual = cor;
            grupo.pintar();
            aoEditar(atual);
          },
        }));

      const grupo = grupoBotoes(paleta, botoes, 'cor', () => atual, (v) => {
        if (!cores.includes(v)) return false;
        atual = v;
        return true;
      });
      return { ...grupo, ler: () => atual };
    }

    case 'icone': {
      const lista = Array.isArray(campo.opcoes) && campo.opcoes.length
        ? campo.opcoes.map((o) => (typeof o === 'string' ? o : o.valor))
        : ICONES;
      let atual = texto(valorInicial) || lista[0];

      const grade = el('div', { class: 'icones', id, role: 'radiogroup' });
      const botoes = lista.map((ico) =>
        el('button', {
          type: 'button',
          class: 'icone-btn',
          role: 'radio',
          dataset: { icone: ico },
          onclick: () => {
            atual = ico;
            grupo.pintar();
            aoEditar(atual);
          },
        }, ico));

      const grupo = grupoBotoes(grade, botoes, 'icone', () => atual, (v) => {
        if (!lista.includes(v)) return false;
        atual = v;
        return true;
      });
      return { ...grupo, ler: () => atual };
    }

    case 'segmentado': {
      const opcoes = Array.isArray(campo.opcoes) ? campo.opcoes : [];
      const porChave = new Map(opcoes.map((o) => [String(o.valor), o.valor]));
      const inicial = texto(valorInicial);
      let atual = porChave.has(inicial) ? inicial : String(opcoes[0]?.valor ?? '');

      const seg = el('div', { class: 'seg', id, role: 'radiogroup' });
      const botoes = opcoes.map((o) =>
        el('button', {
          type: 'button',
          class: 'seg-btn',
          role: 'radio',
          dataset: { valor: String(o.valor) },
          style: o.cor ? { '--seg-cor': o.cor } : null,
          onclick: () => {
            atual = String(o.valor);
            grupo.pintar();
            aoEditar(porChave.get(atual));
          },
        }, o.icone ? `${o.icone} ${o.rotulo}` : o.rotulo));

      const grupo = grupoBotoes(seg, botoes, 'valor', () => atual, (v) => {
        if (!porChave.has(v)) return false;
        atual = v;
        return true;
      });
      return { ...grupo, ler: () => (porChave.has(atual) ? porChave.get(atual) : null) };
    }

    case 'texto':
    default: {
      const input = el('input', {
        ...comum,
        class: 'input',
        type: 'text',
        maxlength: campo.max ?? 200,
        value: texto(valorInicial),
      });
      return entrada(input, () => vazioOuNulo(input.value));
    }
  }
}

// =====================================================================
// Estados de carregamento / vazio
// =====================================================================

/** Placeholder de carregamento: substitui o conteudo do container. */
export function skeleton(container, linhas = 3) {
  if (!container) return;
  const total = Math.max(1, Number(linhas) || 1);
  container.replaceChildren(
    el('div', { class: 'skeleton-wrap', 'aria-busy': 'true', 'aria-label': 'Carregando...' },
      Array.from({ length: total }, () => el('div', { class: 'skeleton' }))),
  );
}

/** Estado vazio. acao: { texto, onClick } | undefined */
export function vazio(container, { ico = '📭', msg = 'Nada por aqui ainda.', acao } = {}) {
  if (!container) return;
  container.replaceChildren(
    el('div', { class: 'empty' },
      el('div', { class: 'empty-ico' }, ico),
      el('p', {}, msg),
      acao?.texto
        ? el('button', { class: 'primary-btn', type: 'button', onclick: acao.onClick }, acao.texto)
        : null),
  );
}
