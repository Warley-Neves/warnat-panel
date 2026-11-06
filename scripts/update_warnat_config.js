const { query, pool } = require('../database/db');

async function run() {
  try {
    const res = await query('SELECT regras_agendamento FROM tenant_ai_configs WHERE tenant_id = $1', ['14ddfc5e-c5ec-4219-8763-59454f039207']);
    if (res.rowCount > 0) {
      const cfg = res.rows[0].regras_agendamento || {};
      cfg.dias_atendimento = ['sabado'];
      cfg.dias = ['sabado'];
      cfg.slots_agendamento = ['08:00', '10:00', '12:00', '14:00', '16:00'];
      cfg.slots_disponiveis = ['08:00', '10:00', '12:00', '14:00', '16:00'];
      await query('UPDATE tenant_ai_configs SET regras_agendamento = $1, nome_assistente = $2 WHERE tenant_id = $3', [
        JSON.stringify(cfg),
        'Nat',
        '14ddfc5e-c5ec-4219-8763-59454f039207'
      ]);
      console.log('✅ WarNat Tech config updated successfully!');
    }
  } catch (err) {
    console.error('Error updating config:', err);
  } finally {
    await pool.end();
  }
}

run();
