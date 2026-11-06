// ==============================================================================
// Test Suite: Chamadas de Voz/Vídeo & Áudio (Whisper Transcription & TTS)
// ==============================================================================

const assert = require('assert');
const { query } = require('../database/db');
const webhookController = require('../controllers/webhook.controller');
const evolutionService = require('../services/evolution.service');
const messageCache = require('../services/message-cache.service');
const audioTranscriptionService = require('../services/audio-transcription.service');
const ttsService = require('../services/tts.service');
const aiEngine = require('../services/ai-engine.service');

async function runTests() {
  console.log('================================================================');
  console.log('🚀 INICIANDO TESTES DE CHAMADAS (VOZ/VÍDEO) E ÁUDIOS (WHISPER & TTS)');
  console.log('================================================================\n');

  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    return Promise.resolve()
      .then(fn)
      .then(() => {
        console.log(`  ✅ [PASS] ${name}`);
        passed++;
      })
      .catch(err => {
        console.error(`  ❌ [FAIL] ${name}:`, err.message);
        failed++;
      });
  }

  // Identifica o tenant da WarNat Tech
  const tenantRes = await query(`SELECT id, nome_empresa FROM tenants ORDER BY created_at ASC LIMIT 1`);
  const tenant = tenantRes.rows[0];
  const tenantId = tenant.id;

  // Garante configuração inicial de IA com atendimento de chamadas e áudio ativo
  await query(
    `UPDATE tenant_ai_configs 
     SET modo_atendimento = 'automacao',
         atender_chamadas = true,
         responder_com_audio = 'quando_receber_audio',
         voz_ia = 'nova'
     WHERE tenant_id = $1`,
    [tenantId]
  );

  const testPhone = '5531977770001';
  const testJid = `${testPhone}@s.whatsapp.net`;

  // Limpa mensagens e sessões anteriores do teste
  await query(`DELETE FROM chat_messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE remote_jid = $1)`, [testJid]);
  await query(`DELETE FROM chat_sessions WHERE remote_jid = $1`, [testJid]);

  // Mock para interceptar envios da Evolution API
  const originalSendText = evolutionService.sendTextMessage;
  const originalSendAudio = evolutionService.sendWhatsAppAudio;
  const originalRejectCall = evolutionService.rejectCall;
  const originalTranscribe = audioTranscriptionService.transcribeAudio;
  const originalGenerateSpeech = ttsService.generateSpeech;

  let sentMessages = [];
  let sentAudios = [];
  let rejectedCalls = [];

  evolutionService.sendTextMessage = async (instanceName, to, text) => {
    const msgId = `MOCK_TEXT_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    sentMessages.push({ instanceName, to, text, msgId });
    return { success: true, messageId: msgId };
  };

  evolutionService.sendWhatsAppAudio = async (instanceName, to, audioBase64, options) => {
    const msgId = `MOCK_AUDIO_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    sentAudios.push({ instanceName, to, audioBase64, msgId, options });
    return { success: true, messageId: msgId };
  };

  evolutionService.rejectCall = async (instanceName, callId) => {
    rejectedCalls.push({ instanceName, callId });
    return { success: true };
  };

  try {
    // --------------------------------------------------------------------------
    // TESTE 1: Recebimento de Chamada de Voz no WhatsApp
    // --------------------------------------------------------------------------
    await test('Recebimento de Chamada de Voz: Registra no CRM e responde com Nat', async () => {
      sentMessages = [];
      sentAudios = [];
      rejectedCalls = [];

      const payload = {
        event: 'call',
        instance: 'warnat-tech',
        data: {
          id: 'call_voice_123',
          from: testJid,
          isVideo: false,
          isGroup: false,
          status: 'offer'
        }
      };

      const result = await webhookController.handleWebhook(payload);
      assert.strictEqual(result.handled, true, 'Webhook deveria ter tratado a chamada');
      assert.strictEqual(result.action, 'call_answered_with_bot_notice');
      assert.strictEqual(rejectedCalls.length, 1, 'Chamada deveria ter sido rejeitada na Evolution API');
      assert.strictEqual(rejectedCalls[0].callId, 'call_voice_123');

      // Verifica gravação no banco de dados
      const msgs = await query(
        `SELECT role, content, media_type 
         FROM chat_messages m 
         JOIN chat_sessions s ON s.id = m.session_id 
         WHERE s.remote_jid = $1 
         ORDER BY m.created_at ASC`,
        [testJid]
      );

      assert.strictEqual(msgs.rowCount, 2, 'Deveria ter registrado a chamada do usuário e a resposta da IA');
      assert.strictEqual(msgs.rows[0].role, 'user');
      assert.strictEqual(msgs.rows[0].media_type, 'call_voice');
      assert.ok(msgs.rows[0].content.includes('voz'), 'Conteúdo deve mencionar chamada de voz');

      assert.strictEqual(msgs.rows[1].role, 'assistant');
      assert.ok(msgs.rows[1].content.includes('Nat'), 'Resposta deve ser da assistente virtual Nat');
      assert.ok(msgs.rows[1].content.includes('áudio e texto'), 'Resposta deve orientar o atendimento ágil');

      // Verifica se a resposta foi enviada pelo canal do WhatsApp
      assert.strictEqual(sentMessages.length, 1);
      assert.ok(sentMessages[0].text.includes('Nat'));
    });

    // --------------------------------------------------------------------------
    // TESTE 2: Recebimento de Chamada de Vídeo no WhatsApp
    // --------------------------------------------------------------------------
    await test('Recebimento de Chamada de Vídeo: Identifica tipo vídeo e acolhe no WhatsApp', async () => {
      sentMessages = [];
      rejectedCalls = [];

      const payload = {
        event: 'call',
        instance: 'warnat-tech',
        data: {
          id: 'call_video_456',
          from: testJid,
          isVideo: true,
          isGroup: false,
          status: 'offer'
        }
      };

      const result = await webhookController.handleWebhook(payload);
      assert.strictEqual(result.handled, true);
      assert.strictEqual(result.isVideo, true);

      const msgs = await query(
        `SELECT role, content, media_type 
         FROM chat_messages m 
         JOIN chat_sessions s ON s.id = m.session_id 
         WHERE s.remote_jid = $1 
         ORDER BY m.created_at DESC LIMIT 2`,
        [testJid]
      );

      assert.strictEqual(msgs.rows[1].media_type, 'call_video');
      assert.ok(msgs.rows[1].content.includes('vídeo'));
      assert.ok(msgs.rows[0].content.includes('vídeo'), 'Aviso da IA deve citar a chamada de vídeo');
    });

    // --------------------------------------------------------------------------
    // TESTE 3: Chamada com Tenant em Modo 100% Manual
    // --------------------------------------------------------------------------
    await test('Chamada com Tenant em Modo Manual: Registra sem resposta automática do bot', async () => {
      sentMessages = [];
      await query(`UPDATE tenant_ai_configs SET modo_atendimento = 'manual' WHERE tenant_id = $1`, [tenantId]);

      const payload = {
        event: 'call',
        instance: 'warnat-tech',
        data: {
          id: 'call_manual_789',
          from: testJid,
          isVideo: false,
          status: 'offer'
        }
      };

      const result = await webhookController.handleWebhook(payload);
      assert.strictEqual(result.handled, true);
      assert.strictEqual(result.action, 'call_logged_manual_mode');
      assert.strictEqual(sentMessages.length, 0, 'Não deve disparar mensagem automática em modo manual');

      // Restaura modo automação
      await query(`UPDATE tenant_ai_configs SET modo_atendimento = 'automacao' WHERE tenant_id = $1`, [tenantId]);
    });

    // --------------------------------------------------------------------------
    // TESTE 4: Transcrição de Áudio Recebido (OpenAI Whisper Pipeline)
    // --------------------------------------------------------------------------
    await test('Escutar Áudio: Baixa base64 e transcreve via Whisper para a IA', async () => {
      // Mock da transcrição Whisper
      audioTranscriptionService.transcribeAudio = async (base64) => {
        return 'Olá Nat, gostaria de agendar uma visita para instalar 4 câmeras na minha loja';
      };

      const audioJid = '5531977770004@s.whatsapp.net';

      const audioPayload = {
        event: 'messages.upsert',
        instance: 'warnat-tech',
        data: {
          key: {
            remoteJid: audioJid,
            fromMe: false,
            id: `AUDIO_MSG_${Date.now()}`
          },
          pushName: 'Cliente Áudio',
          message: {
            audioMessage: {
              mimetype: 'audio/ogg; codecs=opus',
              seconds: 5,
              base64: 'T2xhIE5hdCwgdHJhbnNjcmljw6NvIGRlIHRlc3Rl'
            }
          }
        }
      };

      const res = await webhookController.handleWebhook(audioPayload);
      assert.strictEqual(res.handled, true);
      assert.strictEqual(res.action, 'buffered_in_debounce');

      // Limpa buffer de debounce do teste para não disparar em segundo plano
      const bufKey = `${tenantId}:${audioJid}`;
      const buf = webhookController.debounceBuffers.get(bufKey);
      if (buf && buf.timer) clearTimeout(buf.timer);
      webhookController.debounceBuffers.delete(bufKey);

      // Verifica se a mensagem gravada no banco contém [audio] e a transcrição
      const msgRes = await query(
        `SELECT content, media_type FROM chat_messages m 
         JOIN chat_sessions s ON s.id = m.session_id 
         WHERE s.remote_jid = $1 
         ORDER BY m.created_at DESC LIMIT 1`,
        [audioJid]
      );

      assert.strictEqual(msgRes.rows[0].media_type, 'audio');
      assert.ok(msgRes.rows[0].content.startsWith('[audio]'));
      assert.ok(msgRes.rows[0].content.includes('instalar 4 câmeras'));
    });

    // --------------------------------------------------------------------------
    // TESTE 5: Responder por Áudio (TTS Voice Synthesis & WhatsApp Audio)
    // --------------------------------------------------------------------------
    await test('Responder por Áudio: Gera nota de voz via TTS e envia como áudio PTT', async () => {
      sentAudios = [];
      sentMessages = [];

      // Mock da síntese TTS
      ttsService.generateSpeech = async (text, options) => {
        return {
          buffer: Buffer.from('mock-audio-bytes'),
          base64: 'bW9jay1hdWRpby1ieXRlcw==',
          mimetype: 'audio/mp3',
          voice: options.voice || 'nova',
          size: 16
        };
      };

      // Busca sessão do contato de teste
      const sess = await query(`SELECT id FROM chat_sessions WHERE remote_jid = $1`, [testJid]);
      const sessionId = sess.rows[0].id;

      // Executa um turno onde o usuário enviou áudio (isAudio: true)
      const turnRes = await aiEngine.processTurn({
        tenantId,
        instanceName: 'warnat-tech',
        sessionId,
        remoteJid: testJid,
        pushName: 'Cliente Áudio',
        userMessage: '[audio] Quero uma visita técnica para instalação de câmeras novas',
        isAudio: true
      });

      assert.strictEqual(turnRes.success, true);
      assert.strictEqual(turnRes.mediaType, 'audio', 'Deveria ter respondido no formato áudio');
      assert.strictEqual(sentAudios.length, 1, 'Deveria ter chamado sendWhatsAppAudio');
      assert.strictEqual(sentAudios[0].to, testJid);
      assert.ok(sentAudios[0].audioBase64, 'Deveria conter áudio base64 sintetizado');

      // Verifica se a resposta foi gravada no banco com media_type 'audio'
      const savedMsg = await query(
        `SELECT role, media_type, content FROM chat_messages 
         WHERE session_id = $1 AND role = 'assistant' 
         ORDER BY created_at DESC LIMIT 1`,
        [sessionId]
      );

      assert.strictEqual(savedMsg.rows[0].media_type, 'audio');
      assert.ok(savedMsg.rows[0].content.length > 10);
    });

    // --------------------------------------------------------------------------
    // TESTE 6: Modo 'sempre' responder com áudio (mesmo recebendo texto)
    // --------------------------------------------------------------------------
    await test('Modo "sempre responder por áudio": Responde com áudio mesmo se cliente mandou texto', async () => {
      sentAudios = [];
      await query(`UPDATE tenant_ai_configs SET responder_com_audio = 'sempre' WHERE tenant_id = $1`, [tenantId]);

      const sess = await query(`SELECT id FROM chat_sessions WHERE remote_jid = $1`, [testJid]);
      const sessionId = sess.rows[0].id;

      const turnRes = await aiEngine.processTurn({
        tenantId,
        instanceName: 'warnat-tech',
        sessionId,
        remoteJid: testJid,
        pushName: 'Cliente Texto',
        userMessage: 'Qual o valor da instalação?',
        isAudio: false
      });

      assert.strictEqual(turnRes.success, true);
      assert.strictEqual(turnRes.mediaType, 'audio', 'Mesmo recebendo texto puro, deve responder em áudio no modo "sempre"');
      assert.strictEqual(sentAudios.length, 1);

      // Restaura para modo híbrido
      await query(`UPDATE tenant_ai_configs SET responder_com_audio = 'quando_receber_audio' WHERE tenant_id = $1`, [tenantId]);
    });

    // --------------------------------------------------------------------------
    // TESTE 7: Modo 'nunca' responder com áudio (apenas texto)
    // --------------------------------------------------------------------------
    await test('Modo "nunca responder por áudio": Responde em texto mesmo se cliente mandou áudio', async () => {
      sentAudios = [];
      sentMessages = [];
      await query(`UPDATE tenant_ai_configs SET responder_com_audio = 'nunca' WHERE tenant_id = $1`, [tenantId]);

      const sess = await query(`SELECT id FROM chat_sessions WHERE remote_jid = $1`, [testJid]);
      const sessionId = sess.rows[0].id;

      const turnRes = await aiEngine.processTurn({
        tenantId,
        instanceName: 'warnat-tech',
        sessionId,
        remoteJid: testJid,
        pushName: 'Cliente Áudio',
        userMessage: '[audio] Quero conserto de câmera',
        isAudio: true
      });

      assert.strictEqual(turnRes.success, true);
      assert.strictEqual(turnRes.mediaType, 'text', 'No modo "nunca", deve responder estritamente em texto');
      assert.strictEqual(sentAudios.length, 0);
      assert.strictEqual(sentMessages.length, 1);

      // Restaura para modo padrão híbrido
      await query(`UPDATE tenant_ai_configs SET responder_com_audio = 'quando_receber_audio' WHERE tenant_id = $1`, [tenantId]);
    });

    // --------------------------------------------------------------------------
    // TESTE 8: Validação do Serviço Real de TTS e Whisper com Classes
    // --------------------------------------------------------------------------
    await test('Validação dos Serviços TTS e Whisper: Métodos e inicialização íntegros', async () => {
      assert.strictEqual(typeof ttsService.generateSpeech, 'function');
      assert.strictEqual(typeof audioTranscriptionService.transcribeAudio, 'function');
      assert.strictEqual(typeof evolutionService.sendWhatsAppAudio, 'function');
      assert.strictEqual(typeof evolutionService.rejectCall, 'function');
    });

  } finally {
    // Restaura mocks
    evolutionService.sendTextMessage = originalSendText;
    evolutionService.sendWhatsAppAudio = originalSendAudio;
    evolutionService.rejectCall = originalRejectCall;
    audioTranscriptionService.transcribeAudio = originalTranscribe;
    ttsService.generateSpeech = originalGenerateSpeech;

    // Limpa dados de teste
    await query(`DELETE FROM chat_messages WHERE session_id IN (SELECT id FROM chat_sessions WHERE remote_jid = $1)`, [testJid]);
    await query(`DELETE FROM chat_sessions WHERE remote_jid = $1`, [testJid]);
  }

  console.log('\n================================================================');
  console.log(`📊 RESULTADO FINAL: ${passed} PASSOU / ${failed} FALHOU`);
  console.log('================================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('💥 Erro fatal no runner de testes:', err);
  process.exit(1);
});
