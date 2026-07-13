# Controlador Financeiro

App de controle financeiro pessoal. Os dados ficam num **PostgreSQL de verdade rodando nesta máquina** —
não em `localStorage`, não no navegador. Se você limpar o cache do browser, nada se perde.

```
Navegador (HTML/CSS/JS, sem framework)
      |  fetch  /api/...
Node + Express            → http://localhost:3001
      |  driver pg (pool)
PostgreSQL 18             → localhost:5432
      |
banco: controlador_financeiro   (usuário da aplicação: fin_app)
```

## Como rodar

```powershell
npm start
```

Depois abra **http://localhost:3001**.

O servidor recusa a subir se não conseguir falar com o banco — ele diz exatamente qual credencial tentou usar.

## Comandos

| Comando | O que faz |
|---|---|
| `npm start` | Sobe a API + o app em http://localhost:3001 |
| `npm run dev` | Igual, com reload automático ao salvar arquivo |
| `npm run db:create` | Cria o banco e o usuário `fin_app` (idempotente; precisa da senha de superusuário no `.env`) |
| `npm run db:migrate` | Aplica as migrations de `db/migrations/` (idempotente) |
| `npm run db:seed` | Popula ~8 meses de dados de exemplo (**apaga os lançamentos existentes**) |
| `npm run db:limpar` | Zera o app para uso real: apaga lançamentos, metas, orçamentos e recorrentes e zera o saldo inicial das contas. Preserva categorias e contas. Exige `CONFIRMAR=sim` |
| `npm run db:reset` | Derruba e recria o schema. Exige `CONFIRMAR=sim` |
| `npm run smoke` | Testes de integridade contra o banco real (nada é persistido) |

## Estrutura

```
db/migrations/     schema SQL versionado
src/
  config.js        lê o .env
  db.js            pool do pg + parsers de tipo
  http.js          erros HTTP, validadores, tradução de erro do Postgres
  server.js        Express: monta as rotas, serve public/, error handler central
  routes/          uma rota por recurso
  services/        regras que não são CRUD (geração de lançamentos recorrentes)
  scripts/         create-db, migrate, seed, reset, smoke
public/            o frontend (ES Modules nativos, sem build)
docs/API.md        contrato da API — fonte única de verdade
docs/FRONTEND.md   contrato dos módulos do frontend
```

## Decisões que valem saber

**O banco impede categoria incoerente.** Uma transação de `despesa` não consegue apontar para uma categoria
de `receita` — não por validação na tela, mas por uma chave estrangeira composta `(categoria_id, tipo)`
referenciando `categorias(id, tipo)`. Nem um `INSERT` manual no `psql` passa.

**Apagar categoria não apaga histórico.** `ON DELETE SET NULL (categoria_id)` deixa as transações vivas,
apenas sem categoria. Orçamentos daquela categoria, esses sim, somem em cascata.

**Datas não escorregam de dia.** O driver `pg` foi configurado para devolver `DATE` como string crua
`AAAA-MM-DD`. Sem isso, uma transação de 01/07 vira 30/06 no fuso UTC-3.

**Dinheiro é `numeric(14,2)`, nunca `float`.** E o driver converte para `Number` na leitura, então não
existe `"10" + "5" = "105"` no meio do caminho.

## Backup

O backup é do banco, feito com `pg_dump`:

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\pg_dump.exe' -U fin_app -h localhost `
  -d controlador_financeiro -F c -f "backup-financeiro.dump"
```

Restaurar:

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\pg_restore.exe' -U fin_app -h localhost `
  -d controlador_financeiro --clean "backup-financeiro.dump"
```

## Credenciais

Ficam em `.env` (que está no `.gitignore`). Atenção a uma pegadinha: o `dotenv` trata `#` como início de
comentário, então **senha com `#` chega truncada** ao app. Se trocar a senha, evite `#` ou coloque o valor
entre aspas.
