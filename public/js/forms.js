/**
 * Definicoes de formulario reutilizadas pela topbar e pelas views.
 * Cada funcao monta os campos, abre o modal (ui.js) e salva via api.js.
 * Contrato: docs/FRONTEND.md e docs/API.md.
 *
 * Regra pos-escrita: mexeu em categoria/conta (ou em algo que derive delas, como o
 * saldo das contas) -> await carregarBase(); sempre emitir() + toast().
 */

import { api, ApiError } from './api.js';
import { abrirModal, confirmar, el, fmtMoeda, hoje, toast } from './ui.js';
import { carregarBase, categoriasPorTipo, emitir, state } from './state.js';

// --- Constantes de apresentacao --------------------------------------

// Hex de 7 caracteres: e o formato que o backend valida (RE_COR) e o max=7 de texto().
const PALETA = [
  { hex: '#ef4444', nome: 'Vermelho' },
  { hex: '#f97316', nome: 'Laranja' },
  { hex: '#f59e0b', nome: 'Âmbar' },
  { hex: '#eab308', nome: 'Amarelo' },
  { hex: '#84cc16', nome: 'Lima' },
  { hex: '#22c55e', nome: 'Verde' },
  { hex: '#10b981', nome: 'Esmeralda' },
  { hex: '#14b8a6', nome: 'Turquesa' },
  { hex: '#06b6d4', nome: 'Ciano' },
  { hex: '#0ea5e9', nome: 'Azul-céu' },
  { hex: '#3b82f6', nome: 'Azul' },
  { hex: '#6366f1', nome: 'Índigo' },
  { hex: '#8b5cf6', nome: 'Violeta' },
  { hex: '#a855f7', nome: 'Roxo' },
  { hex: '#d946ef', nome: 'Magenta' },
  { hex: '#ec4899', nome: 'Rosa' },
  { hex: '#f43f5e', nome: 'Cereja' },
  { hex: '#64748b', nome: 'Cinza' },
];

const ICONES_CATEGORIA = [
  '📦', '🍔', '🛒', '☕', '🍺', '🏠', '💡', '💧', '🔥', '🌐',
  '📱', '🚗', '⛽', '🚌', '✈️', '🏖️', '💊', '🏥', '🏋️', '💇',
  '👕', '🎓', '📚', '🎮', '🎬', '🎵', '🎁', '🐶', '👶', '🧸',
  '🧾', '🔧', '🖥️', '💼', '💰', '💵', '🏦', '📈', '🤝', '🎯',
];

const ICONES_META = [
  '🏆', '🎯', '🏠', '🚗', '✈️', '🏖️', '🎓', '💍', '👶', '🐶',
  '🖥️', '📱', '🛠️', '💰', '🏦', '📈', '🎁', '🚑', '🧳', '🎸',
];

// Espelham os DEFAULT de db/migrations/001_init.sql.
const COR_PADRAO = '#64748b';
const ICONE_CATEGORIA_PADRAO = '📦';
const COR_META_PADRAO = '#6366f1';
const ICONE_META_PADRAO = '🏆';

// Duas listas porque os backends divergem, e um botao a mais aqui vira 400 la:
// so´ POST/PUT /api/transacoes aceita 'transferencia' (src/routes/transacoes.js);
// categorias e recorrentes validam contra ['receita','despesa'] e recusam o resto.
const TIPOS_LANCAMENTO = [
  { valor: 'despesa', rotulo: 'Despesa' },
  { valor: 'receita', rotulo: 'Receita' },
  { valor: 'transferencia', rotulo: 'Transferência' },
];

const TIPOS_RECEITA_DESPESA = [
  { valor: 'despesa', rotulo: 'Despesa' },
  { valor: 'receita', rotulo: 'Receita' },
];

// Os tipos de conta sao dados do usuario (tabela tipos_conta), e nao uma lista fixa:
// o select se monta a partir do que ele tem cadastrado na hora de abrir o modal.
function opcoesTipoConta() {
  return state.tiposConta.map((t) => ({
    valor: t.chave,
    rotulo: `${t.icone ?? ''} ${t.rotulo}`.trim(),
  }));
}

const FREQUENCIAS = [
  { valor: 'diaria', rotulo: 'Diária' },
  { valor: 'semanal', rotulo: 'Semanal' },
  { valor: 'mensal', rotulo: 'Mensal' },
  { valor: 'anual', rotulo: 'Anual' },
];

const opcoesCor = () => PALETA.map((c) => ({ valor: c.hex, rotulo: c.nome, cor: c.hex }));

// valor/rotulo/icone com o mesmo emoji: renderiza igual independente de qual campo o ui.js leia.
const opcoesIcone = (lista) => lista.map((e) => ({ valor: e, rotulo: e, icone: e }));

// --- Conversao de valores do formulario ------------------------------

const paraCampo = (id) => (id === null || id === undefined ? '' : String(id));

function idOuNull(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function textoOuNull(valor) {
  const s = String(valor ?? '').trim();
  return s === '' ? null : s;
}

const marcado = (valor) => valor === true || valor === 'true' || valor === 'on' || valor === 1 || valor === '1';

/** Rede de seguranca: o backend tambem valida, mas o erro fica mais perto do campo. */
function moedaObrigatoria(valor, campo) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ApiError('Informe um valor maior que zero.', 400, campo);
  }
  return Math.round(n * 100) / 100;
}

// --- Opcoes que dependem do state ------------------------------------

