# Contrato da API — Controlador Financeiro

Fonte única de verdade. Backend implementa exatamente isto; frontend consome exatamente isto.

- Base: `/api`. Corpo e resposta sempre JSON.

## `/api/auth`
- `GET /api/auth/status` → `{ cadastrado, usuario, legado }` (público; informa se o primeiro cadastro já foi feito).
- `POST /api/auth/cadastro` body `{ usuario, senha, confirmacao }` → `201` (público; disponível somente enquanto não houver usuário cadastrado).
- `POST /api/auth/login` body `{ usuario, senha, lembrar? }` → `200` e cookie de sessão.
- `GET /api/auth/sessao` → estado da sessão atual.
- `POST /api/auth/logout` → `204` e remove o cookie.
- Dinheiro: `number` com 2 casas, **sempre positivo**. O sinal vem de `tipo` (`receita` | `despesa`).
- Datas: string `AAAA-MM-DD`. Mês: string `AAAA-MM`. Nunca enviar/receber `Date` serializado.
- Erro: status HTTP adequado + corpo `{ "erro": "mensagem em pt-BR", "campo": "nome_do_campo" }` (campo é opcional).
- Sucesso: `200` (leitura/atualização), `201` (criação), `204` (remoção, sem corpo).

## Regra de integridade (garantida pelo banco)
Uma transação/orçamento/recorrente de tipo `despesa` **só** aceita categoria de tipo `despesa` (idem receita).
Violar isso devolve `409`. `categoria_id` pode ser `null` ("sem categoria").

---

## GET /api/health
`200 → { ok: true, agora, banco, versao }`

## /api/categorias
- `GET /api/categorias?tipo=receita|despesa` → `200 → Categoria[]` ordenado por tipo, nome.
  `Categoria = { id, nome, tipo, cor, icone, em_uso: boolean }` (`em_uso` = existe transação vinculada).
- `POST /api/categorias` body `{ nome, tipo, cor?, icone? }` → `201 → Categoria`
- `PUT /api/categorias/:id` body `{ nome, cor?, icone? }` → `200 → Categoria`
  Trocar `tipo` de categoria em uso → `409`.
- `DELETE /api/categorias/:id` → `204`. Transações vinculadas ficam com `categoria_id = null` (não são apagadas).

## /api/contas
- `GET /api/contas?incluir_arquivadas=true` → `200 → Conta[]`
  `Conta = { id, nome, tipo, cor, saldo_inicial, arquivada, receitas, despesas, saldo }` (saldo vem da view `vw_saldo_contas`).
- `POST /api/contas` body `{ nome, tipo?, saldo_inicial?, cor? }` → `201 → Conta`
- `PUT /api/contas/:id` body `{ nome, tipo?, saldo_inicial?, cor?, arquivada? }` → `200 → Conta`
- `DELETE /api/contas/:id` → `204`. Transações vinculadas ficam com `conta_id = null`.

`tipo` é a **chave** de um `/api/tipos-conta` do próprio usuário — não uma lista fixa.
Chave desconhecida → `400`. Ausente no POST → cai no primeiro tipo do usuário.

## /api/tipos-conta
Como o usuário classifica suas contas. Cada tipo tem uma `chave` estável (derivada do nome
na criação, e imutável — é o que `contas.tipo` guarda) e um `rotulo`/`icone` editáveis.

- `GET /api/tipos-conta` → `200 → TipoConta[]` ordenado por rótulo.
  `TipoConta = { id, chave, rotulo, icone, contas }` (`contas` = quantas contas usam o tipo).
- `POST /api/tipos-conta` body `{ rotulo, icone? }` → `201 → TipoConta`
  A chave sai do rótulo ("Vale-Alimentação" → `vale-alimentacao`). Rótulo/chave repetido → `409`.
  Rótulo sem nenhuma letra ou número (`"###"`) → `400`.
- `PUT /api/tipos-conta/:id` body `{ rotulo, icone? }` → `200 → TipoConta`
  Só o rótulo e o ícone mudam. **A chave nunca muda**, então renomear não reescreve conta nenhuma.
- `DELETE /api/tipos-conta/:id` → `204`. Tipo em uso por alguma conta → `409` (a FK também barra).

