import { Router } from 'express';
import { query, withTransaction } from '../db.js';
import {
  asyncHandler,
  badRequest,
  conflict,
  notFound,
  texto,
  dinheiro,
  data as validaData,
  enumerado,
  idOpcional,
  idParam,
  mesParaIntervalo,
} from '../http.js';
import { FREQUENCIAS, proximaData } from '../services/recorrentes.js';

const router = Router();

/**
 * 'transferencia' move dinheiro entre duas contas suas: nao entrou nem saiu do seu
 * patrimonio, entao ela NAO e´ receita nem despesa. Toda soma de dinheiro do sistema
 * (KPIs, evolucao, donut, anual, resumo, gasto do orcamento) filtra por 'receita' ou
 * 'despesa' -- logo a transferencia fica de fora delas por construcao. Ver 011_transferencias.sql.
 */
const TIPOS = ['receita', 'despesa', 'transferencia'];

/**
 * A "natureza" do lancamento nao e´ uma coluna: ela e´ DERIVADA de quem criou a
 * transacao. Fixo e´ o que veio de um recorrente (aluguel, internet), parcelado
 * e´ uma parcela de uma compra, e avulso e´ o resto -- o gasto do dia a dia.
 * Derivar evita ter duas fontes de verdade que podem se contradizer.
 */
const NATUREZAS = ['avulso', 'fixo', 'parcelado'];

const NATUREZA_SQL = `
  CASE WHEN t.parcelamento_id IS NOT NULL THEN 'parcelado'
       WHEN t.recorrente_id   IS NOT NULL THEN 'fixo'
       ELSE 'avulso'
  END`;

/** Como tratar os lancamentos que o usuario escondeu. */
const OCULTAS = ['excluir', 'incluir', 'apenas'];

/** Colunas de ordenacao permitidas -> expressao SQL. Nada fora daqui entra na query. */
const ORDENAR = {
  data: 't.data',
  valor: 't.valor',
  descricao: 't.descricao',
};

const DIRECAO = { asc: 'ASC', desc: 'DESC' };

const LIMITE_PADRAO = 100;
const LIMITE_MAX = 500;

/**
 * Normaliza acentos em SQL puro (o schema nao instala a extensao unaccent).
 * lower() ja resolve a maiuscula acentuada, mas mapeamos os dois casos por seguranca.
 */
const semAcento = (expr) =>
  `translate(lower(${expr}), ` +
  `'áàâãäéèêëíìîïóòôõöúùûüçñÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇÑ', ` +
  `'aaaaaeeeeiiiiooooouuuucnaaaaaeeeeiiiiooooouuuucn')`;

/** Escapa os curingas do LIKE para que % e _ digitados pelo usuario sejam literais. */
const escapaLike = (s) => s.replace(/[\\%_]/g, '\\$&');

const SELECT_TRANSACAO = `
  SELECT t.id,
         t.descricao,
         t.valor,
         t.tipo,
         t.data,
         t.categoria_id,
         cat.nome  AS categoria_nome,
         cat.cor   AS categoria_cor,
         cat.icone AS categoria_icone,
         t.conta_id,
         con.nome  AS conta_nome,
         con.cor   AS conta_cor,
         t.conta_destino_id,
         dst.nome  AS conta_destino_nome,
         dst.cor   AS conta_destino_cor,
         t.observacao,
         t.recorrente_id,
         t.oculta,
         t.parcelamento_id,
         t.parcela_num,
         par.total_parcelas,
         par.valor_total AS parcelamento_total,
         ${NATUREZA_SQL} AS natureza
    FROM transacoes t
    LEFT JOIN categorias    cat ON cat.id = t.categoria_id AND cat.usuario_id = t.usuario_id
    LEFT JOIN contas        con ON con.id = t.conta_id AND con.usuario_id = t.usuario_id
    LEFT JOIN contas        dst ON dst.id = t.conta_destino_id AND dst.usuario_id = t.usuario_id
    LEFT JOIN parcelamentos par ON par.id = t.parcelamento_id AND par.usuario_id = t.usuario_id
`;

