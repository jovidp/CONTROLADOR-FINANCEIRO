/**
 * View "Configurações" — contas, tipos de conta, troca de senha e estado do banco.
 *
 * As contas são buscadas na API a cada montagem (e não lidas de state.contas):
 * o saldo muda a cada transação lançada, e uma escrita em transações chama
 * emitir() SEM recarregar a base — o cache do state teria saldo velho.
 */

import { api, ApiError } from '../api.js';
import { tipoContaPorChave } from '../state.js';
import { el, fmtMoeda, skeleton, vazio, toast } from '../ui.js';
import { excluirCom, formConta, formTipoConta } from '../forms.js';
import { num } from '../dominio.js';

const COR_SAIDA = 'var(--out, #ef4444)';
const COR_PADRAO = '#64748b';

// =====================================================================
// Montagem
// =====================================================================

export async function montar(container) {
  if (!container) return;

  skeleton(container, 5);

  // allSettled: uma seção fora do ar não pode apagar a tela inteira — as outras
  // continuam renderizando, cada uma com o seu próprio estado de erro.
  const [resContas, resTipos] = await Promise.allSettled([
    api.contas.listar({ incluir_arquivadas: true }),
    // Buscado aqui (e não lido de state.tiposConta) pelo mesmo motivo das contas: só
    // esta resposta traz quantas contas usam cada tipo, e esse número muda o tempo todo.
    api.tiposConta.listar(),
  ]);

  const contas = resContas.status === 'fulfilled' && Array.isArray(resContas.value)
    ? resContas.value
    : null;
  const erroContas = resContas.status === 'rejected' ? resContas.reason : null;

  const tipos = resTipos.status === 'fulfilled' && Array.isArray(resTipos.value)
    ? resTipos.value
    : null;
  const erroTipos = resTipos.status === 'rejected' ? resTipos.reason : null;

  container.replaceChildren(
    secaoContas(container, contas, erroContas),
    secaoTipos(container, tipos, erroTipos),
    secaoSeguranca(),
  );
}

// =====================================================================
// Conta e segurança — troca de senha
// =====================================================================

function secaoSeguranca() {
  const atual = el('input', {
    class: 'input', type: 'password', autocomplete: 'current-password',
    placeholder: 'Senha atual', 'aria-label': 'Senha atual',
  });
  const nova = el('input', {
    class: 'input', type: 'password', autocomplete: 'new-password',
    minlength: '12', maxlength: '200',
    placeholder: 'Nova senha (mín. 12 caracteres)', 'aria-label': 'Nova senha',
  });
  const conf = el('input', {
    class: 'input', type: 'password', autocomplete: 'new-password',
    minlength: '12', maxlength: '200',
    placeholder: 'Confirmar nova senha', 'aria-label': 'Confirmar nova senha',
  });
  const btn = el('button', { class: 'primary-btn', type: 'submit' }, 'Trocar senha');

  const form = el(
    'form',
    { class: 'form-grid', autocomplete: 'off' },
    el('div', { class: 'campo' }, atual),
    el('div', { class: 'campo' }, nova),
    el('div', { class: 'campo' }, conf),
    btn,
  );

  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    // Checagem local so por conveniencia: a regra de verdade (12+, senha != usuario,
    // nao-obvia, senha atual correta) e´ do servidor, que ve o que o navegador nao ve.
    if (nova.value !== conf.value) {
      toast('As senhas não são iguais.', 'erro');
      return;
    }
    btn.disabled = true;
    try {
      await api.auth.trocarSenha({
        senha_atual: atual.value,
        senha_nova: nova.value,
        confirmacao: conf.value,
      });
      form.reset();
      toast('Senha trocada.', 'ok');
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Não consegui trocar a senha.', 'erro');
    } finally {
      btn.disabled = false;
    }
  });

  return el(
    'section',
    { class: 'secao' },
    el(
      'div',
      { class: 'card' },
      el('div', { class: 'card-head' }, el('h2', {}, 'Conta e segurança')),
      el(
        'p',
        { class: 'muted' },
        'Troque a sua senha. Você precisa da senha atual para confirmar — assim, um acesso ' +
          'aberto por engano não consegue trocar a senha e tomar a conta.',
      ),
      form,
    ),
    cartao2FA(),
    cartaoAtividade(),
  );
}

// --- Helpers locais --------------------------------------------------

/** timestamp ISO -> data/hora local legível. */
function horaLegivel(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('pt-BR');
}

/**
 * Copia texto para a área de transferência e dá um feedback no botão.
 * navigator.clipboard só existe em contexto seguro (https ou localhost); o plano B
 * com textarea + execCommand cobre o acesso por IP na rede local.
 */
async function copiar(texto, botao) {
  const rotulo = botao.textContent;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(texto);
    } else {
      const area = el('textarea', {
        value: texto, readOnly: true,
        style: { position: 'fixed', top: '-1000px', opacity: '0' },
      });
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
    }
    botao.textContent = '✅ copiado';
    setTimeout(() => { botao.textContent = rotulo; }, 1500);
  } catch {
    toast('Não consegui copiar. Selecione o texto e use Ctrl+C.', 'erro');
  }
}