## /api/transacoes
- `GET /api/transacoes` — query params (todos opcionais):
  `de` (AAAA-MM-DD), `ate`, `mes` (AAAA-MM, atalho que define de/ate), `tipo`, `categoria_id`,
  `conta_id`, `q` (busca na descrição, case-insensitive), `ordenar` (`data`|`valor`|`descricao`, default `data`),
  `direcao` (`asc`|`desc`, default `desc`), `limite` (default 100, máx 500), `offset` (default 0),
  `natureza` (lista separada por vírgula: `avulso`, `fixo`, `parcelado`; ausente = todas),
  `ocultas` (`excluir` (default) | `incluir` | `apenas`).
  → `200 → { itens: Transacao[], total: number, ocultos: number, resumo: { receitas, despesas, saldo } }`
  `total` e `resumo` refletem **todos** os registros do filtro, não só a página.
  **`resumo` NUNCA soma lançamento oculto**, nem com `ocultas=incluir` — nesse modo a lista
  mostra a linha (riscada), mas o dinheiro continua fora, para bater com o painel.
  `total` (usado pela paginação) acompanha a lista. `ocultos` diz quantos ficaram de fora.
  `Transacao = { id, descricao, valor, tipo, data, categoria_id, categoria_nome, categoria_cor, categoria_icone, conta_id, conta_nome, conta_cor, observacao, recorrente_id, oculta, parcelamento_id, parcela_num, total_parcelas, parcelamento_total, natureza }`
  `natureza` é **derivada**, não é coluna: `parcelado` se veio de um parcelamento, `fixo` se veio
  de um recorrente, `avulso` no resto.
- `POST /api/transacoes` body `{ descricao, valor, tipo, data, categoria_id?, conta_id?, observacao? }` → `201 → Transacao`
- `PUT /api/transacoes/:id` mesmo body → `200 → Transacao`
- `PATCH /api/transacoes/:id/oculta` body `{ oculta: boolean }` → `200 → Transacao`
  Esconder não apaga: a linha fica no banco, mas sai da lista e **de todos os totais**
  (painel, relatórios, orçamentos e saldo das contas). Sempre reversível.
- `POST /api/transacoes/:id/fixar` body `{ frequencia? }` (default `mensal`) → `200 → Transacao`
  Transforma um lançamento avulso em **fixo**. Como `natureza` é derivada, isso não é um flag:
  cria um `/api/recorrentes` com os dados da transação e vincula os dois (numa transação só).
  A recorrente já nasce apontando para a **próxima** ocorrência — a desta transação é ela mesma.
  Transação que já é fixa → `409`. Parcela de compra parcelada → `400`.
- `DELETE /api/transacoes/:id` → `204`

## /api/parcelamentos
Compra dividida em N lançamentos mensais — um por mês, para o orçamento de cada mês
ficar honesto (12x de R$ 100 não pode virar R$ 1.200 num mês só).

- `GET /api/parcelamentos` → `200 → Parcelamento[]`
  `Parcelamento = { id, descricao, valor_total, total_parcelas, tipo, data_primeira, observacao, categoria_id, categoria_nome, categoria_cor, categoria_icone, conta_id, conta_nome, parcelas_pagas, restante }`
- `GET /api/parcelamentos/:id` → `200 → Parcelamento & { parcelas: { id, parcela_num, valor, data, oculta }[] }`
- `POST /api/parcelamentos` body `{ descricao, valor_total, total_parcelas (2..120), tipo, data_primeira, categoria_id?, conta_id?, observacao? }` → `201 → Parcelamento`
  Você informa o **total** da compra e em quantas vezes; o valor de cada parcela sai da divisão.
  Cria a compra **e** as N transações de uma vez, numa transação só. A parcela 1 cai em
  `data_primeira`; as demais, um mês depois cada (dia grampeado no fim do mês: 31/01 → 28/02).
  Os centavos que não dividem exato vão nas primeiras parcelas (100 em 3x = 33,34 + 33,33 + 33,33),
  então a soma bate **exatamente** com `valor_total`.
- `DELETE /api/parcelamentos/:id` → `204` — leva junto todas as parcelas (ON DELETE CASCADE).

