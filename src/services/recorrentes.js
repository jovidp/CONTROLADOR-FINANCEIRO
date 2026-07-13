/**
 * Materializacao de lancamentos recorrentes.
 *
 * Toda a aritmetica de data e feita em UTC e formatada a mao. Nunca usamos
 * toISOString() sobre datas locais nem deixamos o Date "normalizar" um dia
 * que transborda o mes (31/01 + 1 mes viraria 03/03) -- o dia e grampeado
 * no ultimo dia do mes de destino.
 */
import { withTransaction } from '../db.js';
import { data as validaData, enumerado } from '../http.js';

export const FREQUENCIAS = ['diaria', 'semanal', 'mensal', 'anual'];

/** Teto de lancamentos gerados por recorrente em uma unica execucao. */
const TETO_POR_RECORRENTE = 500;

/**
 * Teto de passos do laco de datas. Serve so como rede de seguranca contra um
 * proxima_data absurdamente antigo (cobre ~270 anos de frequencia diaria).
 */
const TETO_ITERACOES = 100_000;

const pad2 = (n) => String(n).padStart(2, '0');

const paraIso = (ano, mes, dia) =>
  `${String(ano).padStart(4, '0')}-${pad2(mes)}-${pad2(dia)}`;

/** Partes numericas de 'AAAA-MM-DD' (ja validado). */
function partes(dataIso) {
  const [ano, mes, dia] = dataIso.split('-').map(Number);
  return { ano, mes, dia };
}

function somarDias(dataIso, dias) {
  const { ano, mes, dia } = partes(dataIso);
  const dt = new Date(Date.UTC(ano, mes - 1, dia));
  dt.setUTCDate(dt.getUTCDate() + dias);
  return paraIso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/**
 * Soma meses grampeando o dia no ultimo dia do mes de destino.
 * 31/01 + 1 mes -> 28/02 (29/02 em bissexto); 29/02 + 12 meses -> 28/02.
 */
export function somarMeses(dataIso, meses) {
  const { ano, mes, dia } = partes(dataIso);
  const total = ano * 12 + (mes - 1) + meses;
  const anoDestino = Math.floor(total / 12);
  const mesDestino = total - anoDestino * 12; // 0..11

  // Dia 0 do mes seguinte = ultimo dia do mes de destino.
  const ultimoDia = new Date(Date.UTC(anoDestino, mesDestino + 1, 0)).getUTCDate();
  return paraIso(anoDestino, mesDestino + 1, Math.min(dia, ultimoDia));
}

/** Proxima ocorrencia a partir de `dataIso` conforme a frequencia. -> 'AAAA-MM-DD' */
export function proximaData(dataIso, frequencia) {
  const iso = validaData(dataIso, 'proxima_data');
  const freq = enumerado(frequencia, 'frequencia', FREQUENCIAS);

  switch (freq) {
    case 'diaria':
      return somarDias(iso, 1);
    case 'semanal':
      return somarDias(iso, 7);
    case 'mensal':
      return somarMeses(iso, 1);
    case 'anual':
      return somarMeses(iso, 12);
    default:
      // Inalcancavel: enumerado() ja barrou qualquer outro valor.
      throw new Error(`Frequência não suportada: ${frequencia}`);
  }
}

/** Data de hoje no fuso LOCAL. toISOString() mudaria o dia em fusos negativos. */
function hojeLocal() {
  const agora = new Date();
  return paraIso(agora.getFullYear(), agora.getMonth() + 1, agora.getDate());
}

/**
 * Gera as transacoes de todas as recorrentes vencidas.
 *
 * Idempotente: ao fim do laco proxima_data sempre passa de hoje (ou a recorrente
 * e desativada), entao uma segunda execucao no mesmo dia nao encontra nada.
 * O SELECT ... FOR UPDATE serializa chamadas concorrentes (boot + API): a segunda
 * espera o COMMIT da primeira e, ja em READ COMMITTED, reavalia o WHERE sobre a
 * linha atualizada -- que nao satisfaz mais proxima_data <= hoje.
 *
 * @returns {Promise<number>} quantidade de transacoes geradas
 */
export async function processarRecorrentes(usuarioId) {
  const hoje = hojeLocal();

  return withTransaction(async (client) => {
    // ORDER BY id mantem uma ordem de travamento estavel (evita deadlock entre
    // duas execucoes concorrentes).
    const { rows: recorrentes } = await client.query(
      `SELECT id, descricao, valor, tipo, categoria_id, conta_id,
              frequencia, proxima_data, data_fim
        FROM recorrentes
        WHERE usuario_id = $1
          AND ativa = true
          AND proxima_data <= $2
        ORDER BY id
          FOR UPDATE`,
      [usuarioId, hoje],
    );

    let totalGerado = 0;

    for (const rec of recorrentes) {
      // Datas sao strings 'AAAA-MM-DD': comparacao lexicografica == cronologica.
      let proxima = rec.proxima_data;
      let continuaAtiva = true;
      let passos = 0;
      const ocorrencias = [];

      while (proxima <= hoje && passos < TETO_ITERACOES) {
        passos++;

        // Acima do teto paramos de lancar, mas seguimos avancando a data ate
        // ultrapassar hoje -- assim a recorrente volta ao trilho na proxima rodada
        // em vez de ficar presa gerando 500 lancamentos para sempre.
        if (ocorrencias.length < TETO_POR_RECORRENTE) ocorrencias.push(proxima);

        const seguinte = proximaData(proxima, rec.frequencia);

        if (rec.data_fim && seguinte > rec.data_fim) {
          // A serie acabou. O CHECK recorrentes_periodo_ck exige
          // proxima_data <= data_fim, entao `proxima` fica na ultima ocorrencia
          // materializada (inofensivo: a linha sai do filtro por ativa = false).
          continuaAtiva = false;
          break;
        }
        proxima = seguinte;
      }

      if (ocorrencias.length > 0) {
        const { rowCount } = await client.query(
          `INSERT INTO transacoes
             (usuario_id, descricao, valor, tipo, data, categoria_id, conta_id, recorrente_id)
             SELECT $1, $2, $3, $4, d, $5, $6, $7
             FROM unnest($8::date[]) AS d`,
          [
            usuarioId,
            rec.descricao,
            rec.valor,
            rec.tipo,
            rec.categoria_id,
            rec.conta_id,
            rec.id,
            ocorrencias,
          ],
        );
        totalGerado += rowCount;
      }

      await client.query(
        `UPDATE recorrentes SET proxima_data = $1, ativa = $2 WHERE id = $3 AND usuario_id = $4`,
        [proxima, continuaAtiva, rec.id, usuarioId],
      );
    }

    return totalGerado;
  });
}
