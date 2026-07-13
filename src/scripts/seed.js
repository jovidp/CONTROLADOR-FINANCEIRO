/**
 * DESTRUTIVO: popula a conta de UM usuario com dados de exemplo realistas
 * (~8 meses de historico), APAGANDO os lancamentos que ele tiver.
 *
 * Re-executavel: comeca apagando (transacoes, parcelamentos, metas, aportes,
 * orcamentos e recorrentes DAQUELE usuario) e recria tudo do zero, dentro de UMA
 * transacao. Categorias e contas base sao garantidas com ON CONFLICT DO NOTHING.
 *
 * Exige USUARIO=<id> e CONFIRMAR=<nome do banco>. Faz backup antes de apagar.
 *
 * Ate´ a migration 006 este script fazia `DELETE FROM transacoes` SEM WHERE -- e
 * so´ nao apagou a vida financeira de todos os cadastrados porque o `ON CONFLICT
 * (nome)` logo abaixo apontava para uma constraint que a propria 006 tinha dropado:
 * o script quebrava com erro 42P10 e o ROLLBACK salvava os dados. Consertar o
 * ON CONFLICT sem escopar os DELETEs teria sido catastrofico.
 *
 * Datas: aritmetica em UTC e formatacao manual 'AAAA-MM-DD'. Nunca toISOString()
 * sobre data local -- em fuso negativo isso volta o dia.
 */
import { withTransaction, closePool } from '../db.js';
import { exigirConfirmacao, exigirUsuario, encerrarCom } from './guardas.js';
import { backup } from './backup.js';
import { sob } from '../manutencao.js';

const MESES_HISTORICO = 8;
const MESES_NO_VERMELHO = [2, 5]; // indices dentro da janela; nunca o mes corrente

// --- Datas -----------------------------------------------------------

const pad = (n) => String(n).padStart(2, '0');
const iso = (ano, mes, dia) => `${ano}-${pad(mes)}-${pad(dia)}`;
const diasNoMes = (ano, mes) => new Date(Date.UTC(ano, mes, 0)).getUTCDate();

// Hoje no fuso LOCAL, decomposto (nunca via toISOString).
const agora = new Date();
const HOJE = { ano: agora.getFullYear(), mes: agora.getMonth() + 1, dia: agora.getDate() };

/** Janela de meses terminando no mes corrente, em ordem cronologica. */
function janelaDeMeses(qtd) {
  const meses = [];
  for (let i = qtd - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(HOJE.ano, HOJE.mes - 1 - i, 1)); // UTC.month aceita negativo
    meses.push({ ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1 });
  }
  return meses;
}

/**
 * Data dentro do mes. No mes corrente o dia e limitado a hoje: um app de exemplo
 * nao pode nascer com lancamentos no futuro (bagunca dashboard e orcamentos).
 */
function dataNoMes({ ano, mes }, dia) {
  const ehMesCorrente = ano === HOJE.ano && mes === HOJE.mes;
  const limite = ehMesCorrente ? HOJE.dia : diasNoMes(ano, mes);
  return iso(ano, mes, Math.min(Math.max(dia, 1), limite));
}

// --- Aleatorio deterministico (mesmo seed => mesmo dataset) -----------

