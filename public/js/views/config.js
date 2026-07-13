/**
 * View "Configurações" — contas, estado do banco e comandos úteis.
 *
 * As contas são buscadas na API a cada montagem (e não lidas de state.contas):
 * o saldo muda a cada transação lançada, e uma escrita em transações chama
 * emitir() SEM recarregar a base — o cache do state teria saldo velho.
 *
 * Backup NÃO é feito por aqui: o dado vive no PostgreSQL, então o backup é
 * pg_dump. A seção "Sobre" entrega o comando pronto para copiar.
 */

import { api, ApiError } from '../api.js';
import { carregarBase, emitir, tipoContaPorChave } from '../state.js';
import { el, fmtMoeda, hoje, skeleton, vazio, confirmar, toast } from '../ui.js';
import { formConta, formTipoConta } from '../forms.js';

const COR_SAIDA = 'var(--out, #ef4444)';
const COR_PADRAO = '#64748b';

// Padrões do .env (src/config.js). Só entram no comando de pg_dump quando o
// /api/health não responde — o contrato do health não expõe usuário/host do banco.
const BANCO_PADRAO = 'controlador_financeiro';
const USUARIO_PADRAO = 'fin_app';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// =====================================================================
// Montagem
// =====================================================================

export async function montar(container) {
  if (!container) return;

  skeleton(container, 5);

  // allSettled: o banco fora do ar não pode apagar a tela inteira — é justamente
  // quando o usuário precisa ver o selo vermelho e os comandos para religar.
  const [resContas, resTipos, resHealth] = await Promise.allSettled([
    api.contas.listar({ incluir_arquivadas: true }),
    // Buscado aqui (e não lido de state.tiposConta) pelo mesmo motivo das contas: só
    // esta resposta traz quantas contas usam cada tipo, e esse número muda o tempo todo.
    api.tiposConta.listar(),
    api.health(),
  ]);

  const contas = resContas.status === 'fulfilled' && Array.isArray(resContas.value)
    ? resContas.value
    : null;
  const erroContas = resContas.status === 'rejected' ? resContas.reason : null;

  const tipos = resTipos.status === 'fulfilled' && Array.isArray(resTipos.value)
    ? resTipos.value
    : null;
  const erroTipos = resTipos.status === 'rejected' ? resTipos.reason : null;

  const health = resHealth.status === 'fulfilled' ? resHealth.value : null;
  const erroHealth = resHealth.status === 'rejected' ? resHealth.reason : null;

  container.replaceChildren(
    secaoContas(container, contas, erroContas),
    secaoTipos(container, tipos, erroTipos),
    secaoBanco(health, erroHealth),
    secaoSobre(health),
  );
}

// =====================================================================
// 1. Contas
// =====================================================================

function secaoContas(container, contas, erro) {
  const secao = el(
    'section',
    { class: 'secao' },
    el(
      'div',
      { class: ['card', 'view-head'] },
      el(
        'div',
        { class: 'card-head' },
        el(
          'div',
          {},
          el('h2', {}, 'Contas'),
          el('p', { class: 'muted' }, 'Onde o seu dinheiro fica. O saldo é o saldo inicial + receitas − despesas.'),
        ),
        el('button', { class: 'primary-btn', type: 'button', onclick: () => formConta() }, '+ Nova conta'),
      ),
    ),
  );

  if (erro) {
    const card = el('div', { class: 'card' });
    vazio(card, {
      ico: '⚠️',
      msg: erro instanceof ApiError ? erro.message : 'Não consegui carregar as contas.',
      acao: { texto: 'Tentar de novo', onClick: () => montar(container) },
    });
    secao.appendChild(card);
    return secao;
  }

  const lista = contas ?? [];
  const ativas = lista.filter((c) => !c.arquivada);
  const arquivadas = lista.filter((c) => c.arquivada);

  if (!lista.length) {
    const card = el('div', { class: 'card' });
    vazio(card, {
      ico: '🏦',
      msg: 'Nenhuma conta cadastrada. Crie uma conta para saber de onde sai e para onde vai cada lançamento.',
      acao: { texto: '+ Criar minha primeira conta', onClick: () => formConta() },
    });
    secao.appendChild(card);
    return secao;
  }

  secao.appendChild(cardPatrimonio(ativas));

  if (ativas.length) {
    secao.appendChild(el('div', { class: 'contas-grade' }, ativas.map(cartaoConta)));
  } else {
    const card = el('div', { class: 'card' });
    vazio(card, {
      ico: '📦',
      msg: 'Todas as contas estão arquivadas. Crie uma nova ou reative uma arquivada abaixo.',
      acao: { texto: '+ Nova conta', onClick: () => formConta() },
    });
    secao.appendChild(card);
  }

  if (arquivadas.length) secao.appendChild(blocoArquivadas(arquivadas));

  return secao;
}

