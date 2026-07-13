import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import {
  asyncHandler,
  badRequest,
  booleano,
  conflict,
  dinheiro,
  idOpcional,
  idParam,
  mesParaIntervalo,
  notFound,
} from '../http.js';

const router = Router();

const round1 = (n) => Math.round((n + Number.EPSILON) * 10) / 10;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/** 'AAAA-MM' do mes corrente no fuso LOCAL do servidor (toISOString mudaria o dia em fusos negativos). */
function mesCorrente() {
  const agora = new Date();
  return `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}`;
}

/** Intervalo do mes pedido; sem ?mes= cai no mes corrente. */
function intervaloDaQuery(req) {
  const mes = req.query.mes ? String(req.query.mes) : mesCorrente();
  return mesParaIntervalo(mes);
}

// gasto = despesas da categoria dentro do intervalo do mes. LATERAL resolve todos os
// orcamentos numa unica passada (sem N+1). $1 = inicio, $2 = fim.
const SQL_ORCAMENTOS = `
  SELECT o.id,
         o.categoria_id,
         o.limite,
         o.ativo,
         c.nome  AS categoria_nome,
         c.cor   AS categoria_cor,
         c.icone AS categoria_icone,
         COALESCE(g.gasto, 0) AS gasto
    FROM orcamentos o
    JOIN categorias c ON c.id = o.categoria_id AND c.usuario_id = o.usuario_id
    LEFT JOIN LATERAL (
      SELECT SUM(t.valor) AS gasto
        FROM transacoes t
       WHERE t.categoria_id = o.categoria_id
         AND t.usuario_id = o.usuario_id
         AND t.tipo = 'despesa'
         AND t.data >= $1::date
         AND t.data <= $2::date
         AND NOT t.oculta
    ) g ON true
`;

function mapOrcamento(row) {
  const limite = Number(row.limite);
  const gasto = round2(Number(row.gasto));
  const razao = limite > 0 ? gasto / limite : 0;

  let status = 'ok';
  if (razao >= 1) status = 'estourado';
  else if (razao >= 0.75) status = 'atencao';

  return {
    id: row.id,
    categoria_id: row.categoria_id,
    categoria_nome: row.categoria_nome,
    categoria_cor: row.categoria_cor,
    categoria_icone: row.categoria_icone,
    limite,
    gasto,
    restante: round2(limite - gasto), // pode ser negativo quando estoura
    percentual: round1(razao * 100),
    // 'ativo' nao esta no tipo Orcamento do contrato, mas PUT aceita 'ativo?';
    // sem devolve-lo o frontend nao teria como refletir o estado depois de alternar.
    ativo: row.ativo,
    status,
  };
}

/** Lista apenas os orcamentos ativos, do mais critico para o menos. */
async function listarOrcamentos(db, { inicio, fim }, usuarioId) {
  const { rows } = await db.query(`${SQL_ORCAMENTOS} WHERE o.usuario_id = $3 AND o.ativo ORDER BY o.id`, [inicio, fim, usuarioId]);
  return rows
    .map(mapOrcamento)
    .sort(
      (a, b) =>
        b.percentual - a.percentual ||
        a.categoria_nome.localeCompare(b.categoria_nome, 'pt-BR'),
    );
}

/** Busca um orcamento (ativo ou nao) ja recalculado para o intervalo. */
async function buscarOrcamento(db, id, { inicio, fim }, usuarioId) {
  const { rows } = await db.query(`${SQL_ORCAMENTOS} WHERE o.id = $3 AND o.usuario_id = $4`, [inicio, fim, id, usuarioId]);
  return rows[0] ? mapOrcamento(rows[0]) : null;
}

/**
 * O banco ja barra categoria inexistente/de receita (FK composta) e categoria repetida (UNIQUE).
 * Aqui so damos mensagem e 'campo' melhores do que a traducao generica do handler central.
 */
function traduzConflito(err) {
  if (err.code === '23505' && (err.constraint === 'orcamentos_categoria_uk' || err.constraint === 'orcamentos_usuario_categoria_uk')) {
    return conflict('Esta categoria já possui um orçamento.', 'categoria_id');
  }
  if (err.code === '23503' && err.constraint === 'orcamentos_categoria_fk') {
    return conflict('Categoria inválida: escolha uma categoria de despesa existente.', 'categoria_id');
  }
  return err;
}

// GET /api/orcamentos?mes=AAAA-MM
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const intervalo = intervaloDaQuery(req);
    res.json(await listarOrcamentos(pool, intervalo, req.sessao.id));
  }),
);

// POST /api/orcamentos { categoria_id, limite }
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const corpo = req.body ?? {};
    const categoriaId = idOpcional(corpo.categoria_id, 'categoria_id');
    if (categoriaId === null) throw badRequest('"categoria_id" é obrigatório.', 'categoria_id');
    const limite = dinheiro(corpo.limite, 'limite');

    const intervalo = intervaloDaQuery(req);

    const orcamento = await withTransaction(async (client) => {
      let id;
      try {
        const categoria = await client.query(
          `SELECT 1 FROM categorias WHERE id = $1 AND tipo = 'despesa' AND usuario_id = $2`,
          [categoriaId, req.sessao.id],
        );
        if (!categoria.rowCount) throw badRequest('Categoria de despesa inválida para este usuário.', 'categoria_id');
        const { rows } = await client.query(
          `INSERT INTO orcamentos (usuario_id, categoria_id, limite) VALUES ($1, $2, $3) RETURNING id`,
          [req.sessao.id, categoriaId, limite],
        );
        id = rows[0].id;
      } catch (err) {
        throw traduzConflito(err);
      }
      return buscarOrcamento(client, id, intervalo, req.sessao.id);
    });

    res.status(201).json(orcamento);
  }),
);

// PUT /api/orcamentos/:id { limite, ativo? }
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const corpo = req.body ?? {};
    const limite = dinheiro(corpo.limite, 'limite');
    // ausente = mantem o valor atual; presente = alterna.
    const ativo =
      corpo.ativo === undefined || corpo.ativo === null || corpo.ativo === ''
        ? null
        : booleano(corpo.ativo);

    const intervalo = intervaloDaQuery(req);

    const orcamento = await withTransaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE orcamentos
            SET limite = $1::numeric,
                ativo  = COALESCE($2::boolean, ativo)
          WHERE id = $3 AND usuario_id = $4`,
        [limite, ativo, id, req.sessao.id],
      );
      if (rowCount === 0) throw notFound('Orçamento não encontrado.');
      return buscarOrcamento(client, id, intervalo, req.sessao.id);
    });

    res.json(orcamento);
  }),
);

// DELETE /api/orcamentos/:id
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const { rowCount } = await pool.query('DELETE FROM orcamentos WHERE id = $1 AND usuario_id = $2', [id, req.sessao.id]);
    if (rowCount === 0) throw notFound('Orçamento não encontrado.');
    res.status(204).end();
  }),
);

export default router;
