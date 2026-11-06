// ==============================================================================
// SAAS MULTI-TENANT ENGINE - TYPED POSTGRESQL CLIENT & POOL
// ==============================================================================

import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

// Garante carregamento do .env do diretório raiz
const envPath = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

const connectionString = process.env.DATABASE_CONNECTION_URI || process.env.DATABASE_URL;

let pool: Pool;

if (connectionString) {
  const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');
  pool = new Pool({
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });
} else {
  pool = new Pool({
    host: process.env.POSTGRES_HOST || '127.0.0.1',
    port: Number(process.env.POSTGRES_PORT || 5432),
    user: process.env.POSTGRES_USER || 'evolution_user',
    password: process.env.POSTGRES_PASSWORD || 'sua_senha_forte_aqui',
    database: process.env.POSTGRES_DB || 'evolution_db',
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  });
}

pool.on('error', (err: Error) => {
  console.error('[PostgreSQL Pool Error]:', err.message);
});

/**
 * Executa uma consulta SQL tipada no pool
 */
export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  const start = Date.now();
  const res = await pool.query<T>(text, params);
  const duration = Date.now() - start;
  if (process.env.LOG_SQL === 'true') {
    console.log(`[SQL] ${text.trim().substring(0, 100)}... took ${duration}ms (${res.rowCount} rows)`);
  }
  return res;
}

/**
 * Adquire um cliente dedicado do pool
 */
export async function getClient(): Promise<PoolClient> {
  return await pool.connect();
}

/**
 * Executa um bloco de operações dentro de uma transação isolada
 */
export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Encerra o pool graciosamente
 */
export async function shutdownPool(): Promise<void> {
  await pool.end();
}

export { pool };
