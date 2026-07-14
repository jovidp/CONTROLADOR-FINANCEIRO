/**
 * Definicoes de formulario reutilizadas pela topbar e pelas views.
 * Cada funcao monta os campos, abre o modal (ui.js) e salva via api.js.
 * Contrato: docs/FRONTEND.md e docs/API.md.
 *
 * Regra pos-escrita: mexeu em categoria/conta (ou em algo que derive delas, como o
 * saldo das contas) -> await carregarBase(); sempre emitir() + toast().
 */

import { api, ApiError } from './api.js';
import { abrirModal, confirmar, fmtMoeda, hoje, toast } from './ui.js';
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

/**
 * Transferencia nao e´ um terceiro "tipo de gasto": e´ outro formulario. A categoria some
 * (nao ha´ o que classificar num dinheiro que continua seu -- e o backend RECUSA
 * transferencia com categoria_id, entao o campo tem que sumir de verdade: campo invisivel
 * vale null no submit, e´ isso que o ui.js garante), a conta de destino aparece, e "Conta"
 * vira "Da conta" -- porque agora ela e´ a ORIGEM, nao "a conta". Parcelar e fixar tambem
 * somem: o backend os recusa, e checkbox que so´ existe para dar erro no submit e´ pior do
 * que checkbox nenhum.
 */
const ehTransferencia = (v) => v.tipo === 'transferencia';

/**
 * Parcelar so´ existe para DESPESA.
 *
 * "Receita em 3x" nao e´ uma coisa: dinheiro que entra parcelado sao tres entradas, cada
 * uma no dia em que cai -- e´ so´ lancar as tres, ou marcar como recorrente. O formulario
 * oferecia o "parcelar" para receita tambem, e o backend aceitava; quem marcasse geraria
 * um parcelamento de receita, que nao significa nada e ainda apareceria na tela de
 * compras parceladas.
 */
const ehDespesa = (v) => v.tipo === 'despesa';

/**
 * Descreve a divisao EXATAMENTE como o backend vai grava´-la, para o usuario conferir ANTES
 * de gravar 10 lancamentos no banco.
 */
function previaParcelas(total, vezes) {
  const n = Number(vezes);
  if (!Number.isInteger(n) || n < MIN_PARCELAS || n > MAX_PARCELAS) {
    return `Escolha entre ${MIN_PARCELAS} e ${MAX_PARCELAS} parcelas.`;
  }

  const bruto = Number(total);
  if (!Number.isFinite(bruto) || bruto <= 0) {
    return 'Informe o valor total da compra para ver o valor de cada parcela.';
  }

  return `${descreverDivisao(bruto, n)} · total ${fmtMoeda(bruto)}`;
}

