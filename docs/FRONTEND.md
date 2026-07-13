# Contrato do frontend — Controlador Financeiro

ES Modules nativos servidos por `/js/...`. **Sem build step, sem framework, sem CDN** (o app precisa
funcionar offline). Nada de `localStorage` para dados de negócio — a fonte de verdade é o PostgreSQL,
sempre via `api`. (Única exceção permitida: a preferência de tema claro/escuro.)

Todo texto visível ao usuário é em **pt-BR**.

## `js/api.js`
```js
export class ApiError extends Error {}   // .status, .campo, .message (mensagem pt-BR vinda do backend)
export const api = {
  health(),
  categorias: { listar(params?), criar(dados), atualizar(id, dados), remover(id) },
  contas:     { listar(params?), criar(dados), atualizar(id, dados), remover(id) },
  transacoes: { listar(params?), criar(dados), atualizar(id, dados), remover(id) },
  orcamentos: { listar(params?), criar(dados), atualizar(id, dados), remover(id) },
  metas:      { listar(), criar(dados), atualizar(id, dados), remover(id),
                aportar(id, dados), removerAporte(id, aporteId) },
  recorrentes:{ listar(), criar(dados), atualizar(id, dados), remover(id), processar() },
  relatorios: { resumo(params), evolucao(params), categorias(params), anual(params), anos() },
};
```
Toda resposta não-ok vira `ApiError` com a mensagem do backend. `204` devolve `null`.

## `js/state.js`
```js
export const state = { mes, categorias, contas, carregado };  // mes = 'AAAA-MM'
export function setMes(mes);            // dispara mudança
export async function carregarBase();   // busca categorias + contas e guarda em state
export function onMudanca(fn);          // inscreve observador
export function emitir();               // notifica observadores (chamar após qualquer escrita)
export function categoriaPorId(id);     // -> Categoria | undefined
export function contaPorId(id);         // -> Conta | undefined
export function categoriasPorTipo(tipo);
```
Views **nunca** chamam re-render umas das outras: mutou → `await carregarBase()` se mexeu em
categoria/conta, depois `emitir()`. O `main.js` escuta e remonta a view ativa.

## `js/ui.js`
```js
export function el(tag, attrs, ...filhos);  // attrs: {class, onclick, ...}; filhos: string|Node|array
export function fmtMoeda(n);       // 1234.5  -> "R$ 1.234,50"
export function fmtMoedaCurta(n);  // 1234.5  -> "R$ 1,2 mil"   (para eixos de gráfico)
export function fmtData(iso);      // "2026-07-13" -> "13/07/2026"
export function fmtDataCurta(iso); // "2026-07-13" -> "13 jul"
export function fmtMesLongo(mes);  // "2026-07"    -> "julho de 2026"
export function fmtMesCurto(mes);  // "2026-07"    -> "jul/26"
export function fmtPct(n);         // 42.5 -> "42,5%"
export function hoje();            // 'AAAA-MM-DD' no fuso LOCAL (nunca toISOString direto)
export function mesAtual();        // 'AAAA-MM' local
export function toast(msg, tipo);  // tipo: 'ok' | 'erro' | 'info'
export function confirmar({ titulo, msg });        // -> Promise<boolean>
export function abrirModal({ titulo, campos, valores, onSubmit, okLabel });
export function fecharModal();
export function skeleton(container, linhas);       // placeholder de carregamento
export function vazio(container, { ico, msg, acao });  // acao: { texto, onClick } | undefined
```
`abrirModal` monta o form dentro de `#modalForm`. Cada campo:
`{ name, label, tipo, opcoes?, obrigatorio?, step?, min?, placeholder?, dica?, largura? }`
`tipo ∈ ('texto','numero','dinheiro','data','mes','select','textarea','cor','icone','checkbox','segmentado')`.
`largura: 'meio' | 'cheio'` (grid de 2 colunas). `opcoes: [{ valor, rotulo, cor?, icone? }]`.
`onSubmit(valores)` é async; se lançar `ApiError`, o modal mostra o erro **no campo** (`err.campo`) e
não fecha. Sucesso → fecha e mostra toast.

## `js/charts.js` — SVG puro, sem libs
```js
export function barrasAgrupadas(container, dados, opts); // [{ rotulo, receitas, despesas }]
export function donut(container, fatias, opts);          // [{ rotulo, valor, cor }]
export function barrasEmpilhadas(container, dados, opts);// relatório anual: 12 meses
export function sparkline(container, valores);
```
Responsivos via `viewBox` + `preserveAspectRatio`. Tooltip no `hover` (elemento absoluto, não `<title>`).
Estado vazio (todos os valores zero) → mensagem discreta, nunca um gráfico quebrado ou `NaN`.
Cores vêm das variáveis CSS: leia com `getComputedStyle(document.documentElement).getPropertyValue('--in')` etc.,
para que o gráfico acompanhe o tema claro/escuro.

## `js/forms.js` — definições de formulário reutilizadas pela topbar e pelas views
```js
export function formTransacao(tx);   // tx === undefined -> criação
export function formCategoria(cat);
export function formConta(conta);
export function formOrcamento(orc);
export function formMeta(meta);
export function formAporte(meta);
export function formRecorrente(rec);
```
Cada uma abre o modal, salva via `api`, chama `carregarBase()` quando necessário, `emitir()` e `toast()`.
No form de transação, trocar o tipo (receita/despesa) **refiltra** a lista de categorias na hora.

## `js/views/*.js`
Cada view exporta `export async function montar(container)`. É chamada ao ativar a view e sempre que
`emitir()` dispara ou o mês muda. Deve: limpar o container, mostrar `skeleton`, buscar via `api`,
renderizar, e tratar erro mostrando mensagem + botão "tentar de novo".
Views: `dashboard.js`, `transacoes.js`, `orcamentos.js`, `metas.js`, `recorrentes.js`,
`categorias.js`, `relatorios.js`, `config.js`.

## `js/main.js`
Roteamento por `data-view` na sidebar + `location.hash`, seletor de mês (‹ › e `<input type="month">`),
botão "+ Nova transação", alternador de tema (persiste só a preferência em `localStorage`),
menu hambúrguer no mobile. Assina `onMudanca` e remonta a view ativa. No boot:
`carregarBase()` → monta a view do hash → se a API estiver fora, mostra tela de erro explicando
que o PostgreSQL/servidor precisa estar rodando.
