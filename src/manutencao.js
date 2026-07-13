/**
 * Modo de manutencao.
 *
 * Enquanto um script destrutivo roda (backup, migration, limpar, reset), o banco
 * nao pode receber escrita nova pela API: uma transacao gravada no meio de um
 * pg_dump nao entra no backup, e uma gravada no meio de uma migration pode violar
 * a constraint que a migration acabou de criar.
 *
 * O aviso mora num ARQUIVO no disco, e nao numa variavel do processo, de proposito:
 * o script (`npm run db:limpar`) e o servidor sao processos DIFERENTES. Um flag em
 * memoria no script nao seria visto pelo servidor que ja´ esta´ no ar -- que e´
 * justamente quem precisa segurar as requisicoes.
 */
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARQUIVO = path.join(RAIZ, 'manutencao.flag');

/** Estado atual: `null` quando o app esta´ liberado. */
export function estado() {
  if (!existsSync(ARQUIVO)) return null;
  try {
    return JSON.parse(readFileSync(ARQUIVO, 'utf8'));
  } catch {
    // Arquivo corrompido ainda e´ um pedido de manutencao: na duvida, segura.
    return { motivo: 'Manutenção em andamento.', desde: null };
  }
}

export function ligar(motivo = 'Manutenção em andamento.') {
  writeFileSync(ARQUIVO, JSON.stringify({ motivo, desde: new Date().toISOString() }, null, 2));
}

export function desligar() {
  rmSync(ARQUIVO, { force: true });
}

/**
 * Roda `fn` com o app em manutencao, liberando no fim ACONTECA O QUE ACONTECER.
 * Sem o finally, um script que quebrasse no meio deixaria o app travado na tela
 * de manutencao para sempre -- e o unico jeito de sair seria apagar o .flag na mao.
 */
export async function sob(motivo, fn) {
  ligar(motivo);
  try {
    return await fn();
  } finally {
    desligar();
  }
}