// O <option> vazio quem desenha e´ o ui.js (todo select nao-obrigatorio ganha um).
// Estas listas trazem so´ os dados reais; o rotulo do vazio vai no `placeholder` do
// campo -- juntar os dois aqui daria DUAS opcoes vazias no mesmo select.
const SEM_CATEGORIA = 'Sem categoria';
const SEM_CONTA = 'Sem conta';

function opcoesCategoria(tipo) {
  return categoriasPorTipo(tipo).map((c) => ({
    valor: String(c.id),
    // O icone entra no proprio rotulo: <option> nativo nao desenha icone separado, e assim
    // o refiltro em JS reproduz exatamente o mesmo texto que o ui.js montou na abertura.
    rotulo: `${c.icone ?? ''} ${c.nome}`.trim(),
    cor: c.cor,
  }));
}

/** Contas arquivadas somem dos formularios, exceto a do proprio registro em edicao. */
function opcoesConta(idAtual) {
  const atual = paraCampo(idAtual);
  return state.contas
    .filter((c) => !c.arquivada || String(c.id) === atual)
    .map((c) => ({
      valor: String(c.id),
      rotulo: c.arquivada ? `${c.nome} (arquivada)` : c.nome,
      cor: c.cor,
    }));
}

function contaPadrao() {
  const conta = state.contas.find((c) => !c.arquivada);
  return conta ? String(conta.id) : '';
}

// --- Interacao dentro do modal ---------------------------------------
//
// abrirModal() nao expoe hook de "campo mudou". O unico ponto de extensao documentado
// e o form montado em #modalForm, entao a ligacao tipo -> categoria e feita no DOM.
// Tudo aqui degrada em silencio: se a marcacao do ui.js mudar, o filtro deixa de ligar,
// mas o formulario continua enviavel (o banco barra par tipo/categoria incompativel).

const SELETOR_FORM = '#modalForm';

function aoMontarFormulario(fn, tentativas = 3) {
  const form = document.querySelector(SELETOR_FORM);
  if (form) {
    fn(form);
    return;
  }
  if (tentativas > 0) requestAnimationFrame(() => aoMontarFormulario(fn, tentativas - 1));
}

/** Le o tipo selecionado sem assumir como o ui.js desenha o 'segmentado'. */
function lerTipo(form) {
  const escolhido = form.querySelector('[name="tipo"]:checked');
  if (escolhido) return escolhido.value;

  const campo = form.elements?.tipo;
  if (campo instanceof HTMLInputElement || campo instanceof HTMLSelectElement) return campo.value;

  const pressionado = form.querySelector(
    '[name="tipo"][aria-pressed="true"], [data-campo="tipo"] [aria-pressed="true"], ' +
    '[data-campo="tipo"] [aria-checked="true"]',
  );
  if (pressionado) return pressionado.value || pressionado.dataset.valor || '';

  return typeof campo?.value === 'string' ? campo.value : '';
}

function preencherCategorias(select, tipo) {
  const selecionado = select.value;
  // replaceChildren() varre tambem o <option> vazio que o ui.js desenhou: refazemos.
  const opcoes = [{ valor: '', rotulo: SEM_CATEGORIA }, ...opcoesCategoria(tipo)];

  select.replaceChildren();
  for (const opcao of opcoes) {
    const option = document.createElement('option');
    option.value = opcao.valor;
    option.textContent = opcao.rotulo;
    if (opcao.cor) option.dataset.cor = opcao.cor;
    select.appendChild(option);
  }

  // Categoria do tipo antigo nao existe mais na lista: volta para "Sem categoria".
  select.value = opcoes.some((o) => o.valor === selecionado) ? selecionado : '';
}

/** Trocar o tipo refiltra a lista de categorias na hora. */
function ligarFiltroCategoria(tipoInicial) {
  aoMontarFormulario((form) => {
    const select = form.querySelector('select[name="categoria_id"]');
    if (!select) return;

    // O controle segmentado nao possui um input[name="tipo"] tradicional. O
    // valor inicial deve ser lido do botao realmente marcado no DOM, porque o
    // tipo recebido pela view pode estar desatualizado (principalmente ao
    // editar uma recorrencia). Sem esta sincronizacao o select podia ficar
    // apenas com "Sem categoria".
    let tipoAtual = lerTipo(form) || tipoInicial;
    preencherCategorias(select, tipoAtual);

    const sincronizar = () => {
      const tipo = lerTipo(form);
      if (tipo !== 'receita' && tipo !== 'despesa') return;
      if (tipo === tipoAtual) return;
      tipoAtual = tipo;
      preencherCategorias(select, tipo);
    };

    // 'change' cobre radio/select; 'click' cobre botoes do segmentado.
    form.addEventListener('change', sincronizar);
    form.addEventListener('click', sincronizar);
  });
}

/** 'desabilitado' nao esta no contrato de campo, entao tambem desligamos no DOM. */
function desabilitarCampo(name) {
  aoMontarFormulario((form) => {
    for (const alvo of form.querySelectorAll(`[name="${name}"]`)) alvo.disabled = true;
    const grupo = form.querySelector(`[data-campo="${name}"]`);
    if (grupo) for (const alvo of grupo.querySelectorAll('button, input, select')) alvo.disabled = true;
  });
}

