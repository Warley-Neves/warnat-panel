// ==============================================================================
// History Sync Service - Sincronização Completa do Histórico do WhatsApp
// Carrega conversas e mensagens históricas da Evolution API para o PostgreSQL
// Modo 100% manual e proteção anti-disparo automatizado
// ==============================================================================

const { query } = require('../database/db');
const evolutionService = require('./evolution.service');

class HistorySyncService {
  constructor() {
    // Mapa de jobs em execução: tenantId -> { status, startedAt, finishedAt, result, error }
    this.jobs = new Map();
  }

  getJob(tenantId) {
    return this.jobs.get(tenantId) || { status: 'idle' };
  }

  /**
   * Extrai o conteúdo legível e o tipo de mídia de um registro de mensagem da Evolution API
   */
  extractMessageContent(record) {
    if (!record || !record.message) return null;
    const msg = record.message;
    let content = '';
    let mediaType = 'text';
    let mediaUrl = null;

    if (msg.conversation) {
      content = msg.conversation;
    } else if (msg.extendedTextMessage?.text) {
      content = msg.extendedTextMessage.text;
    } else if (msg.imageMessage) {
      mediaType = 'image';
      content = msg.imageMessage.caption ? `[Foto] ${msg.imageMessage.caption}` : '[Foto enviada]';
      mediaUrl = msg.imageMessage.url || null;
    } else if (msg.audioMessage) {
      mediaType = 'audio';
      content = '[Áudio gravado]';
      mediaUrl = msg.audioMessage.url || null;
    } else if (msg.videoMessage) {
      mediaType = 'video';
      content = msg.videoMessage.caption ? `[Vídeo] ${msg.videoMessage.caption}` : '[Vídeo enviado]';
      mediaUrl = msg.videoMessage.url || null;
    } else if (msg.documentMessage) {
      mediaType = 'document';
      const fileName = msg.documentMessage.fileName || msg.documentMessage.filename || 'documento';
      content = msg.documentMessage.caption ? `[Documento: ${fileName}] ${msg.documentMessage.caption}` : `[Documento: ${fileName}]`;
      mediaUrl = msg.documentMessage.url || null;
    } else if (msg.locationMessage) {
      mediaType = 'location';
      const lat = msg.locationMessage.degreesLatitude;
      const long = msg.locationMessage.degreesLongitude;
      const name = msg.locationMessage.name ? ` (${msg.locationMessage.name})` : '';
      const address = msg.locationMessage.address ? ` - ${msg.locationMessage.address}` : '';
      content = `[Localização: https://maps.google.com/?q=${lat},${long}${name}${address}]`;
    } else if (msg.contactMessage || msg.contactsArrayMessage) {
      mediaType = 'contact';
      const contact = msg.contactMessage || msg.contactsArrayMessage?.contacts?.[0];
      content = `[Contato compartilhado: ${contact?.displayName || 'Contato'}]`;
    } else if (msg.stickerMessage) {
      mediaType = 'sticker';
      content = '[Figurinha]';
    } else if (msg.templateMessage?.interactiveMessageTemplate?.body?.text) {
      content = msg.templateMessage.interactiveMessageTemplate.body.text;
    } else if (msg.templateMessage?.hydratedTemplate?.hydratedContentText) {
      content = msg.templateMessage.hydratedTemplate.hydratedContentText;
    } else if (msg.interactiveMessage?.body?.text) {
      content = msg.interactiveMessage.body.text;
    } else if (msg.buttonsMessage?.contentText) {
      content = msg.buttonsMessage.contentText;
    } else if (msg.listMessage?.description) {
      content = msg.listMessage.description;
    } else if (record.messageType === 'protocolMessage') {
      return null; // Ignora mensagens de controle interno do protocolo WhatsApp
    } else {
      content = `[${record.messageType || 'Mensagem'}]`;
    }

    if (!content || !content.trim()) return null;

    return {
      content: content.trim(),
      mediaType,
      mediaUrl
    };
  }

