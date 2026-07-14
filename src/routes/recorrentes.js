import express from 'express';
import { query } from '../db.js';
import {
  asyncHandler,
  badRequest,
  booleano,
  data,
  dinheiro,
  enumerado,
  idOpcional,
  idParam,
  notFound,
  texto,
} from '../http.js';
import { FREQUENCIAS, processarRecorrentes } from '../services/recorrentes.js';

const router = express.Router();

const TIPOS = ['receita', 'despesa'];

/**
 * Data limite (2 anos atras) para a proxima ocorrencia de uma recorrente. Uma recorrente
 * comeca perto de hoje ou no futuro; uma proxima_data anos no passado so serviria para
 * fazer o processarRecorrentes iterar dia a dia ate alcancar hoje -- o vetor de DoS que o
 * red-team achou. Aqui e a barreira na ENTRADA; o orcamento do servico e a rede embaixo.
 */
function limiteMinimoProxima() {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 2);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const SELECT_BASE = `
  SELECT r.id, r.descricao, r.valor, r.tipo,
         r.categoria_id,
         c.nome  AS categoria_nome,
         c.cor   AS categoria_cor,
         c.icone AS categoria_icone,
         r.conta_id,
         ct.nome AS conta_nome,
         r.frequencia, r.proxima_data, r.data_fim, r.ativa
    FROM recorrentes r
    LEFT JOIN categorias c  ON c.id  = r.categoria_id AND c.usuario_id = r.usuario_id
    LEFT JOIN contas     ct ON ct.id = r.conta_id AND ct.usuario_id = r.usuario_id
`;

async function buscarPorId(id, usuarioId) {
  const { rows } = await query(`${SELECT_BASE} WHERE r.id = $1 AND r.usuario_id = $2`, [id, usuarioId]);
  return rows[0] ?? null;
}

async function validarVinculos(d, usuarioId) {
  if (d.categoria_id !== null) {
    const { rowCount } = await query(
      'SELECT 1 FROM categorias WHERE id = $1 AND tipo = $2 AND usuario_id = $3',
      [d.categoria_id, d.tipo, usuarioId],
    );
    if (!rowCount) throw badRequest('Categoria inválida para este usuário e tipo.', 'categoria_id');
  }
  if (d.conta_id !== null) {
    const { rowCount } = await query('SELECT 1 FROM contas WHERE id = $1 AND usuario_id = $2', [d.conta_id, usuarioId]);
    if (!rowCount) throw badRequest('Conta inválida para este usuário.', 'conta_id');
  }
}

/** Valida o corpo de POST/PUT. `ativa` so e aceita no PUT. */
function validarCorpo(body, { comAtiva = false } = {}) {
  const descricao = texto(body.descricao, 'descricao');
  const valor = dinheiro(body.valor, 'valor');
  const tipo = enumerado(body.tipo, 'tipo', TIPOS);
  const frequencia = enumerado(body.frequencia, 'frequencia', FREQUENCIAS);
  const proxima_data = data(body.proxima_data, 'proxima_data');
  const data_fim = data(body.data_fim, 'data_fim', { obrigatorio: false });
  const categoria_id = idOpcional(body.categoria_id, 'categoria_id');
  const conta_id = idOpcional(body.conta_id, 'conta_id');

  // Datas 'AAAA-MM-DD' comparam lexicograficamente na ordem cronologica.
  if (proxima_data < limiteMinimoProxima()) {
    throw badRequest('"proxima_data" está muito no passado. Use uma data recente ou futura.', 'proxima_data');
  }
  if (data_fim && data_fim < proxima_data) {
    throw badRequest('"data_fim" deve ser igual ou posterior à próxima data.', 'data_fim');
  }

  // Ausente no PUT = manter o valor atual (resolvido com COALESCE no UPDATE).
  const ativa =
    comAtiva && body.ativa !== undefined && body.ativa !== null && body.ativa !== ''
      ? booleano(body.ativa, true)
      : null;

  return { descricao, valor, tipo, frequencia, proxima_data, data_fim, categoria_id, conta_id, ativa };
}

router.post(
  '/processar',
  asyncHandler(async (req, res) => {
    const gerados = await processarRecorrentes(req.sessao.id);
    res.json({ gerados });
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `${SELECT_BASE} WHERE r.usuario_id = $1 ORDER BY r.ativa DESC, r.proxima_data ASC, r.id ASC`,
      [req.sessao.id],
    );
    res.json(rows);
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const d = validarCorpo(req.body ?? {});
    await validarVinculos(d, req.sessao.id);

    const { rows } = await query(
      `INSERT INTO recorrentes
         (usuario_id, descricao, valor, tipo, categoria_id, conta_id, frequencia, proxima_data, data_fim)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        req.sessao.id,
        d.descricao,
        d.valor,
        d.tipo,
        d.categoria_id,
        d.conta_id,
        d.frequencia,
        d.proxima_data,
        d.data_fim,
      ],
    );

    res.status(201).json(await buscarPorId(rows[0].id, req.sessao.id));
  }),
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const d = validarCorpo(req.body ?? {}, { comAtiva: true });
    await validarVinculos(d, req.sessao.id);

    const { rowCount } = await query(
      `UPDATE recorrentes
          SET descricao    = $1,
              valor        = $2,
              tipo         = $3,
              categoria_id = $4,
              conta_id     = $5,
              frequencia   = $6,
              proxima_data = $7,
              data_fim     = $8,
              ativa        = COALESCE($9::boolean, ativa)
        WHERE id = $10 AND usuario_id = $11`,
      [
        d.descricao,
        d.valor,
        d.tipo,
        d.categoria_id,
        d.conta_id,
        d.frequencia,
        d.proxima_data,
        d.data_fim,
        d.ativa,
        id,
        req.sessao.id,
      ],
    );
    if (rowCount === 0) throw notFound('Recorrente não encontrada.');

    res.json(await buscarPorId(id, req.sessao.id));
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    // As transacoes ja geradas permanecem: a FK e ON DELETE SET NULL.
    const { rowCount } = await query('DELETE FROM recorrentes WHERE id = $1 AND usuario_id = $2', [id, req.sessao.id]);
    if (rowCount === 0) throw notFound('Recorrente não encontrada.');
    res.status(204).end();
  }),
);

export default router;