// --- Verificação em duas etapas (2FA) --------------------------------

function cartao2FA() {
  const corpo = el('div', { class: 'card-2fa-corpo' }, el('p', { class: 'muted' }, 'Carregando…'));
  render2FA(corpo);
  return el(
    'div',
    { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', {}, 'Verificação em duas etapas (2FA)')),
    corpo,
  );
}

async function render2FA(corpo) {
  let st;
  try {
    st = await api.auth.status2fa();
  } catch {
    corpo.replaceChildren(el('p', { class: 'muted' }, 'Não consegui carregar o estado do 2FA.'));
    return;
  }
  if (st.ativo) render2FAAtivo(corpo, st);
  else render2FAInativo(corpo);
}

function render2FAInativo(corpo) {
  const btn = el('button', { class: 'primary-btn', type: 'button' }, '🔐 Ativar 2FA');
  btn.addEventListener('click', () => enrollIniciar(corpo, btn));
  corpo.replaceChildren(
    el(
      'p',
      { class: 'muted' },
      'Uma segunda barreira além da senha: um código de 6 dígitos que muda a cada 30 segundos, ' +
        'gerado por um app no seu celular (Google Authenticator, Authy, Microsoft Authenticator). ' +
        'Mesmo que a senha vaze, ninguém entra sem o seu celular.',
    ),
    btn,
  );
}

async function enrollIniciar(corpo, btn) {
  btn.disabled = true;
  try {
    const { segredo } = await api.auth.iniciar2fa();
    enrollMostrarChave(corpo, segredo);
  } catch (err) {
    toast(err instanceof ApiError ? err.message : 'Não consegui iniciar o 2FA.', 'erro');
    btn.disabled = false;
  }
}

function enrollMostrarChave(corpo, segredo) {
  const chaveFmt = segredo.match(/.{1,4}/g).join(' ');
  const btnCopiar = el('button', { class: 'link-btn', type: 'button' }, '📋 copiar chave');
  btnCopiar.addEventListener('click', () => copiar(segredo, btnCopiar));

  const codigo = el('input', {
    class: 'input', type: 'text', inputmode: 'numeric', maxlength: '6',
    placeholder: '000000', 'aria-label': 'Código do app',
  });
  const btnConfirmar = el('button', { class: 'primary-btn', type: 'submit' }, 'Confirmar e ativar');

  const form = el(
    'form',
    { class: 'form-grid', autocomplete: 'off' },
    el('div', { class: 'campo' }, codigo),
    btnConfirmar,
  );
  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    btnConfirmar.disabled = true;
    try {
      const { codigos } = await api.auth.confirmar2fa({ codigo: codigo.value.trim() });
      enrollMostrarRecuperacao(corpo, codigos);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Código incorreto.', 'erro');
      btnConfirmar.disabled = false;
      codigo.focus();
    }
  });

  corpo.replaceChildren(
    el(
      'ol',
      { class: 'passos-2fa' },
      el('li', {}, 'No app autenticador, escolha "adicionar conta" → "inserir uma chave de configuração".'),
      el('li', {}, 'Nome: Controlador Financeiro. Chave (digite exatamente, sem os espaços):'),
    ),
    el('div', { class: 'chave-2fa' }, el('code', {}, chaveFmt), btnCopiar),
    el('p', { class: 'muted' }, 'Depois, digite abaixo o código de 6 dígitos que o app mostrar:'),
    form,
  );
  codigo.focus();
}

function enrollMostrarRecuperacao(corpo, codigos) {
  const btnCopiar = el('button', { class: 'link-btn', type: 'button' }, '📋 copiar todos');
  btnCopiar.addEventListener('click', () => copiar(codigos.join('\n'), btnCopiar));
  const btnConcluir = el('button', { class: 'primary-btn', type: 'button' }, 'Guardei — concluir');
  btnConcluir.addEventListener('click', () => { toast('2FA ativado com sucesso.', 'ok'); render2FA(corpo); });

  corpo.replaceChildren(
    el(
      'div',
      { class: 'form-alerta' },
      '⚠️ Guarde estes códigos de recuperação AGORA — eles não aparecem de novo. ' +
        'Cada um serve UMA vez, para entrar caso você perca o celular.',
    ),
    el('div', { class: 'codigos-recup' }, codigos.map((c) => el('code', {}, c))),
    btnCopiar,
    btnConcluir,
  );
}

function render2FAAtivo(corpo, st) {
  const btn = el('button', { class: 'danger-btn', type: 'button' }, 'Desativar 2FA');
  btn.addEventListener('click', () => render2FADesativar(corpo, st));
  corpo.replaceChildren(
    el('span', { class: ['selo', 'selo-ok'] }, el('span', { class: 'selo-ponto', 'aria-hidden': 'true' }), 'ativo'),
    el(
      'p',
      { class: 'muted' },
      `Está ligada — o login pede o código do app. Você tem ${st.recuperacao_restantes} ` +
        'código(s) de recuperação restante(s).',
    ),
    btn,
  );
}