/** Salvou: atualiza o cache se preciso, avisa as views e confirma para o usuario. */
async function depoisDeSalvar(msg, { recarregar = false } = {}) {
  if (recarregar) {
    try {
      await carregarBase();
    } catch {
      // O registro ja foi gravado: falhar ao reler o cache nao pode virar erro de formulario
      // (o modal ficaria aberto sugerindo que nada foi salvo). A view remontada mostra o erro.
    }
  }
  emitir();
  toast(msg, 'ok');
}

// --- Transacoes -------------------------------------------------------

const MIN_PARCELAS = 2;
const MAX_PARCELAS = 120;

export function formTransacao(tx) {
  const edicao = Boolean(tx);
  const tipoInicial = tx?.tipo ?? 'despesa';

  // Parcelar so´ faz sentido ao CRIAR. Editando, voce esta´ mexendo numa parcela
  // especifica -- transformar ela em compra nova aqui so´ geraria confusao.
  const podeParcelar = !edicao;

  const camposParcelamento = podeParcelar
    ? [
        {
          name: 'parcelar',
          label: 'Parcelar esta compra',
          tipo: 'checkbox',
          largura: 'cheio',
        },
        {
          name: 'total_parcelas',
          label: 'Em quantas vezes',
          tipo: 'numero',
          largura: 'meio',
          min: String(MIN_PARCELAS),
          max: String(MAX_PARCELAS),
          placeholder: '12',
        },
      ]
    : [];

  // "Fixo" nao e´ uma etiqueta: e´ ter vindo de um lancamento recorrente (NATUREZA_SQL,
  // no backend). Por isso marcar aqui CRIA a recorrente. So´ oferecemos para o lancamento
  // avulso: quem ja´ e´ fixo nao tem o que marcar, e uma parcela nao se repete para sempre.
  const podeFixar = edicao && !tx.recorrente_id && !tx.parcelamento_id;

  const campoFixar = podeFixar
    ? [
        {
          name: 'fixar',
          label: 'É um lançamento fixo (repete todo mês)',
          tipo: 'checkbox',
          largura: 'cheio',
          dica: 'Ao salvar, cria um lançamento fixo com estes dados. Os próximos meses passam a ser gerados sozinhos — este aqui continua sendo o deste mês.',
        },
      ]
    : [];

  abrirModal({
    titulo: edicao ? 'Editar transação' : 'Nova transação',
    okLabel: edicao ? 'Salvar' : 'Adicionar',
    campos: [
      {
        name: 'tipo',
        label: 'Tipo',
        tipo: 'segmentado',
        opcoes: TIPOS_LANCAMENTO,
        obrigatorio: true,
        largura: 'cheio',
      },
      {
        name: 'descricao',
        label: 'Descrição',
        tipo: 'texto',
        obrigatorio: true,
        largura: 'cheio',
        placeholder: 'Ex.: Mercado do mês',
      },
      { name: 'valor', label: 'Valor', tipo: 'dinheiro', obrigatorio: true, largura: 'meio' },
      { name: 'data', label: 'Data', tipo: 'data', obrigatorio: true, largura: 'meio' },
      ...camposParcelamento,
      ...campoFixar,
      {
        name: 'categoria_id',
        label: 'Categoria',
        tipo: 'select',
        opcoes: opcoesCategoria(tipoInicial),
        placeholder: SEM_CATEGORIA,
        largura: 'meio',
      },
      {
        name: 'conta_id',
        label: 'Conta',
        tipo: 'select',
        opcoes: opcoesConta(tx?.conta_id),
        placeholder: SEM_CONTA,
        largura: 'meio',
      },
      // So´ aparece quando o tipo e´ Transferencia (ligarTransferencia cuida disso).
      // NAO e´ `obrigatorio: true` de proposito: um campo required+escondido faz o
      // reportValidity() tentar focar um display:none e o formulario trava sem
      // mostrar erro nenhum. O `required` e´ ligado no DOM so´ quando ele esta´ visivel.
      {
        name: 'conta_destino_id',
        label: 'Para a conta',
        tipo: 'select',
        opcoes: opcoesConta(tx?.conta_destino_id),
        placeholder: 'Escolha o destino',
        largura: 'meio',
      },
      {
        name: 'observacao',
        label: 'Observação',
        tipo: 'textarea',
        largura: 'cheio',
        placeholder: 'Opcional',
      },
    ],
    valores: {
      tipo: tipoInicial,
      descricao: tx?.descricao ?? '',
      valor: tx?.valor ?? '',
      data: tx?.data ?? hoje(),
      parcelar: false,
      total_parcelas: '',
      fixar: false,
      categoria_id: paraCampo(tx?.categoria_id),
      conta_id: edicao ? paraCampo(tx.conta_id) : contaPadrao(),
      conta_destino_id: paraCampo(tx?.conta_destino_id),
      observacao: tx?.observacao ?? '',
    },
    onSubmit: async (v) => {
      if (v.tipo === 'transferencia') {
        const origem = idOuNull(v.conta_id);
        const destino = idOuNull(v.conta_destino_id);

        if (origem === null) throw new ApiError('Escolha a conta de origem.', 400, 'conta_id');
        if (destino === null) throw new ApiError('Escolha a conta de destino.', 400, 'conta_destino_id');
        if (origem === destino) {
          throw new ApiError('A conta de destino precisa ser diferente da de origem.', 400, 'conta_destino_id');
        }

        const dados = {
          descricao: v.descricao,
          valor: moedaObrigatoria(v.valor, 'valor'),
          tipo: 'transferencia',
          data: v.data,
          categoria_id: null, // transferencia nao classifica: o dinheiro continua sendo seu
          conta_id: origem,
          conta_destino_id: destino,
          observacao: textoOuNull(v.observacao),
        };

        if (edicao) await api.transacoes.atualizar(tx.id, dados);
        else await api.transacoes.criar(dados);

        await depoisDeSalvar(
          edicao ? 'Transferência atualizada.' : 'Transferência registrada.',
          { recarregar: true },
        );
        return;
      }

      if (podeParcelar && marcado(v.parcelar)) {
        const vezes = Number(v.total_parcelas);
        if (!Number.isInteger(vezes) || vezes < MIN_PARCELAS || vezes > MAX_PARCELAS) {
          throw new ApiError(
            `Diga em quantas vezes parcelar (de ${MIN_PARCELAS} a ${MAX_PARCELAS}).`,
            400,
            'total_parcelas',
          );
        }

        const valor = moedaObrigatoria(v.valor, 'valor');
        if (Math.round(valor * 100) < vezes) {
          throw new ApiError(
            `O valor total é pequeno demais para ${vezes} parcelas (daria menos de um centavo por parcela).`,
            400,
            'valor',
          );
        }

        await api.parcelamentos.criar({
          descricao: v.descricao,
          valor_total: valor,
          total_parcelas: vezes,
          tipo: v.tipo,
          data_primeira: v.data,
          categoria_id: idOuNull(v.categoria_id),
          conta_id: idOuNull(v.conta_id),
          observacao: textoOuNull(v.observacao),
        });

        await depoisDeSalvar(`Compra parcelada em ${vezes}x criada.`, { recarregar: true });
        return;
      }

      const valor = moedaObrigatoria(v.valor, 'valor');

      const dados = {
        descricao: v.descricao,
        valor,
        tipo: v.tipo,
        data: v.data,
        categoria_id: idOuNull(v.categoria_id),
        conta_id: idOuNull(v.conta_id),
        observacao: textoOuNull(v.observacao),
      };

      if (edicao) await api.transacoes.atualizar(tx.id, dados);
      else await api.transacoes.criar(dados);

      // Fixar DEPOIS de salvar: a recorrente e´ montada a partir da transacao ja´ gravada,
      // entao ela herda o valor/categoria/conta que voce acabou de editar, e nao os antigos.
      const fixou = edicao && podeFixar && marcado(v.fixar);
      if (fixou) await api.transacoes.fixar(tx.id);

      // O saldo das contas e o em_uso das categorias derivam das transacoes: o cache envelheceu.
      const msg = fixou
        ? 'Transação atualizada e marcada como fixa: os próximos meses serão gerados sozinhos.'
        : edicao ? 'Transação atualizada.' : 'Transação adicionada.';
      await depoisDeSalvar(msg, { recarregar: true });
    },
  });

  ligarFiltroCategoria(tipoInicial);
  ligarTransferencia();
  if (podeParcelar) ligarParcelamento();
}

