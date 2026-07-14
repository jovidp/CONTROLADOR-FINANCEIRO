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
| `npm run db:backup` | Backup com `pg_dump` em `backups/`, **cifrado** (ver Segurança). |
| `npm run db:restore -- backups/<arq>` | Restaura um backup por cima do banco atual. |
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
npm run db:restore -- backups/controlador_financeiro_2026-07-14-11-06-34_manual.dump.enc
```

Ele decifra num arquivo temporário (apagado no fim), põe o app em manutenção e chama o
`pg_restore --clean`. Antes de sobrescrever qualquer coisa, tira um backup do estado
**atual** — se o arquivo não for o que você esperava, ainda dá para voltar.

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

---

## Segurança

Dentro do tailnet, quem alcança a porta já foi autenticado pelo Tailscale. Com o
**Funnel** ligado, o app fica na internet aberta e o login passa a ser a **única**
parede. O que sustenta essa parede:

**O IP do cliente vem do `req.ip`, nunca do primeiro item do `X-Forwarded-For.`** Esse
cabeçalho é uma lista que cada proxy vai *anexando* — e o começo dela pode ter vindo do
próprio cliente. Lendo o primeiro item (como o código fazia), bastava mandar um
`X-Forwarded-For` diferente a cada tentativa para cair numa chave nova toda vez: o freio
de 5 tentativas contava até 1 para sempre, e a força bruta era livre. O `trust proxy:
'loopback'` do Express anda pela lista da direita para a esquerda e para no primeiro
endereço que não é de confiança — o que o Tailscale escreveu, e não o que o cliente
inventou.

**Dois freios separados, nunca um global.** Login (por usuário+IP) e cadastro (por IP)
têm contadores próprios: adivinhar a senha de alguém e criar contas em massa são ataques
diferentes, e a cota de um não pode ser consumida pelo outro. Um contador *global*
deixaria qualquer um trancar o login de todo mundo errando cinco senhas de propósito.

**A CSP bloqueia todo script inline, por hash.** Os `<script>` escritos dentro do HTML
(o que aplica o tema antes da primeira pintura) são liberados pelo `sha256` do conteúdo,
calculado do arquivo no boot. Um script *injetado* tem outro conteúdo, logo outro hash,
logo não roda. Junto vão `frame-ancestors 'none'` (clickjacking), `nosniff`, HSTS no
HTTPS e `Referrer-Policy: no-referrer`.

**Senha nova exige 12+ caracteres** e recusa as óbvias (`123456789012`, o nome do app, o
próprio login com números colados). A regra vale só para senhas **novas**: endurecê-la
não pode trancar do lado de fora quem se cadastrou quando ela era outra.

**`/api/health` fala pouco com quem vem de fora.** O nome do banco e a versão exata do
PostgreSQL só saem para o `127.0.0.1` — de fora, apenas `{ok:true}`.

### Os backups são cifrados (`BACKUP_CHAVE`)

O banco em si **não** é cifrado, e não deve ser: os valores precisam ser somados pelo
PostgreSQL (a `vw_saldo_contas` deriva o saldo das transações), e um número cifrado não
soma. Também não protegeria de nada — quem chega ao seu Windows chega ao `.env`, onde a
chave estaria.

O backup é outra história: é o **único** lugar onde os seus dados saem da máquina
inteiros, num arquivo só, que vai para um pendrive, um e-mail ou uma nuvem. Ele é cifrado
com **AES-256-GCM** (`src/cripto.js`), com a chave derivada da `BACKUP_CHAVE` por scrypt
e um salt novo a cada arquivo. GCM cifra **e autentica**: um `.enc` adulterado não
decifra "quase certo" — ele falha, alto e claro.

> **Guarde uma cópia da `BACKUP_CHAVE` fora desta máquina.** Sem ela, nenhum backup pode
> ser restaurado — nem por você. Com a variável vazia, os dumps saem em texto claro e o
> servidor avisa a cada backup.