/** Inteiro nao-negativo vindo da query string. */
function inteiro(valor, campo, { padrao = 0, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (valor === undefined || valor === null || valor === '') return padrao;
  const n = Number(valor);
  if (!Number.isInteger(n) || n < min) throw badRequest(`"${campo}" inválido.`, campo);
  return Math.min(n, max);
}

/** Monta as condicoes do WHERE (compartilhadas pela pagina e pela agregacao). */
function montaFiltros(q, usuarioId) {
  const cond = [];
  const params = [usuarioId];
  cond.push('t.usuario_id = $1');

  let de = validaData(q.de, 'de', { obrigatorio: false });
  let ate = validaData(q.ate, 'ate', { obrigatorio: false });

  // "mes" e apenas um atalho: se "de"/"ate" vierem juntos, eles ganham.
  if (q.mes !== undefined && q.mes !== '') {
    const intervalo = mesParaIntervalo(q.mes);
    de = de ?? intervalo.inicio;
    ate = ate ?? intervalo.fim;
  }

  if (de) {
    params.push(de);
    cond.push(`t.data >= $${params.length}`);
  }
  if (ate) {
    params.push(ate);
    cond.push(`t.data <= $${params.length}`);
  }

  const tipo = enumerado(q.tipo, 'tipo', TIPOS, { obrigatorio: false });
  if (tipo) {
    params.push(tipo);
    cond.push(`t.tipo = $${params.length}`);
  }

  const categoriaId = idOpcional(q.categoria_id, 'categoria_id');
  if (categoriaId !== null) {
    params.push(categoriaId);
    cond.push(`t.categoria_id = $${params.length}`);
  }

  // A conta filtrada casa dos DOIS lados: uma transferencia que ENTRA nela tem a
  // conta em conta_destino_id, nao em conta_id -- e ela precisa aparecer no extrato
  // da conta, senao o dinheiro chega e some da vista.
  const contaId = idOpcional(q.conta_id, 'conta_id');
  if (contaId !== null) {
    params.push(contaId);
    cond.push(`(t.conta_id = $${params.length} OR t.conta_destino_id = $${params.length})`);
  }

  const busca = texto(q.q, 'q', { obrigatorio: false, max: 200 });
  if (busca) {
    params.push(escapaLike(busca));
    const p = `$${params.length}::text`;
    cond.push(`${semAcento('t.descricao')} LIKE '%' || ${semAcento(p)} || '%' ESCAPE '\\'`);
  }

  // natureza=fixo,parcelado -> so´ essas; o resto some da lista E dos totais.
  // Lista vazia nao vira "WHERE natureza IN ()" (erro de sintaxe): o filtro some.
  if (q.natureza !== undefined && q.natureza !== '') {
    const pedidas = String(q.natureza)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const n of pedidas) enumerado(n, 'natureza', NATUREZAS);

    const unicas = [...new Set(pedidas)];
    if (unicas.length && unicas.length < NATUREZAS.length) {
      const marcadores = unicas.map((n) => {
        params.push(n);
        return `$${params.length}`;
      });
      cond.push(`${NATUREZA_SQL} IN (${marcadores.join(', ')})`);
    }
  }

  // Por padrao o lancamento oculto nao aparece nem soma. A tela pede 'incluir'
  // (para revisar) ou 'apenas' (para achar o que foi escondido e desfazer).
  const ocultas = enumerado(q.ocultas ?? 'excluir', 'ocultas', OCULTAS);
  if (ocultas === 'excluir') cond.push('t.oculta = false');
  if (ocultas === 'apenas') cond.push('t.oculta = true');

  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : '';
  return { where, params };
}