export function formTransacao(tx) {
  const edicao = Boolean(tx);
  const tipoInicial = tx?.tipo ?? 'despesa';

  // Parcelar so´ faz sentido ao CRIAR. Editando, voce esta´ mexendo numa parcela
  // especifica -- transformar ela em compra nova aqui so´ geraria confusao.
  const podeParcelar = !edicao;

  // "Fixo" nao e´ uma etiqueta: e´ ter vindo de um lancamento recorrente (NATUREZA_SQL,
  // no backend). Por isso marcar aqui CRIA a recorrente. So´ oferecemos para o lancamento
  // avulso: quem ja´ e´ fixo nao tem o que marcar, e uma parcela nao se repete para sempre.
  const podeFixar = edicao && !tx.recorrente_id && !tx.parcelamento_id;

  const parcelando = (v) => podeParcelar && ehDespesa(v) && marcado(v.parcelar);

  // Tudo o que um campo faz com OUTRO campo. Registrado como onChange dos campos que
  // importam, entao vive e morre com o modal -- nada e´ pendurado no #modalForm, que e´ no
  // permanente do index.html e ficaria com o handler preso depois que o modal fechasse.
  const aoMudar = (_, campos) => {
    const v = campos.valores();

    campos.rotulo('conta_id', ehTransferencia(v) ? 'Da conta' : 'Conta');
    // O total que voce digita nao e´ a parcela: e´ a compra inteira.
    campos.rotulo('valor', parcelando(v) ? 'Valor total da compra' : 'Valor');

    if (ehTransferencia(v)) {
      // O destino nao pode ser a origem: ela sai da lista (e a selecao cai fora se era ela).
      campos.repovoar(
        'conta_destino_id',
        opcoesConta(tx?.conta_destino_id).filter((o) => o.valor !== paraCampo(v.conta_id)),
      );
    } else {
      // Categoria pertence ao par (tipo, id) -- a FK e´ composta. Trocar Despesa <-> Receita
      // troca a lista inteira. Na transferencia nao repovoamos: categoriasPorTipo() so´ filtra
      // receita/despesa e devolveria TODAS as categorias para 'transferencia' -- justo no campo
      // que nem esta´ na tela.
      campos.repovoar('categoria_id', opcoesCategoria(v.tipo));
    }

    campos.dica('total_parcelas', parcelando(v) ? previaParcelas(v.valor, v.total_parcelas) : '');
  };

  const camposParcelamento = podeParcelar
    ? [
        {
          name: 'parcelar',
          label: 'Parcelar esta compra',
          tipo: 'checkbox',
          largura: 'cheio',
          // So´ em despesa. Trocar para Receita esconde o campo -- e campo escondido vale
          // null no submit, entao a marcacao nao vaza para o POST de parcelamento.
          visivel: ehDespesa,
          onChange: (ligado, campos) => {
            // Semente: abrir o campo vazio faria a previa ja´ nascer reclamando. So´ aqui --
            // no aoMudar geral, isso repreencheria o campo a cada tecla e o usuario nunca
            // conseguiria apagar o "2" para digitar outro numero.
            if (ligado && !campos.valores().total_parcelas) campos.set('total_parcelas', MIN_PARCELAS);
            aoMudar(ligado, campos);
          },
        },
        {
          name: 'total_parcelas',
          label: 'Em quantas vezes',
          tipo: 'numero',
          largura: 'meio',
          min: String(MIN_PARCELAS),
          max: String(MAX_PARCELAS),
          placeholder: '12',
          dicaClasse: 'parcela-previa',
          visivel: parcelando,
          onChange: aoMudar,
        },
      ]
    : [];

  const campoFixar = podeFixar
    ? [
        {
          name: 'fixar',
          label: 'É um lançamento fixo (repete todo mês)',
          tipo: 'checkbox',
          largura: 'cheio',
          visivel: (v) => !ehTransferencia(v),
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
        onChange: aoMudar,
      },
      {
        name: 'descricao',
        label: 'Descrição',
        tipo: 'texto',
        obrigatorio: true,
        largura: 'cheio',
        placeholder: 'Ex.: Mercado do mês',
      },
      {
        name: 'valor',
        label: 'Valor',
        tipo: 'dinheiro',
        obrigatorio: true,
        largura: 'meio',
        onChange: aoMudar, // o rotulo e a previa das parcelas dependem dele
      },
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
        visivel: (v) => !ehTransferencia(v),
      },
      {
        name: 'conta_id',
        label: 'Conta',
        tipo: 'select',
        opcoes: opcoesConta(tx?.conta_id),
        placeholder: SEM_CONTA,
        largura: 'meio',
        // Fora da transferencia, "Sem conta" e´ uma escolha valida; na transferencia ela e´
        // a origem do dinheiro, e sem origem nao ha´ o que transferir.
        obrigatorio: ehTransferencia,
        onChange: aoMudar, // a origem some da lista de destinos
      },
      {
        name: 'conta_destino_id',
        label: 'Para a conta',
        tipo: 'select',
        opcoes: opcoesConta(tx?.conta_destino_id),
        placeholder: 'Escolha o destino',
        largura: 'meio',
        visivel: ehTransferencia,
        obrigatorio: ehTransferencia,
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

      // parcelando() e´ o MESMO predicado que decide se o campo aparece: se ele nao esta´ na
      // tela, nao pode virar parcelamento no submit. Checar `marcado(v.parcelar)` solto
      // deixaria a porta aberta para uma receita marcada antes da troca de tipo.
      if (parcelando(v)) {
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
        disabled: tipoTravado,
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
        // O tipo que a view mandou pode estar velho (e ja´ ficou): o onChange dispara na
        // abertura com o valor que o controle REALMENTE tem, entao a lista sai certa aqui
        // e continua certa a cada troca.
        onChange: (tipo, campos) => campos.repovoar('categoria_id', opcoesCategoria(tipo)),
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
