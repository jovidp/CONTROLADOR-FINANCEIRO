import { Router } from 'express';
import { pool, withTransaction } from '../db.js';
import {
  asyncHandler,
  badRequest,
  booleano,
  conflict,
  data as validaData,
  dinheiro,
  idParam,
  notFound,
  texto,
} from '../http.js';

const router = Router();

const round1 = (n) => Math.round((n + Number.EPSILON) * 10) / 10;
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Mesma regra de categorias.js e contas.js: a cor so pode ser hexadecimal.
// Sem isso, texto arbitrario ('red;--z:1') era gravado cru e a interface trocava
// silenciosamente pela cor padrao, em vez de o usuario receber um 400.
const RE_COR = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

/**
 * Cor e´ sempre opcional no contrato; ausente = mantem/usa o default do banco.
 *
 * Chama-se `validaCor`, e nao `cor`, porque os handlers declaram um `const cor` local
 * -- e esse const SOMBREAVA a funcao, deixando-a inalcancavel. A validacao existia no
 * arquivo, parecia certa na leitura, e nunca rodava: `POST /api/metas` com
 * {"cor":"red;--z:1"} gravava o texto cru e devolvia 201 em vez de 400.
 */
function validaCor(valor) {
  const s = texto(valor, 'cor', { obrigatorio: false, max: 7 });
  if (s === null) return null;
  if (!RE_COR.test(s)) throw badRequest('"cor" deve ser um hexadecimal como #4f46e5.', 'cor');
  return s;
}

/** 'AAAA-MM-DD' de hoje no fuso LOCAL (toISOString adiantaria o dia em fusos negativos). */
function hoje() {
  const agora = new Date();
  const mes = String(agora.getMonth() + 1).padStart(2, '0');
  const dia = String(agora.getDate()).padStart(2, '0');
  return `${agora.getFullYear()}-${mes}-${dia}`;
}

/**
 * O validador 'dinheiro' de http.js rejeita negativos, mas um aporte negativo e um
 * resgate legitimo. Aqui so o zero e proibido (o banco tambem barra: CHECK valor <> 0).
 */
function valorAporte(valor) {
  if (valor === undefined || valor === null || valor === '') {
    throw badRequest('"valor" é obrigatório.', 'valor');
  }
  const n = Number(valor);
  if (!Number.isFinite(n)) throw badRequest('"valor" deve ser um número.', 'valor');
  const arredondado = round2(n);
  if (arredondado === 0) {
    throw badRequest('"valor" não pode ser zero: use positivo para aportar ou negativo para resgatar.', 'valor');
  }
  if (Math.abs(arredondado) > 999_999_999.99) throw badRequest('"valor" é grande demais.', 'valor');
  return arredondado;
}

// FILTER (WHERE a.id IS NOT NULL) evita o [null] que o json_agg produziria
// para uma meta sem aportes (o LEFT JOIN gera uma linha com a.* nulo).
const SQL_METAS = `
  SELECT m.id,
         m.nome,
         m.valor_alvo,
         m.prazo,
         m.cor,
         m.icone,
         m.concluida,
         COALESCE(SUM(a.valor), 0) AS guardado,
         COALESCE(
           json_agg(
             json_build_object('id', a.id, 'valor', a.valor, 'data', a.data, 'observacao', a.observacao)
             ORDER BY a.data DESC, a.id DESC
           ) FILTER (WHERE a.id IS NOT NULL),
           '[]'
         ) AS aportes
    FROM metas m
    LEFT JOIN meta_aportes a ON a.meta_id = m.id
`;

function mapMeta(row) {
  const valorAlvo = Number(row.valor_alvo);
  const guardado = round2(Number(row.guardado));
  // resgates podem levar o guardado abaixo de zero; restante e percentual ficam ancorados
  // em 0..100 para nao quebrar barras de progresso na interface.
  const percentual = valorAlvo > 0 ? Math.min(Math.max(round1((guardado / valorAlvo) * 100), 0), 100) : 0;

  return {
    id: row.id,
    nome: row.nome,
    valor_alvo: valorAlvo,
    prazo: row.prazo,
    cor: row.cor,
    icone: row.icone,
    concluida: row.concluida,
    guardado,
    restante: round2(Math.max(valorAlvo - guardado, 0)),
    percentual,
    aportes: (row.aportes ?? []).map((a) => ({
      id: a.id,
      valor: Number(a.valor),
      data: a.data,
      observacao: a.observacao,
    })),
  };
}