/**
 * Transferencia nao e´ um terceiro "tipo de gasto": e´ outro formulario.
 * Some a categoria (nao ha´ o que classificar num dinheiro que continua seu), aparece a
 * conta de destino, e "Conta" vira "Da conta" -- porque agora ela e´ a ORIGEM, nao "a conta".
 * Parcelar e fixar tambem somem: o backend os recusa para transferencia, e um checkbox que
 * so´ existe para dar erro no submit e´ pior do que checkbox nenhum.
 */
function ligarTransferencia() {
  aoMontarFormulario((form) => {
    const grupo = (name) => form.querySelector(`[data-campo="${name}"]`);

    const grupoCategoria = grupo('categoria_id');
    const grupoDestino = grupo('conta_destino_id');
    const selectDestino = form.querySelector('select[name="conta_destino_id"]');
    const selectCategoria = form.querySelector('select[name="categoria_id"]');
    const rotuloConta = form.querySelector('[data-campo="conta_id"] .campo-label');
    const selectConta = form.querySelector('select[name="conta_id"]');
    if (!grupoDestino || !selectDestino) return;

    // Podem nao existir (parcelar/fixar so´ aparecem em criacao/edicao respectivamente).
    const opcionais = ['parcelar', 'total_parcelas', 'fixar'].map(grupo).filter(Boolean);
    const checkParcelar = form.querySelector('input[name="parcelar"]');
    const checkFixar = form.querySelector('input[name="fixar"]');

    const aplicar = () => {
      const ehTransferencia = lerTipo(form) === 'transferencia';

      grupoDestino.classList.toggle('hidden', !ehTransferencia);
      grupoCategoria?.classList.toggle('hidden', ehTransferencia);

      // required so´ enquanto visivel: um required escondido trava o submit em silencio.
      selectDestino.required = ehTransferencia;

      if (ehTransferencia) {
        // A categoria fica para tras ao trocar o tipo; o backend a zera de qualquer
        // forma, mas deixar o select preenchido por baixo do campo escondido mentiria.
        if (selectCategoria) selectCategoria.value = '';

        // A origem passa a ser obrigatoria (fora da transferencia, "Sem conta" e´ valido).
        if (selectConta) selectConta.required = true;

        for (const g of opcionais) g.classList.add('hidden');
        if (checkParcelar) checkParcelar.checked = false;
        if (checkFixar) checkFixar.checked = false;

        // O destino nao pode ser a origem: some da lista o que ja´ esta´ escolhido de la´.
        for (const opcao of selectDestino.options) {
          if (!opcao.value) continue;
          opcao.hidden = selectConta ? opcao.value === selectConta.value : false;
        }
        if (selectDestino.value && selectDestino.value === selectConta?.value) selectDestino.value = '';
      } else {
        if (selectConta) selectConta.required = false;
        // 'parcelar' so´ existe na criacao e 'total_parcelas' so´ abre com ele marcado --
        // devolver os dois visiveis aqui reabriria o "em quantas vezes" sozinho.
        for (const g of opcionais) {
          if (g !== grupo('total_parcelas')) g.classList.remove('hidden');
        }
      }

      if (rotuloConta) {
        rotuloConta.textContent = ehTransferencia ? 'Da conta' : 'Conta';
      }
    };

    aplicar();
    form.addEventListener('change', aplicar);
    form.addEventListener('click', aplicar);
  });
}

