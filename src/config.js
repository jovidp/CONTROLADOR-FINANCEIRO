import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 3000),
  // Em qual endereco o servidor escuta. Padrao 127.0.0.1 (so´ o loopback) porque o
  // bind local NAO tem HTTPS: em 0.0.0.0 qualquer maquina da rede alcanca o app por
  // http://<ip>:PORT e a SENHA viaja em texto claro pelo cabo. O Tailscale (Serve e
  // Funnel) faz proxy de 127.0.0.1, entao tailnet e internet continuam funcionando --
  // com TLS. Quem realmente precisar do acesso cru pela LAN poe HOST=0.0.0.0 no .env,
  // sabendo o que esta´ abrindo.
  host: process.env.HOST || '127.0.0.1',
  db: {
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'controlador_financeiro',
    user: process.env.PGUSER || 'fin_app',
    password: process.env.PGPASSWORD || '',
  },
  superuser: {
    user: process.env.PG_SUPERUSER || 'postgres',
    password: process.env.PG_SUPERPASSWORD || '',
  },
  // AUTH_USUARIO/AUTH_SENHA_HASH: login legado do .env, para instalacoes anteriores ao
  // cadastro pelo navegador. Hoje o normal e´ deixa-los vazios (o usuario nasce no banco).
  // SESSION_SECRET: se preenchido, o server.js exige >= 32 caracteres no boot (segredo
  // curto = cookie forjavel); se vazio, o auth.js sorteia um efemero forte a cada boot.
  auth: {
    usuario: process.env.AUTH_USUARIO || '',
    senhaHash: process.env.AUTH_SENHA_HASH || '',
    segredo: process.env.SESSION_SECRET || '',
  },
  // Cifra os arquivos de backups/. Vazia, o dump fica em texto claro -- o que so´ e´
  // aceitavel enquanto ele nunca sair desta maquina.
  backup: {
    chave: process.env.BACKUP_CHAVE || '',
  },
  // Codigo de convite do cadastro. Preenchido, o cadastro passa a EXIGI-LO: ninguem cria
  // conta sem ele. Vazio, o cadastro fica aberto (ok atras do tailnet ou em localhost;
  // no Funnel, preencha). Entregue o codigo so´ a quem for usar o app.
  cadastro: {
    convite: process.env.CADASTRO_CONVITE || '',
  },
};
