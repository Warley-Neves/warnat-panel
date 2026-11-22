// ==============================================================================
// Serviço de Retomada Automática no Início do Expediente - WarNat SaaS
// Dispara automaticamente o início do atendimento quando o expediente abre,
// EXCLUSIVAMENTE para clientes que enviaram mensagem fora do horário e
// receberam o aviso automático de fora do expediente.
// ==============================================================================

const { query: defaultQuery } = require('../database/db');
const defaultEvolutionService = require('./evolution.service');
const defaultMessageCache = require('./message-cache.service');
const defaultEntitlementsService = require('./entitlements.service');
const defaultWebhookController = require('../controllers/webhook.controller');
const defaultAiEngine = require('./ai-engine.service');

class AfterHoursFollowupService {
  constructor(deps = {}) {
    this.query = deps.query || defaultQuery;
    this.evolutionService = deps.evolutionService || defaultEvolutionService;
    this.messageCache = deps.messageCache || defaultMessageCache;
    this.entitlementsService = deps.entitlementsService || defaultEntitlementsService;
    this.webhookController = deps.webhookController || defaultWebhookController;
    this.aiProcessor = deps.aiProcessor || ((params) => defaultAiEngine.processTurn(params));

    this.intervalHandle = null;
    this.warmupHandle = null;
    this.isProcessing = false;
    this.defaultIntervalMs = 30000; // Verifica a cada 30 segundos
    this.staggerDelayMs = deps.staggerDelayMs !== undefined ? deps.staggerDelayMs : 1500;
  }

  /**
   * Inicia o monitor em segundo plano para retomada no horário de atendimento
   */
  start(intervalMs = this.defaultIntervalMs) {
    if (this.intervalHandle || this.warmupHandle) {
      return;
    }

    console.log(`🕒 [AfterHoursFollowup] Monitor de retomada no início do expediente ativado (verificação a cada ${Math.round(intervalMs / 1000)}s).`);

    // Primeira execução após 10s para aguardar estabilização inicial do servidor/banco
    this.warmupHandle = setTimeout(() => {
      this.warmupHandle = null;
      this.processPendingFollowups().catch((err) => {
        console.warn('[AfterHoursFollowup] Erro na verificação inicial:', err.message);
      });

      this.intervalHandle = setInterval(() => {
        this.processPendingFollowups().catch((err) => {
          console.warn('[AfterHoursFollowup] Erro no ciclo periódico:', err.message);
        });
      }, intervalMs);

      if (this.intervalHandle.unref) {
        this.intervalHandle.unref();
      }
    }, 10000);

    if (this.warmupHandle.unref) {
      this.warmupHandle.unref();
    }
  }