/**
 * O campo "em quantas vezes" so´ aparece com o parcelar ligado, e o rotulo do valor
 * vira "Valor total da compra" -- porque e´ o total que voce digita, nao a parcela.
 * A previa ("10x de R$ 400,00") existe para o usuario conferir a divisao ANTES de
 * gravar 10 lancamentos no banco.
 */
function ligarParcelamento() {
  aoMontarFormulario((form) => {
    const check = form.querySelector('input[name="parcelar"]');
    const grupoVezes = form.querySelector('[data-campo="total_parcelas"]');
    const inputVezes = form.querySelector('input[name="total_parcelas"]');
    const inputValor = form.querySelector('input[name="valor"]');
    const rotuloValor = form.querySelector('[data-campo="valor"] .campo-label');
    if (!check || !grupoVezes || !inputVezes || !inputValor) return;

    const previa = el('small', { class: 'campo-dica parcela-previa' });
    grupoVezes.appendChild(previa);

    const atualizarPrevia = () => {
      const vezes = Number(inputVezes.value);
      const total = Number(inputValor.value);

      if (!Number.isInteger(vezes) || vezes < MIN_PARCELAS || vezes > MAX_PARCELAS) {
        previa.textContent = `Escolha entre ${MIN_PARCELAS} e ${MAX_PARCELAS} parcelas.`;
      } else if (!Number.isFinite(total) || total <= 0) {
        previa.textContent = 'Informe o valor total da compra para ver o valor de cada parcela.';
      } else {
        previa.textContent = `${descreverDivisao(total, vezes)} · total ${fmtMoeda(total)}`;
      }
    };

    const sincronizar = () => {
      const ligado = check.checked;
      grupoVezes.classList.toggle('hidden', !ligado);
      // O ' *' de campo obrigatorio e´ um <span> irmao: trocar so´ o nó de texto o preserva.
      if (rotuloValor?.firstChild) {
        rotuloValor.firstChild.textContent = ligado ? 'Valor total da compra' : 'Valor';
      }
      if (ligado && !inputVezes.value) inputVezes.value = '2';
      if (ligado) atualizarPrevia();
    };

    check.addEventListener('change', sincronizar);
    inputVezes.addEventListener('input', atualizarPrevia);
    inputValor.addEventListener('input', atualizarPrevia);
    sincronizar();
  });
}

/**
 * Descreve a divisao EXATAMENTE como o backend vai grava´-la (services/parcelas.js):
 * em centavos inteiros, com o resto distribuido nas primeiras parcelas. 100,00 em 3x
 * nao e´ "3x de 33,33" (isso perderia um centavo) -- e´ 33,34 + 33,33 + 33,33.
 */
function descreverDivisao(total, vezes) {
  const centavos = Math.round(total * 100);
  if (centavos < vezes) return `Valor pequeno demais para ${vezes} parcelas (daria menos de um centavo cada).`;

  const base = Math.floor(centavos / vezes);
  const resto = centavos - base * vezes;
  if (resto === 0) return `${vezes}x de ${fmtMoeda(base / 100)}`;

  return `${resto}x de ${fmtMoeda((base + 1) / 100)} e ${vezes - resto}x de ${fmtMoeda(base / 100)}`;
}

// --- Categorias -------------------------------------------------------

export function formCategoria(cat) {
  const edicao = Boolean(cat);
  // Categoria em uso tem lancamentos apontando para o par (id, tipo): a FK composta
  // impede a troca de tipo (o backend devolveria 409).
  const tipoTravado = edicao && Boolean(cat.em_uso);

  abrirModal({
    titulo: edicao ? 'Editar categoria' : 'Nova categoria',
    okLabel: edicao ? 'Salvar' : 'Criar',
    campos: [
      {
        name: 'nome',
        label: 'Nome',
        tipo: 'texto',
        obrigatorio: true,
        largura: 'cheio',
        placeholder: 'Ex.: Alimentação',
      },
      {
        name: 'tipo',
        label: 'Tipo',
        tipo: 'segmentado',
        opcoes: TIPOS_RECEITA_DESPESA,
        obrigatorio: true,
        largura: 'cheio',
        desabilitado: tipoTravado,
        dica: tipoTravado
          ? 'O tipo não pode ser alterado: já existem lançamentos usando esta categoria.'
          : undefined,
      },
      { name: 'cor', label: 'Cor', tipo: 'cor', opcoes: opcoesCor(), largura: 'cheio' },
      {
        name: 'icone',
        label: 'Ícone',
        tipo: 'icone',
        opcoes: opcoesIcone(ICONES_CATEGORIA),
        largura: 'cheio',
      },
    ],
    valores: {
      nome: cat?.nome ?? '',
      tipo: cat?.tipo ?? 'despesa',
      cor: cat?.cor ?? COR_PADRAO,
      icone: cat?.icone ?? ICONE_CATEGORIA_PADRAO,
    },
    onSubmit: async (v) => {
      const dados = {
        nome: v.nome,
        cor: v.cor,
        icone: v.icone,
      };
      // Campo desabilitado nao chega no submit; e o backend mantem o tipo atual quando ausente.
      if (!tipoTravado) dados.tipo = v.tipo;

      if (edicao) await api.categorias.atualizar(cat.id, dados);
      else await api.categorias.criar(dados);

      await depoisDeSalvar(edicao ? 'Categoria atualizada.' : 'Categoria criada.', {
        recarregar: true,
      });
    },
  });

  if (tipoTravado) desabilitarCampo('tipo');
}

