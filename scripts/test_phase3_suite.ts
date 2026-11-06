// ==============================================================================
// SAAS MULTI-TENANT ENGINE - PHASE 3 TEST SUITE (TYPESCRIPT)
// Comprehensive automated test verifying:
// 1. EvolutionApiService: sendTextMessage captures and returns key.id
// 2. MessageCacheService: setBotSent with 60s TTL and isBotSent lookup
// 3. WebhookController - Anti-Loop (fromMe: true from bot is ignored)
// 4. WebhookController - Human operator takeover (fromMe: true activates pause)
// 5. WebhookController - Media fallback & empty payload protection
// 6. WebhookController - Debounce buffering of rapid sequential messages
// ==============================================================================

import { query, shutdownPool } from '../src/database/db';
import { AuthService } from '../src/services/auth.service';
import { evolutionService } from '../src/services/evolution.service';
import { messageCache } from '../src/services/message-cache.service';
import { WebhookController } from '../src/controllers/webhook.controller';
import { EvolutionWebhookPayload, AITurnInput } from '../src/types/evolution.types';

async function runPhase3Tests() {
  console.log('================================================================');
  console.log('🧪 INICIANDO BATERIA DE TESTES DE INTEGRAÇÃO - FASE 3 (TYPESCRIPT)');
  console.log('================================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition: boolean, testName: string, details?: string) {
    totalTests++;
    if (condition) {
      console.log(`  ✅ [PASS] ${testName}`);
      passedTests++;
    } else {
      console.error(`  ❌ [FAIL] ${testName}${details ? `: ${details}` : ''}`);
      throw new Error(`Test failed: ${testName}`);
    }
  }

  // Instancia controller com delay curto para teste rápido (150ms)
  const testWebhookController = new WebhookController(150);

  try {
    // --------------------------------------------------------------------------
    // Setup: Cria Tenant de Teste dedicado
    // --------------------------------------------------------------------------
    const tenantEmail = `fase3.test.${Date.now()}@evolution.com`;
    const regResult = await AuthService.registerTenantAndAdmin({
      nome_empresa: 'Fase 3 Tech Telecom',
      documento: '11.222.333/0001-44',
      plano: 'pro',
      nome: 'Diretor Fase 3',
      email: tenantEmail,
      password: 'SenhaForte123!',
      sobre_empresa: 'Provedor de telecomunicações e CFTV.'
    });

    const tenantId = regResult.tenant.id;
    const instanceName = `inst-test-${Date.now()}`;

    // Cadastra instância WhatsApp para o Tenant
    await query(
      `INSERT INTO tenant_whatsapp_instances (tenant_id, instance_name, numero_telefone, status)
       VALUES ($1, $2, '5531999998888', 'open');`,
      [tenantId, instanceName]
    );

    // --------------------------------------------------------------------------
    // Teste 1: EvolutionApiService & Captura de key.id
    // --------------------------------------------------------------------------
    console.log('📋 Teste 1: EvolutionApiService (Envio e Captura do key.id)');
    const sendResult = await evolutionService.sendTextMessage(
      instanceName,
      '5531988889999',
      'Olá, este é um teste automatizado da Fase 3.'
    );
    assert(Boolean(sendResult.messageId), 'sendTextMessage captura e retorna o messageId / key.id');
    assert(sendResult.messageId.length > 5, 'messageId possui tamanho e formato consistente');

    // --------------------------------------------------------------------------
    // Teste 2: Cache de Mensagens do Bot (Anti-Loop Cache)
    // --------------------------------------------------------------------------
    console.log('\n📋 Teste 2: MessageCacheService (TTL 60s & bot_sent lookup)');
    const testBotMsgId = `EVO_BOT_${Date.now()}_ABC`;
    await messageCache.setBotSent(testBotMsgId, 60);

    const isBot = await messageCache.isBotSent(testBotMsgId);
    assert(isBot === true, 'Mensagem registrada como enviada pelo bot retorna true');

    const isUnknown = await messageCache.isBotSent('MSG_INEXISTENTE_XYZ');
    assert(isUnknown === false, 'Mensagem desconhecida retorna false');

    // --------------------------------------------------------------------------
    // Teste 3: Trava de Auto-Loop (fromMe: true originado pela IA)
    // --------------------------------------------------------------------------
    console.log('\n📋 Teste 3: Trava de Auto-Loop (fromMe: true no cache da IA é ignorado)');
    const testRemoteJid = '5531977776666@s.whatsapp.net';

    const botSentPayload: EvolutionWebhookPayload = {
      event: 'messages.upsert',
      instance: instanceName,
      data: {
        key: {
          remoteJid: testRemoteJid,
          fromMe: true,
          id: testBotMsgId
        },
        message: {
          conversation: 'Resposta automática enviada pelo bot.'
        }
      }
    };

    const loopResult = await testWebhookController.handleWebhook(botSentPayload);
    assert(loopResult.handled === true, 'Evento processado pelo webhook');
    assert(loopResult.action === 'ignored_bot_sent', 'Trava de auto-loop ativada: mensagem da própria IA ignorada');

    // --------------------------------------------------------------------------
    // Teste 4: Detecção de Operador Humano no Celular Físico (fromMe: true sem cache)
    // --------------------------------------------------------------------------
    console.log('\n📋 Teste 4: Detecção de Operador Humano (Ativação de Pausa da IA)');
    const humanMsgId = `HUMAN_MSG_${Date.now()}`;
    const humanPayload: EvolutionWebhookPayload = {
      event: 'messages.upsert',
      instance: instanceName,
      data: {
        key: {
          remoteJid: testRemoteJid,
          fromMe: true,
          id: humanMsgId
        },
        message: {
          conversation: 'Olá! Sou o técnico João assumindo o atendimento.'
        }
      }
    };

    const humanResult = await testWebhookController.handleWebhook(humanPayload);
    assert(humanResult.action === 'human_operator_takeover_activated', 'Atendimento pausado para operador humano');
    assert(Boolean(humanResult.pausedUntil), 'Data pausedUntil calculada');
    assert(humanResult.pausaMinutos === 45, 'Tempo de pausa respeita tenant_ai_configs (45 min)');

    // Verifica no banco de dados se a sessão está em pausa_humana
    const sessionDb = await query<{ status_atendimento: string; paused_until: Date }>(
      `SELECT status_atendimento, paused_until FROM chat_sessions WHERE tenant_id = $1 AND remote_jid = $2;`,
      [tenantId, testRemoteJid]
    );
    assert(sessionDb.rows[0].status_atendimento === 'pausa_humana', 'Sessão persistida como "pausa_humana"');
    assert(new Date(sessionDb.rows[0].paused_until) > new Date(), 'paused_until está no futuro');

    // Verifica se a mensagem do humano foi gravada
    const humanMsgDb = await query(
      `SELECT content, role FROM chat_messages WHERE message_id = $1;`,
      [humanMsgId]
    );
    assert(humanMsgDb.rows.length === 1, 'Mensagem do operador gravada no histórico');
    assert(humanMsgDb.rows[0].role === 'assistant', 'Mensagem gravada com role assistant');

    // --------------------------------------------------------------------------
    // Teste 5: Edge Cases de Mídia e Fallbacks
    // --------------------------------------------------------------------------
    console.log('\n📋 Teste 5: Tratamento de Mídias (Áudio, Foto e Proteção contra Vazio)');
    const clientJid = '5531911112222@s.whatsapp.net';

    // 5.1 Payload vazio
    const emptyPayload: EvolutionWebhookPayload = {
      event: 'messages.upsert',
      instance: instanceName,
      data: {
        key: { remoteJid: clientJid, fromMe: false, id: `EMPTY_${Date.now()}` },
        message: {}
      }
    };
    const emptyRes = await testWebhookController.handleWebhook(emptyPayload);
    assert(emptyRes.action === 'empty_payload_ignored', 'Payload vazio protegido sem quebrar o sistema');

    // 5.2 Áudio sem transcrição
    const audioPayload: EvolutionWebhookPayload = {
      event: 'messages.upsert',
      instance: instanceName,
      data: {
        key: { remoteJid: clientJid, fromMe: false, id: `AUDIO_${Date.now()}` },
        message: { audioMessage: { seconds: 12 } }
      }
    };
    const audioRes = await testWebhookController.handleWebhook(audioPayload);
    assert(audioRes.action === 'media_fallback_dispatched', 'Fallback amigável disparado para áudio recebido');

    // 5.3 Imagem / Foto do local
    const imagePayload: EvolutionWebhookPayload = {
      event: 'messages.upsert',
      instance: instanceName,
      data: {
        key: { remoteJid: clientJid, fromMe: false, id: `IMG_${Date.now()}` },
        message: { imageMessage: { caption: '' } }
      }
    };
    const imageRes = await testWebhookController.handleWebhook(imagePayload);
    assert(imageRes.action === 'media_fallback_dispatched', 'Fallback amigável disparado para foto recebida');

    // --------------------------------------------------------------------------
    // Teste 6: Debounce de Mensagens Fragmentadas Rápidas
    // --------------------------------------------------------------------------
    console.log('\n📋 Teste 6: Debounce de Mensagens Sequenciais (Buffer Consolidado)');
    const rapidJid = '5531933334444@s.whatsapp.net';

    let dispatchedTurn: AITurnInput | null = null;
    testWebhookController.setAIProcessor(async (turn) => {
      dispatchedTurn = turn;
    });

    // Envia 3 fragmentos rápidos
    await testWebhookController.handleWebhook({
      event: 'messages.upsert',
      instance: instanceName,
      data: {
        key: { remoteJid: rapidJid, fromMe: false, id: `RAPID_1_${Date.now()}` },
        pushName: 'Cliente Rápido',
        message: { conversation: 'Olá boa tarde' }
      }
    });

    await testWebhookController.handleWebhook({
      event: 'messages.upsert',
      instance: instanceName,
      data: {
        key: { remoteJid: rapidJid, fromMe: false, id: `RAPID_2_${Date.now()}` },
        pushName: 'Cliente Rápido',
        message: { conversation: 'Vocês atendem no bairro Lourdes?' }
      }
    });

    await testWebhookController.handleWebhook({
      event: 'messages.upsert',
      instance: instanceName,
      data: {
        key: { remoteJid: rapidJid, fromMe: false, id: `RAPID_3_${Date.now()}` },
        pushName: 'Cliente Rápido',
        message: { conversation: 'Preciso consertar 4 câmeras hoje.' }
      }
    });

    // Aguarda o término do debounce (150ms + margem)
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert(dispatchedTurn !== null, 'Turno da IA disparado após o tempo de debounce');
    assert(
      (dispatchedTurn as any)?.userMessage === 'Olá boa tarde\nVocês atendem no bairro Lourdes?\nPreciso consertar 4 câmeras hoje.',
      'Fragmentos rápidos consolidados em uma única mensagem contínua'
    );
    assert((dispatchedTurn as any)?.remoteJid === rapidJid, 'JID correto encaminhado para a IA');

    // --------------------------------------------------------------------------
    // Limpeza final do tenant de teste
    // --------------------------------------------------------------------------
    await query('DELETE FROM tenants WHERE id = $1;', [tenantId]);

    console.log('\n================================================================');
    console.log(`🎉 TODAS AS VALIDAÇÕES DA FASE 3 FORAM CONCLUÍDAS COM SUCESSO!`);
    console.log(`Total de Testes: ${totalTests} | Aprovados: ${passedTests} | Falhas: 0`);
    console.log('================================================================\n');

  } catch (err) {
    console.error('❌ Falha na bateria de testes da Fase 3:', err);
    throw err;
  } finally {
    testWebhookController.clearBuffers();
    await shutdownPool();
  }
}

runPhase3Tests()
  .then(() => {
    setTimeout(() => process.exit(0), 100);
  })
  .catch((err) => {
    console.error(err);
    setTimeout(() => process.exit(1), 100);
  });