async function listarMetas(db, usuarioId) {
  // O contrato nao fixa a ordem: pendentes primeiro, depois as de prazo mais proximo.
  const { rows } = await db.query(
    `${SQL_METAS} WHERE m.usuario_id = $1 GROUP BY m.id ORDER BY m.concluida ASC, m.prazo ASC NULLS LAST, m.id DESC`,
    [usuarioId],
  );
  return rows.map(mapMeta);
}

async function buscarMeta(db, id, usuarioId) {
  const { rows } = await db.query(`${SQL_METAS} WHERE m.id = $1 AND m.usuario_id = $2 GROUP BY m.id`, [id, usuarioId]);
  return rows[0] ? mapMeta(rows[0]) : null;
}

/** Reavalia 'concluida' a partir da soma real dos aportes (nos dois sentidos). */
async function reavaliarConcluida(db, id, usuarioId) {
  await db.query(
    `UPDATE metas m
        SET concluida = COALESCE((SELECT SUM(a.valor) FROM meta_aportes a WHERE a.meta_id = m.id), 0) >= m.valor_alvo
      WHERE m.id = $1 AND m.usuario_id = $2`,
    [id, usuarioId],
  );
}

function traduzConflito(err) {
  if (err.code === '23505' && (err.constraint === 'metas_nome_uk' || err.constraint === 'metas_usuario_nome_uk')) {
    return conflict('Já existe uma meta com esse nome.', 'nome');
  }
  return err;
}

// GET /api/metas
router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json(await listarMetas(pool, req.sessao.id));
  }),
);

// POST /api/metas { nome, valor_alvo, prazo?, cor?, icone? }
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const corpo = req.body ?? {};
    const nome = texto(corpo.nome, 'nome');
    const valorAlvo = dinheiro(corpo.valor_alvo, 'valor_alvo');
    const prazo = validaData(corpo.prazo, 'prazo', { obrigatorio: false });
    const cor = validaCor(corpo.cor);
    const icone = texto(corpo.icone, 'icone', { obrigatorio: false, max: 20 });

    // Colunas vem desta whitelist fixa (nunca do corpo); cor/icone so entram quando
    // informados, para preservar o DEFAULT do banco.
    const colunas = ['usuario_id', 'nome', 'valor_alvo', 'prazo'];
    const valores = [req.sessao.id, nome, valorAlvo, prazo];
    if (cor !== null) {
      colunas.push('cor');
      valores.push(cor);
    }
    if (icone !== null) {
      colunas.push('icone');
      valores.push(icone);
    }
    const placeholders = valores.map((_, i) => `$${i + 1}`).join(', ');

    const meta = await withTransaction(async (client) => {
      let id;
      try {
        const { rows } = await client.query(
          `INSERT INTO metas (${colunas.join(', ')}) VALUES (${placeholders}) RETURNING id`,
          valores,
        );
        id = rows[0].id;
      } catch (err) {
        throw traduzConflito(err);
      }
      return buscarMeta(client, id, req.sessao.id);
    });

    res.status(201).json(meta);
  }),
);