// --- Contas -----------------------------------------------------------

export function formConta(conta) {
  const edicao = Boolean(conta);

  const campos = [
    {
      name: 'nome',
      label: 'Nome',
      tipo: 'texto',
      obrigatorio: true,
      largura: 'cheio',
      placeholder: 'Ex.: Conta do banco',
    },
    {
      name: 'tipo',
      label: 'Tipo',
      tipo: 'select',
      opcoes: opcoesTipoConta(),
      obrigatorio: true,
      largura: 'meio',
      dica: 'Gerencie os tipos em Configurações › Tipos de conta.',
    },
    {
      name: 'saldo_inicial',
      label: 'Saldo inicial',
      tipo: 'numero', // 'dinheiro' exigiria > 0; saldo de abertura pode ser 0 ou negativo.
      step: 0.01,
      largura: 'meio',
      dica: 'Pode ser zero ou negativo (ex.: cartão com fatura em aberto).',
    },
    { name: 'cor', label: 'Cor', tipo: 'cor', opcoes: opcoesCor(), largura: 'cheio' },
  ];

  if (edicao) {
    campos.push({
      name: 'arquivada',
      label: 'Arquivar conta',
      tipo: 'checkbox',
      largura: 'cheio',
      dica: 'Contas arquivadas somem dos formulários, mas o histórico é mantido.',
    });
  }

  abrirModal({
    titulo: edicao ? 'Editar conta' : 'Nova conta',
    okLabel: edicao ? 'Salvar' : 'Criar',
    campos,
    valores: {
      nome: conta?.nome ?? '',
      // Sem chutar 'corrente': o usuario pode ter renomeado/apagado esse tipo.
      tipo: conta?.tipo ?? state.tiposConta[0]?.chave ?? '',
      saldo_inicial: conta?.saldo_inicial ?? 0,
      cor: conta?.cor ?? COR_PADRAO,
      arquivada: conta?.arquivada ?? false,
    },
    onSubmit: async (v) => {
      const saldo = Number(v.saldo_inicial === '' || v.saldo_inicial === null ? 0 : v.saldo_inicial);
      if (!Number.isFinite(saldo)) {
        throw new ApiError('Informe um número válido.', 400, 'saldo_inicial');
      }

      const dados = {
        nome: v.nome,
        tipo: v.tipo,
        saldo_inicial: Math.round(saldo * 100) / 100,
        cor: v.cor,
      };
      if (edicao) dados.arquivada = marcado(v.arquivada);

      if (edicao) await api.contas.atualizar(conta.id, dados);
      else await api.contas.criar(dados);

      await depoisDeSalvar(edicao ? 'Conta atualizada.' : 'Conta criada.', { recarregar: true });
    },
  });
}

// --- Tipos de conta ---------------------------------------------------

const ICONES_TIPO_CONTA = [
  '🏦', '🐖', '👛', '💳', '📈', '💰', '💵', '🧾', '🪙', '📊',
  '🏧', '🎫', '🍽️', '🎁', '📱', '🔒', '🧳', '🏢', '🤝', '📦',
];

const ICONE_TIPO_CONTA_PADRAO = '🏦';

/**
 * O nome e´ editavel, mas a CHAVE (derivada do nome na criacao) nunca muda -- e´ ela
 * que as contas guardam. Por isso renomear e´ seguro: nenhuma conta e´ reescrita.
 */
export function formTipoConta(tipo) {
  const edicao = Boolean(tipo);

  abrirModal({
    titulo: edicao ? 'Editar tipo de conta' : 'Novo tipo de conta',
    okLabel: edicao ? 'Salvar' : 'Criar',
    campos: [
      {
        name: 'rotulo',
        label: 'Nome',
        tipo: 'texto',
        obrigatorio: true,
        largura: 'cheio',
        placeholder: 'Ex.: Vale-alimentação',
        dica: edicao && tipo.contas > 0
          ? `${tipo.contas} conta(s) usam este tipo. Renomear aqui muda o nome em todas elas.`
          : undefined,
      },
      {
        name: 'icone',
        label: 'Ícone',
        tipo: 'icone',
        opcoes: opcoesIcone(ICONES_TIPO_CONTA),
        largura: 'cheio',
      },
    ],
    valores: {
      rotulo: tipo?.rotulo ?? '',
      icone: tipo?.icone ?? ICONE_TIPO_CONTA_PADRAO,
    },
    onSubmit: async (v) => {
      const dados = { rotulo: v.rotulo, icone: v.icone };

      if (edicao) await api.tiposConta.atualizar(tipo.id, dados);
      else await api.tiposConta.criar(dados);

      await depoisDeSalvar(edicao ? 'Tipo de conta atualizado.' : 'Tipo de conta criado.', {
        recarregar: true,
      });
    },
  });
}

