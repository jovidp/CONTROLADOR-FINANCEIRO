/**
 * Liga/desliga a pagina de manutencao na mao.
 *
 *   npm run manutencao:on  -- "Trocando o HD do servidor"
 *   npm run manutencao:off
 *   npm run manutencao        (mostra o estado)
 *
 * Os scripts destrutivos (backup, migrate, limpar, reset) ja´ ligam e desligam
 * sozinhos -- isto aqui e´ para a manutencao que voce faz FORA deles.
 *
 * Nao fala com o banco: so´ escreve o manutencao.flag, que o servidor no ar le´ a
 * cada requisicao. Nao precisa reiniciar nada, o efeito e´ imediato.
 */
import { estado, ligar, desligar } from '../manutencao.js';

const acao = (process.argv[2] || 'status').toLowerCase();
const motivo = process.argv.slice(3).join(' ').trim();

function mostrar() {
  const atual = estado();
  if (!atual) {
    console.log('\n  O app está NO AR (sem manutenção).\n');
    return;
  }
  console.log('\n  O app está EM MANUTENÇÃO.');
  console.log(`  Motivo: ${atual.motivo}`);
  if (atual.desde) console.log(`  Desde:  ${new Date(atual.desde).toLocaleString('pt-BR')}`);
  console.log('\n  Para liberar: npm run manutencao:off\n');
}

switch (acao) {
  case 'on':
    ligar(motivo || 'Manutenção em andamento. Já voltamos.');
    console.log('\n  = app EM MANUTENÇÃO. Quem abrir o endereço vê a página de aviso.');
    console.log(`  Motivo: ${motivo || 'Manutenção em andamento. Já voltamos.'}`);
    console.log('\n  Para liberar: npm run manutencao:off\n');
    break;

  case 'off':
    desligar();
    console.log('\n  = app LIBERADO. A página de manutenção some sozinha em até 5s.\n');
    break;

  default:
    mostrar();
}