// PUT /api/metas/:id { nome, valor_alvo, prazo?, cor?, icone?, concluida? }
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const corpo = req.body ?? {};
    const nome = texto(corpo.nome, 'nome');
    const valorAlvo = dinheiro(corpo.valor_alvo, 'valor_alvo');
    const prazo = validaData(corpo.prazo, 'prazo', { obrigatorio: false }); // null limpa o prazo
    const cor = validaCor(corpo.cor);
    const icone = texto(corpo.icone, 'icone', { obrigatorio: false, max: 20 });
    // ausente = mantem o valor atual (COALESCE no SQL)
    const concluida =
      corpo.concluida === undefined || corpo.concluida === null || corpo.concluida === ''
        ? null
        : booleano(corpo.concluida);

    const meta = await withTransaction(async (client) => {
      let rowCount;
      try {
        ({ rowCount } = await client.query(
          `UPDATE metas
              SET nome       = $1,
                  valor_alvo = $2::numeric,
                  prazo      = $3::date,
                  cor        = COALESCE($4::text, cor),
                  icone      = COALESCE($5::text, icone),
                  concluida  = COALESCE($6::boolean, concluida)
            WHERE id = $7 AND usuario_id = $8`,
          [nome, valorAlvo, prazo, cor, icone, concluida, id, req.sessao.id],
        ));
      } catch (err) {
        throw traduzConflito(err);
      }
      if (rowCount === 0) throw notFound('Meta não encontrada.');

      // Mudar o valor_alvo muda o que significa "concluida" -- e o front nao manda o
      // campo, entao o COALESCE acima preservava o valor antigo. Sem reavaliar, uma
      // meta de R$ 1.000 ja´ batida e depois reajustada para R$ 5.000 continuava
      // marcada como CONCLUIDA, exibindo 20% de progresso. O POST e o DELETE de aporte
      // ja´ reavaliavam; so´ o PUT nao.
      //
      // So´ quando o cliente NAO mandou `concluida`: quem manda o campo esta´ dizendo
      // explicitamente qual e´ o estado, e reavaliar por cima anularia o pedido dele.
      if (concluida === null) await reavaliarConcluida(client, id, req.sessao.id);
      return buscarMeta(client, id, req.sessao.id);
    });

    res.json(meta);
  }),
);

// DELETE /api/metas/:id  (aportes somem em cascata)
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const { rowCount } = await pool.query('DELETE FROM metas WHERE id = $1 AND usuario_id = $2', [id, req.sessao.id]);
    if (rowCount === 0) throw notFound('Meta não encontrada.');
    res.status(204).end();
  }),
);

// POST /api/metas/:id/aportes { valor, data?, observacao? } -> Meta inteira recalculada
router.post(
  '/:id/aportes',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const corpo = req.body ?? {};
    const valor = valorAporte(corpo.valor);
    const dataAporte = validaData(corpo.data, 'data', { obrigatorio: false }) ?? hoje();
    const observacao = texto(corpo.observacao, 'observacao', { obrigatorio: false });

    const meta = await withTransaction(async (client) => {
      const { rowCount } = await client.query('SELECT 1 FROM metas WHERE id = $1 AND usuario_id = $2 FOR UPDATE', [id, req.sessao.id]);
      if (rowCount === 0) throw notFound('Meta não encontrada.');

      // usuario_id no aporte (migration 012): e´ o que deixa a FK composta
      // (usuario_id, meta_id) -> metas impedir, NO BANCO, um aporte cair na meta de
      // outra pessoa. Antes, a unica barreira era o WHERE do JS.
      await client.query(
        `INSERT INTO meta_aportes (usuario_id, meta_id, valor, data, observacao)
         VALUES ($1, $2, $3::numeric, $4::date, $5)`,
        [req.sessao.id, id, valor, dataAporte, observacao],
      );

      await reavaliarConcluida(client, id, req.sessao.id);
      return buscarMeta(client, id, req.sessao.id);
    });

    res.status(201).json(meta);
  }),
);

// DELETE /api/metas/:id/aportes/:aporteId
router.delete(
  '/:id/aportes/:aporteId',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const aporteId = idParam(req.params.aporteId);

    await withTransaction(async (client) => {
      // o meta_id no WHERE garante 404 se o aporte for de outra meta
      const { rowCount } = await client.query(
        `DELETE FROM meta_aportes
          WHERE id = $1 AND meta_id = $2
            AND EXISTS (SELECT 1 FROM metas m WHERE m.id = meta_id AND m.usuario_id = $3)`,
        [aporteId, id, req.sessao.id],
      );
      if (rowCount === 0) throw notFound('Aporte não encontrado para esta meta.');
      await reavaliarConcluida(client, id, req.sessao.id);
    });

    res.status(204).end();
  }),
);

export default router;
