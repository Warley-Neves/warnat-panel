// ==============================================================================
// SAAS MULTI-TENANT ENGINE - WEBHOOK CONTROLLER (TYPESCRIPT)
// Anti-loop (fromMe) lock, human operator detection, media fallbacks & message debounce
// ==============================================================================

import { query } from '../database/db';
import { evolutionService } from '../services/evolution.service';
import { messageCache } from '../services/message-cache.service';
import { aiEngineService } from '../services/ai-engine.service';
import { audioTranscriptionService } from '../services/audio-transcription.service';
import { ttsService } from '../services/tts.service';
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
   * Valida se a automação está autorizada a responder com base no dia e horário configurados (Horário de Brasília)
   */
  public checkAutomationOperatingHours(aiConfig: any, referenceDate: Date | string | null = null): { isOpen: boolean; currentDay?: string; currentTime?: string; [k: string]: any } {
    if (!aiConfig) return { isOpen: true, reason: 'no_config_fallback' };

    if (aiConfig.automacao_horario_ativo === false) {
      return { isOpen: true, reason: '24_7_always_active' };
    }

    const baseDate = referenceDate ? new Date(referenceDate) : new Date();
    const brDate = new Date(baseDate.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const DAYS_MAP = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
    const currentDayName = DAYS_MAP[brDate.getDay()];
    const hours = String(brDate.getHours()).padStart(2, '0');
    const minutes = String(brDate.getMinutes()).padStart(2, '0');
    const currentTime = `${hours}:${minutes}`;

    const normalizeDay = (d: string) => String(d || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace('-feira', '')
      .trim();

    const rawDays = aiConfig.automacao_dias_semana ||
      aiConfig.regras_agendamento?.dias_atendimento ||
      aiConfig.regras_agendamento?.dias ||
      ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];

    const activeDays = (Array.isArray(rawDays) ? rawDays : []).map(normalizeDay);

    const inicio = aiConfig.automacao_horario_inicio || aiConfig.regras_agendamento?.horario_inicio || '08:00';
    const fim = aiConfig.automacao_horario_fim || aiConfig.regras_agendamento?.horario_fim || '18:00';

    const isDayAllowed = activeDays.includes(currentDayName);
    const isTimeAllowed = inicio <= fim
      ? (currentTime >= inicio && currentTime <= fim)
      : (currentTime >= inicio || currentTime <= fim);

    return {
      isOpen: isDayAllowed && isTimeAllowed,
      currentDay: currentDayName,
      currentTime,
      inicio,
      fim,
      activeDays,
      isDayAllowed,
      isTimeAllowed
    };
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
    const instanceName = payload.instance || (payload as any).instanceName || payload.data?.instance || (payload.data as any)?.instanceName;
    let tenantId: string | null = null;

    if (instanceName) {
      const instRes = await query<{ tenant_id: string }>(
        `SELECT tenant_id FROM tenant_whatsapp_instances WHERE LOWER(instance_name) = LOWER($1) LIMIT 1;`,
        [instanceName]
      );
      if (instRes.rows.length > 0) {
        tenantId = instRes.rows[0].tenant_id;
      } else {
        const suffixMatch = String(instanceName).match(/-([a-f0-9]{6})$/i);
        if (suffixMatch) {
          const tenantBySuffix = await query<{ id: string }>(
            `SELECT id FROM tenants WHERE CAST(id AS text) LIKE $1 LIMIT 1;`,
            [`${suffixMatch[1]}%`]
          );
          if (tenantBySuffix.rows.length > 0) {
            tenantId = tenantBySuffix.rows[0].id;
            await query(
              `INSERT INTO tenant_whatsapp_instances (tenant_id, instance_name, status)
               VALUES ($1, $2, 'open')
               ON CONFLICT (tenant_id) DO UPDATE SET instance_name = EXCLUDED.instance_name, status = 'open', updated_at = now();`,
              [tenantId, instanceName]
            ).catch(() => {});
          }
        }
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
    tenantId?: string;
    status?: string;
    [key: string]: any;
  }> {
    if (!payload || !payload.event) {
      return { handled: false, reason: 'payload_sem_evento' };
    }

    const eventName = String(payload.event).toLowerCase().replace(/_/g, '.');

    // 1. Atualizações de estado da conexão WhatsApp
    if (eventName === 'connection.update') {
      const instanceName = payload.instance || (payload as any).instanceName || payload.data?.instance;
      const state = payload.data?.state;
      if (instanceName && state) {
        const normalizedState =
          state === 'open' ? 'open' : state === 'connecting' ? 'connecting' : 'disconnected';
        await query(
          `UPDATE tenant_whatsapp_instances 
           SET status = $1, updated_at = NOW() 
           WHERE LOWER(instance_name) = LOWER($2);`,
          [normalizedState, instanceName]
        );

        if (normalizedState === 'open') {
          const defaultWebhook = evolutionService.getDefaultWebhookUrl();
          evolutionService.setWebhook(instanceName, defaultWebhook).catch(() => {});
        }
      }
      return { handled: true, event: 'connection.update' };
    }

    // ============================================================================
    // 2. ATENDIMENTO E LOG DE CHAMADAS DE VOZ E VÍDEO NO WHATSAPP
    // ============================================================================
    if (eventName === 'call') {
      const callData: any = payload.data || {};
      const callStatus = callData.status;
      const isVideo = !!callData.isVideo;
      const rawCallerJid = callData.from || callData.id;
      const altCallerPn = callData.fromPn || callData.callerPn || callData.remoteJidAlt;
      const callerJid = (rawCallerJid && String(rawCallerJid).includes('@lid') && altCallerPn && String(altCallerPn).includes('@s.whatsapp.net'))
        ? altCallerPn
        : rawCallerJid;

      if (!callerJid || callerJid.includes('@g.us')) {
        return { handled: true, action: 'call_ignored' };
      }

      const effectiveJid = callerJid.includes('@') ? callerJid : `${callerJid}@s.whatsapp.net`;
      const { tenantId, instanceName } = await this.resolveTenantAndSession(payload);

      if (callData.id) {
        await evolutionService.rejectCall(instanceName, callData.id).catch(() => {});
      }

      if (callStatus && callStatus !== 'offer' && callStatus !== 'ringing') {
        return { handled: true, event: 'call_status_update', status: callStatus };
      }

      const callTypeDesc = isVideo ? 'vídeo' : 'voz';
      const callMediaType = isVideo ? 'call_video' : 'call_voice';
      const callText = `[Chamada de ${callTypeDesc} recebida]`;

      console.log(`[Webhook] Chamada de ${callTypeDesc} recebida de ${effectiveJid} para tenant ${tenantId}`);

      let sessionRes = await query<{ id: string; status_atendimento: string; paused_until: Date | null; etapa_funil?: string }>(
        `SELECT id, status_atendimento, paused_until, etapa_funil 
         FROM chat_sessions 
         WHERE tenant_id = $1 AND remote_jid = $2;`,
        [tenantId, effectiveJid]
      );

      const aiConfigRes = await query<any>(
        `SELECT atender_chamadas, mensagem_chamada, responder_com_audio, voz_ia, modo_atendimento 
         FROM tenant_ai_configs WHERE tenant_id = $1;`,
        [tenantId]
      );
      const aiConfig = aiConfigRes.rows[0] || {};
      const isManualTenant = aiConfig.modo_atendimento === 'manual';
      const initialStatus = isManualTenant ? 'manual' : 'ia_ativa';
      const initialPausedUntil = isManualTenant ? new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000) : null;
      const initialStage = isManualTenant ? 'manual' : 'novo';

      let session: { id: string; status_atendimento: string; paused_until: Date | null; etapa_funil?: string };
      if (sessionRes.rows.length === 0) {
        const newSession = await query<{ id: string; status_atendimento: string; paused_until: Date | null; etapa_funil?: string }>(
          `INSERT INTO chat_sessions (tenant_id, remote_jid, client_name, status_atendimento, etapa_funil, paused_until, last_interaction)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())
           RETURNING id, status_atendimento, paused_until, etapa_funil;`,
          [tenantId, effectiveJid, null, initialStatus, initialStage, initialPausedUntil]
        );
        session = newSession.rows[0];
      } else {
        session = sessionRes.rows[0];
        await query(
          `UPDATE chat_sessions SET last_interaction = NOW() WHERE id = $1 AND tenant_id = $2;`,
          [session.id, tenantId]
        );
      }

      await query(
        `INSERT INTO chat_messages (session_id, tenant_id, role, content, media_type, message_id)
         VALUES ($1, $2, 'user', $3, $4, $5);`,
        [session.id, tenantId, callText, callMediaType, `call_${Date.now()}`]
      );

      if (aiConfig.modo_atendimento === 'manual') {
        console.log(`[Webhook] Tenant em modo manual. Chamada registrada sem resposta automática.`);
        return { handled: true, action: 'call_logged_manual_mode', isVideo: isVideo as any, callerJid: effectiveJid } as any;
      }

      const isContactManual = Boolean(
        session.status_atendimento === 'manual' ||
        session.status_atendimento === 'pausa_humana' ||
        session.status_atendimento === 'transbordado' ||
        (session as any).etapa_funil === 'manual' ||
        (session.paused_until && new Date(session.paused_until).getTime() > Date.now())
      );
      if (isContactManual) {
        console.log(`[Webhook] Contato ${effectiveJid} em atendimento manual. Chamada registrada.`);
        return { handled: true, action: 'call_logged_contact_manual', isVideo: isVideo as any, callerJid: effectiveJid } as any;
      }

      if (aiConfig.atender_chamadas !== false) {
        let msgChamada = aiConfig.mensagem_chamada ||
          `Olá! Vi que você me ligou por chamada de ${callTypeDesc}. 😊 Como sou a Nat, assistente virtual da WarNat Tech, e nossos especialistas costumam estar em atendimentos externos e visitas técnicas em campo, nosso atendimento aqui pelo WhatsApp é realizado com total agilidade por mensagens de áudio e texto!\n\nComo posso te ajudar agora? Pode me mandar um áudio ou escrever por aqui que já te oriento imediatamente!`;

        msgChamada = msgChamada.replace(/chamada(\s+de\s+(voz|vídeo))?/i, `chamada de ${callTypeDesc}`);

        let sendRes: any;
        let sentMediaType = 'text';

        if (aiConfig.responder_com_audio === 'sempre') {
          try {
            await evolutionService.sendPresence(instanceName, effectiveJid, 'recording');
            const speech = await ttsService.generateSpeech(msgChamada, { voice: aiConfig.voz_ia || 'nova' });
            sendRes = await evolutionService.sendWhatsAppAudio(instanceName, effectiveJid, speech.base64);
            sentMediaType = 'audio';
          } catch (ttsErr: any) {
            console.warn('[Webhook] Falha no TTS para chamada, enviando texto:', ttsErr.message);
            sendRes = await evolutionService.sendTextMessage(instanceName, effectiveJid, msgChamada);
          }
        } else {
          await evolutionService.sendPresence(instanceName, effectiveJid, 'composing');
          sendRes = await evolutionService.sendTextMessage(instanceName, effectiveJid, msgChamada);
        }

        if (sendRes?.messageId) {
          await messageCache.setBotSent(sendRes.messageId, 60);
          await query(
            `INSERT INTO chat_messages (session_id, tenant_id, role, content, media_type, message_id)
             VALUES ($1, $2, 'assistant', $3, $4, $5);`,
            [session.id, tenantId, msgChamada, sentMediaType, sendRes.messageId]
          );
        }

        return {
          handled: true,
          action: 'call_answered_with_bot_notice',
          isVideo,
          callerJid: effectiveJid,
          sentMediaType
        } as any;
      }

      return { handled: true, action: 'call_logged_no_auto_reply', isVideo, callerJid: effectiveJid } as any;
    }

    // Aceita apenas eventos de mensagens novas (messages.upsert)
    if (eventName !== 'messages.upsert') {
      return { handled: false, reason: 'evento_ignorado' };
    }

    const data = payload.data;
    if (!data || !data.key) {
      return { handled: false, reason: 'dados_de_mensagem_ausentes' };
    }

    const keyAny: any = data.key;
    const { remoteJid, fromMe, id: messageId } = data.key;
    const remoteJidAlt = keyAny.remoteJidAlt || keyAny.senderPn || keyAny.participantAlt || (keyAny.participant && String(keyAny.participant).includes('@s.whatsapp.net') ? keyAny.participant : null);

    // Ignora grupos e transmissões de status
    if (!remoteJid || remoteJid.includes('@g.us') || remoteJid === 'status@broadcast') {
      return { handled: true, action: 'grupo_ou_broadcast_ignorado' };
    }

    // Normaliza LID do WhatsApp para JID real quando presente
    let effectiveJid = remoteJid;
    if (remoteJid.includes('@lid') && remoteJidAlt && String(remoteJidAlt).includes('@s.whatsapp.net')) {
      effectiveJid = remoteJidAlt;
    }

    const { tenantId, instanceName } = await this.resolveTenantAndSession(payload);
    const sanitizePushName = (raw?: string | null): string | null => {
      if (!raw || typeof raw !== 'string') return null;
      const trimmed = raw.trim();
      if (!trimmed) return null;
      const lower = trimmed.toLowerCase();
      if (['você', 'voce', 'eu', 'cliente', 'null', 'undefined'].includes(lower)) return null;
      if (trimmed.includes('@lid') || /^\+?[\d\s().-]+$/.test(trimmed)) return null;
      return trimmed;
    };
    const pushName = fromMe ? null : sanitizePushName(data.pushName);

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
           tenant_id, remote_jid, status_atendimento, paused_until, pending_after_hours_followup, after_hours_last_user_msg, last_interaction, first_human_reply_at
         ) VALUES ($1, $2, 'pausa_humana', $3, false, NULL, NOW(), NOW())
         ON CONFLICT (tenant_id, remote_jid) 
         DO UPDATE SET 
           status_atendimento = 'pausa_humana',
           paused_until = $3,
           pending_after_hours_followup = false,
           after_hours_last_user_msg = NULL,
           last_interaction = NOW(),
           first_human_reply_at = COALESCE(chat_sessions.first_human_reply_at, NOW())
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
    let sessionRes = await query<{ id: string; status_atendimento: string; paused_until: Date | null; etapa_funil?: string; pending_after_hours_followup?: boolean; after_hours_notice_sent_at?: Date | null }>(
      `SELECT id, status_atendimento, paused_until, etapa_funil, pending_after_hours_followup, after_hours_notice_sent_at 
       FROM chat_sessions 
       WHERE tenant_id = $1 AND remote_jid = $2;`,
      [tenantId, effectiveJid]
    );

    let session: { id: string; status_atendimento: string; paused_until: Date | null; etapa_funil?: string; pending_after_hours_followup?: boolean; after_hours_notice_sent_at?: Date | null };

    if (sessionRes.rows.length === 0) {
      const aiConfigRes = await query<{ modo_atendimento?: string }>(
        `SELECT modo_atendimento FROM tenant_ai_configs WHERE tenant_id = $1;`,
        [tenantId]
      );
      const isManualTenant = aiConfigRes.rows[0]?.modo_atendimento === 'manual';
      const initialStatus = isManualTenant ? 'manual' : 'ia_ativa';
      const initialPausedUntil = isManualTenant ? new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000) : null;
      const initialStage = isManualTenant ? 'manual' : 'novo';

      const newSession = await query<{ id: string; status_atendimento: string; paused_until: Date | null; etapa_funil?: string; pending_after_hours_followup?: boolean; after_hours_notice_sent_at?: Date | null }>(
        `INSERT INTO chat_sessions (tenant_id, remote_jid, client_name, status_atendimento, etapa_funil, paused_until, last_interaction)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING id, status_atendimento, paused_until, etapa_funil, pending_after_hours_followup, after_hours_notice_sent_at;`,
        [tenantId, effectiveJid, pushName, initialStatus, initialStage, initialPausedUntil]
      );
      session = newSession.rows[0];
    } else {
      session = sessionRes.rows[0];
      await query(
        `UPDATE chat_sessions 
         SET last_interaction = NOW(), client_name = COALESCE($1, NULLIF(TRIM(client_name), ''))
         WHERE id = $2 AND tenant_id = $3;`,
        [pushName || null, session.id, tenantId]
      );
    }

    // ============================================================================
    // 3. TRATAMENTO DE CONTEÚDO E EDGE CASES (ÁUDIO, FOTO, TEXTO VAZIO)
    // ============================================================================
    let text = '';
    let isMediaAcknowledgmentNeeded = false;
    let mediaResponseText = '';
    let isAudioMessage = false;

    if (data.message?.conversation) {
      text = data.message.conversation;
    } else if (data.message?.extendedTextMessage?.text) {
      text = data.message.extendedTextMessage.text;
    } else if (data.message?.speechToText) {
      // Áudio transcrito pelo Whisper
      const speech = typeof data.message.speechToText === 'string'
        ? data.message.speechToText
        : (data.message.speechToText.text || '');
      text = speech ? (speech.startsWith('[audio]') ? speech : `[audio] ${speech}`) : '';
      isAudioMessage = true;
    } else if (data.message?.audioMessage) {
      // Mensagem de áudio recebida
      isAudioMessage = true;
      let audioBase64 = (data.message as any).base64 || (data as any).base64 || (data.message.audioMessage as any).base64;

      if (!audioBase64) {
        audioBase64 = await evolutionService.getBase64FromMediaMessage(instanceName, data.key, data.message);
      }

      if (audioBase64) {
        console.log(`[Webhook] Transcrevendo áudio recebido de ${effectiveJid} via OpenAI Whisper...`);
        const transcription = await audioTranscriptionService.transcribeAudio(audioBase64, {
          mimetype: data.message.audioMessage.mimetype || 'audio/ogg'
        });

        if (transcription && transcription.trim()) {
          console.log(`[Webhook] Áudio transcrito com sucesso: "${transcription}"`);
          text = `[audio] ${transcription.trim()}`;
        }
      }

      // Se não conseguiu transcrever por áudio vazio ou falha
      if (!text || !text.trim()) {
        text = '[áudio do cliente]';
        isMediaAcknowledgmentNeeded = true;
        mediaResponseText = 'Recebi seu áudio! Nossa equipe já está atenta e ouvindo a sua mensagem.';
      }
    } else if (data.message?.imageMessage) {
      // Imagem ou foto do local enviada
      if (data.message.imageMessage.caption && data.message.imageMessage.caption.trim()) {
        text = data.message.imageMessage.caption.trim();
      } else {
        text = '[foto/imagem enviada pelo cliente]';
        isMediaAcknowledgmentNeeded = true;
        mediaResponseText = 'Recebi a sua foto! Imagens e fotos do local são analisadas detalhadamente pelo nosso especialista técnico.';
      }
    } else if (data.message?.videoMessage) {
      if (data.message.videoMessage.caption && data.message.videoMessage.caption.trim()) {
        text = data.message.videoMessage.caption.trim();
      } else {
        text = '[vídeo enviado pelo cliente]';
        isMediaAcknowledgmentNeeded = true;
        mediaResponseText = 'Recebi o seu vídeo! Nossa equipe já está verificando os detalhes da gravação.';
      }
    } else if (data.message?.documentMessage) {
      const doc = data.message.documentMessage;
      const fileName = doc.fileName || (doc as any).filename || 'documento';
      if (doc.caption && doc.caption.trim()) {
        text = `[Documento: ${fileName}] ${doc.caption.trim()}`;
      } else {
        text = `[Documento anexado: ${fileName}]`;
      }
    } else if (data.message?.locationMessage) {
      const loc = data.message.locationMessage;
      const lat = loc.degreesLatitude;
      const long = loc.degreesLongitude;
      const name = loc.name ? ` (${loc.name})` : '';
      const address = loc.address ? ` - ${loc.address}` : '';
      text = `[Localização compartilhada: https://maps.google.com/?q=${lat},${long}${name}${address}]`;
    } else if (data.message?.contactMessage || data.message?.contactsArrayMessage) {
      const contact = data.message.contactMessage || data.message.contactsArrayMessage?.contacts?.[0];
      const dispName = contact?.displayName || 'Contato';
      text = `[Contato compartilhado: ${dispName}]`;
    } else if (data.message?.stickerMessage) {
      text = '[Figurinha enviada pelo cliente]';
    }

    // Proteção contra payload vazio: não permite quebrar a LLM
    if (!text || !text.trim()) {
      return { handled: true, action: 'empty_payload_ignored' };
    }

    let detectedMediaType = 'text';
    if (isAudioMessage) detectedMediaType = 'audio';
    else if (data.message?.imageMessage) detectedMediaType = 'image';
    else if (data.message?.videoMessage) detectedMediaType = 'video';
    else if (data.message?.documentMessage) detectedMediaType = 'document';
    else if (data.message?.locationMessage) detectedMediaType = 'location';
    else if (data.message?.contactMessage || data.message?.contactsArrayMessage) detectedMediaType = 'contact';
    else if (data.message?.stickerMessage) detectedMediaType = 'sticker';

    // Salva a mensagem recebida no histórico do chat
    await query(
      `INSERT INTO chat_messages (session_id, tenant_id, role, content, media_type, message_id)
       VALUES ($1, $2, 'user', $3, $4, $5);`,
      [session.id, tenantId, text.trim(), detectedMediaType, messageId || null]
    );

    // Atualiza queued_at para cálculo de TME
    await query(
      `UPDATE chat_sessions 
       SET queued_at = COALESCE(queued_at, NOW()), last_interaction = NOW()
       WHERE id = $1 AND tenant_id = $2;`,
      [session.id, tenantId]
    );

    // ============================================================================
    // 4. VERIFICAÇÃO DE ATENDIMENTO MANUAL GLOBAL (TENANT) OU POR CONTATO INDIVIDUAL
    // ============================================================================
    // A) Busca configurações de IA e horário comercial do tenant
    const aiConfigRes = await query<{
      modo_atendimento: string;
      automacao_horario_ativo?: boolean;
      automacao_dias_semana?: any;
      automacao_horario_inicio?: string;
      automacao_horario_fim?: string;
      automacao_enviar_msg_fora_expediente?: boolean;
      automacao_fora_expediente_msg?: string;
      regras_agendamento?: any;
    }>(
      `SELECT modo_atendimento, automacao_horario_ativo, automacao_dias_semana, automacao_horario_inicio, automacao_horario_fim, automacao_enviar_msg_fora_expediente, automacao_fora_expediente_msg, regras_agendamento FROM tenant_ai_configs WHERE tenant_id = $1;`,
      [tenantId]
    );
    const aiConfig = aiConfigRes.rows[0] || ({} as any);
    const tenantModo = aiConfig.modo_atendimento || 'automacao';

    if (tenantModo === 'manual') {
      console.log(`🛑 [Webhook] Tenant ${tenantId} configurado em ATENDIMENTO 100% MANUAL GLOBAL. IA silenciada.`);
      return {
        handled: true,
        action: 'tenant_manual_mode_active',
        tenantId
      };
    }

    // B) Checa se este contato específico está em atendimento manual ou com IA pausada
    const isContactManual = Boolean(
      session.status_atendimento === 'manual' ||
      session.status_atendimento === 'pausa_humana' ||
      session.status_atendimento === 'transbordado' ||
      session.etapa_funil === 'manual' ||
      (session.paused_until && new Date(session.paused_until).getTime() > Date.now())
    );

    if (isContactManual) {
      console.log(`🛑 [Webhook] Contato ${effectiveJid} em ATENDIMENTO MANUAL EXCLUSIVO (status: ${session.status_atendimento}, etapa: ${session.etapa_funil}, paused_until: ${session.paused_until}). Automação 100% silenciada.`);
      return {
        handled: true,
        action: 'message_saved_human_in_control',
        reason: 'contact_manual_mode_active',
        status: session.status_atendimento,
        pausedUntil: session.paused_until || undefined
      };
    }

    // C) Validação de Dias da Semana e Horários de Atendimento da Automação (Horário de Brasília)
    const scheduleCheck = this.checkAutomationOperatingHours(aiConfig);
    if (!scheduleCheck.isOpen) {
      console.log(`[Webhook] Fora do expediente da automação para o Tenant ${tenantId} (${scheduleCheck.currentDay} ${scheduleCheck.currentTime}).`);

      const shouldSendNotice = aiConfig.automacao_enviar_msg_fora_expediente !== false;
      let noticeDispatched = false;
      let followupQueued = false;

      if (shouldSendNotice) {
        const cooldownKey = `outside_notice:${tenantId}:${effectiveJid}`;
        const recentlyNotifiedInDb = Boolean(
          session.pending_after_hours_followup &&
          session.after_hours_notice_sent_at &&
          (Date.now() - new Date(session.after_hours_notice_sent_at).getTime()) < (2 * 60 * 60 * 1000)
        );
        const alreadySent = (await (messageCache as any).has(cooldownKey)) || recentlyNotifiedInDb;

        if (!alreadySent) {
          const defaultOutsideMsg = 'Olá! Nosso atendimento no momento está fora do nosso horário de funcionamento. Registramos sua mensagem e responderemos assim que retornarmos!';
          const outsideMsg = (aiConfig.automacao_fora_expediente_msg && aiConfig.automacao_fora_expediente_msg.trim())
            ? aiConfig.automacao_fora_expediente_msg.trim()
            : defaultOutsideMsg;

          try {
            const sendRes = await evolutionService.sendTextMessage(instanceName, effectiveJid, outsideMsg);
            const wasDelivered = Boolean(sendRes && (sendRes as any).success === true && !(sendRes as any).simulated);

            if (wasDelivered) {
              if (sendRes.messageId) {
                await messageCache.setBotSent(sendRes.messageId, 120);
                await query(
                  `INSERT INTO chat_messages (session_id, tenant_id, role, content, message_id)
                   VALUES ($1, $2, 'assistant', $3, $4);`,
                  [session.id, tenantId, outsideMsg, sendRes.messageId]
                );
              }
              await (messageCache as any).set(cooldownKey, 7200);

              await query(
                `UPDATE chat_sessions
                 SET pending_after_hours_followup = true,
                     after_hours_notice_sent_at = NOW(),
                     after_hours_notice_msg_id = $1,
                     after_hours_last_user_msg = CASE
                       WHEN pending_after_hours_followup = true AND after_hours_last_user_msg IS NOT NULL AND after_hours_last_user_msg <> ''
                         THEN after_hours_last_user_msg || E'\n' || $2
                       ELSE $2
                     END
                 WHERE id = $3 AND tenant_id = $4;`,
                [sendRes.messageId || null, text.trim(), session.id, tenantId]
              );

              noticeDispatched = true;
              followupQueued = true;
            }
          } catch (sendErr: any) {
            console.warn('[Webhook] Falha ao enviar mensagem de fora do expediente:', sendErr.message);
          }
        } else if (session.pending_after_hours_followup) {
          await query(
            `UPDATE chat_sessions
             SET after_hours_last_user_msg = CASE
               WHEN after_hours_last_user_msg IS NOT NULL AND after_hours_last_user_msg <> ''
                 THEN after_hours_last_user_msg || E'\n' || $1
               ELSE $1
             END
             WHERE id = $2 AND tenant_id = $3 AND pending_after_hours_followup = true;`,
            [text.trim(), session.id, tenantId]
          );
          followupQueued = true;
        }
      }

      return {
        handled: true,
        action: 'outside_operating_hours',
        tenantId,
        remoteJid: effectiveJid,
        currentDay: scheduleCheck.currentDay,
        currentTime: scheduleCheck.currentTime,
        noticeDispatched,
        followupQueued,
        reason: 'outside_business_hours'
      };
    }

    if (session.pending_after_hours_followup) {
      await query(
        `UPDATE chat_sessions
         SET pending_after_hours_followup = false, after_hours_last_user_msg = NULL
         WHERE id = $1 AND tenant_id = $2;`,
        [session.id, tenantId]
      );
      session.pending_after_hours_followup = false;
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
      if (isAudioMessage) buffer.isAudio = true;
    } else {
      buffer = {
        tenantId,
        instanceName,
        sessionId: session.id,
        remoteJid: effectiveJid,
        pushName: pushName || '',
        messages: [text.trim()],
        isAudio: isAudioMessage,
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
    console.log(`💬 [Webhook] Debounce concluído para ${buffer.remoteJid} (${buffer.messages.length} fragmentos, isAudio=${!!buffer.isAudio}):\n"${consolidatedText}"`);

    // Notifica presença "digitando..." ou gravando áudio no WhatsApp
    if (buffer.isAudio) {
      await evolutionService.sendPresence(buffer.instanceName, buffer.remoteJid, 'recording');
    } else {
      await evolutionService.sendPresence(buffer.instanceName, buffer.remoteJid, 'composing');
    }

    if (this.aiProcessor) {
      try {
        await this.aiProcessor({
          tenantId: buffer.tenantId,
          instanceName: buffer.instanceName,
          sessionId: buffer.sessionId,
          remoteJid: buffer.remoteJid,
          pushName: buffer.pushName,
          userMessage: consolidatedText,
          isAudio: !!buffer.isAudio
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
