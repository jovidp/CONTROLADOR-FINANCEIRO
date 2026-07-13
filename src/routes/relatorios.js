import { Router } from 'express';
import { query } from '../db.js';
import { asyncHandler, badRequest, data, enumerado, mesParaIntervalo } from '../http.js';

const router = Router();

// --- Helpers de data (sempre no fuso LOCAL; toISOString mudaria o dia) ---

function mesCorrente() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function anoCorrente() {
  return new Date().getFullYear();
}

/** 'AAAA-MM' -> mes imediatamente anterior. Usa UTC so para a aritmetica de calendario. */
function mesAnterior(mes) {
  const [ano, m] = mes.split('-').map(Number);
  const d = new Date(Date.UTC(ano, m - 2, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const MESES_ABREV = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/**
 * 'AAAA-MM' -> 'jul/26'. Montado em JS de proposito: to_char(...,'TMmon/YY')
 * depende do lc_time do servidor, que no Windows nao e confiavel.
 */
function rotuloMes(mes) {
  const [ano, m] = mes.split('-');
  return `${MESES_ABREV[Number(m) - 1]}/${ano.slice(2)}`;
}

// --- Helpers numericos ------------------------------------------------

/** Arredonda evitando lixo de ponto flutuante vindo de subtracoes em JS. */
function arred(valor, casas = 2) {
  const fator = 10 ** casas;
  return Math.round(Number(valor || 0) * fator) / fator;
}

/**
 * Variacao percentual contra o mes anterior. Devolve null quando nao ha base de
 * comparacao (anterior = 0) -- o frontend mostra "—" em vez de "Infinity%".
 * Divide pelo modulo para que o SINAL indique melhora/piora mesmo com saldo
 * anterior negativo (-100 -> -50 e uma melhora de +50%, nao -50%).
 */
function variacaoPct(atual, anterior) {
  if (!anterior) return null;
  return arred(((atual - anterior) / Math.abs(anterior)) * 100, 1);
}

function inteiro(valor, campo, { padrao, min, max }) {
  if (valor === undefined || valor === null || valor === '') return padrao;
  const n = Number(valor);
  if (!Number.isInteger(n)) throw badRequest(`"${campo}" deve ser um número inteiro.`, campo);
  if (n < min || n > max) throw badRequest(`"${campo}" deve estar entre ${min} e ${max}.`, campo);
  return n;
}

/** Valida 'AAAA-MM' e devolve o proprio mes (mesParaIntervalo ja faz a checagem). */
function mesValido(valor, campo, padrao) {
  if (valor === undefined || valor === null || valor === '') return padrao;
  const mes = String(valor);
  mesParaIntervalo(mes, campo);
  return mes;
}

// =====================================================================
// GET /api/relatorios/resumo?mes=AAAA-MM
// =====================================================================
router.get(
  '/resumo',
  asyncHandler(async (req, res) => {
    const mes = mesValido(req.query.mes, 'mes', mesCorrente());
    const atual = mesParaIntervalo(mes);
    const anterior = mesParaIntervalo(mesAnterior(mes));

    // Uma unica varredura: mes atual, mes anterior e acumulado historico.
    // O mes anterior sempre termina antes do fim do mes atual, entao
    // "data <= fim do mes atual" cobre tudo que interessa.
    const { rows } = await query(
      `SELECT
         COALESCE(SUM(valor) FILTER (WHERE tipo = 'receita' AND data BETWEEN $1 AND $2), 0) AS receitas,
         COALESCE(SUM(valor) FILTER (WHERE tipo = 'despesa' AND data BETWEEN $1 AND $2), 0) AS despesas,
         COALESCE(SUM(valor) FILTER (WHERE tipo = 'receita' AND data BETWEEN $3 AND $4), 0) AS receitas_ant,
         COALESCE(SUM(valor) FILTER (WHERE tipo = 'despesa' AND data BETWEEN $3 AND $4), 0) AS despesas_ant,
         COALESCE(SUM(valor) FILTER (WHERE tipo = 'receita'), 0)
           - COALESCE(SUM(valor) FILTER (WHERE tipo = 'despesa'), 0) AS saldo_acumulado
       FROM transacoes
       WHERE usuario_id = $5
         AND data <= $2
         AND NOT oculta`,
      [atual.inicio, atual.fim, anterior.inicio, anterior.fim, req.sessao.id],
    );

    const r = rows[0];
    const receitas = arred(r.receitas);
    const despesas = arred(r.despesas);
    const saldo = arred(receitas - despesas);

    const receitasAnt = arred(r.receitas_ant);
    const despesasAnt = arred(r.despesas_ant);
    const saldoAnt = arred(receitasAnt - despesasAnt);

    // Pode ser negativa: gastou mais do que ganhou.
    const taxaEconomia = receitas > 0 ? arred(((receitas - despesas) / receitas) * 100, 1) : 0;

    res.json({
      receitas,
      despesas,
      saldo,
      taxa_economia: taxaEconomia,
      variacao: {
        receitas_pct: variacaoPct(receitas, receitasAnt),
        despesas_pct: variacaoPct(despesas, despesasAnt),
        saldo_pct: variacaoPct(saldo, saldoAnt),
      },
      saldo_acumulado: arred(r.saldo_acumulado),
    });
  }),
);

// =====================================================================
// GET /api/relatorios/evolucao?meses=6&ate=AAAA-MM
// =====================================================================
router.get(
  '/evolucao',
  asyncHandler(async (req, res) => {
    const meses = inteiro(req.query.meses, 'meses', { padrao: 6, min: 1, max: 36 });
    const ate = mesValido(req.query.ate, 'ate', mesCorrente());
    const fimSerie = mesParaIntervalo(ate).inicio;

    // generate_series + LEFT JOIN: meses sem movimento aparecem zerados
    // em vez de sumirem da serie.
    const { rows } = await query(
      `WITH serie AS (
         SELECT generate_series(
                  $1::date - make_interval(months => $2::int - 1),
                  $1::date,
                  interval '1 month'
                )::date AS ini
       )
       SELECT
         to_char(s.ini, 'YYYY-MM') AS mes,
         COALESCE(SUM(t.valor) FILTER (WHERE t.tipo = 'receita'), 0) AS receitas,
         COALESCE(SUM(t.valor) FILTER (WHERE t.tipo = 'despesa'), 0) AS despesas
       FROM serie s
       LEFT JOIN transacoes t
         ON t.data >= s.ini
        AND t.data < (s.ini + interval '1 month')::date
        AND t.usuario_id = $3
        AND NOT t.oculta
       GROUP BY s.ini
       ORDER BY s.ini`,
      [fimSerie, meses, req.sessao.id],
    );

    res.json(rows.map(linhaMes));
  }),
);

/** Linha { mes, receitas, despesas } -> item do contrato, com rotulo e saldo. */
function linhaMes(row) {
  const receitas = arred(row.receitas);
  const despesas = arred(row.despesas);
  return {
    mes: row.mes,
    rotulo: rotuloMes(row.mes),
    receitas,
    despesas,
    saldo: arred(receitas - despesas),
  };
}

// =====================================================================
// GET /api/relatorios/categorias?mes=AAAA-MM&tipo=despesa  (ou de/ate)
// =====================================================================
router.get(
  '/categorias',
  asyncHandler(async (req, res) => {
    const tipo = enumerado(req.query.tipo ?? 'despesa', 'tipo', ['receita', 'despesa']);

    // 'mes' e um atalho que define de/ate. Sem nenhum filtro de periodo,
    // cai no mes corrente (evita varrer o historico inteiro sem querer).
    let de = null;
    let ate = null;
    if (req.query.mes) {
      ({ inicio: de, fim: ate } = mesParaIntervalo(req.query.mes));
    } else {
      de = data(req.query.de, 'de', { obrigatorio: false });
      ate = data(req.query.ate, 'ate', { obrigatorio: false });
      if (!de && !ate) ({ inicio: de, fim: ate } = mesParaIntervalo(mesCorrente()));
    }
    if (de && ate && de > ate) throw badRequest('"de" não pode ser depois de "ate".', 'de');

    // Clausulas montadas a partir de fragmentos fixos; os valores vao sempre
    // como placeholders ($1, $2...).
    const params = [tipo, req.sessao.id];
    const clausulas = ['t.tipo = $1', 't.usuario_id = $2', 'NOT t.oculta'];
    if (de) {
      params.push(de);
      clausulas.push(`t.data >= $${params.length}`);
    }
    if (ate) {
      params.push(ate);
      clausulas.push(`t.data <= $${params.length}`);
    }

    const { rows } = await query(
      `WITH filtradas AS (
         SELECT t.categoria_id, t.valor
         FROM transacoes t
         WHERE ${clausulas.join(' AND ')}
       ),
       periodo AS (
         SELECT COALESCE(SUM(valor), 0) AS geral FROM filtradas
       )
       SELECT
         f.categoria_id,
         COALESCE(c.nome, 'Sem categoria') AS nome,
         COALESCE(c.cor, '#94a3b8') AS cor,
         COALESCE(c.icone, '📦') AS icone,
         SUM(f.valor) AS total,
         COUNT(*) AS transacoes,
         CASE
           WHEN (SELECT geral FROM periodo) > 0
             THEN ROUND(SUM(f.valor) * 100 / (SELECT geral FROM periodo), 1)
           ELSE 0
         END AS percentual
       FROM filtradas f
       LEFT JOIN categorias c ON c.id = f.categoria_id AND c.usuario_id = $2
       GROUP BY f.categoria_id, c.nome, c.cor, c.icone
       ORDER BY total DESC, nome ASC`,
      params,
    );

    res.json(
      rows.map((row) => ({
        categoria_id: row.categoria_id,
        nome: row.nome,
        cor: row.cor,
        icone: row.icone,
        total: arred(row.total),
        percentual: arred(row.percentual, 1),
        transacoes: Number(row.transacoes),
      })),
    );
  }),
);

// =====================================================================
// GET /api/relatorios/anual?ano=2026
// =====================================================================
router.get(
  '/anual',
  asyncHandler(async (req, res) => {
    const ano = inteiro(req.query.ano, 'ano', { padrao: anoCorrente(), min: 1970, max: 2999 });

    const { rows } = await query(
      `WITH serie AS (
         SELECT generate_series(
                  make_date($1::int, 1, 1),
                  make_date($1::int, 12, 1),
                  interval '1 month'
                )::date AS ini
       )
       SELECT
         to_char(s.ini, 'YYYY-MM') AS mes,
         COALESCE(SUM(t.valor) FILTER (WHERE t.tipo = 'receita'), 0) AS receitas,
         COALESCE(SUM(t.valor) FILTER (WHERE t.tipo = 'despesa'), 0) AS despesas
       FROM serie s
       LEFT JOIN transacoes t
         ON t.data >= s.ini
        AND t.data < (s.ini + interval '1 month')::date
        AND t.usuario_id = $2
        AND NOT t.oculta
       GROUP BY s.ini
       ORDER BY s.ini`,
      [ano, req.sessao.id],
    );

    const meses = rows.map(linhaMes);

    const totais = meses.reduce(
      (acc, m) => ({
        receitas: acc.receitas + m.receitas,
        despesas: acc.despesas + m.despesas,
      }),
      { receitas: 0, despesas: 0 },
    );
    totais.receitas = arred(totais.receitas);
    totais.despesas = arred(totais.despesas);
    totais.saldo = arred(totais.receitas - totais.despesas);

    // Um mes zerado (sem movimento) ainda e um mes valido para melhor/pior:
    // se todos os outros forem negativos, o mes zerado e mesmo o melhor.
    // So quando o ano inteiro nao tem transacao alguma e que nao ha o que eleger.
    const houveMovimento = meses.some((m) => m.receitas > 0 || m.despesas > 0);
    const soMes = ({ mes, rotulo, saldo }) => ({ mes, rotulo, saldo });

    const melhor = houveMovimento
      ? soMes(meses.reduce((a, b) => (b.saldo > a.saldo ? b : a)))
      : null;
    const pior = houveMovimento
      ? soMes(meses.reduce((a, b) => (b.saldo < a.saldo ? b : a)))
      : null;

    res.json({
      meses,
      totais,
      media: {
        receitas: arred(totais.receitas / 12),
        despesas: arred(totais.despesas / 12),
      },
      melhor_mes: melhor,
      pior_mes: pior,
    });
  }),
);

// =====================================================================
// GET /api/relatorios/anos
// =====================================================================
router.get(
  '/anos',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT DISTINCT EXTRACT(YEAR FROM data)::int AS ano
       FROM transacoes
       WHERE usuario_id = $1 AND NOT oculta
       ORDER BY ano DESC`,
      [req.sessao.id],
    );

    // O ano corrente entra sempre, mesmo sem lancamento nenhum -- e o ano que o
    // seletor do frontend precisa abrir por padrao. Vem do relogio local, nao do
    // now() do banco.
    const anos = new Set(rows.map((r) => r.ano));
    anos.add(anoCorrente());

    res.json([...anos].sort((a, b) => b - a));
  }),
);

export default router;