/** Patrimônio total = soma dos saldos das contas NÃO arquivadas. */
function cardPatrimonio(ativas) {
  const total = ativas.reduce((soma, c) => soma + num(c.saldo), 0);
  const negativo = total < 0;

  return el(
    'div',
    { class: ['card', 'kpi', 'patrimonio'] },
    el(
      'div',
      { class: 'kpi-top' },
      el('span', { class: 'kpi-label' }, 'Patrimônio total'),
      el('span', { class: 'kpi-ico' }, '💎'),
    ),
    el('div', { class: 'kpi-value', style: negativo ? { color: COR_SAIDA } : null }, fmtMoeda(total)),
    el(
      'div',
      { class: ['kpi-foot', 'muted'] },
      `soma de ${ativas.length} conta(s) ativa(s)${negativo ? ' — você está no vermelho' : ''}`,
    ),
  );
}

function cartaoConta(conta) {
  const cor = conta.cor || COR_PADRAO;
  const meta = tipoContaPorChave(conta.tipo);
  const saldo = num(conta.saldo);
  const negativo = saldo < 0;

  return el(
    'article',
    { class: ['card', 'conta-card'], style: { '--conta-cor': cor, borderLeft: `4px solid ${cor}` } },
    el(
      'div',
      { class: 'conta-top' },
      el('span', { class: 'conta-ico', style: { background: `${cor}33` } }, meta.icone),
      el(
        'div',
        { class: 'conta-id' },
        el('strong', { class: 'conta-nome' }, conta.nome),
        el('span', { class: 'muted' }, meta.rotulo),
      ),
      el(
        'div',
        { class: 'conta-acoes' },
        el(
          'button',
          {
            class: 'icon-btn',
            type: 'button',
            title: 'Editar conta',
            'aria-label': `Editar conta ${conta.nome}`,
            onclick: () => formConta(conta),
          },
          '✏️',
        ),
        el(
          'button',
          {
            class: 'icon-btn',
            type: 'button',
            title: 'Excluir conta',
            'aria-label': `Excluir conta ${conta.nome}`,
            onclick: () => excluirConta(conta),
          },
          '🗑️',
        ),
      ),
    ),
    el(
      'div',
      { class: 'conta-saldo' },
      el('span', { class: 'muted' }, 'Saldo atual'),
      el(
        'strong',
        { class: 'conta-valor', style: negativo ? { color: COR_SAIDA } : null },
        fmtMoeda(saldo),
      ),
    ),
    el(
      'div',
      { class: ['conta-foot', 'muted'] },
      `Saldo inicial: ${fmtMoeda(num(conta.saldo_inicial))}`,
      conta.arquivada ? el('span', { class: ['tag', 'tag-arquivada'] }, 'Arquivada') : null,
    ),
  );
}

function blocoArquivadas(arquivadas) {
  return el(
    'details',
    { class: 'arquivadas' },
    el('summary', {}, `Mostrar arquivadas (${arquivadas.length})`),
    el(
      'p',
      { class: 'muted' },
      'Contas arquivadas não entram no patrimônio total e não aparecem nos formulários. ' +
        'As transações delas continuam no histórico.',
    ),
    el('div', { class: 'contas-grade' }, arquivadas.map(cartaoConta)),
  );
}

async function excluirConta(conta) {
  const ok = await confirmar({
    titulo: 'Excluir conta',
    msg:
      `A conta "${conta.nome}" será excluída. As transações lançadas nela NÃO são apagadas: ` +
      'elas ficam sem conta. Se você só quer tirá-la da frente, prefira arquivar (editar → arquivada).',
    okLabel: 'Excluir',
  });
  if (!ok) return;

  try {
    await api.contas.remover(conta.id);
    // Mexeu em conta: recarrega a base antes de avisar os observadores.
    await carregarBase();
    toast('Conta excluída.', 'ok');
    emitir();
  } catch (err) {
    toast(err?.message || 'Não foi possível excluir a conta.', 'erro');
  }
}

// =====================================================================
// 2. Tipos de conta
// =====================================================================