// GET /api/transacoes
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { where, params } = montaFiltros(req.query, req.sessao.id);

    const ordenar = enumerado(req.query.ordenar ?? 'data', 'ordenar', Object.keys(ORDENAR));
    const direcao = enumerado(req.query.direcao ?? 'desc', 'direcao', Object.keys(DIRECAO));
    const limite = inteiro(req.query.limite, 'limite', { padrao: LIMITE_PADRAO, min: 1, max: LIMITE_MAX });
    const offset = inteiro(req.query.offset, 'offset', { padrao: 0, min: 0 });

    // ', t.id DESC' desempata: sem isso a paginacao repete/perde linhas com a mesma data.
    const orderBy = `ORDER BY ${ORDENAR[ordenar]} ${DIRECAO[direcao]}, t.id DESC`;

    // Um lancamento oculto NUNCA soma -- nem quando a lista o revela. Por isso o
    // dinheiro e´ somado sempre com ocultas='excluir', e nao com o filtro da tela:
    // se o modo "mostrar ocultos" o trouxesse de volta para o total, a linha
    // riscada diria uma coisa e o total diria outra, e o painel (que sempre exclui)
    // discordaria dos dois.
    const somas = montaFiltros({ ...req.query, ocultas: 'excluir' }, req.sessao.id);

    // Mesmos filtros, so´ os escondidos: e´ o que o total esta´ deixando de fora.
    const escondidos = montaFiltros({ ...req.query, ocultas: 'apenas' }, req.sessao.id);

    const { itens, contagem, agregado, ocultos } = await withTransaction(async (client) => {
      const pagina = await client.query(
        `${SELECT_TRANSACAO} ${where} ${orderBy} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limite, offset],
      );

      // A contagem acompanha a LISTA (senao a paginacao quebraria); o dinheiro, nao.
      const total = await client.query(
        `SELECT count(*)::int AS n FROM transacoes t ${where}`,
        params,
      );

      const resumo = await client.query(
        `SELECT COALESCE(SUM(t.valor) FILTER (WHERE t.tipo = 'receita'), 0) AS receitas,
                COALESCE(SUM(t.valor) FILTER (WHERE t.tipo = 'despesa'), 0) AS despesas
           FROM transacoes t
           ${somas.where}`,
        somas.params,
      );

      const fora = await client.query(
        `SELECT count(*)::int AS n FROM transacoes t ${escondidos.where}`,
        escondidos.params,
      );

      return {
        itens: pagina.rows,
        contagem: total.rows[0].n,
        agregado: resumo.rows[0],
        ocultos: fora.rows[0].n,
      };
    });

    const receitas = Number(agregado.receitas);
    const despesas = Number(agregado.despesas);

    res.json({
      itens,
      total: contagem,
      ocultos,
      resumo: {
        receitas,
        despesas,
        saldo: Math.round((receitas - despesas) * 100) / 100,
      },
    });
  }),
);

/** Valida o corpo de POST/PUT. O vinculo categoria x tipo e garantido pela FK composta. */
function lerCorpo(body) {
  const t = {
    descricao: texto(body.descricao, 'descricao', { max: 200 }),
    valor: dinheiro(body.valor, 'valor'),
    tipo: enumerado(body.tipo, 'tipo', TIPOS),
    data: validaData(body.data, 'data'),
    categoria_id: idOpcional(body.categoria_id, 'categoria_id'),
    conta_id: idOpcional(body.conta_id, 'conta_id'),
    conta_destino_id: idOpcional(body.conta_destino_id, 'conta_destino_id'),
    observacao: texto(body.observacao, 'observacao', { obrigatorio: false, max: 1000 }),
  };

  if (t.tipo === 'transferencia') {
    // As duas contas sao obrigatorias -- sem uma delas o dinheiro sai de lugar
    // nenhum ou nao chega em lugar nenhum. (Fora da transferencia, conta_id segue
    // opcional, como sempre foi.)
    if (t.conta_id === null) {
      throw badRequest('Escolha a conta de origem da transferência.', 'conta_id');
    }
    if (t.conta_destino_id === null) {
      throw badRequest('Escolha a conta de destino da transferência.', 'conta_destino_id');
    }
    if (t.conta_id === t.conta_destino_id) {
      throw badRequest('A conta de destino precisa ser diferente da de origem.', 'conta_destino_id');
    }
    // Categoria classifica gasto/ganho; um dinheiro que continua sendo seu nao tem
    // o que classificar. Zeramos em vez de recusar: trocar o tipo no formulario ja´
    // preenchido nao deve virar um erro na cara do usuario.
    t.categoria_id = null;
  } else {
    t.conta_destino_id = null;
  }

  return t;
}

async function lerTransacao(client, id, usuarioId) {
  const { rows } = await client.query(`${SELECT_TRANSACAO} WHERE t.id = $1 AND t.usuario_id = $2`, [id, usuarioId]);
  return rows[0];
}

async function validarVinculos(client, t, usuarioId) {
  if (t.categoria_id !== null) {
    const { rowCount } = await client.query(
      'SELECT 1 FROM categorias WHERE id = $1 AND tipo = $2 AND usuario_id = $3',
      [t.categoria_id, t.tipo, usuarioId],
    );
    if (!rowCount) throw badRequest('Categoria inválida para este usuário e tipo.', 'categoria_id');
  }
  if (t.conta_id !== null) {
    const { rowCount } = await client.query('SELECT 1 FROM contas WHERE id = $1 AND usuario_id = $2', [t.conta_id, usuarioId]);
    if (!rowCount) throw badRequest('Conta inválida para este usuário.', 'conta_id');
  }
  // O isolamento por usuario da conta de destino e´ garantido aqui, no JS: nao ha´
  // FK composta (usuario_id, conta_id) no schema -- mesma escolha ja´ feita para conta_id.
  if (t.conta_destino_id !== null) {
    const { rowCount } = await client.query('SELECT 1 FROM contas WHERE id = $1 AND usuario_id = $2', [
      t.conta_destino_id,
      usuarioId,
    ]);
    if (!rowCount) throw badRequest('Conta de destino inválida para este usuário.', 'conta_destino_id');
  }
}

// POST /api/transacoes
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const t = lerCorpo(req.body ?? {});

    const criada = await withTransaction(async (client) => {
      await validarVinculos(client, t, req.sessao.id);
      const { rows } = await client.query(
        `INSERT INTO transacoes
           (usuario_id, descricao, valor, tipo, data, categoria_id, conta_id, conta_destino_id, observacao)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          req.sessao.id,
          t.descricao,
          t.valor,
          t.tipo,
          t.data,
          t.categoria_id,
          t.conta_id,
          t.conta_destino_id,
          t.observacao,
        ],
      );
      return lerTransacao(client, rows[0].id, req.sessao.id);
    });

    res.status(201).json(criada);
  }),
);

