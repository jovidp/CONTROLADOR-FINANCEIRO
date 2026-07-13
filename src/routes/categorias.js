import express from 'express';
import { query, withTransaction } from '../db.js';
import {
  asyncHandler,
  badRequest,
  conflict,
  enumerado,
  idParam,
  notFound,
  texto,
} from '../http.js';

const router = express.Router();

const TIPOS = ['receita', 'despesa'];

// Espelham os DEFAULT de db/migrations/001_init.sql (nao da para parametrizar DEFAULT no INSERT).
const COR_PADRAO = '#64748b';
const ICONE_PADRAO = '📦';

const RE_COR = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

/** Cor e sempre opcional no contrato; ausente = mantem/usa o default do banco. */
function cor(valor) {
  const s = texto(valor, 'cor', { obrigatorio: false, max: 7 });
  if (s === null) return null;
  if (!RE_COR.test(s)) throw badRequest('"cor" deve ser um hexadecimal como #4f46e5.', 'cor');
  return s;
}

function icone(valor) {
  return texto(valor, 'icone', { obrigatorio: false, max: 16 });
}

/** 'tipo' nao consta no body do PUT, mas o front pode mandar. null = nao mexer. */
function tipoOpcional(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  return enumerado(valor, 'tipo', TIPOS);
}

// ORDER BY sem COLLATE "pt-BR" de proposito: essa collation NAO existe para UTF8
// (COLLATE "pt-BR" derruba a query com 42704). O banco ja usa Portuguese_Brazil.1252
// como collation padrao, entao o ORDER BY simples ja ordena acentos corretamente
// (Agua < Alimentacao < Casa < Eden < Zebra).
const SELECT_CATEGORIA = `
  SELECT c.id, c.nome, c.tipo, c.cor, c.icone,
         EXISTS (SELECT 1 FROM transacoes t WHERE t.categoria_id = c.id AND t.usuario_id = c.usuario_id) AS em_uso
    FROM categorias c
`;

async function buscarPorId(cliente, id, usuarioId) {
  const { rows } = await cliente.query(`${SELECT_CATEGORIA} WHERE c.id = $1 AND c.usuario_id = $2`, [id, usuarioId]);
  if (!rows[0]) throw notFound('Categoria não encontrada.');
  return rows[0];
}

/** UNIQUE (nome, tipo): vira 409 com o campo certo para o modal destacar. */
function traduzNomeDuplicado(err, nome, tipo) {
  if (err.code !== '23505') return err;
  const alvo = tipo ? `uma categoria de ${tipo}` : 'uma categoria desse tipo';
  return conflict(`Já existe ${alvo} chamada "${nome}".`, 'nome');
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const tipo = enumerado(req.query.tipo, 'tipo', TIPOS, { obrigatorio: false });
    const { rows } = await query(
      `${SELECT_CATEGORIA}
        WHERE c.usuario_id = $2 AND ($1::text IS NULL OR c.tipo = $1)
        ORDER BY c.tipo, c.nome`,
      [tipo, req.sessao.id],
    );
    res.json(rows);
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const nome = texto(body.nome, 'nome');
    const tipo = enumerado(body.tipo, 'tipo', TIPOS);
    const corHex = cor(body.cor);
    const ico = icone(body.icone);

    let categoria;
    try {
      categoria = await withTransaction(async (cliente) => {
        const { rows } = await cliente.query(
          `INSERT INTO categorias (usuario_id, nome, tipo, cor, icone)
           VALUES ($1, $2, $3, COALESCE($4::text, $6), COALESCE($5::text, $7))
           RETURNING id`,
          [req.sessao.id, nome, tipo, corHex, ico, COR_PADRAO, ICONE_PADRAO],
        );
        return buscarPorId(cliente, rows[0].id, req.sessao.id);
      });
    } catch (err) {
      throw traduzNomeDuplicado(err, nome, tipo);
    }

    res.status(201).json(categoria);
  }),
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = req.body ?? {};
    const nome = texto(body.nome, 'nome');
    const corHex = cor(body.cor);
    const ico = icone(body.icone);
    const tipo = tipoOpcional(body.tipo);

    let categoria;
    try {
      categoria = await withTransaction(async (cliente) => {
        const { rows: atuais } = await cliente.query(
          'SELECT id, tipo FROM categorias WHERE id = $1 AND usuario_id = $2 FOR UPDATE',
          [id, req.sessao.id],
        );
        const atual = atuais[0];
        if (!atual) throw notFound('Categoria não encontrada.');

        if (tipo !== null && tipo !== atual.tipo) {
          // A FK composta (id, tipo) e ON UPDATE RESTRICT: o banco barraria a troca,
          // mas com mensagem generica. Checamos antes para explicar o motivo real.
          const { rows: uso } = await cliente.query(
            'SELECT count(*)::int AS n FROM transacoes WHERE categoria_id = $1 AND usuario_id = $2',
            [id, req.sessao.id],
          );
          const n = uso[0].n;
          if (n > 0) {
            const plural = n > 1 ? 'existem' : 'existe';
            const substantivo = n > 1 ? 'lançamentos' : 'lançamento';
            throw conflict(
              `Não é possível trocar o tipo: ${plural} ${n} ${substantivo} usando esta categoria.`,
              'tipo',
            );
          }

          // Orcamentos e recorrentes apontam para a mesma chave (id, tipo).
          const { rows: vinculos } = await cliente.query(
            `SELECT EXISTS (SELECT 1 FROM orcamentos o   WHERE o.categoria_id = $1 AND o.usuario_id = $2) AS tem_orcamento,
                    EXISTS (SELECT 1 FROM recorrentes r  WHERE r.categoria_id = $1 AND r.usuario_id = $2) AS tem_recorrente`,
            [id, req.sessao.id],
          );
          if (vinculos[0].tem_orcamento) {
            throw conflict(
              'Não é possível trocar o tipo: existe um orçamento usando esta categoria.',
              'tipo',
            );
          }
          if (vinculos[0].tem_recorrente) {
            throw conflict(
              'Não é possível trocar o tipo: existem lançamentos fixos usando esta categoria.',
              'tipo',
            );
          }
        }

        await cliente.query(
          `UPDATE categorias
              SET nome  = $2,
                  tipo  = COALESCE($3::text, tipo),
                  cor   = COALESCE($4::text, cor),
                  icone = COALESCE($5::text, icone)
            WHERE id = $1 AND usuario_id = $6`,
          [id, nome, tipo, corHex, ico, req.sessao.id],
        );

        return buscarPorId(cliente, id, req.sessao.id);
      });
    } catch (err) {
      throw traduzNomeDuplicado(err, nome, tipo);
    }

    res.json(categoria);
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    // O schema ja resolve os vinculos: transacoes/recorrentes ficam com
    // categoria_id NULL e os orcamentos somem em cascata.
    const { rowCount } = await query('DELETE FROM categorias WHERE id = $1 AND usuario_id = $2', [id, req.sessao.id]);
    if (rowCount === 0) throw notFound('Categoria não encontrada.');
    res.status(204).end();
  }),
);

export default router;