function secaoTipos(container, tipos, erro) {
  const secao = el(
    'section',
    { class: 'secao' },
    el(
      'div',
      { class: ['card', 'view-head'] },
      el(
        'div',
        { class: 'card-head' },
        el(
          'div',
          {},
          el('h2', {}, 'Tipos de conta'),
          el(
            'p',
            { class: 'muted' },
            'Como você classifica suas contas: corrente, poupança, cartão… ou o que fizer sentido para você.',
          ),
        ),
        el('button', { class: 'primary-btn', type: 'button', onclick: () => formTipoConta() }, '+ Novo tipo'),
      ),
    ),
  );

  if (erro) {
    const card = el('div', { class: 'card' });
    vazio(card, {
      ico: '⚠️',
      msg: erro instanceof ApiError ? erro.message : 'Não consegui carregar os tipos de conta.',
      acao: { texto: 'Tentar de novo', onClick: () => montar(container) },
    });
    secao.appendChild(card);
    return secao;
  }

  const lista = tipos ?? [];

  if (!lista.length) {
    const card = el('div', { class: 'card' });
    vazio(card, {
      ico: '🏦',
      msg: 'Nenhum tipo de conta. Crie ao menos um — toda conta precisa de um tipo.',
      acao: { texto: '+ Criar um tipo', onClick: () => formTipoConta() },
    });
    secao.appendChild(card);
    return secao;
  }

  secao.appendChild(el('div', { class: 'tipos-grade' }, lista.map(cartaoTipo)));
  return secao;
}

function cartaoTipo(tipo) {
  const emUso = num(tipo.contas);

  return el(
    'article',
    { class: ['card', 'tipo-card'] },
    el('span', { class: 'tipo-ico' }, tipo.icone),
    el(
      'div',
      { class: 'tipo-id' },
      el('strong', {}, tipo.rotulo),
      el('span', { class: 'muted' }, emUso ? `${emUso} conta(s)` : 'nenhuma conta usa'),
    ),
    el(
      'div',
      { class: 'conta-acoes' },
      el(
        'button',
        {
          class: 'icon-btn',
          type: 'button',
          title: 'Editar tipo',
          'aria-label': `Editar tipo ${tipo.rotulo}`,
          onclick: () => formTipoConta(tipo),
        },
        '✏️',
      ),
      el(
        'button',
        {
          class: 'icon-btn',
          type: 'button',
          title: 'Excluir tipo',
          'aria-label': `Excluir tipo ${tipo.rotulo}`,
          onclick: () => excluirTipo(tipo),
        },
        '🗑️',
      ),
    ),
  );
}

async function excluirTipo(tipo) {
  // Tipo em uso o backend recusa (409) -- avisar aqui evita o modal de confirmacao
  // seguido de um erro, que faria o usuario achar que a exclusao "falhou".
  if (num(tipo.contas) > 0) {
    toast(`"${tipo.rotulo}" está em uso por ${tipo.contas} conta(s). Troque o tipo delas antes.`, 'erro');
    return;
  }

  const ok = await confirmar({
    titulo: 'Excluir tipo de conta',
    msg: `O tipo "${tipo.rotulo}" será excluído. Nenhuma conta usa ele, então nada mais muda.`,
    okLabel: 'Excluir',
  });
  if (!ok) return;

  try {
    await api.tiposConta.remover(tipo.id);
    await carregarBase();
    toast('Tipo de conta excluído.', 'ok');
    emitir();
  } catch (err) {
    toast(err?.message || 'Não foi possível excluir o tipo.', 'erro');
  }
}

// =====================================================================
// 3. Banco de dados
// =====================================================================

/** "PostgreSQL 18.0 on x86_64..., compiled by gcc" -> "PostgreSQL 18.0" */
function versaoCurta(versao) {
  const s = String(versao ?? '').trim();
  if (!s) return '—';
  const m = s.match(/^PostgreSQL\s+([\w.]+)/i);
  return m ? `PostgreSQL ${m[1]}` : s.slice(0, 60);
}

/** timestamptz do banco -> data/hora local legível. */
function horaLegivel(agora) {
  const d = new Date(agora);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR');
}