function render2FADesativar(corpo, st) {
  const senha = el('input', {
    class: 'input', type: 'password', autocomplete: 'current-password',
    placeholder: 'Sua senha', 'aria-label': 'Sua senha',
  });
  const codigo = el('input', {
    class: 'input', type: 'text', inputmode: 'numeric', maxlength: '20',
    placeholder: 'Código do app ou de recuperação', 'aria-label': 'Código',
  });
  const btn = el('button', { class: 'danger-btn', type: 'submit' }, 'Desativar');
  const btnCancelar = el('button', { class: 'btn', type: 'button' }, 'Cancelar');
  btnCancelar.addEventListener('click', () => render2FAAtivo(corpo, st));

  const form = el(
    'form',
    { class: 'form-grid', autocomplete: 'off' },
    el('div', { class: 'campo' }, senha),
    el('div', { class: 'campo' }, codigo),
    el('div', { class: 'btn-row' }, btn, btnCancelar),
  );
  form.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    btn.disabled = true;
    try {
      await api.auth.desativar2fa({ senha: senha.value, codigo: codigo.value.trim() });
      toast('2FA desativado.', 'ok');
      render2FA(corpo);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Não consegui desativar.', 'erro');
      btn.disabled = false;
    }
  });

  corpo.replaceChildren(
    el('p', { class: 'muted' }, 'Para desligar, confirme com a senha e um código atual.'),
    form,
  );
  senha.focus();
}

// --- Atividade recente de login --------------------------------------

function cartaoAtividade() {
  const corpo = el('div', { class: 'card-atividade-corpo' }, el('p', { class: 'muted' }, 'Carregando…'));
  renderAtividade(corpo);
  return el(
    'div',
    { class: 'card' },
    el('div', { class: 'card-head' }, el('h2', {}, 'Atividade recente')),
    corpo,
  );
}

async function renderAtividade(corpo) {
  let res;
  try {
    res = await api.auth.atividade();
  } catch {
    corpo.replaceChildren(el('p', { class: 'muted' }, 'Não consegui carregar a atividade.'));
    return;
  }
  const eventos = Array.isArray(res?.eventos) ? res.eventos : [];
  if (!eventos.length) {
    corpo.replaceChildren(el('p', { class: 'muted' }, 'Nenhum acesso registrado ainda.'));
    return;
  }
  const btnSair = el('button', { class: 'danger-btn', type: 'button' }, 'Sair de todos os outros dispositivos');
  btnSair.addEventListener('click', async () => {
    btnSair.disabled = true;
    try {
      await api.auth.sairTodos();
      toast('Pronto — as outras sessões foram encerradas. Esta continua ativa.', 'ok');
      renderAtividade(corpo);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : 'Não consegui encerrar as sessões.', 'erro');
      btnSair.disabled = false;
    }
  });

  corpo.replaceChildren(
    el('p', { class: 'muted' }, 'Seus últimos acessos. Se algum IP não parecer seu, troque a senha e ative o 2FA.'),
    el(
      'ul',
      { class: 'atividade-lista' },
      eventos.map((ev, i) => el(
        'li',
        { class: 'atividade-item' },
        el('span', { class: 'atividade-ip' }, ev.ip || '—'),
        el('span', { class: ['atividade-quando', 'muted'] }, horaLegivel(ev.criado_em)),
        i === 0 ? el('span', { class: ['tag', 'tag-atual'] }, 'este acesso') : null,
      )),
    ),
    el('p', { class: 'muted', style: { marginTop: '4px' } },
      'Perdeu um aparelho ou acha que alguém entrou? Encerre as outras sessões — você continua conectado aqui.'),
    btnSair,
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

function excluirConta(conta) {
  return excluirCom({
    titulo: 'Excluir conta',
    msg:
      `A conta "${conta.nome}" será excluída. As transações lançadas nela NÃO são apagadas: ` +
      'elas ficam sem conta. Se você só quer tirá-la da frente, prefira arquivar (editar → arquivada).',
    okLabel: 'Excluir',
    acao: () => api.contas.remover(conta.id),
    sucesso: 'Conta excluída.',
    // Mexeu em conta: recarrega a base antes de avisar os observadores.
    recarregar: true,
  });
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

function excluirTipo(tipo) {
  // Tipo em uso o backend recusa (409) -- avisar aqui evita o modal de confirmacao
  // seguido de um erro, que faria o usuario achar que a exclusao "falhou".
  if (num(tipo.contas) > 0) {
    toast(`"${tipo.rotulo}" está em uso por ${tipo.contas} conta(s). Troque o tipo delas antes.`, 'erro');
    return;
  }

  return excluirCom({
    titulo: 'Excluir tipo de conta',
    msg: `O tipo "${tipo.rotulo}" será excluído. Nenhuma conta usa ele, então nada mais muda.`,
    okLabel: 'Excluir',
    acao: () => api.tiposConta.remover(tipo.id),
    sucesso: 'Tipo de conta excluído.',
    // state.tiposConta alimenta o select de tipo do formulario de conta.
    recarregar: true,
  });
}
