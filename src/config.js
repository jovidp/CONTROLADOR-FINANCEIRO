import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 3000),
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
  // Login de usuario unico. Sem default nenhum: faltando qualquer um dos tres, o
  // servidor se recusa a subir e manda rodar `npm run senha`. Um valor padrao
  // aqui seria uma senha publica escondida no codigo.
  auth: {
    usuario: process.env.AUTH_USUARIO || '',
    senhaHash: process.env.AUTH_SENHA_HASH || '',
    segredo: process.env.SESSION_SECRET || '',
  },
};
