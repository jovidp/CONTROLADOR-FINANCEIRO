/**
 * Cria a role e o database da aplicacao a partir das credenciais de
 * superusuario (PG_SUPERUSER / PG_SUPERPASSWORD). Conecta no database de
 * manutencao 'postgres' -- por isso NAO usa o pool de src/db.js, que aponta
 * para um banco que talvez ainda nao exista.
 *
 * Idempotente: pode rodar quantas vezes quiser.
 */
import pg from 'pg';
import { config } from '../config.js';

const { Client, escapeIdentifier, escapeLiteral } = pg;

// Identificadores (nomes de role/database) NAO aceitam bind ($1): o unico jeito
// seguro e validar contra uma whitelist estrita e escapar com escapeIdentifier.
const RE_IDENT = /^[a-z_][a-z0-9_]*$/i;

function identificador(valor, campo) {
  const s = String(valor ?? '');
  if (!RE_IDENT.test(s)) {
    throw new Error(
      `${campo} inválido: "${s}". Use apenas letras, números e "_", começando por letra ou "_".`,
    );
  }
  return escapeIdentifier(s);
}

function conectar(database) {
  const client = new Client({
    host: config.db.host,
    port: config.db.port,
    user: config.superuser.user,
    password: config.superuser.password,
    database,
    connectionTimeoutMillis: 5_000,
    application_name: 'controlador-financeiro/create-db',
  });
  return client.connect().then(() => client);
}

async function main() {
  const nomeRole = config.db.user;
  const nomeBanco = config.db.database;

  const sqlRole = identificador(nomeRole, 'PGUSER');
  const sqlBanco = identificador(nomeBanco, 'PGDATABASE');

  if (!config.db.password) {
    throw new Error('PGPASSWORD está vazio no .env. Defina a senha da role da aplicação.');
  }
  // A senha e um literal, nao um identificador: vai escapada, nunca concatenada crua.
  const sqlSenha = escapeLiteral(config.db.password);

  console.log(`\n  Alvo: ${nomeRole}@${config.db.host}:${config.db.port}/${nomeBanco}`);
  console.log(`  Superusuário: ${config.superuser.user}\n`);

  const manutencao = await conectar('postgres');
  try {
    // 1. role da aplicacao
    const { rowCount: temRole } = await manutencao.query(
      'SELECT 1 FROM pg_roles WHERE rolname = $1',
      [nomeRole],
    );
    if (temRole) {
      // Mantem a senha em sincronia com o .env, senao o app nao loga.
      await manutencao.query(`ALTER ROLE ${sqlRole} WITH LOGIN PASSWORD ${sqlSenha}`);
      console.log(`  = role "${nomeRole}" já existia (senha ressincronizada com o .env)`);
    } else {
      await manutencao.query(`CREATE ROLE ${sqlRole} WITH LOGIN PASSWORD ${sqlSenha}`);
      console.log(`  + role "${nomeRole}" criada`);
    }

    // 2. database. CREATE DATABASE nao roda dentro de transacao -- este script
    //    nunca abre BEGIN, cada comando vai em autocommit.
    const { rowCount: temBanco } = await manutencao.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [nomeBanco],
    );
    if (temBanco) {
      console.log(`  = database "${nomeBanco}" já existia`);
    } else {
      await manutencao.query(`CREATE DATABASE ${sqlBanco} OWNER ${sqlRole}`);
      console.log(`  + database "${nomeBanco}" criado (owner: ${nomeRole})`);
    }
  } finally {
    await manutencao.end();
  }

  // 3. permissoes dentro do database novo (schema public nasce do postgres,
  //    nao da role da aplicacao -- no PG 15+ isso bloqueia CREATE TABLE).
  const app = await conectar(nomeBanco);
  try {
    await app.query(`ALTER SCHEMA public OWNER TO ${sqlRole}`);
    await app.query(`GRANT ALL ON SCHEMA public TO ${sqlRole}`);
    await app.query(`GRANT ALL ON DATABASE ${sqlBanco} TO ${sqlRole}`);
    console.log(`  + schema public com owner e permissões para "${nomeRole}"`);
  } finally {
    await app.end();
  }

  console.log('\nOK: banco pronto. Próximo passo: npm run db:migrate\n');
}

main().catch((err) => {
  console.error('\nFALHA ao criar o banco:', err.message);
  console.error(`  Conexão tentada: ${config.superuser.user}@${config.db.host}:${config.db.port}`);
  console.error('  Confira PG_SUPERUSER/PG_SUPERPASSWORD no .env e se o serviço do PostgreSQL está no ar.\n');
  process.exitCode = 1;
});
