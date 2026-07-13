/**
 * View "Metas" — objetivos de economia com aportes (e resgates, que sao aportes
 * negativos).
 *
 * As metas nao dependem do mes selecionado na topbar: a lista e sempre o total
 * historico de cada meta (GET /api/metas devolve a meta ja com guardado,
 * restante, percentual e a lista de aportes).
 */

import { api } from '../api.js';
import { excluirCom, formMeta, formAporte } from '../forms.js';
import {
  el,
  fmtMoeda,
  fmtData,
  fmtPct,
  hoje,
  skeleton,
  vazio,
} from '../ui.js';

const COR_OK = 'var(--in, #22c55e)';
const COR_ATRASO = 'var(--out, #ef4444)';

const num = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0);

const MS_DIA = 86_400_000;

/** Cor de fundo suave a partir da cor da meta (so para hex #rrggbb). */
function corSuave(cor) {
  return /^#[0-9a-f]{6}$/i.test(String(cor ?? '')) ? `${cor}22` : 'transparent';
}

function corMeta(cor) {
  return /^#[0-9a-f]{6}$/i.test(String(cor ?? '')) ? cor : 'var(--acc, #6366f1)';
}

function emUTC(iso) {
  const p = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? '').slice(0, 10));
  if (!p) return null;
  return Date.UTC(Number(p[1]), Number(p[2]) - 1, Number(p[3]));
}

/**
 * Dias de calendario entre hoje e o prazo. Comparar duas meias-noites em UTC evita
 * o erro classico de fuso: subtrair Dates locais em dias com horario de verao daria
 * 23h/25h e arredondaria para o dia errado. 'hoje()' ja vem do relogio LOCAL.
 * Negativo = prazo vencido. null = meta sem prazo (ou prazo invalido).
 */
function diasRestantes(prazo) {
  const alvo = emUTC(prazo);
  const agora = emUTC(hoje());
  if (alvo === null || agora === null) return null;
  return Math.round((alvo - agora) / MS_DIA);
}

function textoPrazo(dias) {
  if (dias > 1) return `faltam ${dias} dias`;
  if (dias === 1) return 'falta 1 dia';
  if (dias === 0) return 'o prazo termina hoje';
  if (dias === -1) return 'venceu ontem';
  return `venceu há ${Math.abs(dias)} dias`;
}

// =====================================================================
// Montagem
// =====================================================================

export async function montar(container) {
  if (!container) return;

  skeleton(container, 3);

  let metas;
  try {
    metas = await api.metas.listar();
  } catch (err) {
    mostrarErro(container, err);
    return;
  }

  renderizar(container, Array.isArray(metas) ? metas : []);
}

function mostrarErro(container, err) {
  const card = el('div', { class: 'card' });
  vazio(card, {
    ico: '⚠️',
    msg: err?.message || 'Não foi possível carregar as metas.',
    acao: { texto: 'Tentar de novo', onClick: () => montar(container) },
  });
  container.replaceChildren(card);
}

function renderizar(container, metas) {
  const abrirNova = () => formMeta();

  const partes = [cabecalho(abrirNova)];

  if (metas.length === 0) {
    const card = el('div', { class: 'card' });
    vazio(card, {
      ico: '🏆',
      msg:
        'Guardar dinheiro fica mais fácil com um alvo. Crie uma meta (viagem, reserva de ' +
        'emergência, troca do carro), defina o valor e registre cada aporte para ver o progresso.',
      acao: { texto: '+ Criar minha primeira meta', onClick: abrirNova },
    });
    partes.push(card);
    container.replaceChildren(...partes);
    return;
  }

  partes.push(el('div', { class: 'goals' }, metas.map(cartao)));
  container.replaceChildren(...partes);
}

// =====================================================================
// Pedacos
// =====================================================================

function cabecalho(abrirNova) {
  return el(
    'div',
    { class: ['card', 'view-head'] },
    el(
      'div',
      { class: 'card-head' },
      el(
        'div',
        {},
        el('h2', {}, 'Metas de economia'),
        el('p', { class: 'muted' }, 'Cada aporte aproxima você do alvo. Resgates entram como valor negativo.'),
      ),
      el('button', { class: 'primary-btn', type: 'button', onclick: abrirNova }, '+ Nova meta'),
    ),
  );
}