  /**
   * Para o monitor periódico (útil em testes e desligamento gracioso)
   */
  stop() {
    if (this.warmupHandle) {
      clearTimeout(this.warmupHandle);
      this.warmupHandle = null;
    }
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Monta mensagem amigável de fallback caso a LLM esteja momentaneamente indisponível
   */
  buildFallbackResumeMessage(row, referenceDate = null) {
    const baseDate = referenceDate ? new Date(referenceDate) : new Date();
    const brDate = new Date(baseDate.toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const brHour = brDate.getHours();
    const saudacao = brHour < 12 ? 'Bom dia' : (brHour < 18 ? 'Boa tarde' : 'Boa noite');
    const assistente = row.nome_assistente || 'Nat';
    const empresa = row.nome_empresa || 'nossa empresa';
    const rawName = String(row.client_name || '').trim();
    const hasValidName = rawName && !/^\d+$/.test(rawName) && rawName.toLowerCase() !== 'cliente' && rawName.toLowerCase() !== 'cliente manual';
    const firstName = hasValidName ? `, ${rawName.split(/\s+/)[0]}` : '';

    return `${saudacao}${firstName}! 😊 Aqui é a ${assistente}, da ${empresa}. Já iniciamos nosso horário de atendimento e estou retornando a mensagem que você nos enviou fora do expediente! Como posso te ajudar agora?`;
  }

  /**
   * Processa todos os clientes elegíveis que enviaram mensagem fora do horário
   * e receberam o aviso de ausência, assim que o horário de atendimento iniciar.
   */
  async processPendingFollowups(options = {}) {
    if (this.isProcessing) {
      return { skipped: true, reason: 'already_running', processed: 0, dispatched: 0 };
    }

    this.isProcessing = true;
    const summary = {
      processed: 0,
      dispatched: 0,
      skippedOutsideHours: 0,
      skippedAlreadyReplied: 0,
      skippedDisconnected: 0,
      skippedNoEntitlement: 0,
      errors: 0
    };

    try {
      // 1. Limpeza preventiva: remove pendência de sessões manuais, concluídas, sem aviso registrado ou expiradas (> 5 dias)
      await this.query(
        `UPDATE chat_sessions
         SET pending_after_hours_followup = false,
             after_hours_last_user_msg = NULL
         WHERE pending_after_hours_followup = true
           AND (
             status_atendimento IN ('manual', 'pausa_humana', 'transbordado')
             OR COALESCE(etapa_funil, 'novo') IN ('manual', 'concluido')
             OR after_hours_notice_sent_at IS NULL
             OR after_hours_notice_sent_at < NOW() - INTERVAL '5 days'
           )`
      );

      // 2. Busca SOMENTE sessões onde o cliente mandou mensagem fora do horário, recebeu o aviso de fora do expediente,
      //    e continua com IA ativa (tenant em automação e contato não manual/não pausado).
      const candidatesRes = await this.query(
        `SELECT
           s.id AS session_id,
           s.tenant_id,
           s.remote_jid,
           s.client_name,
           s.status_atendimento,
           s.etapa_funil,
           s.paused_until,
           s.after_hours_notice_sent_at,
           s.after_hours_notice_msg_id,
           s.after_hours_last_user_msg,
           c.modo_atendimento,
           c.automacao_horario_ativo,
           c.automacao_dias_semana,
           c.automacao_horario_inicio,
           c.automacao_horario_fim,
           c.automacao_enviar_msg_fora_expediente,
           c.automacao_fora_expediente_msg,
           c.regras_agendamento,
           c.nome_assistente,
           t.nome_empresa,
           w.instance_name
         FROM chat_sessions s
         JOIN tenant_ai_configs c ON c.tenant_id = s.tenant_id
         JOIN tenants t ON t.id = s.tenant_id
         JOIN tenant_whatsapp_instances w ON w.tenant_id = s.tenant_id
         WHERE s.pending_after_hours_followup = true
           AND s.after_hours_notice_sent_at IS NOT NULL
           AND c.modo_atendimento = 'automacao'
           AND s.status_atendimento = 'ia_ativa'
           AND COALESCE(s.etapa_funil, 'novo') NOT IN ('manual', 'concluido')
           AND (s.paused_until IS NULL OR s.paused_until <= NOW())
           AND COALESCE(t.ativo, true) = true
           AND w.instance_name IS NOT NULL
         ORDER BY s.after_hours_notice_sent_at ASC
         LIMIT 25`
      );

      if (!candidatesRes || !Array.isArray(candidatesRes.rows) || candidatesRes.rows.length === 0) {
        return summary;
      }

      const instanceStatusCache = new Map();
      const referenceDate = options.referenceDate || null;

      for (const row of candidatesRes.rows) {
        summary.processed++;

        try {
          // 3A. Verifica se AGORA já estamos dentro do dia e horário de atendimento configurado do tenant
          const scheduleCheck = this.webhookController.checkAutomationOperatingHours(row, referenceDate);
          if (!scheduleCheck.isOpen) {
            summary.skippedOutsideHours++;
            continue;
          }

          // 3B. Verifica se o plano do tenant mantém a feature 'automation_bots' liberada
          const canUseBots = await this.entitlementsService.canUseFeature(row.tenant_id, 'automation_bots');
          if (!canUseBots) {
            summary.skippedNoEntitlement++;
            continue;
          }

          // 3C. Se há um debounce em andamento (cliente acabou de mandar nova mensagem), deixa o webhook responder
          const bufferKey = `${row.tenant_id}:${row.remote_jid}`;
          if (this.webhookController.debounceBuffers && this.webhookController.debounceBuffers.has(bufferKey)) {
            continue;
          }

          // 3D. Verifica se algum operador ou a IA já respondeu APÓS o envio do aviso de fora do expediente
          const repliedAfterRes = await this.query(
            `SELECT id
             FROM chat_messages
             WHERE session_id = $1
               AND tenant_id = $2
               AND role = 'assistant'
               AND created_at > $3
               AND ($4::text IS NULL OR message_id IS DISTINCT FROM $4::text)
             LIMIT 1`,
            [row.session_id, row.tenant_id, row.after_hours_notice_sent_at, row.after_hours_notice_msg_id || null]
          );

          if (repliedAfterRes && repliedAfterRes.rowCount > 0) {
            await this.query(
              `UPDATE chat_sessions
               SET pending_after_hours_followup = false, after_hours_last_user_msg = NULL
               WHERE id = $1 AND tenant_id = $2`,
              [row.session_id, row.tenant_id]
            );
            summary.skippedAlreadyReplied++;
            continue;
          }

          // 3E. Verifica se a instância WhatsApp do tenant está conectada ('open') antes de consumir a pendência
          let isConnected = instanceStatusCache.get(row.instance_name);
          if (isConnected === undefined) {
            try {
              const st = await this.evolutionService.getInstanceStatus(row.instance_name);
              isConnected = Boolean(st && st.state === 'open');
            } catch (statusErr) {
              isConnected = false;
            }
            instanceStatusCache.set(row.instance_name, isConnected);
          }

          if (!isConnected) {
            console.log(`[AfterHoursFollowup] Instância ${row.instance_name} offline/reconectando. Mantendo retomada de ${row.remote_jid} na fila.`);
            summary.skippedDisconnected++;
            continue;
          }

          // 3F. Claim atômico no banco: garante disparo ÚNICO (idempotente) e revalida que o contato segue em IA ativa
          const pendingUserMsg = (row.after_hours_last_user_msg || '').trim();
          const claimRes = await this.query(
            `UPDATE chat_sessions
             SET pending_after_hours_followup = false,
                 after_hours_followup_sent_at = NOW(),
                 after_hours_last_user_msg = NULL
             WHERE id = $1
               AND tenant_id = $2
               AND pending_after_hours_followup = true
               AND status_atendimento = 'ia_ativa'
               AND COALESCE(etapa_funil, 'novo') NOT IN ('manual', 'concluido')
               AND (paused_until IS NULL OR paused_until <= NOW())
             RETURNING id`,
            [row.session_id, row.tenant_id]
          );

          if (!claimRes || claimRes.rowCount === 0) {
            continue;
          }

          console.log(`☀️ [AfterHoursFollowup] Horário de atendimento iniciado (${scheduleCheck.currentDay} ${scheduleCheck.currentTime}). Retomando contato ${row.remote_jid} (tenant ${row.tenant_id})...`);

          // 3G. Invoca a Engine de IA para iniciar o atendimento de forma contextualizada
          let dispatchedOk = false;
          try {
            const turnResult = await this.aiProcessor({
              tenantId: row.tenant_id,
              instanceName: row.instance_name,
              sessionId: row.session_id,
              remoteJid: row.remote_jid,
              pushName: row.client_name || '',
              userMessage: pendingUserMsg || 'Olá',
              isAudio: pendingUserMsg.startsWith('[audio]'),
              isAfterHoursResume: true
            });
            dispatchedOk = Boolean(turnResult && (turnResult.success || turnResult.messageId));
          } catch (aiErr) {
            console.warn(`[AfterHoursFollowup] Falha na IA ao retomar ${row.remote_jid} (${aiErr.message}). Aplicando fallback amigável...`);
          }

          // Fallback amigável caso a LLM não tenha conseguido responder (mantém garantia de retomada no expediente)
          if (!dispatchedOk) {
            try {
              const fallbackText = this.buildFallbackResumeMessage(row, referenceDate);
              const sendRes = await this.evolutionService.sendTextMessage(row.instance_name, row.remote_jid, fallbackText);
              if (sendRes && sendRes.success === true && !sendRes.simulated) {
                if (sendRes.messageId) {
                  await this.messageCache.setBotSent(sendRes.messageId, 120);
                  await this.query(
                    `INSERT INTO chat_messages (session_id, tenant_id, role, content, media_type, message_id)
                     VALUES ($1, $2, 'assistant', $3, 'text', $4)`,
                    [row.session_id, row.tenant_id, fallbackText, sendRes.messageId]
                  );
                }
                await this.query(
                  `UPDATE chat_sessions SET last_interaction = NOW() WHERE id = $1 AND tenant_id = $2`,
                  [row.session_id, row.tenant_id]
                );
                dispatchedOk = true;
              }
            } catch (fbErr) {
              console.error(`[AfterHoursFollowup] Falha também no fallback para ${row.remote_jid}:`, fbErr.message);
            }
          }

          if (dispatchedOk) {
            summary.dispatched++;
            console.log(`✅ [AfterHoursFollowup] Atendimento iniciado com sucesso para ${row.remote_jid}!`);
          } else {
            summary.errors++;
          }

          // Pequeno intervalo humanizado entre múltiplos contatos para evitar rajada simultânea no WhatsApp
          if (this.staggerDelayMs > 0 && candidatesRes.rows.length > 1) {
            await new Promise((resolve) => setTimeout(resolve, this.staggerDelayMs));
          }
        } catch (rowErr) {
          summary.errors++;
          console.error(`[AfterHoursFollowup] Erro ao processar retomada da sessão ${row.session_id}:`, rowErr.message);
        }
      }
    } finally {
      this.isProcessing = false;
    }

    return summary;
  }
}

module.exports = new AfterHoursFollowupService();
module.exports.AfterHoursFollowupService = AfterHoursFollowupService;
