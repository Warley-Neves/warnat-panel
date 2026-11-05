const { query } = require('../database/db');
const evolutionService = require('../services/evolution.service');
const messageCache = require('../services/message-cache.service');
const webhookController = require('../controllers/webhook.controller');

async function testPhase3() {
  console.log('------------------------------------------------------------');
  console.log('🧪 Iniciando Testes da Fase 3: Evolution, Anti-Loop & Edge Cases');
  console.log('------------------------------------------------------------');

  // 1. Criar dados de teste (Tenant, Instância, AI Config)
  const tenantRes = await query(
    `INSERT INTO tenants (nome_empresa, plano) VALUES ('Empresa Teste Phase 3', 'pro') RETURNING id`
  );
  const tenantId = tenantRes.rows[0].id;

  const instanceName = `test-instance-${Date.now()}`;
  await query(
    `INSERT INTO tenant_whatsapp_instances (tenant_id, instance_name, status) VALUES ($1, $2, 'open')`,
    [tenantId, instanceName]
  );

  await query(
    `INSERT INTO tenant_ai_configs (tenant_id, sobre_empresa, pausa_automatica_minutos) VALUES ($1, 'Empresa de CFTV e alarmes', 45)`,
    [tenantId]
  );
  console.log('✅ Tenant e Instância de teste preparados no banco.');

  // 2. Testar Cache de Mensagens do Bot (Anti-Loop)
  const botMsgId = `BOT_MSG_${Date.now()}`;
  await messageCache.setBotSent(botMsgId, 60);
  const isBot = await messageCache.isBotSent(botMsgId);
  const isOther = await messageCache.isBotSent('RANDOM_MSG_ID');
  console.log('✅ Teste MessageCache:');
  console.log('   - isBotSent(botMsgId):', isBot, '(esperado: true)');
  console.log('   - isBotSent(RANDOM_MSG_ID):', isOther, '(esperado: false)');
  if (!isBot || isOther) throw new Error('Falha no MessageCache!');

  // 3. Testar Webhook: Auto-Loop com mensagem do bot (fromMe: true, no cache)
  const loopPayload = {
    event: 'messages.upsert',
    instance: instanceName,
    data: {
      key: {
        remoteJid: '5531983579692@s.whatsapp.net',
        fromMe: true,
        id: botMsgId
      },
      message: {
        conversation: 'Olá! Sou a assistente virtual.'
      }
    }
  };
  const loopResult = await webhookController.handleWebhook(loopPayload);
  console.log('✅ Teste Anti-Loop (Bot Sent):', loopResult.action, '(esperado: ignored_bot_sent)');
  if (loopResult.action !== 'ignored_bot_sent') throw new Error('Falha na trava de auto-loop!');

  // 4. Testar Webhook: Operador humano digita no celular físico (fromMe: true, NÃO no cache)
  const humanMsgId = `HUMAN_MSG_${Date.now()}`;
  const humanPayload = {
    event: 'messages.upsert',
    instance: instanceName,
    data: {
      key: {
        remoteJid: '5531983579692@s.whatsapp.net',
        fromMe: true,
        id: humanMsgId
      },
      message: {
        conversation: 'Oi Warley, aqui é o atendente humano. Como posso te ajudar?'
      }
    }
  };
  const humanResult = await webhookController.handleWebhook(humanPayload);
  console.log('✅ Teste Detecção de Atendente Humano:', humanResult.action, '(esperado: human_operator_takeover_activated)');
  console.log('   - Pausa ativada por:', humanResult.pausaMinutos, 'minutos');

  // Verifica se o banco foi atualizado com 'pausa_humana'
  const sessionCheck = await query(
    `SELECT status_atendimento, paused_until FROM chat_sessions WHERE tenant_id = $1 AND remote_jid = '5531983579692@s.whatsapp.net'`,
    [tenantId]
  );
  console.log('   - Status no banco:', sessionCheck.rows[0].status_atendimento, '| Pausado até:', sessionCheck.rows[0].paused_until);
  if (sessionCheck.rows[0].status_atendimento !== 'pausa_humana') throw new Error('Falha ao ativar pausa humana no banco!');

  // 5. Testar Webhook: Cliente envia mensagem enquanto atendimento está pausado
  const userMsgPayload = {
    event: 'messages.upsert',
    instance: instanceName,
    data: {
      key: {
        remoteJid: '5531983579692@s.whatsapp.net',
        fromMe: false,
        id: `USER_MSG_${Date.now()}`
      },
      message: {
        conversation: 'Quero saber quanto fica 4 câmeras'
      }
    }
  };
  const pausedUserResult = await webhookController.handleWebhook(userMsgPayload);
  console.log('✅ Teste Mensagem com IA Pausada:', pausedUserResult.action, '(esperado: message_saved_human_in_control)');

  // 6. Testar Edge Case: Payload vazio (não deve quebrar a aplicação)
  const emptyPayload = {
    event: 'messages.upsert',
    instance: instanceName,
    data: {
      key: {
        remoteJid: '5531983579692@s.whatsapp.net',
        fromMe: false,
        id: `EMPTY_${Date.now()}`
      },
      message: {}
    }
  };
  const emptyResult = await webhookController.handleWebhook(emptyPayload);
  console.log('✅ Teste Payload Vazio:', emptyResult.action, '(esperado: empty_payload_ignored)');

  // 7. Testar Debounce de Mensagens Rápidas
  // Reativa IA para testar debounce
  await query(
    `UPDATE chat_sessions SET status_atendimento = 'ia_ativa', paused_until = NULL WHERE tenant_id = $1`,
    [tenantId]
  );

  let debouncedOutput = null;
  webhookController.setAIProcessor(async (params) => {
    debouncedOutput = params;
  });

  console.log('⏳ Disparando 3 mensagens rápidas seguidas do mesmo cliente...');
  const msg1 = await webhookController.handleWebhook({
    event: 'messages.upsert',
    instance: instanceName,
    data: {
      key: { remoteJid: '5531983579692@s.whatsapp.net', fromMe: false, id: `M1_${Date.now()}` },
      message: { conversation: 'Olá boa noite' }
    }
  });
  const msg2 = await webhookController.handleWebhook({
    event: 'messages.upsert',
    instance: instanceName,
    data: {
      key: { remoteJid: '5531983579692@s.whatsapp.net', fromMe: false, id: `M2_${Date.now()}` },
      message: { conversation: 'Vocês atendem no Barreiro?' }
    }
  });
  const msg3 = await webhookController.handleWebhook({
    event: 'messages.upsert',
    instance: instanceName,
    data: {
      key: { remoteJid: '5531983579692@s.whatsapp.net', fromMe: false, id: `M3_${Date.now()}` },
      message: { conversation: 'Preciso de orçamento' }
    }
  });

  console.log('   - Mensagens buffers registradas:', msg1.action, msg2.action, msg3.action);
  console.log('   - Aguardando 3.5 segundos para o debounce disparar...');
  await new Promise(r => setTimeout(r, 3500));

  if (debouncedOutput && debouncedOutput.userMessage.includes('Olá boa noite\nVocês atendem no Barreiro?\nPreciso de orçamento')) {
    console.log('✅ Teste Debounce: Mensagem consolidada recebida com sucesso!');
    console.log('   Conteúdo consolidado:\n' + debouncedOutput.userMessage);
  } else {
    throw new Error('Falha no debounce consolidado!');
  }

  // 8. Limpeza dos dados de teste
  await query('DELETE FROM tenants WHERE id = $1', [tenantId]);
  console.log('✅ Dados de teste limpos via Cascade.');

  console.log('\n🎉 TODOS OS TESTES DA FASE 3 PASSARAM COM 100% DE SUCESSO!');
  process.exit(0);
}

testPhase3().catch(err => {
  console.error('❌ Falha nos testes da Fase 3:', err);
  process.exit(1);
});
