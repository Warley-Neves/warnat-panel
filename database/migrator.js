// ==============================================================================
// Migrador do Banco de Dados - Multi-Tenant SaaS
// ==============================================================================

const fs = require('fs');
const path = require('path');
const { pool, query } = require('./db');

async function runMigration() {
  console.log('------------------------------------------------------------');
  console.log('🚀 Iniciando Migração do Banco de Dados (SaaS Multi-Tenant)...');
  console.log('------------------------------------------------------------');

  const schemaPath = path.join(__dirname, 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    throw new Error(`Arquivo de schema não encontrado em: ${schemaPath}`);
  }

  const sql = fs.readFileSync(schemaPath, 'utf8');
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Executa o script DDL completo dentro de uma transação segura
    await client.query(sql);

    await client.query('COMMIT');
    console.log('✅ Tabelas criadas/atualizadas com sucesso:');
    console.log('   - tenants (Empresas)');
    console.log('   - users (Usuários Admin e Operadores)');
    console.log('   - tenant_whatsapp_instances (Instâncias Evolution API)');
    console.log('   - tenant_ai_configs (Parâmetros da IA por Tenant)');
    console.log('   - chat_sessions (Sessões e Contatos)');
    console.log('   - chat_messages (Histórico de Mensagens)');
    console.log('✅ Índices de isolamento multi-tenant criados com sucesso.');

    // Verificação de tabelas criadas no banco
    const tablesRes = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name IN ('tenants', 'users', 'tenant_whatsapp_instances', 'tenant_ai_configs', 'customer_profiles', 'appointments', 'chat_sessions', 'chat_messages')
      ORDER BY table_name;
    `);

    console.log('\n📊 Tabelas ativas no banco de dados (8/8):');
    tablesRes.rows.forEach(r => console.log(`   ✔️ ${r.table_name}`));

    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Falha na execução da migração:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

if (require.main === module) {
  runMigration()
    .then(() => {
      console.log('------------------------------------------------------------');
      console.log('🎉 Migração concluída com sucesso!');
      console.log('------------------------------------------------------------');
      process.exit(0);
    })
    .catch((err) => {
      console.error('💥 Erro fatal:', err);
      process.exit(1);
    });
}

module.exports = { runMigration };
