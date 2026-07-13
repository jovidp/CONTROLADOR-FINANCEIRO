# Controlador Financeiro

Controle financeiro pessoal: lançamentos, contas, categorias, orçamentos, metas, compras
parceladas, lançamentos fixos e relatórios. Roda na sua máquina, contra um PostgreSQL
local — os dados não saem daqui.

Node + Express + PostgreSQL. **O frontend não tem build step**: são ES modules servidos
direto, sem framework, sem bundler e sem CDN (o app precisa funcionar offline). A única
dependência de desenvolvimento é o ESLint, que nunca chega ao navegador.

---

## Começando

Pré-requisitos: **Node 20+** e **PostgreSQL 16+** (o app roda no 18).

```bash
npm install
cp .env.example .env      # e edite: senha do Postgres, porta, etc.
npm run setup             # cria o banco e a role, e roda as migrations
npm start                 # http://localhost:3001
```

No Windows, o caminho normal é dar dois cliques em **`Iniciar Controlador.bat`**: ele
liga o serviço do PostgreSQL se estiver parado, pede o login no primeiro acesso, sobe o
servidor e abre o navegador.

O primeiro acesso cria o usuário pelo próprio navegador. Cada usuário nasce com um kit
padrão (14 categorias, 5 tipos de conta e uma conta corrente) e enxerga **apenas** os
próprios dados.

---

## Comandos

| Comando | O que faz |
|---|---|
| `npm start` | Sobe o servidor. |
| `npm run dev` | Idem, reiniciando a cada arquivo salvo. |
| `npm test` | Testes unitários (não precisam de banco). |
| `npm run lint` | ESLint no backend e no frontend. |
| `npm run smoke` | Testes de integridade contra o banco real (roda tudo em transação e dá ROLLBACK). |
| `npm run db:migrate` | Aplica as migrations pendentes. |
| `npm run db:backup` | Backup com `pg_dump` em `backups/`. |
| `npm run senha` | Gera/troca o hash da senha. |
| `npm run manutencao:on -- "motivo"` | Põe o app na página de manutenção. |
| `npm run manutencao:off` | Tira. |

### Comandos que apagam dados

Todos fazem **backup automático antes** e abortam se o backup falhar.

```bash
# Precisam do nome do banco em CONFIRMAR e, quando apagam lançamento, do USUARIO.
CONFIRMAR=controlador_financeiro USUARIO=5 npm run db:limpar   # zera os lançamentos de UM usuário
CONFIRMAR=controlador_financeiro USUARIO=5 npm run db:seed     # troca por dados de exemplo
CONFIRMAR=controlador_financeiro npm run db:reset              # DROP SCHEMA: apaga tudo, de todos
```

`CONFIRMAR` é o **nome do banco**, e não `sim`, de propósito: no PowerShell um
`$env:CONFIRMAR="sim"` continua valendo pela sessão inteira, e armava sem querer o
próximo comando destrutivo que você digitasse.

Rodar sem as variáveis não apaga nada — o script explica o que ia apagar e lista os
usuários para você escolher.

### Restaurar um backup

```bash
pg_restore -h localhost -U fin_app -d controlador_financeiro --clean backups/<arquivo>.dump
```

---

## Como está organizado

```
src/
  server.js        Express, modo de manutenção, e a checagem de porta ocupada
  auth.js          Login, hash scrypt, cookie de sessão assinado, freio de tentativas
  db.js            Pool do pg + os parsers de tipo (numeric → Number, date → string crua)
  http.js          Validadores de entrada e tradução dos erros do Postgres para HTTP
  manutencao.js    Liga/desliga a página de manutenção (via arquivo, não memória)
  routes/          Uma rota por recurso — todas exigem sessão
  services/        Regra de negócio: parcelas, recorrentes, kit padrão
  scripts/         migrate, backup, seed, limpar, reset, smoke, senha
db/migrations/     SQL numerado, aplicado em ordem, cada um dentro de uma transação
public/            O app: HTML, CSS e ES modules. Sem build.
test/              Testes unitários (node:test, sem dependência)
```

### Decisões que valem saber

**O saldo nunca é armazenado.** Ele é derivado das transações, pela view
`vw_saldo_contas`. Não existe o clássico "o saldo dessincronizou do extrato" porque não
existe um segundo lugar onde ele possa dessincronizar.

**Transferência é um tipo de lançamento, não dois lançamentos.** Uma linha só, com conta
de origem e de destino — atômica por construção. E ela não conta como receita nem como
despesa em lugar nenhum.

**O isolamento entre usuários é do banco.** As foreign keys incluem o `usuario_id`
(migration 012): o PostgreSQL **recusa** uma transação sua apontando para a categoria de
outra pessoa. Não depende de o JavaScript lembrar de checar.

**Dinheiro é `numeric(14,2)`, nunca float.** E parcelas são divididas em centavos
inteiros, com o resto nas primeiras — a soma bate com o total, sempre.

**Datas são strings `AAAA-MM-DD` do começo ao fim.** O driver do `pg` é configurado para
não converter `DATE` em `Date`: essa conversão aplica o fuso local e faz um lançamento
do dia 1º aparecer no dia 31 do mês anterior.

**Nada de `innerHTML` com dado do banco.** O helper `el()` do `ui.js` monta tudo com
`createElement` + `textNode`, que já escapa. O ESLint barra `innerHTML` no `public/`.

---

## Modo de manutenção

Enquanto um script destrutivo roda (backup, migration, limpeza), o servidor responde
**503** com uma página de aviso, em vez de deixar alguém gravar um lançamento no meio de
um `pg_dump` — lançamento que não entraria no backup.

Ele liga e desliga sozinho nesses scripts. O aviso mora num arquivo (`manutencao.flag`),
e não numa variável, porque o script e o servidor são **processos diferentes**: um flag
em memória não seria visto pelo servidor que já está no ar — que é justamente quem
precisa segurar as requisições.

---

## Acesso remoto

O `servidor-oculto.vbs` sobe o servidor sem janela (usado pela Tarefa Agendada, no
logon), com a saída indo para `logs/servidor.log`. É o que dá ao Tailscale Serve o que
publicar no tailnet. O cookie de sessão ajusta o `secure` conforme o protocolo da
requisição, então o app funciona em `http://localhost` e em `https://...ts.net` sem
trocar nenhuma configuração.
