import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import {
  asyncHandler,
  badRequest,
  notFound,
  texto,
  dinheiro,
  data as validaData,
  enumerado,
  idOpcional,
  idParam,
} from '../http.js';
import { montarParcelas } from '../services/parcelas.js';

const router = Router();

const TIPOS = ['receita', 'despesa'];
const MIN_PARCELAS = 2;
const MAX_PARCELAS = 120;

const SELECT_PARCELAMENTO = `
  SELECT p.id,
         p.descricao,
         p.valor_total,
         p.total_parcelas,
         p.tipo,
         p.data_primeira,
         p.observacao,
         p.categoria_id,
         cat.nome  AS categoria_nome,
         cat.cor   AS categoria_cor,
         cat.icone AS categoria_icone,
         p.conta_id,
         con.nome  AS conta_nome,
         -- Quanto ja´ passou: parcela vencida e´ a que tem data <= hoje.
         (SELECT count(*)::int FROM transacoes t
           WHERE t.parcelamento_id = p.id AND t.usuario_id = p.usuario_id AND t.data <= CURRENT_DATE) AS parcelas_pagas,
         (SELECT COALESCE(SUM(t.valor), 0) FROM transacoes t
           WHERE t.parcelamento_id = p.id AND t.usuario_id = p.usuario_id AND t.data > CURRENT_DATE)  AS restante
    FROM parcelamentos p
    LEFT JOIN categorias cat ON cat.id = p.categoria_id AND cat.usuario_id = p.usuario_id
    LEFT JOIN contas    con ON con.id = p.conta_id AND con.usuario_id = p.usuario_id
`;

function lerCorpo(body) {
  const totalParcelas = Number(body.total_parcelas);
  if (!Number.isInteger(totalParcelas) || totalParcelas < MIN_PARCELAS || totalParcelas > MAX_PARCELAS) {
    throw badRequest(
      `"total_parcelas" deve ser um número inteiro entre ${MIN_PARCELAS} e ${MAX_PARCELAS}.`,
      'total_parcelas',
    );
  }

  const valorTotal = dinheiro(body.valor_total, 'valor_total');

  // Com 1 centavo em 3x a ultima parcela ficaria em zero, e o banco rejeita
  // (valor > 0). Melhor barrar aqui, com uma mensagem que explica o motivo.
  if (Math.round(valorTotal * 100) < totalParcelas) {
    throw badRequest(
      `O valor total é pequeno demais para ${totalParcelas} parcelas (daria menos de um centavo por parcela).`,
      'valor_total',
    );
  }

  return {
    descricao: texto(body.descricao, 'descricao', { max: 200 }),
    valor_total: valorTotal,
    total_parcelas: totalParcelas,
    tipo: enumerado(body.tipo, 'tipo', TIPOS),
    data_primeira: validaData(body.data_primeira, 'data_primeira'),
    categoria_id: idOpcional(body.categoria_id, 'categoria_id'),
    conta_id: idOpcional(body.conta_id, 'conta_id'),
    observacao: texto(body.observacao, 'observacao', { obrigatorio: false, max: 1000 }),
  };
}

async function validarVinculos(client, p, usuarioId) {
  if (p.categoria_id !== null) {
    const { rowCount } = await client.query(
      'SELECT 1 FROM categorias WHERE id = $1 AND tipo = $2 AND usuario_id = $3',
      [p.categoria_id, p.tipo, usuarioId],
    );
    if (!rowCount) throw badRequest('Categoria inválida para este usuário e tipo.', 'categoria_id');
  }
  if (p.conta_id !== null) {
    const { rowCount } = await client.query('SELECT 1 FROM contas WHERE id = $1 AND usuario_id = $2', [p.conta_id, usuarioId]);
    if (!rowCount) throw badRequest('Conta inválida para este usuário.', 'conta_id');
  }
}

// GET /api/parcelamentos
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await query(`${SELECT_PARCELAMENTO} WHERE p.usuario_id = $1 ORDER BY p.data_primeira DESC, p.id DESC`, [req.sessao.id]);
    res.json(rows);
  }),
);

// GET /api/parcelamentos/:id  -> a compra + as parcelas dela
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);

    const { rows } = await query(`${SELECT_PARCELAMENTO} WHERE p.id = $1 AND p.usuario_id = $2`, [id, req.sessao.id]);
    if (!rows[0]) throw notFound('Parcelamento não encontrado.');

    const { rows: parcelas } = await query(
      `SELECT id, parcela_num, valor, data, oculta
         FROM transacoes
        WHERE parcelamento_id = $1 AND usuario_id = $2
        ORDER BY parcela_num`,
      [id, req.sessao.id],
    );

    res.json({ ...rows[0], parcelas });
  }),
);

// POST /api/parcelamentos  -> cria a compra E gera as N transacoes de uma vez
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const p = lerCorpo(req.body ?? {});

    const criado = await withTransaction(async (client) => {
      await validarVinculos(client, p, req.sessao.id);
      const { rows } = await client.query(
        `INSERT INTO parcelamentos
           (usuario_id, descricao, valor_total, total_parcelas, tipo, categoria_id, conta_id, data_primeira, observacao)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          req.sessao.id,
          p.descricao,
          p.valor_total,
          p.total_parcelas,
          p.tipo,
          p.categoria_id,
          p.conta_id,
          p.data_primeira,
          p.observacao,
        ],
      );
      const parcelamentoId = rows[0].id;

      const parcelas = montarParcelas({
        valorTotal: p.valor_total,
        totalParcelas: p.total_parcelas,
        dataPrimeira: p.data_primeira,
      });

      // Um INSERT so´ com todas as parcelas: ou a compra inteira entra, ou nada entra.
      const valores = [];
      const params = [];
      for (const parcela of parcelas) {
        const base = params.length;
        params.push(
          req.sessao.id,
          `${p.descricao} (${parcela.numero}/${p.total_parcelas})`,
          parcela.valor,
          p.tipo,
          parcela.data,
          p.categoria_id,
          p.conta_id,
          p.observacao,
          parcelamentoId,
          parcela.numero,
        );
        valores.push(
          `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, ` +
            `$${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`,
        );
      }

      await client.query(
        `INSERT INTO transacoes
           (usuario_id, descricao, valor, tipo, data, categoria_id, conta_id, observacao, parcelamento_id, parcela_num)
         VALUES ${valores.join(', ')}`,
        params,
      );

      const { rows: [completo] } = await client.query(`${SELECT_PARCELAMENTO} WHERE p.id = $1 AND p.usuario_id = $2`, [
        parcelamentoId, req.sessao.id,
      ]);
      return completo;
    });

    res.status(201).json(criado);
  }),
);

// DELETE /api/parcelamentos/:id  -> o ON DELETE CASCADE leva junto as parcelas
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const { rowCount } = await query('DELETE FROM parcelamentos WHERE id = $1 AND usuario_id = $2', [id, req.sessao.id]);
    if (rowCount === 0) throw notFound('Parcelamento não encontrado.');
    res.status(204).end();
  }),
);

export default router;
