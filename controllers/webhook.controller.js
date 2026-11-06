// ==============================================================================
// Webhook Controller - Multi-Tenant SaaS
// Proteção Anti-Loop (fromMe), Detecção de Operador Humano, Mídia e Debounce
// ==============================================================================

const { query } = require('../database/db');
const evolutionService = require('../services/evolution.service');
const messageCache = require('../services/message-cache.service');

class WebhookController {
  constructor() {
    // Mapa de buffer para debounce de mensagens rápidas (3 segundos)
    // Key: `${tenantId}:${remoteJid}` -> { timer, messages: [], tenant, session }
    this.debounceBuffers = new Map();
    this.DEBOUNCE_DELAY_MS = 3000;

    // Callback para processamento da LLM (injetado pela Engine de IA ou padrão)
    try {
      const aiEngine = require('../services/ai-engine.service');
      this.aiProcessor = (params) => aiEngine.processTurn(params);
    } catch (e) {
      this.aiProcessor = null;
    }
  }

  /**
   * Permite que a Engine de IA registre seu manipulador para processamento de turnos
   */
  setAIProcessor(processorFn) {
    this.aiProcessor = processorFn;
  }

  /**
   * Resolve o tenant e a sessão a partir do payload da Evolution API
   */
  async resolveTenantAndSession(payload) {
    const instanceName = payload.instance || payload.data?.instance;
    let tenantId = null;

    if (instanceName) {
      const instRes = await query(
        `SELECT tenant_id FROM tenant_whatsapp_instances WHERE instance_name = $1 LIMIT 1`,
        [instanceName]
      );
      if (instRes.rowCount > 0) {
        tenantId = instRes.rows[0].tenant_id;
      }
    }

    // Fallback: se houver apenas um tenant cadastrado ou instância padrão
    if (!tenantId) {
      const defaultTenant = await query(`SELECT id FROM tenants WHERE ativo = true ORDER BY created_at ASC LIMIT 1`);
      if (defaultTenant.rowCount > 0) {
        tenantId = defaultTenant.rows[0].id;
      }
    }

    if (!tenantId) {
      throw new Error(`Nenhum tenant ativo encontrado para a instância: ${instanceName}`);
    }

    return { tenantId, instanceName };
  }

