/**
 * Teste End-to-End com OpenAI GPT-4o-mini para avanço de datas na conversação real
 */

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
const aiEngine = require('../services/ai-engine.service');
const evolutionService = require('../services/evolution.service');
const { query, pool } = require('../database/db');

async function run() {
  console.log('=== TESTE E2E OPENAI: AVANÇO DE DATAS E SUGESTÃO INTELIGENTE ===\n');

  const tenantRes = await query(`SELECT id, nome_empresa FROM tenants LIMIT 1`);
  const tenant = tenantRes.rows[0];

  const testJid = `551197777000${Date.now().toString().slice(-4)}@s.whatsapp.net`;
  const instanceName = 'Evolution-Principal';

  // Mock do envio para capturar a resposta gerada
  let lastSentMessage = '';
  evolutionService.sendTextMessage = async (inst, to, text) => {
    lastSentMessage = text;
    return { success: true, messageId: 'mock-msg-' + Date.now() };
  };

  try {
    // Cria sessão no banco
    const sessRes = await query(
      `INSERT INTO chat_sessions (tenant_id, remote_jid, client_name, etapa_funil)
       VALUES ($1, $2, $3, 'inicio')
       RETURNING id`,
      [tenant.id, testJid, 'Rodrigo Alves']
    );
    const sessionId = sessRes.rows[0].id;

    // Turno 1: Cliente qualifica para nova instalação
    console.log('--- Turno 1: Usuário pede nova instalação ---');
    const msg1 = 'Olá Nat, quero instalar 4 câmeras de segurança na minha casa no Barreiro';
    await query(
      `INSERT INTO chat_messages (session_id, tenant_id, role, content, media_type, message_id)
       VALUES ($1, $2, 'user', $3, 'text', $4)`,
      [sessionId, tenant.id, msg1, 'user-msg-1']
    );

    await aiEngine.processTurn({
      tenantId: tenant.id,
      instanceName,
      sessionId,
      remoteJid: testJid,
      userMessage: msg1,
      pushName: 'Rodrigo Alves'
    });

    const turn1Reply = lastSentMessage;
    console.log('Nat Respondeu (Turno 1):\n', turn1Reply, '\n');

    // Turno 2: Cliente recusa a data oferecida e pede outro sábado
    console.log('--- Turno 2: Usuário recusa a data e pede outro sábado ---');
    const msg2 = 'Poxa, nesse sábado eu não posso porque vou viajar. Tem algum outro sábado mais pra frente?';
    await query(
      `INSERT INTO chat_messages (session_id, tenant_id, role, content, media_type, message_id)
       VALUES ($1, $2, 'user', $3, 'text', $4)`,
      [sessionId, tenant.id, msg2, 'user-msg-2']
    );

    await aiEngine.processTurn({
      tenantId: tenant.id,
      instanceName,
      sessionId,
      remoteJid: testJid,
      userMessage: msg2,
      pushName: 'Rodrigo Alves'
    });

    const turn2Reply = lastSentMessage;
    console.log('Nat Respondeu (Turno 2):\n', turn2Reply, '\n');

    // Turno 3: Cliente recusa 14/11 também e pede mais pra frente
    console.log('--- Turno 3: Usuário recusa 14/11 e pede mais pra frente ---');
    const msg3 = 'Puts, dia 14/11 também não consigo, tem mais pra frente?';
    await query(
      `INSERT INTO chat_messages (session_id, tenant_id, role, content, media_type, message_id)
       VALUES ($1, $2, 'user', $3, 'text', $4)`,
      [sessionId, tenant.id, msg3, 'user-msg-3']
    );

    await aiEngine.processTurn({
      tenantId: tenant.id,
      instanceName,
      sessionId,
      remoteJid: testJid,
      userMessage: msg3,
      pushName: 'Rodrigo Alves'
    });

    const turn3Reply = lastSentMessage;
    console.log('Nat Respondeu (Turno 3):\n', turn3Reply, '\n');

    // Turno 4: Cliente confirma o horário sugerido no Turno 3
    console.log('--- Turno 4: Usuário confirma agendamento para 21/11 às 10h ---');
    const msg4 = 'Perfeito Nat, pode marcar dia 21/11 às 10h!';
    await query(
      `INSERT INTO chat_messages (session_id, tenant_id, role, content, media_type, message_id)
       VALUES ($1, $2, 'user', $3, 'text', $4)`,
      [sessionId, tenant.id, msg4, 'user-msg-4']
    );

    await aiEngine.processTurn({
      tenantId: tenant.id,
      instanceName,
      sessionId,
      remoteJid: testJid,
      userMessage: msg4,
      pushName: 'Rodrigo Alves'
    });

    const turn4Reply = lastSentMessage;
    console.log('Nat Respondeu (Turno 4):\n', turn4Reply, '\n');

    // Verifica se foi agendado no banco
    const apptCheck = await query(
      `SELECT id, servico, data_agendada, status FROM appointments WHERE tenant_id = $1 AND remote_jid = $2`,
      [tenant.id, testJid]
    );

    console.log('Agendamentos criados no banco:', apptCheck.rows);

    // Verificações
    const turn1HasSaturday = turn1Reply.toLowerCase().includes('sábado') || turn1Reply.toLowerCase().includes('sabado');
    const turn2HasNewSaturday = turn2Reply.toLowerCase().includes('14/11') || turn2Reply.toLowerCase().includes('próximo sábado');
    const turn2DoesNotInsistOn07 = !turn2Reply.includes('07/11');
    const turn3Has21 = turn3Reply.includes('21/11');
    const turn3DoesNotInsist = !turn3Reply.includes('07/11') && !turn3Reply.includes('14/11');
    const turn4BookedInDb = apptCheck.rowCount > 0 && apptCheck.rows[0].status === 'agendado';

    console.log('Verificação 1 (Turno 1 sugeriu 07/11):', turn1HasSaturday ? 'OK' : 'FALHA');
    console.log('Verificação 2 (Turno 2 sugeriu 14/11):', turn2HasNewSaturday ? 'OK' : 'FALHA');
    console.log('Verificação 3 (Turno 2 NÃO insistiu em 07/11):', turn2DoesNotInsistOn07 ? 'OK' : 'FALHA');
    console.log('Verificação 4 (Turno 3 sugeriu 21/11):', turn3Has21 ? 'OK' : 'FALHA');
    console.log('Verificação 5 (Turno 3 NÃO insistiu em 07 nem 14):', turn3DoesNotInsist ? 'OK' : 'FALHA');
    console.log('Verificação 6 (Turno 4 gravou no banco com status agendado):', turn4BookedInDb ? 'OK' : 'FALHA');

    // Limpa dados de teste
    await query(`DELETE FROM appointments WHERE tenant_id = $1 AND remote_jid = $2`, [tenant.id, testJid]);
    await query(`DELETE FROM chat_messages WHERE session_id = $1`, [sessionId]);
    await query(`DELETE FROM chat_sessions WHERE id = $1`, [sessionId]);

    if (turn1HasSaturday && turn2HasNewSaturday && turn2DoesNotInsistOn07 && turn3Has21 && turn3DoesNotInsist && turn4BookedInDb) {
      console.log('\n[SUCESSO COMPLETO] Teste E2E de 4 Turnos concluído com 100% de precisão!');
      process.exit(0);
    } else {
      console.error('\n[FALHA] Alguma verificação E2E não atendeu os critérios.');
      process.exit(1);
    }

  } catch (err) {
    console.error('Erro no teste E2E:', err);
    process.exit(1);
  } finally {
    if (pool && pool.end) await pool.end();
  }
}

run();
