/**
 * main.js — casca do app.
 *
 * Responsabilidades (e so estas):
 *  - roteamento por location.hash -> monta a view no #content;
 *  - seletor de mes da topbar -> setMes();
 *  - assina onMudanca() e REMONTA a view ativa;
 *  - tema claro/escuro (unico uso de localStorage permitido: a preferencia);
 *  - menu hamburguer no mobile;
 *  - boot: carregarBase() antes de rotear, com tela de erro se a API estiver fora.
 *
 * Nao conhece regra de negocio: quem fala com a API sao as views e o forms.js.
 */

import { api } from './api.js';
import { state, setMes, carregarBase, onMudanca } from './state.js';
import { confirmar, el, fecharConfirmacao, fecharModal, fmtMesLongo, toast } from './ui.js';
import { formTransacao } from './forms.js';

import * as dashboard from './views/dashboard.js';
import * as transacoes from './views/transacoes.js';
import * as orcamentos from './views/orcamentos.js';
import * as metas from './views/metas.js';
import * as recorrentes from './views/recorrentes.js';
import * as categorias from './views/categorias.js';
import * as relatorios from './views/relatorios.js';
import * as config from './views/config.js';

// =====================================================================
// Views
// =====================================================================

// `sub` pode ser string ou funcao: as telas que dependem do mes precisam
// reescrever o subtitulo toda vez que o mes muda.
const VIEWS = {
  dashboard: {
    titulo: 'Painel',
    sub: () => `Visão geral de ${fmtMesLongo(state.mes)}`,
    montar: dashboard.montar,
  },
  transacoes: {
    titulo: 'Transações',
    sub: 'Todos os lançamentos, com filtro e busca',
    montar: transacoes.montar,
  },
  orcamentos: {
    titulo: 'Orçamentos',
    sub: () => `Tetos de gasto em ${fmtMesLongo(state.mes)}`,
    montar: orcamentos.montar,
  },
  metas: {
    titulo: 'Metas',
    sub: 'Objetivos e quanto você já guardou',
    montar: metas.montar,
  },
  recorrentes: {
    titulo: 'Recorrentes',
    sub: 'Lançamentos fixos que se repetem sozinhos',
    montar: recorrentes.montar,
  },
  categorias: {
    titulo: 'Categorias',
    sub: 'Como suas receitas e despesas são organizadas',
    montar: categorias.montar,
  },
  relatorios: {
    titulo: 'Relatórios',
    sub: 'Evolução, comparações e fechamento anual',
    montar: relatorios.montar,
  },
  config: {
    titulo: 'Configurações',
    sub: 'Contas, aparência e manutenção dos dados',
    montar: config.montar,
  },
};

const VIEW_PADRAO = 'dashboard';

// =====================================================================
// Referencias do DOM (a casca e estatica: buscar uma vez basta)
// =====================================================================

const content = document.getElementById('content');
const nav = document.getElementById('nav');
const sidebar = document.getElementById('sidebar');
const backdrop = document.getElementById('backdrop');
const btnMenu = document.getElementById('btnMenu');
const btnNova = document.getElementById('btnNova');
const btnTema = document.getElementById('btnTema');
const btnSair = document.getElementById('btnSair');
const mesInput = document.getElementById('mesInput');
const mesAnterior = document.getElementById('mesAnterior');
const mesProximo = document.getElementById('mesProximo');
const viewTitulo = document.getElementById('viewTitulo');
const viewSub = document.getElementById('viewSub');

function fecharCamadas() {
  fecharModal();
  fecharConfirmacao();
  alternarMenu(false);
}

// =====================================================================
// Roteamento
// =====================================================================

/**
 * Nome da rota no hash, ignorando a querystring ('#transacoes?categoria=3').
 * Hash desconhecido ou vazio cai no painel (e o hash e normalizado com
 * replaceState, que nao dispara hashchange -- evita rotear duas vezes).
 */