  /**
   * Sincroniza o histórico completo de conversas e mensagens de um Tenant específico
   * @param {string} tenantId UUID do tenant
   * @param {object} options Opções de sincronização
   */
  async syncTenantHistory(tenantId, options = {}) {
    if (!tenantId) throw new Error('tenantId é obrigatório para sincronização de histórico.');

    const job = {
      status: 'running',
      startedAt: new Date(),
      result: null,
      error: null
    };
    this.jobs.set(tenantId, job);

    try {
      console.log(`[HistorySync] Iniciando sincronização otimizada para tenant ${tenantId}...`);

      // 1. Busca a instância conectada deste tenant
      const instRes = await query(
        `SELECT instance_name, status, numero_telefone 
         FROM tenant_whatsapp_instances 
         WHERE tenant_id = $1 LIMIT 1`,
        [tenantId]
      );

      if (instRes.rowCount === 0 || !instRes.rows[0].instance_name) {
        throw new Error('Nenhuma instância WhatsApp configurada para esta empresa.');
      }

      const instanceName = instRes.rows[0].instance_name;

      // 2. Garante modo 100% manual e silencia qualquer disparo automatizado
      await query(
        `UPDATE tenant_ai_configs 
         SET modo_atendimento = 'manual', updated_at = now() 
         WHERE tenant_id = $1`,
        [tenantId]
      ).catch(() => {});

      // 3. Ativa syncFullHistory na Evolution API
      try {
        await evolutionService.updateSettings(instanceName, {
          syncFullHistory: true,
          readMessages: false,
          readStatus: false,
          groupsIgnore: true
        });
      } catch (stErr) {
        console.warn(`[HistorySync] Aviso ao ativar syncFullHistory para ${instanceName}:`, stErr.message);
      }

      // 4. Busca todos os contatos salvos no WhatsApp (em paralelo com chats)
      const contactMap = new Map();
      const lidToPhoneMap = new Map();
      const chatSummaryMap = new Map();

      const [contactsResult, chatsResult] = await Promise.allSettled([
        evolutionService.findContacts(instanceName),
        evolutionService.findChats(instanceName)
      ]);

      if (contactsResult.status === 'fulfilled' && Array.isArray(contactsResult.value)) {
        for (const c of contactsResult.value) {
          if (!c.remoteJid || c.remoteJid.includes('@g.us')) continue;
          const cleanPhone = c.remoteJid.replace(/@.*$/, '').replace(/\D/g, '');
          const rawName = (c.pushName || '').trim();
          const info = {
            pushName: (rawName && !['você', 'voce', 'eu'].includes(rawName.toLowerCase())) ? rawName : null,
            profilePicUrl: c.profilePicUrl || null
          };
          contactMap.set(c.remoteJid, info);
          if (cleanPhone) contactMap.set(cleanPhone, info);
        }
      }

      if (chatsResult.status === 'fulfilled' && Array.isArray(chatsResult.value)) {
        for (const ch of chatsResult.value) {
          const rawJid = ch.remoteJid || ch.id;
          if (!rawJid || rawJid.includes('@g.us') || rawJid === 'status@broadcast') continue;

          const altJid = ch.lastMessage?.key?.remoteJidAlt;
          if (rawJid.includes('@lid') && altJid && altJid.includes('@s.whatsapp.net')) {
            lidToPhoneMap.set(rawJid, altJid);
          }

          const rawPush = (ch.pushName || ch.lastMessage?.pushName || '').trim();
          const safePush = (rawPush && !['você', 'voce', 'eu', 'null'].includes(rawPush.toLowerCase()) && !rawPush.includes('@lid') && !/^\d{10,}$/.test(rawPush)) ? rawPush : null;

          const effectiveJid = (rawJid.includes('@lid') && altJid) ? altJid : rawJid;
          chatSummaryMap.set(effectiveJid, {
            rawJid,
            updatedAt: ch.updatedAt ? new Date(ch.updatedAt) : new Date(),
            pushName: safePush,
            unreadCount: ch.unreadCount || 0
          });
        }
      }

      console.log(`[HistorySync] ${contactMap.size} contatos e ${chatSummaryMap.size} chats identificados em ${instanceName}.`);

      // 5. Busca primeira página de mensagens para determinar o total real
      const firstPageRes = await evolutionService.findMessages(instanceName, { page: 1, limit: 100 });
      const firstRecords = firstPageRes.messages?.records || firstPageRes.records || [];
      const totalMessagesFound = firstPageRes.messages?.total || firstRecords.length;
      const totalPages = Math.min(options.limitPages || 95, firstPageRes.messages?.pages || Math.ceil(totalMessagesFound / 50) || 1);

      const allRecords = [...firstRecords];
      for (const r of firstRecords) {
        const rJid = r.key?.remoteJid;
        const altJid = r.key?.remoteJidAlt;
        if (rJid && rJid.includes('@lid') && altJid && altJid.includes('@s.whatsapp.net')) {
          lidToPhoneMap.set(rJid, altJid);
        }
      }

      // Se houver mais páginas, busca em lotes concorrentes (4 páginas por vez)
      if (totalPages > 1) {
        const remainingPages = [];
        for (let p = 2; p <= totalPages; p++) remainingPages.push(p);

        const concurrency = 4;
        for (let i = 0; i < remainingPages.length; i += concurrency) {
          const pageBatch = remainingPages.slice(i, i + concurrency);
          const pageResults = await Promise.allSettled(
            pageBatch.map(p => evolutionService.findMessages(instanceName, { page: p, limit: 100 }))
          );

          for (const res of pageResults) {
            if (res.status === 'fulfilled') {
              const recs = res.value.messages?.records || res.value.records || [];
              for (const r of recs) {
                allRecords.push(r);
                const rJid = r.key?.remoteJid;
                const altJid = r.key?.remoteJidAlt;
                if (rJid && rJid.includes('@lid') && altJid && altJid.includes('@s.whatsapp.net')) {
                  lidToPhoneMap.set(rJid, altJid);
                }
              }
            }
          }
        }
      }

      console.log(`[HistorySync] ${allRecords.length} mensagens recuperadas da Evolution API.`);

      // 6. Ordena cronologicamente
      allRecords.sort((a, b) => (a.messageTimestamp || 0) - (b.messageTimestamp || 0));

      // 7. Busca todas as sessões já existentes no banco para este tenant (1 query)
      const existingSessionsRes = await query(
        `SELECT id, remote_jid, last_interaction, client_name 
         FROM chat_sessions 
         WHERE tenant_id = $1`,
        [tenantId]
      );

      const sessionCache = new Map(); // effectiveJid -> { id, lastInteraction, clientName }
      for (const s of existingSessionsRes.rows) {
        sessionCache.set(s.remote_jid, {
          id: s.id,
          lastInteraction: s.last_interaction ? new Date(s.last_interaction) : new Date(0),
          clientName: s.client_name
        });
      }

      // 8. Busca todos os message_id já salvos para este tenant (1 query) para evitar duplicidade com custo zero
      const existingMsgIdsRes = await query(
        `SELECT message_id FROM chat_messages WHERE tenant_id = $1 AND message_id IS NOT NULL`,
        [tenantId]
      );
      const existingMsgSet = new Set(existingMsgIdsRes.rows.map(r => r.message_id));

      // Funções auxiliares para nomes limpos e seguros
      const isValidClientName = (name) => {
        if (!name || typeof name !== 'string') return false;
        const s = name.trim().toLowerCase();
        if (!s || s === 'você' || s === 'voce' || s === 'eu' || s === 'null' || s === 'undefined') return false;
        if (s.includes('@lid') || /^\d{10,}$/.test(s)) return false;
        return true;
      };

      const resolveClientName = (pushFromMsg, contactInfo, chatInfo, effectiveJid, cleanPhone) => {
        if (isValidClientName(pushFromMsg)) return pushFromMsg.trim();
        if (isValidClientName(contactInfo?.pushName)) return contactInfo.pushName.trim();
        if (isValidClientName(chatInfo?.pushName)) return chatInfo.pushName.trim();
        if (cleanPhone) return `+${cleanPhone}`;
        const shortId = effectiveJid.replace(/@.*$/, '').slice(-6);
        return `Cliente (${shortId})`;
      };

      // 9. Agrupa e garante que todas as sessões necessárias existam no banco
      const farFuture = new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);

      const ensureSession = async (effectiveJid, pushNameFromMsg, interactionDate) => {
        if (sessionCache.has(effectiveJid)) {
          const cached = sessionCache.get(effectiveJid);
          if (interactionDate > cached.lastInteraction) {
            cached.lastInteraction = interactionDate;
          }
          if (isValidClientName(pushNameFromMsg) && (!isValidClientName(cached.clientName) || cached.clientName === 'Você' || cached.clientName.startsWith('Cliente'))) {
            cached.clientName = pushNameFromMsg.trim();
          }
          return cached.id;
        }

        const cleanPhone = effectiveJid.replace(/@.*$/, '').replace(/\D/g, '');
        const contactInfo = contactMap.get(effectiveJid) || contactMap.get(cleanPhone);
        const chatInfo = chatSummaryMap.get(effectiveJid);

        const resolvedName = resolveClientName(pushNameFromMsg, contactInfo, chatInfo, effectiveJid, cleanPhone);

        // Insere profile
        await query(
          `INSERT INTO customer_profiles (tenant_id, remote_jid, nome, telefone)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (tenant_id, remote_jid)
           DO UPDATE SET nome = COALESCE(NULLIF(customer_profiles.nome, 'Você'), EXCLUDED.nome), updated_at = now()`,
          [tenantId, effectiveJid, resolvedName, cleanPhone]
        ).catch(() => {});

        const leadData = {
          nome: resolvedName,
          telefone: cleanPhone,
          origem: 'whatsapp_historico_sincronizado'
        };

        const sessRes = await query(
          `INSERT INTO chat_sessions (
             tenant_id, remote_jid, client_name, status_atendimento, etapa_funil, 
             paused_until, dados_lead, last_interaction, created_at
           ) VALUES ($1, $2, $3, 'manual', 'manual', $4, $5, $6, $6)
           ON CONFLICT (tenant_id, remote_jid)
           DO UPDATE SET 
             client_name = COALESCE(NULLIF(chat_sessions.client_name, 'Você'), EXCLUDED.client_name),
             status_atendimento = 'manual',
             etapa_funil = 'manual',
             paused_until = $4,
             last_interaction = GREATEST(chat_sessions.last_interaction, EXCLUDED.last_interaction)
           RETURNING id`,
          [tenantId, effectiveJid, resolvedName, farFuture, JSON.stringify(leadData), interactionDate]
        );

        const sessionId = sessRes.rows[0].id;
        sessionCache.set(effectiveJid, {
          id: sessionId,
          lastInteraction: interactionDate,
          clientName: resolvedName
        });
        return sessionId;
      };

      // Cria/atualiza sessões para todos os chats identificados
      for (const [effectiveJid, chatData] of chatSummaryMap.entries()) {
        try {
          await ensureSession(effectiveJid, chatData.pushName, chatData.updatedAt);
        } catch (e) {}
      }

      // 10. Prepara as mensagens que realmente precisam ser inseridas
      const messagesToInsert = [];

      for (const record of allRecords) {
        const key = record.key || {};
        const rawJid = key.remoteJid;
        if (!rawJid || rawJid.includes('@g.us') || rawJid === 'status@broadcast') continue;

        let effectiveJid = rawJid;
        if (key.remoteJidAlt && key.remoteJidAlt.includes('@s.whatsapp.net')) {
          effectiveJid = key.remoteJidAlt;
        } else if (rawJid.includes('@lid') && lidToPhoneMap.has(rawJid)) {
          effectiveJid = lidToPhoneMap.get(rawJid);
        }

        if (effectiveJid.includes('@g.us') || effectiveJid === 'status@broadcast') continue;

        // Se a mensagem veio do cliente e traz pushName legítimo, aprimora o nome do contato
        const pushFromMsg = (!key.fromMe && isValidClientName(record.pushName)) ? record.pushName.trim() : null;

        const messageId = key.id || record.id || `hist_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        const msgDate = record.messageTimestamp ? new Date(record.messageTimestamp * 1000) : new Date();
        const sessionId = await ensureSession(effectiveJid, pushFromMsg, msgDate);

        if (existingMsgSet.has(messageId)) continue; // Já gravada, pula com zero custo

        const parsed = this.extractMessageContent(record);
        if (!parsed) continue;

        messagesToInsert.push({
          sessionId,
          role: key.fromMe ? 'assistant' : 'user',
          content: parsed.content,
          mediaType: parsed.mediaType,
          mediaUrl: parsed.mediaUrl,
          messageId,
          msgDate
        });

        existingMsgSet.add(messageId);
      }

      // 11. Insere as novas mensagens em lotes eficientes (batches de 50)
      let importedMessagesCount = 0;
      const batchSize = 50;

      for (let i = 0; i < messagesToInsert.length; i += batchSize) {
        const chunk = messagesToInsert.slice(i, i + batchSize);
        const valueClauses = [];
        const params = [];
        let pIdx = 1;

        for (const item of chunk) {
          valueClauses.push(`($${pIdx}, $${pIdx+1}, $${pIdx+2}, $${pIdx+3}, $${pIdx+4}, $${pIdx+5}, $${pIdx+6}, $${pIdx+7})`);
          params.push(
            item.sessionId,
            tenantId,
            item.role,
            item.content,
            item.mediaType,
            item.mediaUrl,
            item.messageId,
            item.msgDate
          );
          pIdx += 8;
        }

        try {
          await query(
            `INSERT INTO chat_messages (session_id, tenant_id, role, content, media_type, media_url, message_id, created_at)
             VALUES ${valueClauses.join(', ')}
             ON CONFLICT DO NOTHING`,
            params
          );
          importedMessagesCount += chunk.length;
        } catch (batchErr) {
          console.warn(`[HistorySync] Erro no lote de inserção:`, batchErr.message);
        }
      }

      // 12. Atualiza timestamps de última interação e garante status manual e nomes corrigidos
      for (const [jid, sessionData] of sessionCache.entries()) {
        const updateNameClause = isValidClientName(sessionData.clientName) ? sessionData.clientName : null;
        await query(
          `UPDATE chat_sessions 
           SET last_interaction = $1, status_atendimento = 'manual', etapa_funil = 'manual', paused_until = $2,
               client_name = COALESCE($5, NULLIF(client_name, 'Você'), 'Cliente ' || RIGHT(remote_jid, 6))
           WHERE id = $3 AND tenant_id = $4`,
          [sessionData.lastInteraction, farFuture, sessionData.id, tenantId, updateNameClause]
        ).catch(() => {});
      }

      // Limpeza de qualquer 'Você' remanescente nas tabelas
      await query(
        `UPDATE chat_sessions 
         SET client_name = 'Cliente ' || RIGHT(remote_jid, 6)
         WHERE tenant_id = $1 AND (client_name = 'Você' OR client_name = 'voce' OR client_name IS NULL)`,
        [tenantId]
      ).catch(() => {});

      await query(
        `UPDATE customer_profiles 
         SET nome = 'Cliente ' || RIGHT(remote_jid, 6)
         WHERE tenant_id = $1 AND (nome = 'Você' OR nome = 'voce' OR nome IS NULL)`,
        [tenantId]
      ).catch(() => {});

      console.log(`[HistorySync] Concluído! ${sessionCache.size} conversas mapeadas, ${importedMessagesCount} novas mensagens importadas.`);

      const result = {
        success: true,
        instanceName,
        tenantId,
        modoAtendimento: 'manual',
        totalConversas: sessionCache.size,
        mensagensImportadas: importedMessagesCount,
        totalMensagensEvolution: totalMessagesFound
      };

      job.status = 'completed';
      job.finishedAt = new Date();
      job.result = result;

      return result;
    } catch (err) {
      console.error(`[HistorySync] Falha na sincronização (${tenantId}):`, err.message);
      job.status = 'error';
      job.finishedAt = new Date();
      job.error = err.message;
      throw err;
    }
  }

  /**
   * Sincroniza o histórico de todos os tenants ativos no sistema
   */
  async syncAllActiveTenants() {
    console.log('[HistorySync] Sincronizando histórico de todos os tenants com WhatsApp ativo...');
    const tenantsRes = await query(
      `SELECT t.id, t.nome_empresa, i.instance_name, i.status
       FROM tenants t
       JOIN tenant_whatsapp_instances i ON i.tenant_id = t.id
       WHERE t.ativo = true AND (i.status = 'open' OR i.status = 'connecting')`
    );

    const results = [];
    for (const row of tenantsRes.rows) {
      try {
        const res = await this.syncTenantHistory(row.id);
        results.push({ tenant: row.nome_empresa, ...res });
      } catch (e) {
        results.push({ tenant: row.nome_empresa, success: false, error: e.message });
      }
    }

    return results;
  }
}

module.exports = new HistorySyncService();
module.exports.HistorySyncService = HistorySyncService;
