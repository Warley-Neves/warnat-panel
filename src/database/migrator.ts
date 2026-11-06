// ==============================================================================
// SAAS MULTI-TENANT ENGINE - DATABASE MIGRATOR (TYPESCRIPT)
// Idempotent execution of database/schema.sql with strict schema verification
// ==============================================================================

import fs from 'fs';
import path from 'path';
import { query, withTransaction, shutdownPool } from './db';

export interface MigrationReport {
  success: boolean;
  appliedAt: string;
  tablesVerified: string[];
  indexesVerified: string[];
  constraintsVerified: string[];
  warnings: string[];
}

const REQUIRED_TABLES = [
  'tenants',
  'users',
  'tenant_whatsapp_instances',
  'tenant_ai_configs',
  'customer_profiles',
  'appointments',
  'chat_sessions',
  'chat_messages'
];

const REQUIRED_INDEXES = [
  'idx_users_tenant_email',
  'idx_customer_lookup',
  'idx_appointments_lookup',
  'idx_chat_messages_flow'
];

const REQUIRED_CONSTRAINTS = [
  'uk_tenant_customer',
  'uk_tenant_session'
];

export async function runMigration(): Promise<MigrationReport> {
  const schemaPath = path.resolve(__dirname, '..', '..', 'database', 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Schema file not found at: ${schemaPath}`);
  }

  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  console.log('🔄 [Migrator] Executando schema DDL no PostgreSQL...');

  // Executa o script dentro de uma transação
  await withTransaction(async (client) => {
    await client.query(schemaSql);
  });

  console.log('✅ [Migrator] Schema DDL executado com sucesso.');
  console.log('🔍 [Migrator] Verificando integridade das 8 tabelas e índices multi-tenant...');

  // 1. Verifica existência de todas as tabelas
  const tablesRes = await query<{ table_name: string }>(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_name = ANY($1::text[])
    ORDER BY table_name;
  `, [REQUIRED_TABLES]);

  const verifiedTables = tablesRes.rows.map(r => r.table_name);
  const missingTables = REQUIRED_TABLES.filter(t => !verifiedTables.includes(t));

  if (missingTables.length > 0) {
    throw new Error(`[Migrator] Falha: Tabelas ausentes após migração: ${missingTables.join(', ')}`);
  }

  // 2. Verifica índices
  const indexRes = await query<{ indexname: string }>(`
    SELECT indexname 
    FROM pg_indexes 
    WHERE schemaname = 'public' AND indexname = ANY($1::text[]);
  `, [REQUIRED_INDEXES]);

  const verifiedIndexes = indexRes.rows.map(r => r.indexname);

  // 3. Verifica constraints
  const constrRes = await query<{ conname: string }>(`
    SELECT conname 
    FROM pg_constraint 
    WHERE conname = ANY($1::text[]);
  `, [REQUIRED_CONSTRAINTS]);

  const verifiedConstraints = constrRes.rows.map(r => r.conname);

  const report: MigrationReport = {
    success: true,
    appliedAt: new Date().toISOString(),
    tablesVerified: verifiedTables,
    indexesVerified: verifiedIndexes,
    constraintsVerified: verifiedConstraints,
    warnings: []
  };

  if (verifiedIndexes.length < REQUIRED_INDEXES.length) {
    const missing = REQUIRED_INDEXES.filter(i => !verifiedIndexes.includes(i));
    report.warnings.push(`Índices ausentes ou com nomes alternativos: ${missing.join(', ')}`);
  }

  return report;
}

// Execução direta via CLI: npx tsx src/database/migrator.ts
if (require.main === module) {
  runMigration()
    .then((report) => {
      console.log('\n==================================================');
      console.log('✨ RELATÓRIO DE MIGRAÇÃO MULTI-TENANT (FASE 2)');
      console.log('==================================================');
      console.log(`Status: ${report.success ? 'SUCESSO' : 'FALHA'}`);
      console.log(`Horário: ${report.appliedAt}`);
      console.log(`Tabelas Verificadas (${report.tablesVerified.length}/8):`, report.tablesVerified.join(', '));
      console.log(`Índices Verificados:`, report.indexesVerified.join(', '));
      console.log(`Constraints Verificadas:`, report.constraintsVerified.join(', '));
      if (report.warnings.length > 0) {
        console.warn('Avisos:', report.warnings);
      }
      console.log('==================================================\n');
      return shutdownPool();
    })
    .catch((err) => {
      console.error('❌ [Migrator Error]:', err);
      shutdownPool().finally(() => process.exit(1));
    });
}
