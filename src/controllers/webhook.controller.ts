// ==============================================================================
// SAAS MULTI-TENANT ENGINE - WEBHOOK CONTROLLER (TYPESCRIPT)
// Anti-loop (fromMe) lock, human operator detection, media fallbacks & message debounce
// ==============================================================================

import { query } from '../database/db';
import { evolutionService } from '../services/evolution.service';
import { messageCache } from '../services/message-cache.service';
import { aiEngineService } from '../services/ai-engine.service';
import {
  EvolutionWebhookPayload,
  DebounceBufferItem,
  AITurnInput
} from '../types/evolution.types';

export class WebhookController {
  private debounceBuffers: Map<string, DebounceBufferItem>;
  public debounceDelayMs: number;
  private aiProcessor: ((turn: AITurnInput) => Promise<any>) | null = null;

  constructor(debounceDelayMs: number = 3000) {
    this.debounceBuffers = new Map<string, DebounceBufferItem>();
    this.debounceDelayMs = debounceDelayMs;
    // Vincula por padrão à Engine de IA (Fase 4)
    this.aiProcessor = (turn) => aiEngineService.processTurn(turn);
  }

  /**
   * Conecta o processador da Engine de IA (Fase 4)
   */
  public setAIProcessor(processor: (turn: AITurnInput) => Promise<any>): void {
    this.aiProcessor = processor;
  }

  /**
   * Limpa buffers ativos (usado em testes para teardown seguro)
   */
  public clearBuffers(): void {
    for (const buffer of this.debounceBuffers.values()) {
      if (buffer.timer) {
        clearTimeout(buffer.timer);
      }
    }
    this.debounceBuffers.clear();
  }

  /**
   * Identifica o tenant_id e o instance_name a partir dos metadados do webhook
   */
  public async resolveTenantAndSession(payload: EvolutionWebhookPayload): Promise<{ tenantId: string; instanceName: string }> {
    const instanceName = payload.instance || payload.data?.instance;
    let tenantId: string | null = null;

    if (instanceName) {
      const instRes = await query<{ tenant_id: string }>(
        `SELECT tenant_id FROM tenant_whatsapp_instances WHERE instance_name = $1 LIMIT 1;`,
        [instanceName]
      );
      if (instRes.rows.length > 0) {
        tenantId = instRes.rows[0].tenant_id;
      }
    }

    // Fallback: seleciona o primeiro tenant ativo cadastrado se não houver mapeamento direto
    if (!tenantId) {
      const defaultTenant = await query<{ id: string }>(
        `SELECT id FROM tenants WHERE ativo = true ORDER BY created_at ASC LIMIT 1;`
      );
      if (defaultTenant.rows.length > 0) {
        tenantId = defaultTenant.rows[0].id;
      }
    }

    if (!tenantId) {
      throw new Error(`Nenhum tenant ativo encontrado para a instância: ${instanceName || 'desconhecida'}`);
    }

    return {
      tenantId,
      instanceName: instanceName || 'default-instance'
    };
  }

