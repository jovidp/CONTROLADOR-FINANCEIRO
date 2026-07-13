/**
 * Tipos de conta do usuario (corrente, poupanca, cartao... e o que ele inventar).
 *
 * Cada tipo tem uma CHAVE estavel e um ROTULO editavel. contas.tipo guarda a chave,
 * e a FK composta (usuario_id, tipo) -> tipos_conta (usuario_id, chave) garante que
 * nenhuma conta aponte para um tipo que nao existe. Por isso a chave e´ imutavel:
 * renomear "Carteira" para "Dinheiro vivo" mexe so´ no rotulo e nenhuma conta precisa
 * ser reescrita.
 */
import express from 'express';
import { query, withTransaction } from '../db.js';
import { asyncHandler, badRequest, conflict, idParam, notFound, texto } from '../http.js';

const router = express.Router();

const ICONE_PADRAO = '🏦';

/**
 * "Vale-Alimentação!" -> "vale-alimentacao". A chave e´ derivada do rotulo so´ na
 * criacao; dali em diante ela e´ o identificador estavel do tipo.
 */
function chaveDe(rotulo) {
  const chave = rotulo
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // tira os acentos que o NFD separou da letra
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, ''); // o slice pode ter deixado um '-' na ponta

  // So´ sobra vazio se o nome nao tiver nenhuma letra nem numero ("###", "🙂").
  if (!chave) throw badRequest('O nome do tipo precisa ter ao menos uma letra ou número.', 'rotulo');
  return chave;
}

function rotuloDe(valor) {
  return texto(valor, 'rotulo', { max: 40 });
}

function iconeDe(valor) {
  return texto(valor, 'icone', { obrigatorio: false, max: 16 });
}

/** UNIQUE (usuario_id, chave|rotulo): vira 409 com o campo certo para o modal destacar. */
function traduzDuplicado(err, rotulo) {
  if (err.code !== '23505') return err;
  return conflict(`Já existe um tipo de conta chamado "${rotulo}".`, 'rotulo');
}

const SELECT_TIPO = `
  SELECT t.id, t.chave, t.rotulo, t.icone,
         (SELECT count(*)::int FROM contas c
           WHERE c.usuario_id = t.usuario_id AND c.tipo = t.chave) AS contas
    FROM tipos_conta t
`;

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await query(`${SELECT_TIPO} WHERE t.usuario_id = $1 ORDER BY t.rotulo`, [req.sessao.id]);
    res.json(rows);
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const rotulo = rotuloDe(req.body?.rotulo);
    const icone = iconeDe(req.body?.icone);
    const chave = chaveDe(rotulo);

    let tipo;
    try {
      tipo = await withTransaction(async (cliente) => {
        const { rows } = await cliente.query(
          `INSERT INTO tipos_conta (usuario_id, chave, rotulo, icone)
           VALUES ($1, $2, $3, COALESCE($4::text, $5))
           RETURNING id`,
          [req.sessao.id, chave, rotulo, icone, ICONE_PADRAO],
        );
        const { rows: lidos } = await cliente.query(`${SELECT_TIPO} WHERE t.id = $1 AND t.usuario_id = $2`, [
          rows[0].id, req.sessao.id,
        ]);
        return lidos[0];
      });
    } catch (err) {
      throw traduzDuplicado(err, rotulo);
    }

    res.status(201).json(tipo);
  }),
);

// A chave nao entra no PUT: ela e´ o que as contas guardam.
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const rotulo = rotuloDe(req.body?.rotulo);
    const icone = iconeDe(req.body?.icone);

    let tipo;
    try {
      tipo = await withTransaction(async (cliente) => {
        const { rowCount } = await cliente.query(
          `UPDATE tipos_conta
              SET rotulo = $2,
                  icone  = COALESCE($3::text, icone)
            WHERE id = $1 AND usuario_id = $4`,
          [id, rotulo, icone, req.sessao.id],
        );
        if (rowCount === 0) throw notFound('Tipo de conta não encontrado.');

        const { rows } = await cliente.query(`${SELECT_TIPO} WHERE t.id = $1 AND t.usuario_id = $2`, [
          id, req.sessao.id,
        ]);
        return rows[0];
      });
    } catch (err) {
      throw traduzDuplicado(err, rotulo);
    }

    res.json(tipo);
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);

    await withTransaction(async (cliente) => {
      const { rows } = await cliente.query(
        `${SELECT_TIPO} WHERE t.id = $1 AND t.usuario_id = $2`,
        [id, req.sessao.id],
      );
      const tipo = rows[0];
      if (!tipo) throw notFound('Tipo de conta não encontrado.');

      // Apagar um tipo em uso deixaria contas apontando para o nada. A FK ja´ barraria
      // (ON DELETE RESTRICT), mas um 409 explicando QUANTAS contas usam e´ mais util
      // que o erro cru do banco.
      if (tipo.contas > 0) {
        throw conflict(
          `"${tipo.rotulo}" está em uso por ${tipo.contas} conta(s). Troque o tipo dessas contas antes de excluir.`,
          'id',
        );
      }

      // Ficar com ZERO tipos e´ um beco sem saida: sem nenhum tipo nao da´ para criar
      // conta nenhuma (contas.tipo tem FK para tipos_conta), e a tela de nova conta
      // abre com o select vazio. Sempre sobra pelo menos um.
      const { rows: [{ total }] } = await cliente.query(
        'SELECT count(*)::int AS total FROM tipos_conta WHERE usuario_id = $1',
        [req.sessao.id],
      );
      if (total <= 1) {
        throw conflict(
          'Este é o seu último tipo de conta. Crie outro antes de excluir este — sem nenhum tipo, não seria possível criar contas.',
          'id',
        );
      }

      await cliente.query('DELETE FROM tipos_conta WHERE id = $1 AND usuario_id = $2', [id, req.sessao.id]);
    });

    res.status(204).end();
  }),
);

export default router;
