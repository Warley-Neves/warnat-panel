// ==============================================================================
// Pool Central de Conexão com PostgreSQL - Multi-Tenant SaaS
// ==============================================================================

const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

// Carregar .env se não estiver no process.env
const envPath = path.resolve(__dirname, '..', '.env');
const envMap = {};
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      envMap[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
    }
  });
}

const env = (k, def) => process.env[k] || envMap[k] || def;

const connectionString = env('DATABASE_CONNECTION_URI') || env('DATABASE_URL');
let poolConfig;

if (connectionString) {
  const isLocal = connectionString.includes('localhost') || connectionString.includes('127.0.0.1');
  poolConfig = {
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  };
} else {
  poolConfig = {
    host: env('POSTGRES_HOST', '127.0.0.1'),
    port: Number(env('POSTGRES_PORT', '5432')),
    user: env('POSTGRES_USER', 'evolution_user'),
    password: env('POSTGRES_PASSWORD', 'sua_senha_forte_aqui'),
    database: env('POSTGRES_DB', 'evolution_db'),
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  };
}

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('[PostgreSQL Pool] Erro inesperado em cliente ocioso:', err.message);
});

module.exports = {
  pool,
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect()
};
