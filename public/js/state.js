/**
 * Estado compartilhado do app: mes selecionado + cache de categorias e contas.
 * O PostgreSQL e a unica fonte de verdade: nada aqui vai para localStorage.
 * Views nunca chamam re-render umas das outras -- mutou, chama emitir().
 */

import { api } from './api.js';

const RE_MES = /^\d{4}-\d{2}$/;

/** Mes corrente no fuso LOCAL. toISOString() viraria o dia em fusos negativos. */
function mesCorrente() {
  const agora = new Date();
  return `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}`;
}

export const state = {
  mes: mesCorrente(),
  categorias: [],
  contas: [],
  tiposConta: [],
  carregado: false,
};

const observadores = new Set();

/** Inscreve um observador. Devolve funcao para cancelar a inscricao. */
export function onMudanca(fn) {
  observadores.add(fn);
  return () => observadores.delete(fn);
}

/** Notifica todos os observadores. Sincrono. */
export function emitir() {
  // Copia o Set: um observador pode se desinscrever durante a propria notificacao.
  for (const fn of [...observadores]) {
    try {
      fn(state);
    } catch (err) {
      // Um observador quebrado nao pode impedir os outros de rodarem.
      console.error('[state] observador falhou:', err);
    }
  }
}

export function setMes(mes) {
  // Ignora valor invalido (ex.: <input type="month"> limpo pelo usuario).
  if (!RE_MES.test(String(mes ?? ''))) return;
  if (mes === state.mes) return;
  state.mes = mes;
  emitir();
}

/** Busca categorias, contas e tipos de conta em paralelo. Lanca ApiError se a API falhar. */
export async function carregarBase() {
  const [categorias, contas, tiposConta] = await Promise.all([
    api.categorias.listar(),
    // Inclui arquivadas: uma transacao antiga pode apontar para conta arquivada e
    // contaPorId() precisa resolver o nome dela. Os formularios e que filtram.
    api.contas.listar({ incluir_arquivadas: true }),
    api.tiposConta.listar(),
  ]);

  state.categorias = categorias ?? [];
  state.contas = contas ?? [];
  state.tiposConta = tiposConta ?? [];
  state.carregado = true;
  return state;
}

/** Ids vindos de <select>/dataset chegam como string; normaliza antes de comparar. */
function mesmoId(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = Number(valor);
  return Number.isInteger(n) ? n : null;
}

export function categoriaPorId(id) {
  const alvo = mesmoId(id);
  if (alvo === null) return undefined;
  return state.categorias.find((c) => c.id === alvo);
}

export function contaPorId(id) {
  const alvo = mesmoId(id);
  if (alvo === null) return undefined;
  return state.contas.find((c) => c.id === alvo);
}

/**
 * O tipo de uma conta, pela chave que ela guarda. Um tipo apagado no meio de uma
 * sessao (ou uma conta de outra origem) nao pode deixar o cartao sem rotulo: o
 * fallback mostra a propria chave em vez de "undefined".
 */
export function tipoContaPorChave(chave) {
  return state.tiposConta.find((t) => t.chave === chave) ?? { chave, rotulo: chave || 'Conta', icone: '🏦' };
}

export function categoriasPorTipo(tipo) {
  if (tipo !== 'receita' && tipo !== 'despesa') return [...state.categorias];
  return state.categorias.filter((c) => c.tipo === tipo);
}
