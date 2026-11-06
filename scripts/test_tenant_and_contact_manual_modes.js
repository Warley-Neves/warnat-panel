// ==============================================================================
// TESTE DE VALIDAÇÃO: MODO DE ATENDIMENTO MANUAL GLOBAL VS AUTOMAÇÃO (TENANT)
// E MODO MANUAL INDIVIDUAL POR CONTATO / CLIENTE
// ==============================================================================

require('dotenv').config();
const { query } = require('../database/db');
const { WebhookController } = require('../controllers/webhook.controller');
const assert = require('assert');

async function runTenantModeValidation() {
  console.log('================================================================');
  console.log('🚀 INICIANDO TESTE DO MODO DE ATENDIMENTO GLOBAL E POR CONTATO');
  console.log('================================================================\n');

  const webhook = new WebhookController(200); // 200ms debounce
  let aiTurnInvoked = false;
  webhook.setAIProcessor(async (turn) => {
    aiTurnInvoked = true;
    return { success: true };
  });

  const tenantRes = await query(`SELECT id FROM tenants LIMIT 1;`);
  const tenant = tenantRes.rows[0];
  const tenantId = tenant.id;
  const instRes = await query(`SELECT instance_name FROM tenant_whatsapp_instances WHERE tenant_id = $1 LIMIT 1;`, [tenantId]);
  const instanceName = instRes.rows[0]?.instance_name || 'warnat-tech';

  const testJidAuto = '5531988880001@s.whatsapp.net';
  const testJidManual = '5531988880002@s.whatsapp.net';

  try {
    // --------------------------------------------------------------------------
    // CENÁRIO 1: Tenant em modo "automacao" (Padrão)
    // --------------------------------------------------------------------------
    console.log('--- CENÁRIO 1: Tenant em Modo Automação IA ---');
    await query(
      `UPDATE tenant_ai_configs SET modo_atendimento = 'automacao' WHERE tenant_id = $1;`,
      [tenantId]
    );

    // Mensagem de contato normal em automação
    aiTurnInvoked = false;
    const msg1 = {
      event: 'messages.upsert',
      instance: instanceName,
      data: {
        key: { remoteJid: testJidAuto, fromMe: false, id: `TEST_AUTO_${Date.now()}` },
        message: { conversation: 'Olá, gostaria de saber sobre instalação de câmeras' }
      }
    };

    const res1 = await webhook.handleWebhook(msg1);
    assert.strictEqual(res1.handled, true);
    assert.strictEqual(res1.action, 'buffered_in_debounce');
    console.log('  ✅ [PASS] Mensagem aceita e colocada no buffer para IA');

    // --------------------------------------------------------------------------
    // CENÁRIO 2: Tenant em modo "manual" (Atendimento 100% Humano / Silencia IA)
    // --------------------------------------------------------------------------
    console.log('\n--- CENÁRIO 2: Tenant em Modo 100% Manual Geral ---');
    await query(
      `UPDATE tenant_ai_configs SET modo_atendimento = 'manual' WHERE tenant_id = $1;`,
      [tenantId]
    );

    const msg2 = {
      event: 'messages.upsert',
      instance: instanceName,
      data: {
        key: { remoteJid: testJidAuto, fromMe: false, id: `TEST_GLOBAL_MANUAL_${Date.now()}` },
        message: { conversation: 'Tem alguém disponível para me atender?' }
      }
    };

    const res2 = await webhook.handleWebhook(msg2);
    assert.strictEqual(res2.handled, true);
    assert.strictEqual(res2.action, 'tenant_manual_mode_active');
    console.log('  ✅ [PASS] Automação silenciada globalmente: IA não responde');

    // Verifica que a mensagem do cliente foi salva no banco para o atendente ler no CRM
    const savedMsgRes = await query(
      `SELECT m.content FROM chat_messages m
       JOIN chat_sessions s ON s.id = m.session_id
       WHERE s.remote_jid = $1 AND s.tenant_id = $2
       ORDER BY m.created_at DESC LIMIT 1;`,
      [testJidAuto, tenantId]
    );
    assert.strictEqual(savedMsgRes.rows[0].content, 'Tem alguém disponível para me atender?');
    console.log('  ✅ [PASS] Mensagem salva no chat do CRM para o operador humano visualizar');

    // --------------------------------------------------------------------------
    // CENÁRIO 3: Tenant em "automacao", mas contato específico selecionado como "manual"
    // --------------------------------------------------------------------------
    console.log('\n--- CENÁRIO 3: Tenant em Automação com Contato Específico em Modo Manual ---');
    await query(
      `UPDATE tenant_ai_configs SET modo_atendimento = 'automacao' WHERE tenant_id = $1;`,
      [tenantId]
    );

    // Cria/coloca o contato testJidManual em status_atendimento = 'manual'
    await query(
      `INSERT INTO chat_sessions (tenant_id, remote_jid, status_atendimento, etapa_funil, paused_until, last_interaction)
       VALUES ($1, $2, 'manual', 'manual', NOW() + INTERVAL '1 year', NOW())
       ON CONFLICT (tenant_id, remote_jid)
       DO UPDATE SET status_atendimento = 'manual', etapa_funil = 'manual', paused_until = NOW() + INTERVAL '1 year';`,
      [tenantId, testJidManual]
    );

    const msgManual = {
      event: 'messages.upsert',
      instance: instanceName,
      data: {
        key: { remoteJid: testJidManual, fromMe: false, id: `TEST_CONTACT_MANUAL_${Date.now()}` },
        message: { conversation: 'Estou falando com um atendente humano?' }
      }
    };

    const resManual = await webhook.handleWebhook(msgManual);
    assert.strictEqual(resManual.handled, true);
    assert.strictEqual(resManual.action, 'message_saved_human_in_control');
    assert.strictEqual(resManual.reason, 'contact_manual_mode_active');
    console.log('  ✅ [PASS] Contato em modo manual não dispara a IA');

    // Verifica que o outro contato normal continua recebendo automação
    const msgAutoAgain = {
      event: 'messages.upsert',
      instance: instanceName,
      data: {
        key: { remoteJid: testJidAuto, fromMe: false, id: `TEST_AUTO_AGAIN_${Date.now()}` },
        message: { conversation: 'Quero agendar uma visita' }
      }
    };

    const resAutoAgain = await webhook.handleWebhook(msgAutoAgain);
    assert.strictEqual(resAutoAgain.handled, true);
    assert.strictEqual(resAutoAgain.action, 'buffered_in_debounce');
    console.log('  ✅ [PASS] Outros contatos continuam sendo atendidos normalmente pela IA');

    // Reativa o contato manual para automação
    await query(
      `UPDATE chat_sessions 
       SET status_atendimento = 'ia_ativa', paused_until = NULL 
       WHERE tenant_id = $1 AND remote_jid = $2;`,
      [tenantId, testJidManual]
    );

    const msgReactivated = {
      event: 'messages.upsert',
      instance: instanceName,
      data: {
        key: { remoteJid: testJidManual, fromMe: false, id: `TEST_REACTIVATED_${Date.now()}` },
        message: { conversation: 'Voltei a falar com o robô' }
      }
    };

    const resReactivated = await webhook.handleWebhook(msgReactivated);
    assert.strictEqual(resReactivated.handled, true);
    assert.strictEqual(resReactivated.action, 'buffered_in_debounce');
    console.log('  ✅ [PASS] Contato reativado para IA com sucesso');

    // Restaura tenant para automacao
    await query(
      `UPDATE tenant_ai_configs SET modo_atendimento = 'automacao' WHERE tenant_id = $1;`,
      [tenantId]
    );

    console.log('\n================================================================');
    console.log('🎉 TODOS OS TESTES DE CONTROLE MANUAL & AUTOMAÇÃO PASSARAM 100%!');
    console.log('================================================================');
    process.exit(0);
  } catch (err) {
    console.error('❌ Erro no teste:', err);
    process.exit(1);
  }
}

runTenantModeValidation();