let semente = 20260713 >>> 0;
function rnd() {
  semente = (semente + 0x6d2b79f5) >>> 0;
  let t = Math.imul(semente ^ (semente >>> 15), 1 | semente);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const dinheiro = (min, max) => Math.round((min + rnd() * (max - min)) * 100) / 100;
const inteiro = (min, max) => Math.floor(min + rnd() * (max - min + 1));
const sorteia = (lista) => lista[inteiro(0, lista.length - 1)];
const chance = (p) => rnd() < p;

// --- Dados base ------------------------------------------------------

// saldo_inicial da Carteira cobre os ~8 meses de gastos em dinheiro abaixo:
// nao existe transferencia entre contas no modelo, entao um saldo_inicial baixo
// deixaria a conta no negativo -- feio para um app de demonstracao.
const CONTAS_EXTRA = [
  { nome: 'Poupança', tipo: 'poupanca', saldo_inicial: 5200.0, cor: '#0ea5e9' },
  { nome: 'Carteira', tipo: 'carteira', saldo_inicial: 1800.0, cor: '#f59e0b' },
];

const MERCADOS = ['Supermercado Extra', 'Assaí Atacadista', 'Mercado do bairro', 'Hortifruti da esquina'];
const RESTAURANTES = ['Almoço no restaurante', 'iFood — jantar', 'Padaria', 'Cafeteria', 'Pizza com a família'];
const LAZER = ['Cinema', 'Bar com os amigos', 'Show', 'Parque aquático', 'Livraria'];
const COMPRAS = ['Roupas', 'Tênis novo', 'Presente de aniversário', 'Utensílios de cozinha'];
const TRANSPORTE_APP = ['Uber para o trabalho', 'Corrida de app', 'Bilhete único'];

/** Monta a lista completa de transacoes dos ~8 meses. */
function gerarTransacoes(meses) {
  const txs = [];
  const add = (mesRef, dia, descricao, valor, tipo, categoria, conta = 'Conta Corrente', observacao = null) => {
    txs.push({ data: dataNoMes(mesRef, dia), descricao, valor, tipo, categoria, conta, observacao });
  };

  meses.forEach((m, idx) => {
    // --- receitas ---
    add(m, 5, 'Salário', 7200.0, 'receita', 'Salário');

    if ([1, 3, 5, 6].includes(idx)) {
      add(m, inteiro(12, 26), 'Freelance — projeto web', dinheiro(900, 2600), 'receita', 'Freelance');
    }
    if ([2, 4, 6, 7].includes(idx)) {
      add(m, 1, 'Rendimento do CDB', dinheiro(120, 420), 'receita', 'Investimentos', 'Poupança');
    }

    // --- despesas fixas ---
    add(m, 10, 'Aluguel', 1850.0, 'despesa', 'Moradia');
    add(m, 15, 'Conta de luz', dinheiro(118, 235), 'despesa', 'Moradia');
    add(m, 16, 'Conta de água', dinheiro(58, 96), 'despesa', 'Moradia');
    add(m, 12, 'Internet 500MB', 99.9, 'despesa', 'Contas & Taxas');
    add(m, 18, 'Celular pré-pago', dinheiro(45, 69), 'despesa', 'Contas & Taxas');
    add(m, 8, 'Plano de saúde', 328.4, 'despesa', 'Saúde');
    add(m, 20, 'Netflix', 44.9, 'despesa', 'Assinaturas');
    add(m, 20, 'Spotify', 21.9, 'despesa', 'Assinaturas');

    // --- alimentacao ---
    add(m, 3, sorteia(MERCADOS), dinheiro(320, 620), 'despesa', 'Alimentação');
    add(m, 18, sorteia(MERCADOS), dinheiro(280, 540), 'despesa', 'Alimentação');
    for (let i = 0; i < inteiro(2, 3); i++) {
      const conta = chance(0.4) ? 'Carteira' : 'Conta Corrente';
      add(m, inteiro(2, 28), sorteia(RESTAURANTES), dinheiro(28, 135), 'despesa', 'Alimentação', conta);
    }

    // --- transporte ---
    add(m, 7, 'Combustível', dinheiro(160, 290), 'despesa', 'Transporte');
    add(m, 22, 'Combustível', dinheiro(150, 275), 'despesa', 'Transporte');
    for (let i = 0; i < inteiro(1, 2); i++) {
      add(m, inteiro(2, 28), sorteia(TRANSPORTE_APP), dinheiro(14, 60), 'despesa', 'Transporte', 'Carteira');
    }

    // --- variaveis ---
    add(m, inteiro(5, 27), sorteia(LAZER), dinheiro(40, 220), 'despesa', 'Lazer');
    if (chance(0.45)) add(m, inteiro(3, 27), sorteia(COMPRAS), dinheiro(90, 480), 'despesa', 'Compras');
    if (chance(0.5)) add(m, inteiro(3, 27), 'Farmácia', dinheiro(28, 160), 'despesa', 'Saúde');
    if (chance(0.3)) add(m, inteiro(3, 27), 'Curso online', dinheiro(59, 240), 'despesa', 'Educação');
    if (chance(0.3)) add(m, inteiro(3, 27), 'Imprevistos', dinheiro(20, 120), 'despesa', 'Outras despesas');

    // --- meses no vermelho (para o grafico ter variacao) ---
    if (MESES_NO_VERMELHO[0] === idx) {
      add(m, 14, 'Reforma do banheiro', 6400.0, 'despesa', 'Moradia', 'Conta Corrente', 'Gasto extraordinário');
    }
    if (MESES_NO_VERMELHO[1] === idx) {
      add(m, 6, 'Notebook novo', 3400.0, 'despesa', 'Compras', 'Conta Corrente', 'Troca do equipamento de trabalho');
      add(m, 12, 'Pacote de viagem — férias', 4900.0, 'despesa', 'Lazer');
    }
  });

  return txs;
}

// --- Orcamentos ------------------------------------------------------
// O limite e derivado do gasto REAL do mes corrente, para que os status
// (estourado / atencao / ok) apareçam de verdade nas barras de progresso,
// independentemente do dia em que o seed rodar.
// Nao orce "Moradia": o smoke.js cria um orcamento nessa categoria e a
// constraint orcamentos_categoria_uk (1 orcamento por categoria) faria o
// "npm run smoke" quebrar em cima de um banco semeado.
const ORCAMENTOS = [
  { categoria: 'Alimentação', fator: 0.82, padrao: 900 }, // ~122% -> estourado
  { categoria: 'Transporte', fator: 1.18, padrao: 600 }, // ~85%  -> atencao
  { categoria: 'Contas & Taxas', fator: 1.55, padrao: 400 }, // ~65%  -> ok
  { categoria: 'Lazer', fator: 2.6, padrao: 500 }, // ~38%  -> ok
];

// =====================================================================

async function main() {
  exigirConfirmacao('db:seed', [
    'Este comando APAGA os lançamentos de UM usuário e põe dados de exemplo no lugar:',
    '  transacoes, parcelamentos, meta_aportes, metas, orcamentos, recorrentes.',
    'As categorias e as contas são preservadas.',
  ]);

  const usuario = await exigirUsuario('db:seed');
  const uid = usuario.id;

  const meses = janelaDeMeses(MESES_HISTORICO);
  const primeiro = meses[0];
  const ultimo = meses[meses.length - 1];

  const resumo = await sob(`Carregando dados de exemplo para ${usuario.usuario}. Já voltamos.`, async () => {
    await backup('pre-seed');

    return withTransaction(async (client) => {
      console.log(`\n  Limpando os lançamentos de "${usuario.usuario}" (id ${uid}).`);
      console.log('  Categorias e contas são preservadas. Outros usuários não são tocados.\n');

      // parcelamentos entra na lista: o CASCADE vai de parcelamentos -> transacoes,
      // e nao o contrario. Sem ele, sobrariam compras parceladas sem nenhuma parcela.
      await client.query('DELETE FROM transacoes    WHERE usuario_id = $1', [uid]);
      await client.query('DELETE FROM parcelamentos WHERE usuario_id = $1', [uid]);
      await client.query(
        'DELETE FROM meta_aportes WHERE meta_id IN (SELECT id FROM metas WHERE usuario_id = $1)', [uid],
      );
      await client.query('DELETE FROM metas       WHERE usuario_id = $1', [uid]);
      await client.query('DELETE FROM orcamentos  WHERE usuario_id = $1', [uid]);
      await client.query('DELETE FROM recorrentes WHERE usuario_id = $1', [uid]);

      // --- base (o cadastro ja traz o kit padrao; aqui e so garantia, sem duplicar) ---
      // ON CONFLICT (usuario_id, nome): a unique global em `nome` morreu na migration
      // 006, quando duas pessoas passaram a poder ter, cada uma, a sua "Conta Corrente".
      await client.query(
        `INSERT INTO contas (usuario_id, nome, tipo, saldo_inicial, cor)
         VALUES ($1, 'Conta Corrente', 'corrente', 0, '#3b82f6')
         ON CONFLICT (usuario_id, nome) DO NOTHING`,
        [uid],
      );
      // Estas duas contas sao do proprio seed: DO UPDATE para que re-executar
      // reproduza exatamente o mesmo estado (o saldo_inicial precisa bater com
      // os gastos gerados abaixo).
      for (const c of CONTAS_EXTRA) {
        await client.query(
          `INSERT INTO contas (usuario_id, nome, tipo, saldo_inicial, cor) VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (usuario_id, nome) DO UPDATE
             SET tipo = EXCLUDED.tipo, saldo_inicial = EXCLUDED.saldo_inicial, cor = EXCLUDED.cor`,
          [uid, c.nome, c.tipo, c.saldo_inicial, c.cor],
        );
      }

      const { rows: cats } = await client.query(
        'SELECT id, nome, tipo FROM categorias WHERE usuario_id = $1', [uid],
      );
      const { rows: contas } = await client.query(
        'SELECT id, nome FROM contas WHERE usuario_id = $1', [uid],
      );
      const idCategoria = new Map(cats.map((c) => [`${c.tipo}:${c.nome}`, c.id]));
      const idConta = new Map(contas.map((c) => [c.nome, c.id]));

      const buscaCategoria = (tipo, nome) => {
        const id = idCategoria.get(`${tipo}:${nome}`);
        if (!id) throw new Error(`Categoria "${nome}" (${tipo}) não existe para este usuário.`);
        return id;
      };
      const buscaConta = (nome) => {
        const id = idConta.get(nome);
        if (!id) throw new Error(`Conta "${nome}" não existe para este usuário.`);
        return id;
      };

      // --- transacoes ---
      const txs = gerarTransacoes(meses);
      for (const t of txs) {
        await client.query(
          `INSERT INTO transacoes (usuario_id, descricao, valor, tipo, data, categoria_id, conta_id, observacao)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [uid, t.descricao, t.valor, t.tipo, t.data,
            buscaCategoria(t.tipo, t.categoria), buscaConta(t.conta), t.observacao],
        );
      }

      // --- orcamentos (sobre o gasto real do mes corrente) ---
      const inicioMes = iso(HOJE.ano, HOJE.mes, 1);
      const fimMes = iso(HOJE.ano, HOJE.mes, diasNoMes(HOJE.ano, HOJE.mes));
      const { rows: gastos } = await client.query(
        `SELECT categoria_id, SUM(valor) AS gasto
           FROM transacoes
          WHERE usuario_id = $1 AND tipo = 'despesa' AND data >= $2 AND data <= $3
          GROUP BY categoria_id`,
        [uid, inicioMes, fimMes],
      );
      const gastoPorCategoria = new Map(gastos.map((g) => [g.categoria_id, Number(g.gasto)]));

      for (const o of ORCAMENTOS) {
        const catId = buscaCategoria('despesa', o.categoria);
        const gasto = gastoPorCategoria.get(catId) || 0;
        const bruto = gasto > 0 ? gasto * o.fator : o.padrao;
        const limite = Math.max(10, Math.round(bruto / 10) * 10); // arredonda para dezena, nunca zero
        await client.query(
          'INSERT INTO orcamentos (usuario_id, categoria_id, limite) VALUES ($1, $2, $3)',
          [uid, catId, limite],
        );
      }

      // --- metas ---
      const { rows: [reserva] } = await client.query(
        `INSERT INTO metas (usuario_id, nome, valor_alvo, prazo, cor, icone)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [uid, 'Reserva de emergência', 20000.0, iso(HOJE.ano + 1, 6, 30), '#22c55e', '🛡️'],
      );
      const { rows: [viagem] } = await client.query(
        `INSERT INTO metas (usuario_id, nome, valor_alvo, prazo, cor, icone)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [uid, 'Viagem para o Chile', 12000.0, iso(HOJE.ano + 1, 12, 20), '#6366f1', '✈️'],
      );

      let aportes = 0;
      // Reserva: aporte todo mes -> perto de concluir (~85% do alvo).
      for (const m of meses) {
        await client.query(
          `INSERT INTO meta_aportes (usuario_id, meta_id, valor, data, observacao)
           VALUES ($1, $2, $3, $4, $5)`,
          [uid, reserva.id, dinheiro(1900, 2300), dataNoMes(m, 6), 'Aporte mensal automático'],
        );
        aportes++;
      }
      // Viagem: comecou agora -> so os dois ultimos meses.
      for (const m of meses.slice(-2)) {
        await client.query(
          `INSERT INTO meta_aportes (usuario_id, meta_id, valor, data, observacao)
           VALUES ($1, $2, $3, $4, $5)`,
          [uid, viagem.id, dinheiro(550, 750), dataNoMes(m, 25), null],
        );
        aportes++;
      }

      // --- recorrentes ---
      // proxima_data SEMPRE no mes que vem: se caisse hoje ou antes, o
      // processarRecorrentes() do boot ja duplicaria os lancamentos do seed.
      const prox = new Date(Date.UTC(HOJE.ano, HOJE.mes, 1)); // mes seguinte
      const pAno = prox.getUTCFullYear();
      const pMes = prox.getUTCMonth() + 1;

      const recorrentes = [
        ['Salário', 7200.0, 'receita', 'Salário', 'Conta Corrente', 'mensal', iso(pAno, pMes, 5)],
        ['Aluguel', 1850.0, 'despesa', 'Moradia', 'Conta Corrente', 'mensal', iso(pAno, pMes, 10)],
        ['Netflix', 44.9, 'despesa', 'Assinaturas', 'Conta Corrente', 'mensal', iso(pAno, pMes, 20)],
      ];
      for (const [descricao, valor, tipo, categoria, conta, frequencia, proximaData] of recorrentes) {
        await client.query(
          `INSERT INTO recorrentes
             (usuario_id, descricao, valor, tipo, categoria_id, conta_id, frequencia, proxima_data, ativa)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)`,
          [uid, descricao, valor, tipo,
            buscaCategoria(tipo, categoria), buscaConta(conta), frequencia, proximaData],
        );
      }

      const { rows: [tot] } = await client.query(
        `SELECT count(*)::int AS n,
                COALESCE(SUM(valor) FILTER (WHERE tipo = 'receita'), 0) AS receitas,
                COALESCE(SUM(valor) FILTER (WHERE tipo = 'despesa'), 0) AS despesas,
                min(data) AS de, max(data) AS ate
           FROM transacoes
          WHERE usuario_id = $1`,
        [uid],
      );

      return { ...tot, aportes, orcamentos: ORCAMENTOS.length, recorrentes: recorrentes.length };
    });
  });

  const brl = (n) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  console.log(`  + ${resumo.n} transações  (${resumo.de} → ${resumo.ate})`);
  console.log(`  + ${resumo.orcamentos} orçamentos (1 estourado, 1 em atenção)`);
  console.log(`  + 2 metas com ${resumo.aportes} aportes`);
  console.log(`  + ${resumo.recorrentes} recorrentes ativas (próxima data no mês que vem)`);
  console.log(`\n  Receitas: ${brl(resumo.receitas)}   Despesas: ${brl(resumo.despesas)}   Saldo: ${brl(resumo.receitas - resumo.despesas)}`);
  console.log(`  Período coberto: ${MESES_HISTORICO} meses (${pad(primeiro.mes)}/${primeiro.ano} a ${pad(ultimo.mes)}/${ultimo.ano})`);
  console.log(`\nOK: dados de exemplo carregados na conta de "${usuario.usuario}".\n`);
}

main()
  .catch((err) => {
    if (!err.message?.includes('confirmação') && !err.message?.includes('usuário')) {
      console.error('  Nenhum dado foi alterado (a transação sofreu ROLLBACK).');
    }
    encerrarCom(err, 'db:seed');
  })
  .finally(closePool);
