/** Helpers compartilhados por todas as rotas: erros, validacao e async. */

export class HttpError extends Error {
  constructor(status, message, campo) {
    super(message);
    this.status = status;
    this.campo = campo;
  }
}

export const badRequest = (msg, campo) => new HttpError(400, msg, campo);
export const notFound = (msg = 'Registro não encontrado') => new HttpError(404, msg);
export const conflict = (msg, campo) => new HttpError(409, msg, campo);

/** Envolve handlers async para que rejeicoes caiam no error middleware. */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// --- Validacao -------------------------------------------------------

export function texto(valor, campo, { obrigatorio = true, max = 200 } = {}) {
  if (valor === undefined || valor === null || String(valor).trim() === '') {
    if (obrigatorio) throw badRequest(`"${campo}" é obrigatório.`, campo);
    return null;
  }
  const s = String(valor).trim();
  if (s.length > max) throw badRequest(`"${campo}" excede ${max} caracteres.`, campo);
  return s;
}

export function dinheiro(valor, campo, { obrigatorio = true, min = 0.01 } = {}) {
  if (valor === undefined || valor === null || valor === '') {
    if (obrigatorio) throw badRequest(`"${campo}" é obrigatório.`, campo);
    return null;
  }
  const n = Number(valor);
  if (!Number.isFinite(n)) throw badRequest(`"${campo}" deve ser um número.`, campo);
  if (n < min) throw badRequest(`"${campo}" deve ser maior que zero.`, campo);
  if (n > 999_999_999.99) throw badRequest(`"${campo}" é grande demais.`, campo);
  return Math.round(n * 100) / 100;
}

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;

export function data(valor, campo, { obrigatorio = true } = {}) {
  if (valor === undefined || valor === null || valor === '') {
    if (obrigatorio) throw badRequest(`"${campo}" é obrigatório.`, campo);
    return null;
  }
  const s = String(valor).slice(0, 10);
  if (!RE_DATA.test(s)) throw badRequest(`"${campo}" deve estar no formato AAAA-MM-DD.`, campo);
  const [a, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(a, m - 1, d));
  if (dt.getUTCFullYear() !== a || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw badRequest(`"${campo}" não é uma data válida.`, campo);
  }
  return s;
}

export function enumerado(valor, campo, permitidos, { obrigatorio = true } = {}) {
  if (valor === undefined || valor === null || valor === '') {
    if (obrigatorio) throw badRequest(`"${campo}" é obrigatório.`, campo);
    return null;
  }
  const s = String(valor);
  if (!permitidos.includes(s)) {
    throw badRequest(`"${campo}" deve ser um de: ${permitidos.join(', ')}.`, campo);
  }
  return s;
}

export function idOpcional(valor, campo) {
  if (valor === undefined || valor === null || valor === '' || valor === 'null') return null;
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`"${campo}" inválido.`, campo);
  return n;
}

export function idParam(valor) {
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0) throw badRequest('ID inválido.', 'id');
  return n;
}

export function booleano(valor, padrao = false) {
  if (valor === undefined || valor === null || valor === '') return padrao;
  return valor === true || valor === 'true' || valor === 1 || valor === '1';
}

/** 'AAAA-MM' -> { inicio: 'AAAA-MM-01', fim: 'AAAA-MM-<ultimo dia>' } */
export function mesParaIntervalo(mes, campo = 'mes') {
  if (!/^\d{4}-\d{2}$/.test(String(mes || ''))) {
    throw badRequest(`"${campo}" deve estar no formato AAAA-MM.`, campo);
  }
  const [ano, m] = String(mes).split('-').map(Number);
  if (m < 1 || m > 12) throw badRequest(`"${campo}" tem mês inválido.`, campo);
  const ultimoDia = new Date(Date.UTC(ano, m, 0)).getUTCDate();
  return {
    inicio: `${mes}-01`,
    fim: `${mes}-${String(ultimoDia).padStart(2, '0')}`,
  };
}

/** Traduz erros do PostgreSQL para HTTP com mensagem util ao usuario. */
export function traduzErroPg(err) {
  switch (err.code) {
    case '23505': // unique_violation
      return conflict('Já existe um registro com esse nome.');
    case '23503': // foreign_key_violation
      if (err.constraint?.includes('categoria')) {
        return conflict('Categoria inválida ou de tipo incompatível com o lançamento.');
      }
      if (err.table === 'transacoes' || err.table === 'orcamentos' || err.table === 'recorrentes') {
        return conflict('Não é possível alterar: existem lançamentos vinculados.');
      }
      return conflict('Registro vinculado a outros dados. Remova os vínculos primeiro.');
    case '23514': // check_violation
      return badRequest('Valores fora das regras permitidas (verifique tipo, valor e datas).');
    case '23502': // not_null_violation
      return badRequest(`Campo obrigatório ausente: ${err.column}.`, err.column);
    case '22P02': // invalid_text_representation
      return badRequest('Formato de dado inválido.');
    default:
      return null;
  }
}