// --- Orcamentos -------------------------------------------------------

/**
 * `jaOrcadas` (opcional) evita oferecer categoria que ja tem orcamento (o POST devolveria 409).
 * Aceita ids ou os proprios orcamentos vindos de GET /api/orcamentos.
 */
export function formOrcamento(orc, jaOrcadas = []) {
  const edicao = Boolean(orc);

  const usadas = new Set(
    (jaOrcadas ?? []).map((item) =>
      paraCampo(item && typeof item === 'object' ? item.categoria_id : item),
    ),
  );

  const disponiveis = categoriasPorTipo('despesa').filter((c) => !usadas.has(String(c.id)));

  if (!edicao && disponiveis.length === 0) {
    const semCategorias = categoriasPorTipo('despesa').length === 0;
    toast(
      semCategorias
        ? 'Crie uma categoria de despesa antes de definir um orçamento.'
        : 'Todas as categorias de despesa já têm orçamento.',
      'info',
    );
    return;
  }

  const campos = [];

  if (!edicao) {
    campos.push({
      name: 'categoria_id',
      label: 'Categoria',
      tipo: 'select',
      obrigatorio: true,
      largura: 'cheio',
      opcoes: [
        { valor: '', rotulo: 'Selecione uma categoria' },
        ...disponiveis.map((c) => ({
          valor: String(c.id),
          rotulo: `${c.icone ?? ''} ${c.nome}`.trim(),
          cor: c.cor,
        })),
      ],
    });
  }

  campos.push({
    name: 'limite',
    label: 'Limite mensal',
    tipo: 'dinheiro',
    obrigatorio: true,
    largura: 'cheio',
    // Na edicao a categoria e fixa (PUT /api/orcamentos/:id so aceita limite).
    dica: edicao
      ? `Categoria: ${`${orc.categoria_icone ?? ''} ${orc.categoria_nome ?? ''}`.trim()}`
      : 'Teto de gastos por mês nesta categoria.',
  });

  abrirModal({
    titulo: edicao ? 'Editar orçamento' : 'Novo orçamento',
    okLabel: edicao ? 'Salvar' : 'Criar',
    campos,
    valores: {
      categoria_id: '',
      limite: orc?.limite ?? '',
    },
    onSubmit: async (v) => {
      const limite = moedaObrigatoria(v.limite, 'limite');

      if (edicao) {
        await api.orcamentos.atualizar(orc.id, { limite });
      } else {
        const categoriaId = idOuNull(v.categoria_id);
        if (!categoriaId) throw new ApiError('Escolha uma categoria.', 400, 'categoria_id');
        await api.orcamentos.criar({ categoria_id: categoriaId, limite });
      }

      await depoisDeSalvar(edicao ? 'Orçamento atualizado.' : 'Orçamento criado.');
    },
  });
}

// --- Metas ------------------------------------------------------------

export function formMeta(meta) {
  const edicao = Boolean(meta);

  abrirModal({
    titulo: edicao ? 'Editar meta' : 'Nova meta',
    okLabel: edicao ? 'Salvar' : 'Criar',
    campos: [
      {
        name: 'nome',
        label: 'Nome',
        tipo: 'texto',
        obrigatorio: true,
        largura: 'cheio',
        placeholder: 'Ex.: Reserva de emergência',
      },
      { name: 'valor_alvo', label: 'Valor alvo', tipo: 'dinheiro', obrigatorio: true, largura: 'meio' },
      {
        name: 'prazo',
        label: 'Prazo',
        tipo: 'data',
        largura: 'meio',
        dica: 'Opcional: deixe em branco para meta sem data.',
      },
      { name: 'cor', label: 'Cor', tipo: 'cor', opcoes: opcoesCor(), largura: 'cheio' },
      {
        name: 'icone',
        label: 'Ícone',
        tipo: 'icone',
        opcoes: opcoesIcone(ICONES_META),
        largura: 'cheio',
      },
    ],
    valores: {
      nome: meta?.nome ?? '',
      valor_alvo: meta?.valor_alvo ?? '',
      prazo: meta?.prazo ?? '',
      cor: meta?.cor ?? COR_META_PADRAO,
      icone: meta?.icone ?? ICONE_META_PADRAO,
    },
    onSubmit: async (v) => {
      const dados = {
        nome: v.nome,
        valor_alvo: moedaObrigatoria(v.valor_alvo, 'valor_alvo'),
        prazo: textoOuNull(v.prazo), // null limpa o prazo; 'concluida' fica como esta (nao enviamos)
        cor: v.cor,
        icone: v.icone,
      };

      if (edicao) await api.metas.atualizar(meta.id, dados);
      else await api.metas.criar(dados);

      await depoisDeSalvar(edicao ? 'Meta atualizada.' : 'Meta criada.');
    },
  });
}

