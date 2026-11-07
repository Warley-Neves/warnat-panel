const { query, pool } = require('../database/db');

async function migrate() {
  try {
    console.log('Aplicando migração tempo_resposta_segundos...');
    await query(`
      ALTER TABLE tenant_ai_configs 
      ADD COLUMN IF NOT EXISTS tempo_resposta_segundos INT DEFAULT 3;
    `);

    // Atualiza registros existentes que estejam com null
    await query(`
      UPDATE tenant_ai_configs 
      SET tempo_resposta_segundos = 3 
      WHERE tempo_resposta_segundos IS NULL;
    `);

    const cols = await query(`
      SELECT column_name, data_type, column_default 
      FROM information_schema.columns 
      WHERE table_name = 'tenant_ai_configs' 
      ORDER BY ordinal_position;
    `);

    console.log('Colunas de tenant_ai_configs:');
    cols.rows.forEach(c => console.log(` - ${c.column_name} (${c.data_type}) default: ${c.column_default}`));
  } catch (err) {
    console.error('Erro na migração:', err);
  } finally {
    await pool.end();
  }
}

migrate();