  /**
   * Processador principal do webhook da Evolution API
   */
  async handleWebhook(payload) {
    if (!payload || !payload.event) {
      return { handled: false, reason: 'payload_sem_evento' };
    }

    // 1. Atualização de estado da conexão
    if (payload.event === 'connection.update') {
      const instanceName = payload.instance;
      const state = payload.data?.state;
      if (instanceName && state) {
        await query(
          `UPDATE tenant_whatsapp_instances 
           SET status = $1, updated_at = now() 
           WHERE instance_name = $2`,
          [state === 'open' ? 'open' : state === 'connecting' ? 'connecting' : 'disconnected', instanceName]
        );
      }
      return { handled: true, event: 'connection.update' };
    }

    // Aceita apenas eventos de mensagens novas
    if (payload.event !== 'messages.upsert') {
      return { handled: false, reason: 'evento_ignorado' };
    }

    const data = payload.data;
    if (!data || !data.key) {
      return { handled: false, reason: 'dados_de_mensagem_ausentes' };
    }

    const { remoteJid, fromMe, id: messageId } = data.key;
    const remoteJidAlt = data.key.remoteJidAlt;

    // Ignora grupos e transmissões de status
    if (!remoteJid || remoteJid.includes('@g.us') || remoteJid === 'status@broadcast') {
      return { handled: true, action: 'grupo_ou_broadcast_ignorado' };
    }

    // Resolve LID para número real do WhatsApp
    let effectiveJid = remoteJid;
    if (remoteJid.includes('@lid') && remoteJidAlt && remoteJidAlt.includes('@s.whatsapp.net')) {
      effectiveJid = remoteJidAlt;
    }

    const { tenantId, instanceName } = await this.resolveTenantAndSession(payload);
    const pushName = data.pushName || '';

    // ============================================================================
    // 1. TRAVA DE AUTO-LOOP E DETECÇÃO DE OPERADOR HUMANO (fromMe: true)
    // ============================================================================
    if (fromMe) {
      // Checa se a mensagem foi originada pelo nosso bot
      const isFromBot = await messageCache.isBotSent(messageId);

      if (isFromBot) {
        // Disparado pela nossa própria IA: ignora para evitar loop infinito
        return { handled: true, action: 'ignored_bot_sent', messageId };
      }

      // NÃO está no cache do bot: OPERADOR HUMANO enviou pelo WhatsApp físico!
      console.log(`[Webhook] Operador humano detectado no celular físico para ${effectiveJid}!`);

      // Busca configuração de tempo de pausa do tenant
      const aiConfigRes = await query(
        `SELECT pausa_automatica_minutos FROM tenant_ai_configs WHERE tenant_id = $1`,
        [tenantId]
      );
      const pausaMinutos = aiConfigRes.rowCount > 0 ? (aiConfigRes.rows[0].pausa_automatica_minutos || 45) : 45;

      // Atualiza ou cria a sessão de chat ativando a pausa humana
      const pausedUntil = new Date(Date.now() + (pausaMinutos * 60 * 1000));

      const sessionRes = await query(
        `INSERT INTO chat_sessions (tenant_id, remote_jid, client_name, status_atendimento, paused_until, last_interaction)
         VALUES ($1, $2, $3, 'pausa_humana', $4, now())
         ON CONFLICT (tenant_id, remote_jid) 
         DO UPDATE SET 
           status_atendimento = 'pausa_humana',
           paused_until = $4,
           last_interaction = now()
         RETURNING id`,
        [tenantId, effectiveJid, pushName, pausedUntil]
      );

      const sessionId = sessionRes.rows[0].id;

      // Registra a mensagem enviada pelo humano no banco
      const humanText = data.message?.conversation || data.message?.extendedTextMessage?.text || '[Mensagem humana no celular]';
      await query(
        `INSERT INTO chat_messages (session_id, tenant_id, role, content, message_id)
         VALUES ($1, $2, 'assistant', $3, $4)`,
        [sessionId, tenantId, humanText, messageId]
      );

      console.log(`[Webhook] IA pausada para ${effectiveJid} até ${pausedUntil.toISOString()} (${pausaMinutos} min).`);

      return {
        handled: true,
        action: 'human_operator_takeover_activated',
        pausedUntil,
        pausaMinutos
      };
    }

    // ============================================================================
    // 2. OBTÉM OU CRIA A SESSÃO DO CLIENTE NO BANCO DE DADOS
    // ============================================================================
    let sessionRes = await query(
      `SELECT id, status_atendimento, paused_until, dados_lead 
       FROM chat_sessions 
       WHERE tenant_id = $1 AND remote_jid = $2`,
      [tenantId, effectiveJid]
    );

    let session;
    if (sessionRes.rowCount === 0) {
      const newSession = await query(
        `INSERT INTO chat_sessions (tenant_id, remote_jid, client_name, status_atendimento, last_interaction)
         VALUES ($1, $2, $3, 'ia_ativa', now())
         RETURNING id, status_atendimento, paused_until, dados_lead`,
        [tenantId, effectiveJid, pushName]
      );
      session = newSession.rows[0];
    } else {
      session = sessionRes.rows[0];
      await query(
        `UPDATE chat_sessions 
         SET last_interaction = now(), client_name = COALESCE($1, client_name)
         WHERE id = $2`,
        [pushName || null, session.id]
      );
    }

    // ============================================================================
    // 3. TRATAMENTO DE CONTEÚDO E EDGE CASES (ÁUDIO, FOTOS, TEXTO VAZIO)
    // ============================================================================
    let text = '';
    let isMediaAcknowledgmentNeeded = false;
    let mediaResponseText = '';

    if (data.message?.conversation) {
      text = data.message.conversation;
    } else if (data.message?.extendedTextMessage?.text) {
      text = data.message.extendedTextMessage.text;
    } else if (data.message?.speechToText) {
      // Áudio transcrito pelo Whisper
      const speech = typeof data.message.speechToText === 'string'
        ? data.message.speechToText
        : (data.message.speechToText?.text || '');
      text = speech ? `[áudio transcrito] ${speech}` : '';
    } else if (data.message?.audioMessage) {
      // Áudio sem transcrição disponível
      text = '[áudio do cliente]';
      isMediaAcknowledgmentNeeded = true;
      mediaResponseText = 'Recebi seu áudio! Nossa equipe já está atenta e ouvindo a sua mensagem.';
    } else if (data.message?.imageMessage) {
      // Imagem / Foto do local
      text = '[foto/imagem enviada pelo cliente]';
      isMediaAcknowledgmentNeeded = true;
      mediaResponseText = 'Recebi a sua foto! Imagens e fotos do local são analisadas detalhadamente pelo nosso especialista técnico.';
    } else if (data.message?.documentMessage) {
      text = '[documento enviado pelo cliente]';
    }

    // Proteção contra payload vazio: não deixa quebrar a LLM
    if (!text || !text.trim()) {
      return { handled: true, action: 'empty_payload_ignored' };
    }

    // Salva a mensagem recebida no histórico do banco de dados
    await query(
      `INSERT INTO chat_messages (session_id, tenant_id, role, content, message_id)
       VALUES ($1, $2, 'user', $3, $4)`,
      [session.id, tenantId, text.trim(), messageId]
    );

    // ============================================================================
    // 4. VERIFICAÇÃO DE ATENDIMENTO MANUAL GLOBAL (TENANT) OU POR CONTATO INDIVIDUAL
    // ============================================================================
    // A) Checa se o tenant inteiro está configurado em atendimento 100% manual
    const aiConfigRes = await query(
      `SELECT modo_atendimento FROM tenant_ai_configs WHERE tenant_id = $1`,
      [tenantId]
    );
    const tenantModo = aiConfigRes.rows[0]?.modo_atendimento || 'automacao';

    if (tenantModo === 'manual') {
      console.log(`[Webhook] Tenant ${tenantId} configurado em ATENDIMENTO 100% MANUAL GLOBAL. IA silenciada para todos os clientes.`);
      return {
        handled: true,
        action: 'tenant_manual_mode_active',
        tenantId
      };
    }

    // B) Checa se este contato específico foi colocado em atendimento manual ou está com IA pausada
    const isContactManual = (
      session.status_atendimento === 'manual' ||
      session.status_atendimento === 'pausa_humana' ||
      session.status_atendimento === 'transbordado' ||
      (session.paused_until && new Date(session.paused_until) > new Date())
    );

    if (isContactManual) {
      console.log(`[Webhook] Contato ${effectiveJid} em ATENDIMENTO MANUAL EXCLUSIVO. Automação silenciada (apenas operador humano responde).`);
      return {
        handled: true,
        action: 'message_saved_human_in_control',
        reason: 'contact_manual_mode_active',
        status: session.status_atendimento,
        pausedUntil: session.paused_until
      };
    }

    // Se a mensagem for exclusivamente foto ou áudio não transcrito, responde com o aviso amigável
    if (isMediaAcknowledgmentNeeded && mediaResponseText) {
      const sendRes = await evolutionService.sendTextMessage(instanceName, effectiveJid, mediaResponseText);
      if (sendRes.messageId) {
        await messageCache.setBotSent(sendRes.messageId, 60);
        await query(
          `INSERT INTO chat_messages (session_id, tenant_id, role, content, message_id)
           VALUES ($1, $2, 'assistant', $3, $4)`,
          [session.id, tenantId, mediaResponseText, sendRes.messageId]
        );
      }
      return { handled: true, action: 'media_fallback_dispatched' };
    }

    // ============================================================================
    // 5. DEBOUNCE DE MENSAGENS (BUFFER DE 3 SEGUNDOS)
    // Consolidar mensagens picadas enviadas rapidamente antes de invocar a IA
    // ============================================================================
    const bufferKey = `${tenantId}:${effectiveJid}`;
    let buffer = this.debounceBuffers.get(bufferKey);

    if (buffer) {
      clearTimeout(buffer.timer);
      buffer.messages.push(text.trim());
    } else {
      buffer = {
        tenantId,
        instanceName,
        sessionId: session.id,
        remoteJid: effectiveJid,
        pushName,
        messages: [text.trim()],
        timer: null
      };
      this.debounceBuffers.set(bufferKey, buffer);
    }

    buffer.timer = setTimeout(async () => {
      this.debounceBuffers.delete(bufferKey);
      await this.dispatchDebouncedTurn(buffer);
    }, this.DEBOUNCE_DELAY_MS);

    return {
      handled: true,
      action: 'buffered_in_debounce',
      bufferLength: buffer.messages.length
    };
  }

  /**
   * Dispara a rodada consolidada de mensagens após o tempo de debounce
   */
  async dispatchDebouncedTurn(buffer) {
    const consolidatedText = buffer.messages.join('\n');
    console.log(`[Webhook] Debounce concluído para ${buffer.remoteJid}. Mensagem consolidada (${buffer.messages.length} partes):\n"${consolidatedText}"`);

    // Notifica presença "digitando..." no WhatsApp
    await evolutionService.sendPresence(buffer.instanceName, buffer.remoteJid, 'composing');

    if (this.aiProcessor) {
      try {
        await this.aiProcessor({
          tenantId: buffer.tenantId,
          instanceName: buffer.instanceName,
          sessionId: buffer.sessionId,
          remoteJid: buffer.remoteJid,
          pushName: buffer.pushName,
          userMessage: consolidatedText
        });
      } catch (err) {
        console.error(`[Webhook] Erro no processamento da IA para ${buffer.remoteJid}:`, err.message);
      }
    } else {
      console.log(`[Webhook] Engine de IA (Fase 4) não conectada. Mensagem persistida.`);
    }
  }
}

module.exports = new WebhookController();
module.exports.WebhookController = WebhookController;