  /**
   * Processador central de eventos de webhook da Evolution API
   */
  public async handleWebhook(payload: EvolutionWebhookPayload): Promise<{
    handled: boolean;
    action?: string;
    reason?: string;
    pausedUntil?: Date;
    pausaMinutos?: number;
    messageId?: string;
    bufferLength?: number;
    event?: string;
  }> {
    if (!payload || !payload.event) {
      return { handled: false, reason: 'payload_sem_evento' };
    }

    // 1. Atualizações de estado da conexão WhatsApp
    if (payload.event === 'connection.update') {
      const instanceName = payload.instance;
      const state = payload.data?.state;
      if (instanceName && state) {
        const normalizedState =
          state === 'open' ? 'open' : state === 'connecting' ? 'connecting' : 'disconnected';
        await query(
          `UPDATE tenant_whatsapp_instances 
           SET status = $1, updated_at = NOW() 
           WHERE instance_name = $2;`,
          [normalizedState, instanceName]
        );
      }
      return { handled: true, event: 'connection.update' };
    }

    // Aceita apenas eventos de mensagens novas (messages.upsert)
    if (payload.event !== 'messages.upsert') {
      return { handled: false, reason: 'evento_ignorado' };
    }

    const data = payload.data;
    if (!data || !data.key) {
      return { handled: false, reason: 'dados_de_mensagem_ausentes' };
    }

    const { remoteJid, fromMe, id: messageId, remoteJidAlt } = data.key;

    // Ignora grupos e transmissões de status
    if (!remoteJid || remoteJid.includes('@g.us') || remoteJid === 'status@broadcast') {
      return { handled: true, action: 'grupo_ou_broadcast_ignorado' };
    }

    // Normaliza LID do WhatsApp para JID real quando presente
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
      // Checa se a mensagem foi disparada pela IA do nosso bot
      const isFromBot = await messageCache.isBotSent(messageId || '');

      if (isFromBot) {
        // Ignora silenciosamente com status 200 (evita loop infinito)
        return { handled: true, action: 'ignored_bot_sent', messageId };
      }

      // NÃO está no cache do bot: OPERADOR HUMANO enviou pelo WhatsApp físico!
      console.log(`👤 [Webhook] Operador humano detectado no celular físico para ${effectiveJid}!`);

      // Busca tempo de pausa configurado no tenant_ai_configs
      const aiConfigRes = await query<{ pausa_automatica_minutos: number }>(
        `SELECT pausa_automatica_minutos FROM tenant_ai_configs WHERE tenant_id = $1;`,
        [tenantId]
      );
      const pausaMinutos = aiConfigRes.rows[0]?.pausa_automatica_minutos || 45;

      const pausedUntil = new Date(Date.now() + pausaMinutos * 60 * 1000);

      // Atualiza ou cria sessão ativando o modo pausa humana
      const sessionRes = await query<{ id: string }>(
        `INSERT INTO chat_sessions (
           tenant_id, remote_jid, status_atendimento, paused_until, last_interaction
         ) VALUES ($1, $2, 'pausa_humana', $3, NOW())
         ON CONFLICT (tenant_id, remote_jid) 
         DO UPDATE SET 
           status_atendimento = 'pausa_humana',
           paused_until = $3,
           last_interaction = NOW()
         RETURNING id;`,
        [tenantId, effectiveJid, pausedUntil]
      );

      const sessionId = sessionRes.rows[0].id;

      // Registra a mensagem enviada pelo humano no histórico
      const humanText =
        data.message?.conversation ||
        data.message?.extendedTextMessage?.text ||
        '[Mensagem enviada pelo operador no celular]';

      await query(
        `INSERT INTO chat_messages (session_id, tenant_id, role, content, message_id)
         VALUES ($1, $2, 'assistant', $3, $4);`,
        [sessionId, tenantId, humanText, messageId || null]
      );

      console.log(`⏸️ [Webhook] IA pausada para ${effectiveJid} até ${pausedUntil.toISOString()} (${pausaMinutos} min).`);

      return {
        handled: true,
        action: 'human_operator_takeover_activated',
        pausedUntil,
        pausaMinutos
      };
    }

    // ============================================================================
    // 2. RECUPERA OU CRIA A SESSÃO DO CLIENTE NO BANCO DE DADOS
    // ============================================================================
    let sessionRes = await query<{ id: string; status_atendimento: string; paused_until: Date | null }>(
      `SELECT id, status_atendimento, paused_until 
       FROM chat_sessions 
       WHERE tenant_id = $1 AND remote_jid = $2;`,
      [tenantId, effectiveJid]
    );

    let session: { id: string; status_atendimento: string; paused_until: Date | null };

    if (sessionRes.rows.length === 0) {
      const newSession = await query<{ id: string; status_atendimento: string; paused_until: Date | null }>(
        `INSERT INTO chat_sessions (tenant_id, remote_jid, status_atendimento, last_interaction)
         VALUES ($1, $2, 'ia_ativa', NOW())
         RETURNING id, status_atendimento, paused_until;`,
        [tenantId, effectiveJid]
      );
      session = newSession.rows[0];
    } else {
      session = sessionRes.rows[0];
      await query(
        `UPDATE chat_sessions 
         SET last_interaction = NOW()
         WHERE id = $1;`,
        [session.id]
      );
    }