export function formAporte(meta) {
  if (!meta) return;

  abrirModal({
    titulo: `Aporte em ${meta.nome}`,
    okLabel: 'Registrar',
    campos: [
      {
        name: 'valor',
        label: 'Valor',
        tipo: 'numero', // 'dinheiro' exigiria > 0; resgate e um aporte negativo.
        step: 0.01,
        obrigatorio: true,
        largura: 'meio',
        dica: 'Use valor negativo para resgatar.',
      },
      { name: 'data', label: 'Data', tipo: 'data', obrigatorio: true, largura: 'meio' },
      {
        name: 'observacao',
        label: 'Observação',
        tipo: 'texto',
        largura: 'cheio',
        placeholder: 'Opcional',
      },
    ],
    valores: { valor: '', data: hoje(), observacao: '' },
    onSubmit: async (v) => {
      const bruto = Number(v.valor);
      if (v.valor === '' || v.valor === null || !Number.isFinite(bruto)) {
        throw new ApiError('Informe um valor.', 400, 'valor');
      }

      // Arredonda como o backend antes de comparar: 0,004 tambem e zero para o banco.
      const valor = Math.round(bruto * 100) / 100;
      if (valor === 0) {
        throw new ApiError(
          'O valor não pode ser zero: use positivo para aportar ou negativo para resgatar.',
          400,
          'valor',
        );
      }

      await api.metas.aportar(meta.id, {
        valor,
        data: v.data,
        observacao: textoOuNull(v.observacao),
      });

      await depoisDeSalvar(valor > 0 ? 'Aporte registrado.' : 'Resgate registrado.');
    },
  });
}

// --- Recorrentes ------------------------------------------------------

export function formRecorrente(rec) {
  const edicao = Boolean(rec);
  const tipoInicial = rec?.tipo ?? 'despesa';

  abrirModal({
    titulo: edicao ? 'Editar lançamento fixo' : 'Novo lançamento fixo',
    okLabel: edicao ? 'Salvar' : 'Criar',
    campos: [
      {
        name: 'tipo',
        label: 'Tipo',
        tipo: 'segmentado',
        opcoes: TIPOS_RECEITA_DESPESA,
        obrigatorio: true,
        largura: 'cheio',
      },
      {
        name: 'descricao',
        label: 'Descrição',
        tipo: 'texto',
        obrigatorio: true,
        largura: 'cheio',
        placeholder: 'Ex.: Aluguel',
      },
      { name: 'valor', label: 'Valor', tipo: 'dinheiro', obrigatorio: true, largura: 'meio' },
      {
        name: 'frequencia',
        label: 'Frequência',
        tipo: 'select',
        opcoes: FREQUENCIAS,
        obrigatorio: true,
        largura: 'meio',
      },
      {
        name: 'categoria_id',
        label: 'Categoria',
        tipo: 'select',
        opcoes: opcoesCategoria(tipoInicial),
        placeholder: SEM_CATEGORIA,
        largura: 'meio',
      },
      {
        name: 'conta_id',
        label: 'Conta',
        tipo: 'select',
        opcoes: opcoesConta(rec?.conta_id),
        placeholder: SEM_CONTA,
        largura: 'meio',
      },
      {
        name: 'proxima_data',
        label: 'Próxima data',
        tipo: 'data',
        obrigatorio: true,
        largura: 'meio',
        dica: 'O lançamento é criado automaticamente quando a data chega.',
      },
      {
        name: 'data_fim',
        label: 'Repetir até',
        tipo: 'data',
        largura: 'meio',
        dica: 'Opcional: deixe em branco para repetir sem fim.',
      },
    ],
    valores: {
      tipo: tipoInicial,
      descricao: rec?.descricao ?? '',
      valor: rec?.valor ?? '',
      frequencia: rec?.frequencia ?? 'mensal',
      categoria_id: paraCampo(rec?.categoria_id),
      conta_id: edicao ? paraCampo(rec.conta_id) : contaPadrao(),
      proxima_data: rec?.proxima_data ?? hoje(),
      data_fim: rec?.data_fim ?? '',
    },
    onSubmit: async (v) => {
      const proximaData = v.proxima_data;
      const dataFim = textoOuNull(v.data_fim);

      // Datas 'AAAA-MM-DD' comparam lexicograficamente na ordem cronologica.
      if (dataFim && dataFim < proximaData) {
        throw new ApiError('A data final deve ser igual ou posterior à próxima data.', 400, 'data_fim');
      }

      const dados = {
        descricao: v.descricao,
        valor: moedaObrigatoria(v.valor, 'valor'),
        tipo: v.tipo,
        frequencia: v.frequencia,
        proxima_data: proximaData,
        data_fim: dataFim,
        categoria_id: idOuNull(v.categoria_id),
        conta_id: idOuNull(v.conta_id),
      };

      // 'ativa' nao vai no corpo: ausente, o backend preserva o valor atual.
      if (edicao) await api.recorrentes.atualizar(rec.id, dados);
      else await api.recorrentes.criar(dados);

      await depoisDeSalvar(edicao ? 'Lançamento fixo atualizado.' : 'Lançamento fixo criado.');
    },
  });

  ligarFiltroCategoria(tipoInicial);
}

// --- Exclusao com confirmacao ----------------------------------------

/**
 * Confirma, executa `acao()` e avisa as views. Devolve true se excluiu.
 * `recarregar`: true quando a exclusao mexe em categoria/conta (ou no saldo delas).
 * `okLabel`: sem ele o botao diria "Confirmar" -- as telas que dizem "Excluir" no
 * botao precisam continuar dizendo.
 */
export async function excluirCom({
  titulo,
  msg,
  okLabel,
  acao,
  sucesso = 'Registro excluído.',
  recarregar = false,
}) {
  const confirmado = await confirmar({ titulo, msg, okLabel });
  if (!confirmado) return false;

  try {
    await acao();
  } catch (err) {
    toast(err instanceof ApiError ? err.message : 'Não consegui excluir. Tente de novo.', 'erro');
    return false;
  }

  await depoisDeSalvar(sucesso, { recarregar });
  return true;
}