function cartao(meta) {
  const guardado = num(meta.guardado);
  const alvo = num(meta.valor_alvo);
  const restante = num(meta.restante);
  const excedente = guardado - alvo;

  const dias = meta.prazo ? diasRestantes(meta.prazo) : null;
  const atrasada = !meta.concluida && dias !== null && dias < 0;

  // Barra linear (mais legivel que a circular): o percentual do contrato ja vem
  // grampeado em 0..100, mas grampeamos de novo por seguranca.
  const largura = Math.min(Math.max(num(meta.percentual), 0), 100);
  const corBarra = meta.concluida ? COR_OK : atrasada ? COR_ATRASO : corMeta(meta.cor);

  return el(
    'article',
    { class: ['goal', meta.concluida ? 'goal-ok' : null, atrasada ? 'goal-atrasada' : null] },

    // --- topo: icone, nome, situacao e acoes
    el(
      'div',
      { class: 'goal-top' },
      el('span', { class: 'goal-ico', style: { background: corSuave(meta.cor) } }, meta.icone || '🏆'),
      el(
        'div',
        { class: 'goal-id' },
        el('strong', {}, meta.nome),
        el(
          'span',
          { class: 'goal-sub' },
          meta.concluida
            ? el('span', { class: ['tag', 'tag-ok'] }, 'Concluída ✓')
            : atrasada
              ? el('span', { class: ['tag', 'tag-estourado'] }, 'Atrasada')
              : null,
          meta.prazo
            ? el(
                'span',
                { class: atrasada ? 'txt-estourado' : 'muted' },
                `Prazo ${fmtData(meta.prazo)} — ${textoPrazo(dias)}`,
              )
            : el('span', { class: 'muted' }, 'Sem prazo definido'),
        ),
      ),
      el(
        'div',
        { class: 'goal-acoes' },
        el(
          'button',
          {
            class: 'ghost-btn',
            type: 'button',
            title: `Registrar aporte em ${meta.nome}`,
            onclick: () => formAporte(meta),
          },
          '+ Aporte',
        ),
        el(
          'button',
          {
            class: 'icon-btn',
            type: 'button',
            title: 'Editar meta',
            'aria-label': `Editar a meta ${meta.nome}`,
            onclick: () => formMeta(meta),
          },
          '✏️',
        ),
        el(
          'button',
          {
            class: 'icon-btn',
            type: 'button',
            title: 'Excluir meta',
            'aria-label': `Excluir a meta ${meta.nome}`,
            onclick: () => excluirMeta(meta),
          },
          '🗑️',
        ),
      ),
    ),

    // --- progresso
    el(
      'div',
      { class: 'goal-num' },
      el('strong', {}, fmtMoeda(guardado)),
      el('span', { class: 'muted' }, ` de ${fmtMoeda(alvo)}`),
      el('span', { class: ['goal-pct', meta.concluida ? 'txt-ok' : null] }, fmtPct(meta.percentual)),
    ),
    el(
      'div',
      {
        class: 'bar',
        role: 'progressbar',
        'aria-valuenow': String(Math.round(num(meta.percentual))),
        'aria-valuemin': '0',
        'aria-valuemax': '100',
        'aria-label': `${fmtPct(meta.percentual)} do alvo`,
      },
      el('div', { class: 'bar-fill', style: { width: `${largura}%`, background: corBarra } }),
    ),
    el(
      'div',
      { class: 'goal-foot' },
      restante > 0
        ? el('span', { class: 'muted' }, `Faltam ${fmtMoeda(restante)}`)
        : el(
            'span',
            { class: 'txt-ok' },
            excedente > 0 ? `Alvo alcançado — ${fmtMoeda(excedente)} acima` : 'Alvo alcançado 🎉',
          ),
    ),

    // --- aportes
    listaAportes(meta),
  );
}

function listaAportes(meta) {
  const aportes = Array.isArray(meta.aportes) ? meta.aportes : [];

  if (aportes.length === 0) {
    return el(
      'div',
      { class: 'aportes' },
      el('span', { class: 'muted' }, 'Nenhum aporte ainda. Use “+ Aporte” para registrar o primeiro.'),
    );
  }

  return el(
    'div',
    { class: 'aportes' },
    el('h3', { class: 'aportes-titulo' }, `Aportes (${aportes.length})`),
    el(
      'ul',
      { class: 'aporte-list' },
      aportes.map((a) => {
        const valor = num(a.valor);
        const resgate = valor < 0; // aporte negativo = resgate
        return el(
          'li',
          { class: ['aporte', resgate ? 'aporte-resgate' : 'aporte-entrada'] },
          el('span', { class: 'aporte-data' }, fmtData(a.data)),
          el(
            'span',
            { class: 'aporte-desc' },
            a.observacao ? a.observacao : resgate ? 'Resgate' : 'Aporte',
          ),
          el(
            'span',
            { class: ['aporte-valor', resgate ? 'txt-estourado' : 'txt-ok'] },
            `${resgate ? '−' : '+'}${fmtMoeda(Math.abs(valor))}`,
          ),
          el(
            'button',
            {
              class: 'icon-btn',
              type: 'button',
              title: resgate ? 'Remover resgate' : 'Remover aporte',
              'aria-label': `Remover lançamento de ${fmtData(a.data)}`,
              onclick: () => removerAporte(meta, a),
            },
            '✕',
          ),
        );
      }),
    ),
  );
}

// =====================================================================
// Acoes
// =====================================================================

function excluirMeta(meta) {
  return excluirCom({
    titulo: 'Excluir meta',
    msg: `A meta "${meta.nome}" e todos os seus aportes serão apagados. Isso não pode ser desfeito.`,
    acao: () => api.metas.remover(meta.id),
    sucesso: 'Meta excluída.',
  });
}

function removerAporte(meta, aporte) {
  const valor = num(aporte.valor);
  const rotulo = valor < 0 ? 'resgate' : 'aporte';

  return excluirCom({
    titulo: `Remover ${rotulo}`,
    msg: `O ${rotulo} de ${fmtMoeda(Math.abs(valor))} em ${fmtData(aporte.data)} será removido de "${meta.nome}".`,
    acao: () => api.metas.removerAporte(meta.id, aporte.id),
    sucesso: valor < 0 ? 'Resgate removido.' : 'Aporte removido.',
  });
}