// PUT /api/transacoes/:id
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const t = lerCorpo(req.body ?? {});

    const atualizada = await withTransaction(async (client) => {
      await validarVinculos(client, t, req.sessao.id);
      const { rowCount } = await client.query(
        `UPDATE transacoes
            SET descricao = $1,
                valor = $2,
                tipo = $3,
                data = $4,
                categoria_id = $5,
                conta_id = $6,
                conta_destino_id = $7,
                observacao = $8,
                atualizado_em = now()
          WHERE id = $9 AND usuario_id = $10`,
        [
          t.descricao,
          t.valor,
          t.tipo,
          t.data,
          t.categoria_id,
          t.conta_id,
          t.conta_destino_id,
          t.observacao,
          id,
          req.sessao.id,
        ],
      );
      if (rowCount === 0) throw notFound('Transação não encontrada.');
      return lerTransacao(client, id, req.sessao.id);
    });

    res.json(atualizada);
  }),
);

/**
 * PATCH /api/transacoes/:id/oculta  { oculta: true|false }
 *
 * Esconder nao e´ apagar: a linha continua no banco, so´ sai da lista e dos
 * totais. Serve para o gasto que voce nao quer contando na analise (um reembolso,
 * uma compra que nao foi sua) sem perder o registro. Sempre reversivel.
 */