function secaoBanco(health, erro) {
  const conectado = Boolean(health?.ok);

  const selo = el(
    'span',
    { class: ['selo', conectado ? 'selo-ok' : 'selo-erro'] },
    el('span', { class: 'selo-ponto', 'aria-hidden': 'true' }),
    conectado ? 'conectado' : 'sem conexão',
  );

  const corpo = conectado
    ? el(
        'dl',
        { class: 'dados-lista' },
        dado('Banco', health.banco || BANCO_PADRAO),
        dado('Versão', versaoCurta(health.versao)),
        // O contrato do GET /api/health (docs/API.md) devolve { ok, agora, banco, versao } —
        // não expõe o host do PostgreSQL. Mostramos o host do servidor da aplicação, que é
        // quem fala com o banco local, sem inventar um campo que a API não tem.
        dado('Host (servidor da aplicação)', location.host || 'localhost'),
        dado('Relógio do banco', horaLegivel(health.agora)),
      )
    : el(
        'div',
        { class: 'aviso-erro' },
        el(
          'p',
          {},
          erro instanceof ApiError
            ? erro.message
            : 'Não consegui falar com o servidor. Ele está rodando? (npm start)',
        ),
        el(
          'p',
          { class: 'muted' },
          'Verifique se o serviço do PostgreSQL está ativo e se o arquivo .env aponta para o banco certo. ' +
            'Depois, rode "npm start" novamente.',
        ),
      );

  return el(
    'section',
    { class: 'secao' },
    el(
      'div',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', {}, 'Banco de dados'), selo),
      corpo,
      el(
        'p',
        { class: ['muted', 'nota'] },
        'Os seus dados vivem no PostgreSQL local — não no navegador. Nada é guardado em localStorage ' +
          '(só a preferência de tema claro/escuro). Limpar o cache ou trocar de navegador não apaga nenhum ' +
          'lançamento; e o app não funciona com o servidor desligado.',
      ),
    ),
  );
}

function dado(rotulo, valor) {
  return el(
    'div',
    { class: 'dado' },
    el('dt', { class: 'muted' }, rotulo),
    el('dd', {}, String(valor ?? '—')),
  );
}

// =====================================================================
// 4. Sobre / comandos
// =====================================================================

const COMANDOS = [
  'npm start          # sobe o servidor (API + frontend)',
  'npm run db:migrate # cria/atualiza o schema do banco',
  'npm run db:seed    # popula o banco com dados de exemplo',
].join('\n');

function comandoBackup(banco) {
  const arquivo = `${banco}_${hoje()}.dump`;
  return [
    `pg_dump -U ${USUARIO_PADRAO} -d ${banco} -F c -f ${arquivo}`,
    `pg_restore -U ${USUARIO_PADRAO} -d ${banco} --clean ${arquivo}`,
  ].join('\n');
}

function secaoSobre(health) {
  const banco = health?.banco || BANCO_PADRAO;

  return el(
    'section',
    { class: 'secao' },
    el(
      'div',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', {}, 'Comandos úteis')),
      blocoComandos(COMANDOS, 'Comandos do projeto'),
      el(
        'p',
        { class: ['muted', 'nota'] },
        'Rode os comandos na pasta do projeto, num terminal.',
      ),
    ),
    el(
      'div',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', {}, 'Backup e restauração')),
      el(
        'p',
        { class: 'muted' },
        'Não existe "exportar/importar JSON" aqui: como os dados estão no PostgreSQL, o backup de ' +
          'verdade é o pg_dump — ele salva tudo (transações, contas, categorias, metas, orçamentos e ' +
          'recorrentes) num arquivo só, e o pg_restore devolve.',
      ),
      blocoComandos(comandoBackup(banco), 'Comandos de backup'),
      el(
        'p',
        { class: ['muted', 'nota'] },
        `Banco: ${banco}. Ajuste -U (usuário), -h (host) e -p (porta) conforme o seu arquivo .env. ` +
          'O pg_restore com --clean apaga os dados atuais antes de recriar — cuidado ao restaurar por cima.',
      ),
    ),
  );
}

function blocoComandos(texto, rotulo) {
  const btn = el('button', { class: 'link-btn', type: 'button' }, '📋 copiar');
  btn.addEventListener('click', () => copiar(texto, btn));

  return el(
    'div',
    { class: 'bloco-cmd' },
    el('pre', { class: 'cmd', 'aria-label': rotulo }, el('code', {}, texto)),
    btn,
  );
}

/**
 * navigator.clipboard só existe em contexto seguro (https ou localhost). Como o app
 * pode ser aberto por IP na rede local, mantém um plano B com textarea + execCommand.
 */
async function copiar(texto, botao) {
  const rotulo = botao.textContent;

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(texto);
    } else if (!copiarFallback(texto)) {
      throw new Error('sem suporte a cópia');
    }

    botao.textContent = '✅ copiado';
    setTimeout(() => {
      botao.textContent = rotulo;
    }, 1500);
  } catch {
    toast('Não consegui copiar. Selecione o texto e use Ctrl+C.', 'erro');
  }
}

function copiarFallback(texto) {
  const area = el('textarea', {
    value: texto,
    readOnly: true,
    style: { position: 'fixed', top: '-1000px', opacity: '0' },
  });
  document.body.appendChild(area);
  area.select();

  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}