function rotaAtual() {
  const bruto = decodeURIComponent(location.hash.replace(/^#/, ''));
  const nome = bruto.split('?')[0].trim();

  if (!VIEWS[nome]) {
    history.replaceState(null, '', `#${VIEW_PADRAO}`);
    return VIEW_PADRAO;
  }
  return nome;
}

/**
 * Token de geracao: toda montagem recebe um numero. Se uma montagem antiga
 * terminar depois de outra ter comecado, ela ja perdeu a corrida.
 */
let geracao = 0;

/**
 * Monta a view do hash no #content.
 *
 * Cada montagem ganha um container PROPRIO, anexado no lugar do anterior. Uma
 * montagem atrasada (fetch lento) escreve no container dela, que a essa altura
 * ja esta desconectado do documento -- ninguem ve nada e nada duplica. Sem isso,
 * duas views escreveriam no mesmo #content e a que terminasse por ultimo venceria,
 * que nem sempre e a que o usuario pediu.
 */
async function montarView() {
  if (!state.carregado) return; // sem base carregada, quem manda no #content e a tela de erro

  const rota = rotaAtual();
  const view = VIEWS[rota];
  const token = ++geracao;

  marcarNav(rota);
  atualizarCabecalho(view);

  const alvo = el('div', { class: 'view' });
  content.replaceChildren(alvo);

  try {
    await view.montar(alvo);
  } catch (err) {
    // Rede de seguranca: cada view ja trata os proprios erros de API.
    if (token !== geracao) return;
    console.error(`[main] falha ao montar a view "${rota}":`, err);
    alvo.replaceChildren(
      el('div', { class: 'erro-box' },
        el('p', {}, err?.message || 'Não foi possível carregar esta tela.'),
        el('button', { class: 'btn btn-primario', type: 'button', onclick: montarView }, 'Tentar de novo'),
      ),
    );
  }
}

function marcarNav(rota) {
  for (const item of nav.querySelectorAll('.nav-item')) {
    const ativo = item.dataset.view === rota;
    item.classList.toggle('ativo', ativo);
    // aria-current: leitor de tela anuncia qual item e a pagina atual.
    if (ativo) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
}

function atualizarCabecalho(view) {
  if (!view) return;
  viewTitulo.textContent = view.titulo;
  viewSub.textContent = typeof view.sub === 'function' ? view.sub() : view.sub;
  document.title = `${view.titulo} · Controlador Financeiro`;
}

// =====================================================================
// Seletor de mes
// =====================================================================

/** Anda `delta` meses. new Date(ano, mes-1+delta, 1) resolve a virada de ano sozinho. */
function passoMes(delta) {
  const [ano, mes] = String(state.mes).split('-').map(Number);
  if (!Number.isInteger(ano) || !Number.isInteger(mes)) return;

  // Dia 1 e getters LOCAIS: nada de toISOString(), que puxaria o dia para tras em UTC-3.
  const d = new Date(ano, mes - 1 + delta, 1);
  setMes(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
}

function sincronizarMes() {
  if (mesInput.value !== state.mes) mesInput.value = state.mes;
}

// =====================================================================
// Tema (unico dado que pode morar no localStorage: a PREFERENCIA)
// =====================================================================

const CHAVE_TEMA = 'cf:tema';
const TEMAS = ['claro', 'escuro'];

function temaSalvo() {
  try {
    const salvo = localStorage.getItem(CHAVE_TEMA);
    return TEMAS.includes(salvo) ? salvo : null;
  } catch {
    // Navegacao privada / storage bloqueado nao pode derrubar o app.
    return null;
  }
}

function temaDoSistema() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'escuro' : 'claro';
}

function aplicarTema(tema) {
  document.documentElement.dataset.tema = tema;
  btnTema.textContent = tema === 'escuro' ? '☀️' : '🌙';
  const alvo = tema === 'escuro' ? 'claro' : 'escuro';
  btnTema.setAttribute('aria-label', `Mudar para o tema ${alvo}`);
  btnTema.title = `Mudar para o tema ${alvo}`;
}

function alternarTema() {
  const novo = document.documentElement.dataset.tema === 'escuro' ? 'claro' : 'escuro';
  aplicarTema(novo);
  try {
    localStorage.setItem(CHAVE_TEMA, novo);
  } catch {
    // Sem persistencia o tema ainda vale para esta sessao.
  }
  // Os graficos sao SVG com cores lidas das CSS vars na hora do desenho:
  // sem remontar, eles ficariam com a paleta do tema antigo.
  montarView();
}

// =====================================================================
// Menu mobile
// =====================================================================

function alternarMenu(aberto) {
  sidebar.classList.toggle('aberta', aberto);
  backdrop.classList.toggle('hidden', !aberto);
  document.body.classList.toggle('menu-aberto', aberto);
  btnMenu.setAttribute('aria-expanded', String(aberto));
  btnMenu.setAttribute('aria-label', aberto ? 'Fechar menu' : 'Abrir menu');
}

const fecharMenu = () => alternarMenu(false);

// =====================================================================
// Nova transacao
// =====================================================================

function novaTransacao() {
  // Sem categorias/contas em memoria o formulario abriria com selects vazios.
  if (!state.carregado) {
    toast('Ainda não consegui falar com o servidor.', 'erro');
    return;
  }
  formTransacao();
}

// =====================================================================
// Sair
// =====================================================================

/**
 * O cookie de sessao e´ httpOnly: quem o apaga e´ o servidor, no /auth/logout.
 * Mesmo se a chamada falhar, vamos para o login -- deixar o usuario parado numa
 * tela que ele mandou fechar seria pior do que uma sessao que ainda vence sozinha.
 */
async function sair() {
  const ok = await confirmar({
    titulo: 'Sair',
    msg: 'Encerrar a sessão? Você vai precisar entrar de novo.',
    okLabel: 'Sair',
  });
  if (!ok) return;

  try {
    await api.auth.sair();
  } catch {
    toast('Não consegui avisar o servidor, mas vou te desconectar assim mesmo.', 'erro');
  }
  location.replace('/login.html');
}

function modalAberto() {
  return !document.getElementById('modal')?.classList.contains('hidden')
    || !document.getElementById('confirm')?.classList.contains('hidden');
}

/** 'n' abre uma nova transacao -- exceto quando o usuario esta digitando. */
function atalhos(ev) {
  if (ev.key !== 'n' && ev.key !== 'N') return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (modalAberto()) return;

  const alvo = ev.target;
  const tag = alvo?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || alvo?.isContentEditable) return;

  ev.preventDefault();
  novaTransacao();
}

// =====================================================================
// Tela de "servidor fora"
// =====================================================================

function telaSemServidor(err) {
  // Invalida qualquer montagem em voo: quem manda no #content agora e esta tela.
  geracao += 1;

  content.replaceChildren(
    el('div', { class: ['view', 'erro-servidor'] },
      el('div', { class: 'erro-ico', 'aria-hidden': 'true' }, '🔌'),
      el('h2', {}, 'Não consegui falar com o servidor'),
      el('p', { class: 'erro-detalhe' }, err?.message || 'A API não respondeu.'),
      el('ol', { class: 'erro-passos' },
        el('li', {}, 'Confira se o servidor está de pé: rode ', el('code', {}, 'npm start'), ' na pasta do projeto.'),
        el('li', {}, 'Confira se o serviço ', el('code', {}, 'postgresql-x64-18'), ' está ativo nos Serviços do Windows.'),
        el('li', {}, 'Se o banco ainda não existe, rode ', el('code', {}, 'npm run setup'), ' e tente de novo.'),
      ),
      el('button', { class: 'btn btn-primario', type: 'button', onclick: tentarNovamente }, 'Tentar de novo'),
    ),
  );
}

async function tentarNovamente() {
  content.replaceChildren(el('div', { class: 'view' }, el('p', { class: 'carregando' }, 'Conectando...')));
  if (await carregarComTela()) montarView();
}

/** carregarBase() com tela de erro. Devolve true se a base entrou no state. */
async function carregarComTela() {
  try {
    await carregarBase();
    return true;
  } catch (err) {
    telaSemServidor(err);
    return false;
  }
}

// =====================================================================
// Boot
// =====================================================================

function ligarEventos() {
  // O hash continua sendo a URL da rota, mas tratamos o clique explicitamente.
  // Isso evita que um overlay, uma navegacao restaurada pelo browser ou uma
  // pagina servida de cache deixe a aba visualmente presa na tela anterior.
  nav.addEventListener('click', (ev) => {
    const item = ev.target.closest('a[data-view]');
    if (!item || !nav.contains(item)) return;

    const hash = item.getAttribute('href');
    if (!hash) return;

    ev.preventDefault();
    fecharCamadas();
    if (location.hash === hash) montarView();
    else location.hash = hash;
  });

  // Links internos disparados por cards/atalhos continuam usando o evento
  // nativo de mudança do hash.
  window.addEventListener('hashchange', () => {
    fecharCamadas();
    montarView();
  });

  mesAnterior.addEventListener('click', () => passoMes(-1));
  mesProximo.addEventListener('click', () => passoMes(1));
  // 'change' e nao 'input': no <input type="month"> o input dispara a cada
  // digito do ano ("2" -> 0002-07) e dispararia uma busca por mes fantasma.
  mesInput.addEventListener('change', () => setMes(mesInput.value));

  btnNova.addEventListener('click', novaTransacao);
  btnTema.addEventListener('click', alternarTema);
  btnSair.addEventListener('click', sair);

  btnMenu.addEventListener('click', () => alternarMenu(!sidebar.classList.contains('aberta')));
  backdrop.addEventListener('click', fecharMenu);

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && sidebar.classList.contains('aberta')) {
      fecharMenu();
      return;
    }
    atalhos(ev);
  });

  // Sistema mudou de tema e o usuario nunca escolheu um: acompanha.
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (temaSalvo()) return;
    aplicarTema(temaDoSistema());
    montarView();
  });

  // Qualquer escrita (view ou formulario) termina em emitir(): a view ativa
  // remonta com dados frescos, e o cabecalho/seletor acompanham o mes.
  onMudanca(() => {
    sincronizarMes();
    montarView();
  });
}

async function iniciar() {
  aplicarTema(temaSalvo() ?? temaDoSistema());
  sincronizarMes();
  ligarEventos();

  // Rotear antes da base carregar mostraria views com categorias/contas vazias.
  if (!(await carregarComTela())) return;

  montarView();
}

iniciar();
