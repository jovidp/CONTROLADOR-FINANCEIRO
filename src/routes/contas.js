import express from 'express';
import { query, withTransaction } from '../db.js';
import {
  asyncHandler,
  badRequest,
  booleano,
  conflict,
  dinheiro,
  enumerado,
  idParam,
  notFound,
  texto,
} from '../http.js';

const router = express.Router();

const TIPOS = ['corrente', 'poupanca', 'carteira', 'credito', 'investimento'];

// Espelham os DEFAULT de db/migrations/001_init.sql (nao da para parametrizar DEFAULT no INSERT).
const TIPO_PADRAO = 'corrente';
const COR_PADRAO = '#64748b';

const RE_COR = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

function cor(valor) {
  const s = texto(valor, 'cor', { obrigatorio: false, max: 7 });
  if (s === null) return null;
  if (!RE_COR.test(s)) throw badRequest('"cor" deve ser um hexadecimal como #4f46e5.', 'cor');
  return s;
}

function tipoOpcional(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  return enumerado(valor, 'tipo', TIPOS);
}

/**
 * saldo_inicial nao segue a regra "dinheiro sempre positivo": e um saldo de
 * abertura, pode ser zero e pode ser negativo (fatura de cartao, conta no
 * vermelho). Por isso o min do validador e afrouxado.
 */
function saldoInicialOpcional(valor) {
  return dinheiro(valor, 'saldo_inicial', { obrigatorio: false, min: -999_999_999.99 });
}

/** null = campo ausente no body do PUT, entao o valor atual e preservado. */
function arquivadaOpcional(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  return booleano(valor);
}

// Saldos vem prontos da view (saldo_inicial + receitas - despesas).
const SELECT_CONTA = `
  SELECT id, nome, tipo, cor, saldo_inicial, arquivada, receitas, despesas, saldo
    FROM vw_saldo_contas
`;

async function buscarPorId(cliente, id, usuarioId) {
  const { rows } = await cliente.query(`${SELECT_CONTA} WHERE id = $1 AND usuario_id = $2`, [id, usuarioId]);
  if (!rows[0]) throw notFound('Conta não encontrada.');
  return rows[0];
}

/** UNIQUE (nome): vira 409 com o campo certo para o modal destacar. */
function traduzNomeDuplicado(err, nome) {
  if (err.code !== '23505') return err;
  return conflict(`Já existe uma conta chamada "${nome}".`, 'nome');
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const incluirArquivadas = booleano(req.query.incluir_arquivadas, false);
    const { rows } = await query(
      `${SELECT_CONTA}
        WHERE usuario_id = $2 AND ($1::boolean OR NOT arquivada)
        ORDER BY arquivada, nome`,
      [incluirArquivadas, req.sessao.id],
    );
    res.json(rows);
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const nome = texto(body.nome, 'nome');
    const tipo = tipoOpcional(body.tipo);
    const saldoInicial = saldoInicialOpcional(body.saldo_inicial);
    const corHex = cor(body.cor);

    let conta;
    try {
      conta = await withTransaction(async (cliente) => {
        const { rows } = await cliente.query(
          `INSERT INTO contas (usuario_id, nome, tipo, saldo_inicial, cor)
           VALUES ($1, $2, COALESCE($3::text, $6), COALESCE($4::numeric, 0), COALESCE($5::text, $7))
           RETURNING id`,
          [req.sessao.id, nome, tipo, saldoInicial, corHex, TIPO_PADRAO, COR_PADRAO],
        );
        // Rele da view para devolver a conta ja com receitas/despesas/saldo.
        return buscarPorId(cliente, rows[0].id, req.sessao.id);
      });
    } catch (err) {
      throw traduzNomeDuplicado(err, nome);
    }

    res.status(201).json(conta);
  }),
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const body = req.body ?? {};
    const nome = texto(body.nome, 'nome');
    const tipo = tipoOpcional(body.tipo);
    const saldoInicial = saldoInicialOpcional(body.saldo_inicial);
    const corHex = cor(body.cor);
    const arquivada = arquivadaOpcional(body.arquivada);

    let conta;
    try {
      conta = await withTransaction(async (cliente) => {
        const { rowCount } = await cliente.query(
          `UPDATE contas
              SET nome          = $2,
                  tipo          = COALESCE($3::text, tipo),
                  saldo_inicial = COALESCE($4::numeric, saldo_inicial),
                  cor           = COALESCE($5::text, cor),
                  arquivada     = COALESCE($6::boolean, arquivada)
            WHERE id = $1 AND usuario_id = $7`,
          [id, nome, tipo, saldoInicial, corHex, arquivada, req.sessao.id],
        );
        if (rowCount === 0) throw notFound('Conta não encontrada.');
        return buscarPorId(cliente, id, req.sessao.id);
      });
    } catch (err) {
      throw traduzNomeDuplicado(err, nome);
    }

    res.json(conta);
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    // transacoes/recorrentes vinculadas ficam com conta_id NULL (ON DELETE SET NULL).
    const { rowCount } = await query('DELETE FROM contas WHERE id = $1 AND usuario_id = $2', [id, req.sessao.id]);
    if (rowCount === 0) throw notFound('Conta não encontrada.');
    res.status(204).end();
  }),
);

export default router;
