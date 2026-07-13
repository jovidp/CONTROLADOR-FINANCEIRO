/**
 * Cliente HTTP da API. Unico ponto do frontend que fala com o backend.
 * Contrato: docs/API.md. Toda resposta nao-ok vira ApiError; 204 vira null.
 */

const BASE = '/api';

const SEM_SERVIDOR = 'Não consegui falar com o servidor. Ele está rodando? (npm start)';

/** Sentinela: corpo recebido, mas nao era JSON. Diferente de "sem corpo" (null). */
const NAO_JSON = Symbol('corpo-nao-json');

export class ApiError extends Error {
  constructor(mensagem, status = 0, campo = null) {
    super(mensagem);
    this.name = 'ApiError';
    this.status = status;
    this.campo = campo ?? null;
  }
}

/** Monta a querystring ignorando undefined/null/'' para nao enviar 'tipo=' vazio. */
function querystring(params) {
  if (!params) return '';
  const qs = new URLSearchParams();
  for (const [chave, valor] of Object.entries(params)) {
    if (valor === undefined || valor === null || valor === '') continue;
    qs.append(chave, String(valor));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

async function lerCorpo(resposta) {
  if (resposta.status === 204) return null;

  let texto;
  try {
    texto = await resposta.text();
  } catch {
    // Conexao caiu no meio da leitura do corpo.
    throw new ApiError(SEM_SERVIDOR, 0);
  }

  if (texto.trim() === '') return null;

  try {
    return JSON.parse(texto);
  } catch {
    return NAO_JSON;
  }
}

/**
 * Varias requisicoes podem levar 401 no mesmo instante (uma view carrega 3 de
 * uma vez). Sem a trava, cada uma chamaria replace() e a navegacao sairia em
 * rajada -- o guard deixa a primeira ganhar e cala as outras.
 */
let indoParaLogin = false;

function irParaLogin() {
  if (indoParaLogin) return;
  indoParaLogin = true;
  location.replace('/login.html');
}

async function request(metodo, caminho, { body, params } = {}) {
  const url = BASE + caminho + querystring(params);
  const temCorpo = body !== undefined;

  let resposta;
  try {
    resposta = await fetch(url, {
      method: metodo,
      headers: temCorpo ? { 'Content-Type': 'application/json' } : undefined,
      body: temCorpo ? JSON.stringify(body) : undefined,
    });
  } catch {
    // fetch so rejeita por falha de rede/servidor fora; aqui nao existe status HTTP.
    throw new ApiError(SEM_SERVIDOR, 0);
  }

  const dados = await lerCorpo(resposta);

  if (!resposta.ok) {
    // Sessao vencida (ou cookie apagado): nao adianta a view tentar tratar isso --
    // NENHUMA rota vai responder ate o usuario entrar de novo. Manda para o login
    // uma vez so; o replace() evita que o "voltar" caia numa tela morta.
    if (resposta.status === 401) irParaLogin();

    // Corpo nao-JSON (HTML de erro, proxy, servidor caindo): trata como servidor fora.
    if (dados === NAO_JSON) throw new ApiError(SEM_SERVIDOR, 0);

    if (dados && typeof dados.erro === 'string' && dados.erro.trim() !== '') {
      throw new ApiError(dados.erro, resposta.status, dados.campo ?? null);
    }

    // JSON valido porem sem "erro" (ou sem corpo): preserva o status real em vez de
    // fingir que o servidor esta fora, que seria enganoso.
    throw new ApiError(`Erro ${resposta.status} ao falar com o servidor.`, resposta.status, null);
  }

  // Resposta ok deveria ser sempre JSON (ou vazia). Corpo estranho = algo muito errado servindo a rota.
  if (dados === NAO_JSON) throw new ApiError(SEM_SERVIDOR, 0);

  return dados;
}

const id = (v) => encodeURIComponent(v);

export const api = {
  health: () => request('GET', '/health'),

  auth: {
    // O login em si mora em js/login.js: ele nao pode passar por aqui, senao o
    // 401 de "senha errada" viraria um redirect para a propria tela de login.
    sessao: () => request('GET', '/auth/sessao'),
    sair: () => request('POST', '/auth/logout'),
  },

  categorias: {
    listar: (params) => request('GET', '/categorias', { params }),
    criar: (dados) => request('POST', '/categorias', { body: dados }),
    atualizar: (idCat, dados) => request('PUT', `/categorias/${id(idCat)}`, { body: dados }),
    remover: (idCat) => request('DELETE', `/categorias/${id(idCat)}`),
  },

  contas: {
    listar: (params) => request('GET', '/contas', { params }),
    criar: (dados) => request('POST', '/contas', { body: dados }),
    atualizar: (idConta, dados) => request('PUT', `/contas/${id(idConta)}`, { body: dados }),
    remover: (idConta) => request('DELETE', `/contas/${id(idConta)}`),
  },

  // Corrente, poupanca, cartao... e o que o usuario criar. A `chave` e´ o que
  // conta.tipo guarda; o `rotulo` e o `icone` sao a cara dele na tela.
  tiposConta: {
    listar: () => request('GET', '/tipos-conta'),
    criar: (dados) => request('POST', '/tipos-conta', { body: dados }),
    atualizar: (idTipo, dados) => request('PUT', `/tipos-conta/${id(idTipo)}`, { body: dados }),
    remover: (idTipo) => request('DELETE', `/tipos-conta/${id(idTipo)}`),
  },

  transacoes: {
    listar: (params) => request('GET', '/transacoes', { params }),
    criar: (dados) => request('POST', '/transacoes', { body: dados }),
    atualizar: (idTx, dados) => request('PUT', `/transacoes/${id(idTx)}`, { body: dados }),
    remover: (idTx) => request('DELETE', `/transacoes/${id(idTx)}`),
    // Esconder nao apaga: some da lista e dos totais, mas a linha fica no banco.
    ocultar: (idTx, oculta) =>
      request('PATCH', `/transacoes/${id(idTx)}/oculta`, { body: { oculta } }),
    // Vira despesa fixa: cria a recorrente e vincula esta transacao a ela.
    fixar: (idTx, dados = {}) => request('POST', `/transacoes/${id(idTx)}/fixar`, { body: dados }),
  },

  parcelamentos: {
    listar: () => request('GET', '/parcelamentos'),
    obter: (idParc) => request('GET', `/parcelamentos/${id(idParc)}`),
    // Cria a compra E as N transacoes mensais de uma vez.
    criar: (dados) => request('POST', '/parcelamentos', { body: dados }),
    // Leva junto todas as parcelas (ON DELETE CASCADE).
    remover: (idParc) => request('DELETE', `/parcelamentos/${id(idParc)}`),
  },

  orcamentos: {
    listar: (params) => request('GET', '/orcamentos', { params }),
    criar: (dados) => request('POST', '/orcamentos', { body: dados }),
    atualizar: (idOrc, dados) => request('PUT', `/orcamentos/${id(idOrc)}`, { body: dados }),
    remover: (idOrc) => request('DELETE', `/orcamentos/${id(idOrc)}`),
  },

  metas: {
    listar: () => request('GET', '/metas'),
    criar: (dados) => request('POST', '/metas', { body: dados }),
    atualizar: (idMeta, dados) => request('PUT', `/metas/${id(idMeta)}`, { body: dados }),
    remover: (idMeta) => request('DELETE', `/metas/${id(idMeta)}`),
    // Devolve a meta inteira ja recalculada (nao so o aporte criado).
    aportar: (idMeta, dados) => request('POST', `/metas/${id(idMeta)}/aportes`, { body: dados }),
    removerAporte: (idMeta, aporteId) =>
      request('DELETE', `/metas/${id(idMeta)}/aportes/${id(aporteId)}`),
  },

  recorrentes: {
    listar: () => request('GET', '/recorrentes'),
    criar: (dados) => request('POST', '/recorrentes', { body: dados }),
    atualizar: (idRec, dados) => request('PUT', `/recorrentes/${id(idRec)}`, { body: dados }),
    remover: (idRec) => request('DELETE', `/recorrentes/${id(idRec)}`),
    processar: () => request('POST', '/recorrentes/processar'),
  },

  relatorios: {
    resumo: (params) => request('GET', '/relatorios/resumo', { params }),
    evolucao: (params) => request('GET', '/relatorios/evolucao', { params }),
    categorias: (params) => request('GET', '/relatorios/categorias', { params }),
    anual: (params) => request('GET', '/relatorios/anual', { params }),
    anos: () => request('GET', '/relatorios/anos'),
  },
};