router.patch(
  '/:id/oculta',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const valor = req.body?.oculta;

    if (typeof valor !== 'boolean') {
      throw badRequest('"oculta" deve ser true ou false.', 'oculta');
    }

    const atualizada = await withTransaction(async (client) => {
      const { rowCount } = await client.query(
        'UPDATE transacoes SET oculta = $1, atualizado_em = now() WHERE id = $2 AND usuario_id = $3',
        [valor, id, req.sessao.id],
      );
      if (rowCount === 0) throw notFound('Transação não encontrada.');
      return lerTransacao(client, id, req.sessao.id);
    });

    res.json(atualizada);
  }),
);

/**
 * POST /api/transacoes/:id/fixar  { frequencia? }
 *
 * Transforma um lancamento avulso em FIXO. Como a natureza e´ derivada (fixo = tem
 * recorrente_id), "marcar como fixa" nao pode ser um flag: e´ criar a recorrente que
 * a transacao passa a representar e vincular as duas. Feito numa transacao so´ --
 * uma recorrente orfa geraria lancamentos duplicados todo mes, sem ninguem pedir.
 *
 * A recorrente ja´ nasce apontando para a PROXIMA ocorrencia: a desta transacao ja´
 * existe (e´ ela), e semear proxima_data na data dela faria processarRecorrentes()
 * lancar uma copia no mesmo dia.
 */
router.post(
  '/:id/fixar',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const frequencia = enumerado(req.body?.frequencia ?? 'mensal', 'frequencia', FREQUENCIAS);

    const atualizada = await withTransaction(async (client) => {
      const tx = await lerTransacao(client, id, req.sessao.id);
      if (!tx) throw notFound('Transação não encontrada.');

      if (tx.recorrente_id !== null) {
        throw conflict('Esta transação já é fixa: ela veio de um lançamento recorrente.', 'fixar');
      }
      // Uma parcela nao se repete para sempre -- ela pertence a uma compra que tem fim.
      if (tx.parcelamento_id !== null) {
        throw badRequest('Uma parcela de compra parcelada não pode virar despesa fixa.', 'fixar');
      }
      // `recorrentes` nao tem conta de destino (e o CHECK dela so´ aceita receita/despesa):
      // fixar uma transferencia geraria todo mes um lancamento sem para onde ir. Barramos
      // aqui, com mensagem, em vez de deixar o INSERT abaixo estourar um 23514 generico.
      if (tx.tipo === 'transferencia') {
        throw badRequest('Transferências entre contas ainda não podem virar lançamento fixo.', 'fixar');
      }

      const { rows } = await client.query(
        `INSERT INTO recorrentes
           (usuario_id, descricao, valor, tipo, categoria_id, conta_id, frequencia, proxima_data)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          req.sessao.id,
          tx.descricao,
          tx.valor,
          tx.tipo,
          tx.categoria_id,
          tx.conta_id,
          frequencia,
          proximaData(tx.data, frequencia),
        ],
      );

      await client.query(
        'UPDATE transacoes SET recorrente_id = $1, atualizado_em = now() WHERE id = $2 AND usuario_id = $3',
        [rows[0].id, id, req.sessao.id],
      );

      return lerTransacao(client, id, req.sessao.id);
    });

    res.json(atualizada);
  }),
);

// DELETE /api/transacoes/:id
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id);
    const { rowCount } = await query('DELETE FROM transacoes WHERE id = $1 AND usuario_id = $2', [id, req.sessao.id]);
    if (rowCount === 0) throw notFound('Transação não encontrada.');
    res.status(204).end();
  }),
);

export default router;