    // ============================================================================
    // 3. TRATAMENTO DE CONTEÚDO E EDGE CASES (ÁUDIO, FOTO, TEXTO VAZIO)
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
        : (data.message.speechToText.text || '');
      text = speech ? `[áudio transcrito] ${speech}` : '';
    } else if (data.message?.audioMessage) {
      // Áudio sem transcrição disponível
      text = '[áudio do cliente]';
      isMediaAcknowledgmentNeeded = true;
      mediaResponseText = 'Recebi seu áudio! Nossa equipe já está atenta e ouvindo a sua mensagem.';
    } else if (data.message?.imageMessage) {
      // Imagem ou foto do local enviada
      text = '[foto/imagem enviada pelo cliente]';
      isMediaAcknowledgmentNeeded = true;
      mediaResponseText = 'Recebi a sua foto! Imagens e fotos do local são analisadas detalhadamente pelo nosso especialista técnico.';
    } else if (data.message?.documentMessage) {
      text = '[documento enviado pelo cliente]';
    }

    // Proteção contra payload vazio: não permite quebrar a LLM
    if (!text || !text.trim()) {
      return { handled: true, action: 'empty_payload_ignored' };
    }

    // Salva a mensagem recebida no histórico do chat
    await query(
      `INSERT INTO chat_messages (session_id, tenant_id, role, content, message_id)
       VALUES ($1, $2, 'user', $3, $4);`,
      [session.id, tenantId, text.trim(), messageId || null]
    );

    // ============================================================================
    // 4. VERIFICA SE O ATENDIMENTO ESTÁ PAUSADO PARA OPERADOR HUMANO
    // ============================================================================
    const isPaused = session.paused_until && new Date(session.paused_until) > new Date();
    if (isPaused || session.status_atendimento === 'transbordado') {
      console.log(`🛑 [Webhook] ${effectiveJid} pausado até ${session.paused_until?.toISOString()}. IA não responderá.`);
      return {
        handled: true,
        action: 'message_saved_human_in_control',
        pausedUntil: session.paused_until || undefined
      };
    }

    // Se for exclusivamente foto ou áudio sem transcrição, envia o aviso amigável
    if (isMediaAcknowledgmentNeeded && mediaResponseText) {
      const sendRes = await evolutionService.sendTextMessage(instanceName, effectiveJid, mediaResponseText);
      if (sendRes.messageId) {
        await messageCache.setBotSent(sendRes.messageId, 60);
        await query(
          `INSERT INTO chat_messages (session_id, tenant_id, role, content, message_id)
           VALUES ($1, $2, 'assistant', $3, $4);`,
          [session.id, tenantId, mediaResponseText, sendRes.messageId]
        );
      }
      return { handled: true, action: 'media_fallback_dispatched' };
    }

    // ============================================================================
    // 5. DEBOUNCE DE MENSAGENS (BUFFER CONSOLIDADO)
    // Agrupa mensagens sequenciais rápidas antes de chamar a LLM
    // ============================================================================
    const bufferKey = `${tenantId}:${effectiveJid}`;
    let buffer = this.debounceBuffers.get(bufferKey);

    if (buffer) {
      if (buffer.timer) clearTimeout(buffer.timer);
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
      await this.dispatchDebouncedTurn(buffer!);
    }, this.debounceDelayMs);

    return {
      handled: true,
      action: 'buffered_in_debounce',
      bufferLength: buffer.messages.length
    };
  }

  /**
   * Dispara o processamento consolidado de mensagens após expirar o tempo de debounce
   */
  public async dispatchDebouncedTurn(buffer: DebounceBufferItem): Promise<void> {
    const consolidatedText = buffer.messages.join('\n');
    console.log(`💬 [Webhook] Debounce concluído para ${buffer.remoteJid} (${buffer.messages.length} fragmentos):\n"${consolidatedText}"`);

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
      } catch (err: any) {
        console.error(`❌ [Webhook] Erro no processamento da IA para ${buffer.remoteJid}:`, err.message);
      }
    } else {
      console.log(`ℹ️ [Webhook] Turno consolidado para ${buffer.remoteJid}. IA Processor não registrado.`);
    }
  }
}

export const webhookController = new WebhookController();
