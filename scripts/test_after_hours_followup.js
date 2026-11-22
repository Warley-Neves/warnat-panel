// ==============================================================================
// TESTE RIGOROSO: RETOMADA AUTOMÁTICA NO INÍCIO DO HORÁRIO DE ATENDIMENTO
// Valida TODOS os 11 cenários (positivos e negativos) sem exceções
// ==============================================================================

const assert = require('assert');
const { WebhookController } = require('../controllers/webhook.controller');
const { AfterHoursFollowupService } = require('../services/after-hours-followup.service');

async function runTests() {
  console.log('========================================================================');
  console.log('🚀 BATERIA DE TESTES: RETOMADA AUTOMÁTICA APÓS FORA DO EXPEDIENTE');
  console.log('========================================================================\n');

  const webhook = new WebhookController();

  // --------------------------------------------------------------------------
  // Validação de horário de Brasília com referenceDate explícito
  // --------------------------------------------------------------------------
  const scheduleCfg = {
    automacao_horario_ativo: true,
    automacao_dias_semana: ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'],
    automacao_horario_inicio: '08:00',
    automacao_horario_fim: '18:00'
  };

  // Domingo 2026-11-22 21:00 BRT (-03:00) -> FECHADO
  const sundayNight = '2026-11-22T21:00:00-03:00';
  // Segunda 2026-11-23 07:59 BRT (-03:00) -> FECHADO
  const monday0759 = '2026-11-23T07:59:00-03:00';
  // Segunda 2026-11-23 08:00 BRT (-03:00) -> ABERTO
  const monday0800 = '2026-11-23T08:00:00-03:00';
  // Segunda 2026-11-23 18:01 BRT (-03:00) -> FECHADO
  const monday1801 = '2026-11-23T18:01:00-03:00';

  assert.strictEqual(webhook.checkAutomationOperatingHours(scheduleCfg, sundayNight).isOpen, false);
  assert.strictEqual(webhook.checkAutomationOperatingHours(scheduleCfg, monday0759).isOpen, false);
  assert.strictEqual(webhook.checkAutomationOperatingHours(scheduleCfg, monday0800).isOpen, true);
  assert.strictEqual(webhook.checkAutomationOperatingHours(scheduleCfg, monday1801).isOpen, false);
  console.log('✅ [BASE] Validação exata de transição de expediente (07:59 fechado -> 08:00 aberto -> 18:01 fechado) aprovada.');

  // Helper para criar banco em memória + service isolado por cenário
  function createHarness(initialSessions = [], options = {}) {
    const db = {
      sessions: initialSessions.map((s) => ({ ...s })),
      messages: (options.messages || []).map((m) => ({ ...m }))
    };

    const aiCalls = [];
    const sentTexts = [];
    let instanceState = options.instanceState || 'open';
    let canUseBots = options.canUseBots !== undefined ? options.canUseBots : true;
    let shouldAiThrow = Boolean(options.shouldAiThrow);

    const mockQuery = async (sql, params = []) => {
      const normalized = sql.replace(/\s+/g, ' ').trim();

      // 1. Limpeza preventiva
      if (normalized.startsWith('UPDATE chat_sessions SET pending_after_hours_followup = false, after_hours_last_user_msg = NULL WHERE pending_after_hours_followup = true AND (')) {
        const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
        let count = 0;
        for (const s of db.sessions) {
          const expired = !s.after_hours_notice_sent_at || (Date.now() - new Date(s.after_hours_notice_sent_at).getTime() > fiveDaysMs);
          if (
            s.pending_after_hours_followup &&
            (['manual', 'pausa_humana', 'transbordado'].includes(s.status_atendimento) ||
              ['manual', 'concluido'].includes(s.etapa_funil || 'novo') ||
              expired)
          ) {
            s.pending_after_hours_followup = false;
            s.after_hours_last_user_msg = null;
            count++;
          }
        }
        return { rowCount: count, rows: [] };
      }

      // 2. Busca de candidatos
      if (normalized.includes('FROM chat_sessions s JOIN tenant_ai_configs c')) {
        const rows = db.sessions
          .filter((s) =>
            s.pending_after_hours_followup === true &&
            s.after_hours_notice_sent_at != null &&
            s.modo_atendimento === 'automacao' &&
            s.status_atendimento === 'ia_ativa' &&
            !['manual', 'concluido'].includes(s.etapa_funil || 'novo') &&
            (!s.paused_until || new Date(s.paused_until).getTime() <= Date.now()) &&
            s.tenant_ativo !== false &&
            Boolean(s.instance_name)
          )
          .map((s) => ({ ...s, session_id: s.id }));
        return { rowCount: rows.length, rows };
      }

      // 3. Checa se já houve resposta de assistant após o aviso
      if (normalized.includes('FROM chat_messages WHERE session_id = $1 AND tenant_id = $2 AND role = \'assistant\'')) {
        const [sessionId, tenantId, noticeSentAt, noticeMsgId] = params;
        const hits = db.messages.filter((m) =>
          m.session_id === sessionId &&
          m.tenant_id === tenantId &&
          m.role === 'assistant' &&
          new Date(m.created_at).getTime() > new Date(noticeSentAt).getTime() &&
          (!noticeMsgId || m.message_id !== noticeMsgId)
        );
        return { rowCount: hits.length, rows: hits };
      }

      // 4. Limpa pendência após detectar resposta prévia
      if (normalized.startsWith('UPDATE chat_sessions SET pending_after_hours_followup = false, after_hours_last_user_msg = NULL WHERE id = $1 AND tenant_id = $2')) {
        const [sessionId, tenantId] = params;
        const s = db.sessions.find((x) => x.id === sessionId && x.tenant_id === tenantId);
        if (s) {
          s.pending_after_hours_followup = false;
          s.after_hours_last_user_msg = null;
          return { rowCount: 1, rows: [s] };
        }
        return { rowCount: 0, rows: [] };
      }

      // 5. Claim atômico
      if (normalized.includes('SET pending_after_hours_followup = false, after_hours_followup_sent_at = NOW(), after_hours_last_user_msg = NULL WHERE id = $1')) {
        const [sessionId, tenantId] = params;
        const s = db.sessions.find((x) =>
          x.id === sessionId &&
          x.tenant_id === tenantId &&
          x.pending_after_hours_followup === true &&
          x.status_atendimento === 'ia_ativa' &&
          !['manual', 'concluido'].includes(x.etapa_funil || 'novo') &&
          (!x.paused_until || new Date(x.paused_until).getTime() <= Date.now())
        );
        if (!s) return { rowCount: 0, rows: [] };
        s.pending_after_hours_followup = false;
        s.after_hours_followup_sent_at = new Date();
        s.after_hours_last_user_msg = null;
        return { rowCount: 1, rows: [{ id: s.id }] };
      }

      // 6. Insert mensagem fallback
      if (normalized.startsWith('INSERT INTO chat_messages')) {
        db.messages.push({
          session_id: params[0],
          tenant_id: params[1],
          role: 'assistant',
          content: params[2],
          message_id: params[3],
          created_at: new Date()
        });
        return { rowCount: 1, rows: [] };
      }

      // 7. Update last_interaction
      if (normalized.startsWith('UPDATE chat_sessions SET last_interaction = NOW()')) {
        return { rowCount: 1, rows: [] };
      }

      return { rowCount: 0, rows: [] };
    };

    const mockEvolution = {
      getInstanceStatus: async (inst) => ({ success: true, instanceName: inst, state: instanceState }),
      sendTextMessage: async (inst, to, text) => {
        const msgId = `MOCK_FB_${Date.now()}_${sentTexts.length}`;
        sentTexts.push({ inst, to, text, msgId });
        return { success: true, messageId: msgId };
      }
    };

    const mockCache = {
      botSent: new Set(),
      setBotSent: async (id) => mockCache.botSent.add(id)
    };

    const mockEntitlements = {
      canUseFeature: async () => canUseBots
    };

    const mockAiProcessor = async (turn) => {
      if (shouldAiThrow) {
        throw new Error('OpenAI timeout simulado');
      }
      aiCalls.push(turn);
      return { success: true, messageId: `AI_MSG_${aiCalls.length}`, replyText: 'Bom dia! Retomando seu atendimento...' };
    };

    const service = new AfterHoursFollowupService({
      query: mockQuery,
      evolutionService: mockEvolution,
      messageCache: mockCache,
      entitlementsService: mockEntitlements,
      webhookController: webhook,
      aiProcessor: mockAiProcessor,
      staggerDelayMs: 0
    });

    return {
      db,
      service,
      aiCalls,
      sentTexts,
      mockCache,
      setInstanceState: (st) => { instanceState = st; }
    };
  }

  const baseSession = {
    id: 'sess-1',
    tenant_id: 'tenant-1',
    remote_jid: '553183579692@s.whatsapp.net',
    client_name: 'Warley',
    status_atendimento: 'ia_ativa',
    etapa_funil: 'novo',
    paused_until: null,
    pending_after_hours_followup: true,
    after_hours_notice_sent_at: new Date(Date.now() - 60 * 60 * 1000), // 1h atrás
    after_hours_notice_msg_id: 'NOTICE_MSG_1',
    after_hours_last_user_msg: 'Quero orçamento de 4 câmeras',
    modo_atendimento: 'automacao',
    automacao_horario_ativo: true,
    automacao_dias_semana: ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'],
    automacao_horario_inicio: '08:00',
    automacao_horario_fim: '18:00',
    automacao_enviar_msg_fora_expediente: true,
    nome_assistente: 'Nat',
    nome_empresa: 'WarNat Tech',
    instance_name: 'warnat-tech',
    tenant_ativo: true
  };

  // --------------------------------------------------------------------------
  // CENÁRIO 1: Fluxo feliz completo (07:59 bloqueado -> 08:00 dispara 1x -> 08:01 não duplica)
  // --------------------------------------------------------------------------
  console.log('\nCENÁRIO 1: Cliente recebeu aviso fora do horário -> expediente abre às 08:00 -> retoma 1 única vez');
  {
    const h = createHarness([{ ...baseSession }], {
      messages: [
        { session_id: 'sess-1', tenant_id: 'tenant-1', role: 'user', content: 'Quero orçamento de 4 câmeras', created_at: new Date(Date.now() - 61 * 60 * 1000) },
        { session_id: 'sess-1', tenant_id: 'tenant-1', role: 'assistant', content: 'Estamos fora do horário...', message_id: 'NOTICE_MSG_1', created_at: new Date(Date.now() - 60 * 60 * 1000) }
      ]
    });

    // 07:59 -> ainda fechado
    const rClosed = await h.service.processPendingFollowups({ referenceDate: monday0759 });
    assert.strictEqual(rClosed.dispatched, 0);
    assert.strictEqual(rClosed.skippedOutsideHours, 1);
    assert.strictEqual(h.aiCalls.length, 0);
    assert.strictEqual(h.db.sessions[0].pending_after_hours_followup, true);

    // 08:00 -> abriu! Deve retomar imediatamente!
    const rOpen = await h.service.processPendingFollowups({ referenceDate: monday0800 });
    assert.strictEqual(rOpen.dispatched, 1);
    assert.strictEqual(h.aiCalls.length, 1);
    assert.strictEqual(h.aiCalls[0].isAfterHoursResume, true);
    assert.strictEqual(h.aiCalls[0].remoteJid, '553183579692@s.whatsapp.net');
    assert.strictEqual(h.aiCalls[0].userMessage, 'Quero orçamento de 4 câmeras');
    assert.strictEqual(h.db.sessions[0].pending_after_hours_followup, false);
    assert.ok(h.db.sessions[0].after_hours_followup_sent_at);

    // 08:01 -> segundo tick não pode duplicar!
    const rSecond = await h.service.processPendingFollowups({ referenceDate: '2026-11-23T08:01:00-03:00' });
    assert.strictEqual(rSecond.dispatched, 0);
    assert.strictEqual(h.aiCalls.length, 1);
    console.log('  ✅ [PASS] 07:59 aguardou -> 08:00 disparou 1x com contexto completo -> 08:01 não duplicou.');
  }

  // --------------------------------------------------------------------------
  // CENÁRIO 2: Cliente antigo que NÃO mandou mensagem fora do horário (pending = false)
  // --------------------------------------------------------------------------
  console.log('\nCENÁRIO 2: Cliente comum/antigo sem aviso de fora do expediente (pending = false)');
  {
    const h = createHarness([{
      ...baseSession,
      id: 'sess-old',
      pending_after_hours_followup: false,
      after_hours_notice_sent_at: null,
      after_hours_last_user_msg: null
    }]);

    const r = await h.service.processPendingFollowups({ referenceDate: monday0800 });
    assert.strictEqual(r.dispatched, 0);
    assert.strictEqual(h.aiCalls.length, 0);
    console.log('  ✅ [PASS] Cliente comum nunca recebe mensagem espontânea na abertura do expediente.');
  }

  // --------------------------------------------------------------------------
  // CENÁRIO 3: Contato foi marcado como MANUAL antes do expediente abrir
  // --------------------------------------------------------------------------
  console.log('\nCENÁRIO 3: Contato marcado como MANUAL antes de dar o horário');
  {
    const h = createHarness([{
      ...baseSession,
      status_atendimento: 'manual',
      etapa_funil: 'manual'
    }]);

    const r = await h.service.processPendingFollowups({ referenceDate: monday0800 });
    assert.strictEqual(r.dispatched, 0);
    assert.strictEqual(h.aiCalls.length, 0);
    assert.strictEqual(h.db.sessions[0].pending_after_hours_followup, false);
    console.log('  ✅ [PASS] Contato manual tem pendência limpa e automação permanece 100% silenciada.');
  }

  // --------------------------------------------------------------------------
  // CENÁRIO 4: Tenant foi colocado em modo MANUAL global antes do expediente
  // --------------------------------------------------------------------------
  console.log('\nCENÁRIO 4: Tenant em modo 100% MANUAL global');
  {
    const h = createHarness([{
      ...baseSession,
      modo_atendimento: 'manual'
    }]);

    const r = await h.service.processPendingFollowups({ referenceDate: monday0800 });
    assert.strictEqual(r.dispatched, 0);
    assert.strictEqual(h.aiCalls.length, 0);
    console.log('  ✅ [PASS] Tenant em modo manual global não dispara retomada.');
  }

  // --------------------------------------------------------------------------
  // CENÁRIO 5: Operador humano já respondeu ao cliente após o aviso fora do horário
  // --------------------------------------------------------------------------
  console.log('\nCENÁRIO 5: Operador humano já respondeu antes do expediente abrir');
  {
    const noticeTime = new Date(Date.now() - 60 * 60 * 1000);
    const humanReplyTime = new Date(Date.now() - 10 * 60 * 1000);
    const h = createHarness([{ ...baseSession, after_hours_notice_sent_at: noticeTime }], {
      messages: [
        { session_id: 'sess-1', tenant_id: 'tenant-1', role: 'assistant', content: 'Fora do horário', message_id: 'NOTICE_MSG_1', created_at: noticeTime },
        { session_id: 'sess-1', tenant_id: 'tenant-1', role: 'assistant', content: 'Oi, já vou te atender por aqui!', message_id: 'HUMAN_1', created_at: humanReplyTime }
      ]
    });

    const r = await h.service.processPendingFollowups({ referenceDate: monday0800 });
    assert.strictEqual(r.dispatched, 0);
    assert.strictEqual(r.skippedAlreadyReplied, 1);
    assert.strictEqual(h.aiCalls.length, 0);
    assert.strictEqual(h.db.sessions[0].pending_after_hours_followup, false);
    console.log('  ✅ [PASS] Detectou resposta posterior ao aviso e cancelou a retomada sem duplicar.');
  }

  // --------------------------------------------------------------------------
  // CENÁRIO 6: Instância desconectada às 08:00 -> reconecta às 08:05
  // --------------------------------------------------------------------------
  console.log('\nCENÁRIO 6: Instância desconectada às 08:00, reconecta às 08:05');
  {
    const h = createHarness([{ ...baseSession }], { instanceState: 'connecting' });

    const r1 = await h.service.processPendingFollowups({ referenceDate: monday0800 });
    assert.strictEqual(r1.dispatched, 0);
    assert.strictEqual(r1.skippedDisconnected, 1);
    assert.strictEqual(h.db.sessions[0].pending_after_hours_followup, true, 'Pendência deve ser mantida enquanto instância reconecta');

    h.setInstanceState('open');
    const r2 = await h.service.processPendingFollowups({ referenceDate: '2026-11-23T08:05:00-03:00' });
    assert.strictEqual(r2.dispatched, 1);
    assert.strictEqual(h.aiCalls.length, 1);
    assert.strictEqual(h.db.sessions[0].pending_after_hours_followup, false);
    console.log('  ✅ [PASS] Aguardou reconexão do WhatsApp e retomou assim que ficou open.');
  }

  // --------------------------------------------------------------------------
  // CENÁRIO 7: Fallback amigável caso OpenAI falhe na retomada
  // --------------------------------------------------------------------------
  console.log('\nCENÁRIO 7: Falha temporária da OpenAI aciona fallback cordial de retomada');
  {
    const h = createHarness([{ ...baseSession }], { shouldAiThrow: true });

    const r = await h.service.processPendingFollowups({ referenceDate: monday0800 });
    assert.strictEqual(r.dispatched, 1);
    assert.strictEqual(h.sentTexts.length, 1);
    assert.ok(h.sentTexts[0].text.includes('Bom dia, Warley'), 'Fallback deve saudar com Bom dia e nome do cliente');
    assert.ok(h.sentTexts[0].text.includes('WarNat Tech'));
    assert.strictEqual(h.mockCache.botSent.size, 1, 'Fallback deve registrar anti-loop no cache');
    console.log('  ✅ [PASS] Fallback cordial enviado, salvo no histórico e protegido contra anti-loop.');
  }

  // --------------------------------------------------------------------------
  // CENÁRIO 8: Pendência expirada (> 5 dias) é descartada automaticamente
  // --------------------------------------------------------------------------
  console.log('\nCENÁRIO 8: Pendência antiga expirada (> 5 dias) é descartada com segurança');
  {
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
    const h = createHarness([{ ...baseSession, after_hours_notice_sent_at: sixDaysAgo }]);

    const r = await h.service.processPendingFollowups({ referenceDate: monday0800 });
    assert.strictEqual(r.dispatched, 0);
    assert.strictEqual(h.aiCalls.length, 0);
    assert.strictEqual(h.db.sessions[0].pending_after_hours_followup, false);
    console.log('  ✅ [PASS] Pendência expirada foi limpa sem enviar mensagem zumbi.');
  }

  // --------------------------------------------------------------------------
  // CENÁRIO 9: Debounce ativo (cliente acabou de mandar mensagem às 08:00)
  // --------------------------------------------------------------------------
  console.log('\nCENÁRIO 9: Cliente mandou mensagem em tempo real exatamente na abertura');
  {
    const h = createHarness([{ ...baseSession }]);
    webhook.debounceBuffers.set('tenant-1:553183579692@s.whatsapp.net', { messages: ['Bom dia!'] });

    const r = await h.service.processPendingFollowups({ referenceDate: monday0800 });
    webhook.debounceBuffers.delete('tenant-1:553183579692@s.whatsapp.net');
    assert.strictEqual(r.dispatched, 0);
    assert.strictEqual(h.aiCalls.length, 0);
    console.log('  ✅ [PASS] Worker respeitou debounce ativo para evitar duplicidade com webhook em tempo real.');
  }

  // --------------------------------------------------------------------------
  // CENÁRIO 10: Plano sem feature automation_bots não dispara
  // --------------------------------------------------------------------------
  console.log('\nCENÁRIO 10: Tenant sem permissão de automação (entitlement = false)');
  {
    const h = createHarness([{ ...baseSession }], { canUseBots: false });

    const r = await h.service.processPendingFollowups({ referenceDate: monday0800 });
    assert.strictEqual(r.dispatched, 0);
    assert.strictEqual(r.skippedNoEntitlement, 1);
    assert.strictEqual(h.aiCalls.length, 0);
    console.log('  ✅ [PASS] Feature gate de plano respeitado rigorosamente.');
  }

  // --------------------------------------------------------------------------
  // CENÁRIO 11: Múltiplas mensagens acumuladas fora do horário
  // --------------------------------------------------------------------------
  console.log('\nCENÁRIO 11: Múltiplas mensagens fora do horário chegam consolidadas na retomada');
  {
    const h = createHarness([{
      ...baseSession,
      after_hours_last_user_msg: 'Oi\nQuero instalar 4 câmeras no Barreiro'
    }]);

    const r = await h.service.processPendingFollowups({ referenceDate: monday0800 });
    assert.strictEqual(r.dispatched, 1);
    assert.strictEqual(h.aiCalls.length, 1);
    assert.strictEqual(h.aiCalls[0].userMessage, 'Oi\nQuero instalar 4 câmeras no Barreiro');
    console.log('  ✅ [PASS] Todas as mensagens fora do horário foram entregues consolidadas em 1 único atendimento.');
  }

  console.log('\n========================================================================');
  console.log('🎉 TODOS OS 11 CENÁRIOS DO WORKER DE RETOMADA PASSARAM 100%!');
  console.log('========================================================================\n');

  // --------------------------------------------------------------------------
  // BATERIA 2: INTEGRAÇÃO PONTA A PONTA NO WebhookController.handleWebhook
  // --------------------------------------------------------------------------
  console.log('========================================================================');
  console.log('🚀 BATERIA 2: INTEGRAÇÃO E2E DO WEBHOOK (REGRA ESTRITA DE AGENDAMENTO)');
  console.log('========================================================================\n');

  const dbMod = require('../database/db');
  const evMod = require('../services/evolution.service');
  const entMod = require('../services/entitlements.service');
  const cacheMod = require('../services/message-cache.service');

  const origQuery = dbMod.query;
  const origSendText = evMod.sendTextMessage;
  const origCanUse = entMod.canUseFeature;

  let mockAiConfig = {
    modo_atendimento: 'automacao',
    automacao_horario_ativo: true,
    automacao_dias_semana: ['segunda'],
    automacao_horario_inicio: '03:00',
    automacao_horario_fim: '04:00',
    automacao_enviar_msg_fora_expediente: true,
    automacao_fora_expediente_msg: 'Estamos fora do horário. Retornaremos assim que abrirmos!'
  };
  let mockSession = {
    id: 'sess-e2e-1',
    status_atendimento: 'ia_ativa',
    etapa_funil: 'novo',
    paused_until: null,
    dados_lead: {},
    pending_after_hours_followup: false,
    after_hours_notice_sent_at: null,
    after_hours_notice_msg_id: null,
    after_hours_last_user_msg: null
  };
  let sendSucceeds = true;
  let sendCount = 0;

  dbMod.query = async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.includes('FROM tenant_whatsapp_instances')) return { rowCount: 1, rows: [{ tenant_id: 'tenant-e2e' }] };
    if (s.includes('FROM chat_sessions WHERE tenant_id = $1 AND remote_jid = $2')) return { rowCount: 1, rows: [{ ...mockSession }] };
    if (s.includes('FROM tenant_ai_configs')) return { rowCount: 1, rows: [{ ...mockAiConfig }] };
    if (s.includes('SET pending_after_hours_followup = true')) {
      mockSession.pending_after_hours_followup = true;
      mockSession.after_hours_notice_sent_at = new Date();
      mockSession.after_hours_notice_msg_id = params[0];
      mockSession.after_hours_last_user_msg = mockSession.after_hours_last_user_msg
        ? `${mockSession.after_hours_last_user_msg}\n${params[1]}`
        : params[1];
      return { rowCount: 1, rows: [] };
    }
    if (s.includes('SET after_hours_last_user_msg = CASE') && s.includes('AND pending_after_hours_followup = true')) {
      mockSession.after_hours_last_user_msg = mockSession.after_hours_last_user_msg
        ? `${mockSession.after_hours_last_user_msg}\n${params[0]}`
        : params[0];
      return { rowCount: 1, rows: [] };
    }
    if (s.includes('SET pending_after_hours_followup = false, after_hours_last_user_msg = NULL')) {
      mockSession.pending_after_hours_followup = false;
      mockSession.after_hours_last_user_msg = null;
      return { rowCount: 1, rows: [] };
    }
    if (s.includes("status_atendimento = 'pausa_humana'")) {
      mockSession.status_atendimento = 'pausa_humana';
      mockSession.pending_after_hours_followup = false;
      mockSession.after_hours_last_user_msg = null;
      return { rowCount: 1, rows: [{ id: mockSession.id }] };
    }
    return { rowCount: 1, rows: [{ id: mockSession.id }] };
  };

  evMod.sendTextMessage = async () => {
    sendCount++;
    if (!sendSucceeds) return { success: false, simulated: true, messageId: 'SIM_FAIL' };
    return { success: true, messageId: `EV_OK_${sendCount}` };
  };
  entMod.canUseFeature = async () => true;

  delete require.cache[require.resolve('../controllers/webhook.controller')];
  const { WebhookController: FreshWebhookController } = require('../controllers/webhook.controller');
  const wh = new FreshWebhookController();
  wh.DEBOUNCE_DELAY_MS = 30;
  wh.setAIProcessor(async () => ({ success: true }));

  try {
    const jid = '553183579692@s.whatsapp.net';

    // E2E-A: Mensagem fora do expediente -> envia aviso e agenda retomada
    const resA = await wh.handleWebhook({
      event: 'messages.upsert',
      instance: 'warnat-tech',
      data: { key: { remoteJid: jid, fromMe: false, id: 'M1' }, message: { conversation: 'Oi, quero orçamento' }, pushName: 'Warley' }
    });
    assert.strictEqual(resA.action, 'outside_operating_hours');
    assert.strictEqual(resA.noticeDispatched, true);
    assert.strictEqual(resA.followupQueued, true);
    assert.strictEqual(mockSession.pending_after_hours_followup, true);
    assert.strictEqual(mockSession.after_hours_last_user_msg, 'Oi, quero orçamento');
    assert.strictEqual(sendCount, 1);
    console.log('✅ [E2E-A] Mensagem fora do horário -> enviou aviso + agendou retomada no expediente.');

    // E2E-B: 2a mensagem durante cooldown -> não reenvia aviso, acumula contexto
    const resB = await wh.handleWebhook({
      event: 'messages.upsert',
      instance: 'warnat-tech',
      data: { key: { remoteJid: jid, fromMe: false, id: 'M2' }, message: { conversation: 'São 4 câmeras externas' }, pushName: 'Warley' }
    });
    assert.strictEqual(resB.noticeDispatched, false);
    assert.strictEqual(resB.followupQueued, true);
    assert.strictEqual(sendCount, 1);
    assert.strictEqual(mockSession.after_hours_last_user_msg, 'Oi, quero orçamento\nSão 4 câmeras externas');
    console.log('✅ [E2E-B] 2a mensagem fora do horário -> respeitou cooldown e acumulou contexto.');

    // E2E-C: Humano responde pelo celular (fromMe: true) -> cancela retomada automática
    const resC = await wh.handleWebhook({
      event: 'messages.upsert',
      instance: 'warnat-tech',
      data: { key: { remoteJid: jid, fromMe: true, id: 'HUMAN_PHONE_1' }, message: { conversation: 'Oi, já vou te atender!' } }
    });
    assert.strictEqual(resC.action, 'human_operator_takeover_activated');
    assert.strictEqual(mockSession.pending_after_hours_followup, false);
    console.log('✅ [E2E-C] Resposta humana pelo celular cancelou pendência de retomada.');

    // E2E-D: Aviso de fora do expediente DESATIVADO -> NÃO agenda retomada
    mockSession.status_atendimento = 'ia_ativa';
    mockSession.pending_after_hours_followup = false;
    mockSession.after_hours_notice_sent_at = null;
    mockSession.after_hours_last_user_msg = null;
    mockAiConfig.automacao_enviar_msg_fora_expediente = false;
    cacheMod.memoryCache.clear();
    const resD = await wh.handleWebhook({
      event: 'messages.upsert',
      instance: 'warnat-tech',
      data: { key: { remoteJid: jid, fromMe: false, id: 'M3' }, message: { conversation: 'Tem alguém?' } }
    });
    assert.strictEqual(resD.noticeDispatched, false);
    assert.strictEqual(resD.followupQueued, false);
    assert.strictEqual(mockSession.pending_after_hours_followup, false);
    console.log('✅ [E2E-D] Aviso fora do expediente desativado -> NÃO agendou retomada.');

    // E2E-E: Falha na entrega do aviso (simulated: true) -> NÃO agenda retomada
    mockAiConfig.automacao_enviar_msg_fora_expediente = true;
    sendSucceeds = false;
    cacheMod.memoryCache.clear();
    const resE = await wh.handleWebhook({
      event: 'messages.upsert',
      instance: 'warnat-tech',
      data: { key: { remoteJid: jid, fromMe: false, id: 'M4' }, message: { conversation: 'Olá!' } }
    });
    assert.strictEqual(resE.noticeDispatched, false);
    assert.strictEqual(resE.followupQueued, false);
    assert.strictEqual(mockSession.pending_after_hours_followup, false);
    console.log('✅ [E2E-E] Falha na entrega do aviso -> NÃO agendou retomada falsa.');

    // E2E-F: Contato marcado como MANUAL fora do horário -> NÃO envia aviso e NÃO agenda retomada
    sendSucceeds = true;
    mockSession.status_atendimento = 'manual';
    mockSession.etapa_funil = 'manual';
    const resF = await wh.handleWebhook({
      event: 'messages.upsert',
      instance: 'warnat-tech',
      data: { key: { remoteJid: jid, fromMe: false, id: 'M5' }, message: { conversation: 'Oi!' } }
    });
    assert.strictEqual(resF.action, 'message_saved_human_in_control');
    assert.strictEqual(mockSession.pending_after_hours_followup, false);
    console.log('✅ [E2E-F] Contato MANUAL fora do horário -> silenciado 100%, sem aviso e sem retomada.');

    // E2E-G: Cliente manda mensagem já dentro do expediente -> limpa pending para não duplicar
    mockSession.status_atendimento = 'ia_ativa';
    mockSession.etapa_funil = 'novo';
    mockSession.pending_after_hours_followup = true;
    mockAiConfig.automacao_horario_ativo = false; // aberto agora
    const resG = await wh.handleWebhook({
      event: 'messages.upsert',
      instance: 'warnat-tech',
      data: { key: { remoteJid: jid, fromMe: false, id: 'M6' }, message: { conversation: 'Bom dia, já abriram?' } }
    });
    assert.strictEqual(resG.action, 'buffered_in_debounce');
    assert.strictEqual(mockSession.pending_after_hours_followup, false);
    console.log('✅ [E2E-G] Mensagem recebida já no expediente -> limpou pendência do worker e seguiu atendimento normal.');
  } finally {
    dbMod.query = origQuery;
    evMod.sendTextMessage = origSendText;
    entMod.canUseFeature = origCanUse;
  }

  console.log('\n========================================================================');
  console.log('🎉 TODAS AS 18 VALIDAÇÕES (11 WORKER + 7 WEBHOOK E2E) PASSARAM 100%!');
  console.log('========================================================================');
  process.exit(0);
}

runTests().catch((err) => {
  console.error('❌ Falha nos testes:', err);
  process.exit(1);
});