## /api/orcamentos
- `GET /api/orcamentos?mes=AAAA-MM` (default: mês corrente) → `200 → Orcamento[]`
  `Orcamento = { id, categoria_id, categoria_nome, categoria_cor, categoria_icone, limite, gasto, restante, percentual, status }`
  `gasto` = soma das despesas daquela categoria **no mês pedido**. `percentual` = 0..N (pode passar de 100).
  `status` = `ok` (<75%) | `atencao` (75–99%) | `estourado` (>=100%).
- `POST /api/orcamentos` body `{ categoria_id, limite }` → `201 → Orcamento`. Categoria já orçada → `409`.
- `PUT /api/orcamentos/:id` body `{ limite, ativo? }` → `200 → Orcamento`
- `DELETE /api/orcamentos/:id` → `204`

## /api/metas
- `GET /api/metas` → `200 → Meta[]`
  `Meta = { id, nome, valor_alvo, prazo, cor, icone, concluida, guardado, restante, percentual, aportes: Aporte[] }`
  `guardado` = soma dos aportes. `Aporte = { id, valor, data, observacao }` (mais recentes primeiro).
- `POST /api/metas` body `{ nome, valor_alvo, prazo?, cor?, icone? }` → `201 → Meta`
- `PUT /api/metas/:id` body `{ nome, valor_alvo, prazo?, cor?, icone?, concluida? }` → `200 → Meta`
- `DELETE /api/metas/:id` → `204` (aportes vão junto, em cascata)
- `POST /api/metas/:id/aportes` body `{ valor, data?, observacao? }` → `201 → Meta` (meta inteira, já recalculada).
  `valor` pode ser negativo (resgate), mas nunca zero.
- `DELETE /api/metas/:id/aportes/:aporteId` → `204`

## /api/recorrentes
- `GET /api/recorrentes` → `200 → Recorrente[]`
  `Recorrente = { id, descricao, valor, tipo, categoria_id, categoria_nome, categoria_cor, categoria_icone, conta_id, conta_nome, frequencia, proxima_data, data_fim, ativa }`
- `POST /api/recorrentes` body `{ descricao, valor, tipo, frequencia, proxima_data, categoria_id?, conta_id?, data_fim? }` → `201 → Recorrente`
  `frequencia ∈ (diaria, semanal, mensal, anual)`
- `PUT /api/recorrentes/:id` mesmo body + `ativa?` → `200 → Recorrente`
- `DELETE /api/recorrentes/:id` → `204`. As transações já geradas **permanecem** (viram `recorrente_id = null`).
- `POST /api/recorrentes/processar` → `200 → { gerados: number }`
  Materializa em `transacoes` toda ocorrência com `proxima_data <= hoje`, avançando `proxima_data`
  conforme a frequência, até passar de hoje ou de `data_fim` (aí `ativa = false`).
  Deve ser **idempotente**: rodar duas vezes no mesmo dia não duplica lançamentos.

## /api/relatorios
- `GET /api/relatorios/resumo?mes=AAAA-MM` → `200 → { receitas, despesas, saldo, taxa_economia, variacao: { receitas_pct, despesas_pct, saldo_pct }, saldo_acumulado }`
  `variacao.*_pct` compara com o mês anterior (`null` se o mês anterior for zero).
  `taxa_economia` = (receitas - despesas) / receitas * 100 (0 se receitas = 0).
  `saldo_acumulado` = saldo de **todo o histórico** até o fim do mês pedido.
- `GET /api/relatorios/evolucao?meses=6&ate=AAAA-MM` → `200 → [{ mes, rotulo, receitas, despesas, saldo }]`
  Ordem cronológica. Meses sem movimento aparecem zerados (não podem sumir).
- `GET /api/relatorios/categorias?mes=AAAA-MM&tipo=despesa` (ou `de`/`ate`) → `200 → [{ categoria_id, nome, cor, icone, total, percentual, transacoes }]`
  Ordenado por `total` desc. Transações sem categoria entram como `{ categoria_id: null, nome: "Sem categoria" }`.
- `GET /api/relatorios/anual?ano=2026` → `200 → { meses: [{ mes, rotulo, receitas, despesas, saldo }] (12 itens), totais: { receitas, despesas, saldo }, media: { receitas, despesas }, melhor_mes, pior_mes }`
- `GET /api/relatorios/anos` → `200 → number[]` (anos que têm transações, desc; sempre inclui o ano corrente)
