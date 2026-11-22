// ==============================================================================
// TESTE: NOVOS CONTATOS - AUTOMAÇÃO (IA ATIVA) VS MANUAL (HUMANO)
// ==============================================================================

const assert = require('assert');

async function runNewContactsValidation() {
  console.log('========================================================================');
  console.log('🚀 TESTE DE NOVOS CONTATOS: AUTOMAÇÃO (IA) VS MANUAL (HUMANO)');
  console.log('========================================================================\n');

  // Dependências a interceptar
  const dbMod = require('../database/db');
  const evMod = require('../services/evolution.service');
  const entMod = require('../services/entitlements.service');

  const origQuery = dbMod.query;
  const origCanUse = entMod.canUseFeature;
  const origRejectCall = evMod.rejectCall;
  const origSendPresence = evMod.sendPresence;

  // Permissão de bot ativa
  entMod.canUseFeature = async () => true;
  evMod.rejectCall = async () => ({ success: true });
  evMod.sendPresence = async () => ({ success: true });

  // Simulação de banco de dados em memória
  const memoryDb = {
    chat_sessions: [],
    chat_messages: [],
    tenant_ai_configs: [
      {
        tenant_id: 'tenant-test',
        modo_atendimento: 'automacao',
        automacao_horario_ativo: false,
        atender_chamadas: true,
        mensagem_chamada: 'Olá! Como sou a Nat...'
      }
    ],
    tenants: [{ id: 'tenant-test', nome_empresa: 'Empresa Teste', plano: 'pro', ativo: true }],
    tenant_whatsapp_instances: [{ tenant_id: 'tenant-test', instance_name: 'test-inst', status: 'open' }]
  };

  dbMod.query = async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();

    // SELECT tenant_whatsapp_instances / tenants
    if (s.includes('FROM tenant_whatsapp_instances WHERE LOWER(instance_name)')) {
      const inst = params[0]?.toLowerCase();
      const row = memoryDb.tenant_whatsapp_instances.find(w => w.instance_name.toLowerCase() === inst);
      return { rowCount: row ? 1 : 0, rows: row ? [row] : [] };
    }

    if (s.includes('FROM tenants WHERE id = $1')) {
      const t = memoryDb.tenants.find(x => x.id === params[0]);
      return { rowCount: t ? 1 : 0, rows: t ? [t] : [] };
    }

    // SELECT tenant_ai_configs
    if (s.includes('FROM tenant_ai_configs WHERE tenant_id = $1')) {
      const cfg = memoryDb.tenant_ai_configs.find(c => c.tenant_id === params[0]);
      return { rowCount: cfg ? 1 : 0, rows: cfg ? [cfg] : [] };
    }

    // SELECT chat_sessions
    if (s.includes('FROM chat_sessions WHERE tenant_id = $1 AND remote_jid = $2')) {
      const session = memoryDb.chat_sessions.find(x => x.tenant_id === params[0] && x.remote_jid === params[1]);
      return { rowCount: session ? 1 : 0, rows: session ? [session] : [] };
    }

    // INSERT INTO chat_sessions
    if (s.startsWith('INSERT INTO chat_sessions')) {
      const tenantId = params[0];
      const remoteJid = params[1];
      const clientName = params[2];
      let status = 'ia_ativa';
      let etapa = 'novo';
      let pausedUntil = null;

      // params: [tenantId, effectiveJid, pushName, initialStatus, isManualTenant ? 'manual' : 'novo', initialPausedUntil]
      if (params.length >= 6) {
        status = params[3];
        etapa = params[4];
        pausedUntil = params[5];
      }

      const newRow = {
        id: `sess-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        tenant_id: tenantId,
        remote_jid: remoteJid,
        client_name: clientName,
        status_atendimento: status,
        etapa_funil: etapa,
        paused_until: pausedUntil,
        pending_after_hours_followup: false,
        after_hours_notice_sent_at: null,
        unread_count: 0
      };
      memoryDb.chat_sessions.push(newRow);
      return { rowCount: 1, rows: [newRow] };
    }

    // UPDATE chat_sessions
    if (s.startsWith('UPDATE chat_sessions')) {
      const session = memoryDb.chat_sessions.find(x => x.id === params[0] || x.tenant_id === params[1]);
      if (session) {
        session.unread_count = (session.unread_count || 0) + 1;
      }
      return { rowCount: 1, rows: session ? [session] : [] };
    }

    // INSERT INTO chat_messages
    if (s.startsWith('INSERT INTO chat_messages')) {
      const msg = {
        id: `msg-${Date.now()}`,
        session_id: params[0],
        tenant_id: params[1],
        role: params[2],
        content: params[3],
        is_read: false
      };
      memoryDb.chat_messages.push(msg);
      return { rowCount: 1, rows: [msg] };
    }

    return { rowCount: 0, rows: [] };
  };

  // Limpa cache de require para carregar WebhookController com o mock injetado
  delete require.cache[require.resolve('../controllers/webhook.controller')];
  const { WebhookController } = require('../controllers/webhook.controller');

  const webhook = new WebhookController();
  webhook.DEBOUNCE_DELAY_MS = 30;
  let aiProcessorDispatched = false;
  let lastDispatchedTurn = null;

  webhook.setAIProcessor(async (params) => {
    aiProcessorDispatched = true;
    lastDispatchedTurn = params;
    return { success: true };
  });

  try {
    // ------------------------------------------------------------------------
    // CENÁRIO 1: Tenant em AUTOMAÇÃO (IA ATIVA)
    // Novo contato envia mensagem -> DEVE ser atendido pela Automação
    // ------------------------------------------------------------------------
    console.log('--- CENÁRIO 1: Novo contato com Automação (IA Ativa) Habilitada ---');
    memoryDb.tenant_ai_configs[0].modo_atendimento = 'automacao';
    aiProcessorDispatched = false;
    lastDispatchedTurn = null;

    const newContactJid1 = '5531988880001@s.whatsapp.net';
    const payloadMsgAuto = {
      event: 'messages.upsert',
      instance: 'test-inst',
      data: {
        key: {
          remoteJid: newContactJid1,
          fromMe: false,
          id: 'MSG_NEW_001'
        },
        pushName: 'Novo Cliente Automação',
        message: {
          conversation: 'Olá, gostaria de saber mais sobre os serviços'
        }
      }
    };

    const res1 = await webhook.handleWebhook(payloadMsgAuto);
    assert.strictEqual(res1.action, 'buffered_in_debounce', 'Mensagem do novo contato deve entrar no buffer de debounce para IA');

    // Aguarda debounce disparar
    await new Promise(r => setTimeout(r, 60));

    // Valida sessão no banco
    const session1 = memoryDb.chat_sessions.find(s => s.remote_jid === newContactJid1);
    assert(session1, 'Sessão do novo contato deve ser criada');
    assert.strictEqual(session1.status_atendimento, 'ia_ativa', 'Novo contato com automação ativa deve ter status ia_ativa');
    assert.strictEqual(session1.paused_until, null, 'Novo contato com automação ativa deve ter paused_until = null');
    assert.strictEqual(session1.etapa_funil, 'novo', 'Novo contato deve ter etapa_funil = novo');

    // Valida disparo da IA
    assert.strictEqual(aiProcessorDispatched, true, 'Automação IA deve ser disparada para novo contato');
    assert.strictEqual(lastDispatchedTurn.remoteJid, newContactJid1);
    console.log('✅ [PASS] Cenário 1: Novo contato foi atribuído à Automação IA e respondido automaticamente!\n');

    // ------------------------------------------------------------------------
    // CENÁRIO 2: Tenant em MANUAL (HUMANO)
    // Novo contato envia mensagem -> DEVE ser atendido MANUALMENTE (IA 100% silenciada)
    // ------------------------------------------------------------------------
    console.log('--- CENÁRIO 2: Novo contato com Atendimento Manual (Humano) Habilitado ---');
    memoryDb.tenant_ai_configs[0].modo_atendimento = 'manual';
    aiProcessorDispatched = false;
    lastDispatchedTurn = null;

    const newContactJid2 = '5531988880002@s.whatsapp.net';
    const payloadMsgManual = {
      event: 'messages.upsert',
      instance: 'test-inst',
      data: {
        key: {
          remoteJid: newContactJid2,
          fromMe: false,
          id: 'MSG_NEW_002'
        },
        pushName: 'Novo Cliente Manual',
        message: {
          conversation: 'Olá, quero falar com um atendente humano'
        }
      }
    };

    const res2 = await webhook.handleWebhook(payloadMsgManual);
    assert.strictEqual(res2.action, 'tenant_manual_mode_active', 'Automação deve ser silenciada com tenant_manual_mode_active');

    // Aguarda qualquer tempo residual de debounce
    await new Promise(r => setTimeout(r, 60));

    // Valida sessão no banco
    const session2 = memoryDb.chat_sessions.find(s => s.remote_jid === newContactJid2);
    assert(session2, 'Sessão do novo contato deve ser criada');
    assert.strictEqual(session2.status_atendimento, 'manual', 'Novo contato em tenant manual deve ter status manual');
    assert(session2.paused_until && new Date(session2.paused_until).getTime() > Date.now(), 'paused_until deve ser no futuro distante');
    assert.strictEqual(session2.etapa_funil, 'manual', 'Novo contato em tenant manual deve ter etapa_funil = manual');

    // Valida que a IA NÃO foi chamada
    assert.strictEqual(aiProcessorDispatched, false, 'Automação IA NÃO pode ser disparada quando em modo manual');
    console.log('✅ [PASS] Cenário 2: Novo contato foi atribuído ao atendimento Manual e a IA foi 100% silenciada!\n');

    // ------------------------------------------------------------------------
    // CENÁRIO 3: 2ª Mensagem do contato manual permanece manual
    // Mesmo se o tenant mudar ou permanecer manual, o contato nunca é desarmado
    // ------------------------------------------------------------------------
    console.log('--- CENÁRIO 3: Segunda mensagem do contato manual ---');
    const res2b = await webhook.handleWebhook({
      event: 'messages.upsert',
      instance: 'test-inst',
      data: {
        key: {
          remoteJid: newContactJid2,
          fromMe: false,
          id: 'MSG_NEW_002_B'
        },
        pushName: 'Novo Cliente Manual',
        message: {
          conversation: 'Alguém me atende por favor?'
        }
      }
    });

    assert.strictEqual(aiProcessorDispatched, false, 'IA permanece 100% silenciada');
    console.log('✅ [PASS] Cenário 3: Contato manual permanece rigorosamente manual sem intervenção da IA!\n');

    // ------------------------------------------------------------------------
    // CENÁRIO 4: Chamada de novo contato quando Tenant está em Automação
    // ------------------------------------------------------------------------
    console.log('--- CENÁRIO 4: Chamada de novo contato em modo Automação ---');
    memoryDb.tenant_ai_configs[0].modo_atendimento = 'automacao';
    const callerAutoJid = '5531988880003@s.whatsapp.net';

    await webhook.handleWebhook({
      event: 'call',
      instance: 'test-inst',
      data: {
        id: 'CALL_001',
        from: callerAutoJid,
        isVideo: false,
        status: 'offer'
      }
    });

    const sessionCallAuto = memoryDb.chat_sessions.find(s => s.remote_jid === callerAutoJid);
    assert(sessionCallAuto, 'Sessão da chamada deve ser criada');
    assert.strictEqual(sessionCallAuto.status_atendimento, 'ia_ativa', 'Chamada em automação deve ser criada como ia_ativa');
    console.log('✅ [PASS] Cenário 4: Chamada em modo automação inicializada com ia_ativa!\n');

    // ------------------------------------------------------------------------
    // CENÁRIO 5: Chamada de novo contato quando Tenant está em Manual
    // ------------------------------------------------------------------------
    console.log('--- CENÁRIO 5: Chamada de novo contato em modo Manual ---');
    memoryDb.tenant_ai_configs[0].modo_atendimento = 'manual';
    const callerManualJid = '5531988880004@s.whatsapp.net';

    const resCallManual = await webhook.handleWebhook({
      event: 'call',
      instance: 'test-inst',
      data: {
        id: 'CALL_002',
        from: callerManualJid,
        isVideo: false,
        status: 'offer'
      }
    });

    const sessionCallManual = memoryDb.chat_sessions.find(s => s.remote_jid === callerManualJid);
    assert(sessionCallManual, 'Sessão da chamada deve ser criada');
    assert.strictEqual(sessionCallManual.status_atendimento, 'manual', 'Chamada em manual deve ser criada como manual');
    assert.strictEqual(resCallManual.action, 'call_logged_manual_mode', 'Chamada em modo manual não dispara resposta automática');
    console.log('✅ [PASS] Cenário 5: Chamada em modo manual criada como manual sem bot de resposta!\n');

    // ------------------------------------------------------------------------
    // CENÁRIO 6: Contato criado durante modo Manual permanece Manual mesmo após tenant mudar para Automação
    // ------------------------------------------------------------------------
    console.log('--- CENÁRIO 6: Contato manual protegido após tenant reativar Automação ---');
    memoryDb.tenant_ai_configs[0].modo_atendimento = 'automacao';
    aiProcessorDispatched = false;

    const res6 = await webhook.handleWebhook({
      event: 'messages.upsert',
      instance: 'test-inst',
      data: {
        key: {
          remoteJid: newContactJid2, // Contato criado no Cenário 2 (manual)
          fromMe: false,
          id: 'MSG_NEW_002_C'
        },
        pushName: 'Novo Cliente Manual',
        message: {
          conversation: 'Continuo precisando de ajuda humana'
        }
      }
    });

    assert.strictEqual(res6.action, 'message_saved_human_in_control', 'Contato manual deve permanecer silenciado mesmo com tenant em automação');
    assert.strictEqual(aiProcessorDispatched, false, 'IA não deve responder a contato manual pré-existente');
    console.log('✅ [PASS] Cenário 6: Contato manual permaneceu 100% protegido e silenciado mesmo com o tenant em Automação!\n');

    console.log('========================================================================');
    console.log('🎉 TODOS OS 6 CENÁRIOS DE CRIAÇÃO E CONTROLE PASSARAM 100%!');
    console.log('========================================================================');
  } finally {
    dbMod.query = origQuery;
    entMod.canUseFeature = origCanUse;
    evMod.rejectCall = origRejectCall;
    evMod.sendPresence = origSendPresence;
  }
}

runNewContactsValidation().catch(err => {
  console.error('❌ Falha nos testes de novos contatos:', err);
  process.exit(1);
});
