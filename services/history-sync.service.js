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

      // 13. Enriquece os leads automaticamente mapeando números reais e nomes da agenda
      let enrichedInfo = null;
      try {
        enrichedInfo = await this.enrichTenantConversations(tenantId);
      } catch (enrichErr) {
        console.warn(`[HistorySync] Aviso ao enriquecer leads pós-sincronização:`, enrichErr.message);
      }

      console.log(`[HistorySync] Concluído! ${sessionCache.size} conversas mapeadas, ${importedMessagesCount} novas mensagens importadas.`);

      const result = {
        success: true,
        instanceName,
        tenantId,
        modoAtendimento: 'manual',
        totalConversas: sessionCache.size,
        mensagensImportadas: importedMessagesCount,
        totalMensagensEvolution: totalMessagesFound,
        enriquecidos: enrichedInfo?.enriched || 0
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
   * Enriquece dados dos leads de um tenant:
   * - Mapeia telefones reais e nomes completos a partir da agenda do WhatsApp (findContacts)
   * - Extrai dados dos formulários de contrato/mensagens (nome completo, telefone, endereço, tipo de evento)
   * - Limpa referências inválidas de LID gravadas como telefone
   * - Atualiza chat_sessions e customer_profiles
   */
  async enrichTenantConversations(tenantId) {
    if (!tenantId) throw new Error('tenantId é obrigatório para enriquecimento de leads.');

    console.log(`[LeadEnrich] Iniciando enriquecimento inteligente de leads para tenant ${tenantId}...`);

    // 1. Limpa qualquer LID gravado erroneamente como telefone no banco
    await query(
      `UPDATE customer_profiles 
       SET telefone = NULL 
       WHERE tenant_id = $1 AND (telefone LIKE '%@lid%' OR LENGTH(REGEXP_REPLACE(telefone, '\\D', '', 'g')) >= 14)`,
      [tenantId]
    ).catch(() => {});

    // 2. Busca instância do WhatsApp
    const instRes = await query(
      `SELECT instance_name, numero_telefone 
       FROM tenant_whatsapp_instances 
       WHERE tenant_id = $1 LIMIT 1`,
      [tenantId]
    );

    const instanceName = instRes.rows[0]?.instance_name;
    const ownNumbers = new Set();
    if (instRes.rows[0]?.numero_telefone) {
      ownNumbers.add(instRes.rows[0].numero_telefone.replace(/\D/g, ''));
    }

    if (instanceName) {
      try {
        const instInfo = await evolutionService.fetchInstances();
        const myInst = Array.isArray(instInfo) ? instInfo.find(i => i.name === instanceName) : null;
        if (myInst?.ownerJid) {
          const ownerNum = myInst.ownerJid.replace(/@.*$/, '').replace(/\D/g, '');
          if (ownerNum) {
            ownNumbers.add(ownerNum);
            await query(
              `UPDATE tenant_whatsapp_instances SET numero_telefone = $1 WHERE tenant_id = $2 AND (numero_telefone IS NULL OR numero_telefone = '')`,
              [ownerNum, tenantId]
            ).catch(() => {});
          }
        }
      } catch (e) {}
    }

    // 3. Busca agenda de contatos da Evolution API se houver instância
    const phonebookByName = new Map();
    const phonebookByFirstName = new Map();

    if (instanceName) {
      try {
        const cRes = await evolutionService.findContacts(instanceName);
        const contacts = Array.isArray(cRes) ? cRes : (cRes?.contacts || []);
        for (const c of contacts) {
          const remoteJid = c.remoteJid || c.id || '';
          if (!remoteJid || remoteJid.includes('@g.us') || remoteJid.includes('@lid')) continue;

          const cleanPhone = remoteJid.replace(/@.*$/, '').replace(/\D/g, '');
          const rawName = (c.pushName || c.name || c.verifiedName || '').trim();

          if (rawName && cleanPhone && !ownNumbers.has(cleanPhone)) {
            const lower = rawName.toLowerCase();
            phonebookByName.set(lower, { phone: cleanPhone, name: rawName, pic: c.profilePicUrl || null });

            // Indexa por primeiro nome (apenas palavras com >= 3 caracteres e ignorando termos genéricos)
            const parts = lower.split(/\s+/).filter(p => p.length >= 3 && !['cerimonial', 'buffet', 'decor', 'festas', 'espaco', 'eventos'].includes(p));
            if (parts.length > 0) {
              const first = parts[0];
              if (!phonebookByFirstName.has(first)) {
                phonebookByFirstName.set(first, []);
              }
              phonebookByFirstName.get(first).push({ phone: cleanPhone, name: rawName, pic: c.profilePicUrl || null });
            }
          }
        }
        console.log(`[LeadEnrich] Agenda mapeada: ${phonebookByName.size} nomes e ${phonebookByFirstName.size} primeiros nomes indexados.`);
      } catch (err) {
        console.warn(`[LeadEnrich] Aviso ao buscar agenda de contatos:`, err.message);
      }
    }

    // 4. Busca todas as sessões do tenant
    const sessionsRes = await query(
      `SELECT s.id, s.remote_jid, s.client_name, s.dados_lead,
              c.nome as profile_nome, c.telefone as profile_telefone, c.endereco_completo as profile_endereco
       FROM chat_sessions s
       LEFT JOIN customer_profiles c ON c.tenant_id = s.tenant_id AND c.remote_jid = s.remote_jid
       WHERE s.tenant_id = $1`,
      [tenantId]
    );

    const sessions = sessionsRes.rows;
    if (sessions.length === 0) {
      return { success: true, enriched: 0, total: 0 };
    }

    // 5. Busca todas as mensagens do tenant agrupadas por session_id
    const msgsRes = await query(
      `SELECT session_id, role, content, media_type, created_at 
       FROM chat_messages 
       WHERE tenant_id = $1 
       ORDER BY session_id, created_at ASC`,
      [tenantId]
    );

    const msgsBySession = new Map();
    for (const m of msgsRes.rows) {
      if (!msgsBySession.has(m.session_id)) {
        msgsBySession.set(m.session_id, []);
      }
      msgsBySession.get(m.session_id).push(m);
    }

    let enrichedCount = 0;

    for (const s of sessions) {
      const isLid = s.remote_jid.includes('@lid');
      let currentData = typeof s.dados_lead === 'string' ? JSON.parse(s.dados_lead) : (s.dados_lead || {});
      const msgs = msgsBySession.get(s.id) || [];

      let extractedName = null;
      let extractedPhone = null;
      let extractedService = currentData.servico || null;
      let extractedAddress = currentData.bairro_cidade || s.profile_endereco || null;
      let extractedDate = currentData.data_evento || null;

      // Se o remote_jid for direto (@s.whatsapp.net), já temos o telefone real garantido!
      if (!isLid && s.remote_jid.includes('@s.whatsapp.net')) {
        extractedPhone = s.remote_jid.replace(/@.*$/, '').replace(/\D/g, '');
      }

      // Se já existia um telefone real salvo no profile ou dados_lead (não LID)
      if (!extractedPhone) {
        const cand = s.profile_telefone || currentData.telefone;
        if (cand && !cand.includes('@lid')) {
          const digits = cand.replace(/\D/g, '');
          if (digits.length >= 10 && digits.length <= 13 && digits !== ownNumber) {
            extractedPhone = digits;
          }
        }
      }

      // Varredura de mensagens
      for (const m of msgs) {
        const text = m.content || '';
        if (!text || text.length < 3) continue;

        // 1. Extração de Nome
        if (!extractedName) {
          // Nome em ficha/contrato
          const nMatch = text.match(/(?:Nome(?:\s+completo)?|Cliente|Contratante)\s*[:=-]\s*([A-Za-zÀ-ÿ\s]{3,40})/i);
          if (nMatch) {
            const cand = nMatch[1].trim();
            if (!['tudo bem', 'bom dia', 'boa tarde', 'boa noite'].includes(cand.toLowerCase())) {
              extractedName = cand;
            }
          }

          // Auto-apresentação: Sou a/o... / Me chamo...
          if (!extractedName) {
            const sMatch = text.match(/(?:Sou a|Sou o|Me chamo|Aqui é a|Aqui é o)\s+([A-Za-zÀ-ÿ]{3,25})/i);
            if (sMatch) extractedName = sMatch[1].trim();
          }

          // Saudação do operador: Oi, Maria! / Bom dia Luiza!
          if (!extractedName && m.role === 'assistant') {
            const saudMatch = text.match(/(?:Oi|Olá|Ola|Bom dia|Boa tarde|Boa noite)[,! ]+([A-ZÀ-ÿ][a-zà-ÿ]{2,20})(?:!|\?|\s+tudo bem|\s+como vai|\s+querida)/i);
            if (saudMatch) {
              const cand = saudMatch[1].trim();
              const candLower = cand.toLowerCase();
              const stopWords = ['tudo', 'como', 'amigo', 'amiga', 'cliente', 'voce', 'você', 'pessoal', 'querida', 'querido', 'linda', 'lindo', 'flor', 'meninas'];
              if (!stopWords.includes(candLower)) {
                extractedName = cand;
              }
            }
          }
        }

        // 2. Extração de Telefone (em mensagens de usuário ou campos de contrato)
        if (!extractedPhone && (m.role === 'user' || text.match(/(?:Telefone|Celular|Tel|Whats|Contato)\s*[:=-]/i))) {
          const pMatch = text.match(/(?:Telefone|Celular|Tel|Whats|Contato)?\s*(?:[:=-]\s*)?(?:\+?55\s?)?(?:\(?([1-9]{2})\)?\s?)?(?:9\s?[6-9]\d{3}[-\s]?\d{4}|[2-8]\d{3}[-\s]?\d{4})\b/i);
          if (pMatch && !text.toUpperCase().includes('CEP') && !text.includes('28351146242073')) {
            const digits = pMatch[0].replace(/\D/g, '');
            if (digits.length >= 8 && digits.length <= 13 && digits !== ownNumber) {
              extractedPhone = digits.startsWith('55') ? digits : (digits.length >= 10 ? `55${digits}` : digits);
            }
          }
        }

        // 3. Extração de Endereço / Local
        if (!extractedAddress) {
          const eMatch = text.match(/(?:Endereço(?:\s+completo)?|Local(?:\s+do\s+evento)?|Espaço)\s*[:=-]\s*([^\n\r]{8,90})/i);
          if (eMatch) {
            extractedAddress = eMatch[1].trim();
          } else {
            const ruaMatch = text.match(/(?:Rua|Avenida|Av\.|Alameda|Bairro)\s+[A-Za-zÀ-ÿ0-9\s,.-]{8,70}/i);
            if (ruaMatch) extractedAddress = ruaMatch[0].trim();
          }
        }

        // 4. Extração de Data do Evento
        if (!extractedDate) {
          const dMatch = text.match(/(?:Data(?:\s+do\s+evento)?|Dia(?:\s+da\s+festa)?)\s*[:=-]?\s*(\d{1,2}[\/\.-]\d{1,2}(?:[\/\.-]\d{2,4})?)/i);
          if (dMatch) extractedDate = dMatch[1].trim();
        }

        // 5. Extração de Serviços / Tipo de Festa
        if (!extractedService) {
          if (/lustre/i.test(text)) extractedService = 'Locação de Lustre';
          else if (/pergolado/i.test(text)) extractedService = 'Decoração de Pergolado';
          else if (/painel/i.test(text)) extractedService = 'Decoração com Painel';
          else if (/casamento/i.test(text)) extractedService = 'Decoração de Casamento';
          else if (/15 anos|debutante/i.test(text)) extractedService = 'Festa de 15 Anos';
          else if (/aniversário|aniversario|infantil/i.test(text)) extractedService = 'Aniversário Infantil';
          else if (/formatura|colação/i.test(text)) extractedService = 'Formatura / Evento';
          else if (/batizado/i.test(text)) extractedService = 'Decoração de Batizado';
          else if (/chá revelação|cha revelacao|chá de bebê/i.test(text)) extractedService = 'Chá Revelação / Bebê';
        }
      }

      // Cruzamento do Nome com a Agenda de Contatos da Evolution API
      const candidateNameForPhonebook = extractedName || (!s.client_name?.startsWith('Cliente ') && s.client_name !== 'Você' ? s.client_name : null);
      if (candidateNameForPhonebook) {
        const cleanCand = candidateNameForPhonebook.trim().toLowerCase();
        
        // Tentativa 1: Match exato de nome completo na agenda
        if (phonebookByName.has(cleanCand)) {
          const match = phonebookByName.get(cleanCand);
          extractedPhone = extractedPhone || match.phone;
          extractedName = match.name;
        } else {
          // Tentativa 2: Match por primeiro nome
          const firstPart = cleanCand.split(/\s+/)[0];
          if (firstPart.length >= 3 && phonebookByFirstName.has(firstPart)) {
            const matches = phonebookByFirstName.get(firstPart);
            if (matches.length === 1) {
              // Apenas 1 pessoa com esse primeiro nome na agenda -> match perfeito
              extractedPhone = extractedPhone || matches[0].phone;
              extractedName = matches[0].name;
            } else if (matches.length > 1) {
              // Se há mais de uma, verifica se alguma tem o sobrenome
              const fullMatch = matches.find(m => m.name.toLowerCase().includes(cleanCand) || cleanCand.includes(m.name.toLowerCase()));
              if (fullMatch) {
                extractedPhone = extractedPhone || fullMatch.phone;
                extractedName = fullMatch.name;
              } else {
                extractedPhone = extractedPhone || matches[0].phone;
                extractedName = matches[0].name;
              }
            }
          }
        }
      }

      // Define nome final limpo
      const stopWords = ['tudo', 'como', 'amigo', 'amiga', 'cliente', 'voce', 'você', 'pessoal', 'querida', 'querido', 'linda', 'lindo', 'flor', 'meninas', 'moça', 'moca', 'moço', 'moco', 'ola', 'olá', 'oi', 'bom dia', 'boa tarde', 'boa noite', 'sim', 'não', 'obrigado', 'obrigada'];

      let finalName = s.client_name;
      const isCurrentNameInvalid = !finalName || finalName === 'Você' || finalName.startsWith('Cliente ') || finalName.includes('@lid') || /^\d{6,}$/.test(finalName) || stopWords.includes(finalName.toLowerCase());

      if (extractedName && !stopWords.includes(extractedName.toLowerCase()) && !/^\d+$/.test(extractedName)) {
        finalName = extractedName;
      } else if (isCurrentNameInvalid) {
        finalName = `Cliente (${s.remote_jid.replace(/@.*$/, '').slice(-6)})`;
      }

      // Normaliza telefone real final (garante que nunca seja LID nem telefone próprio da empresa)
      let finalPhone = extractedPhone || null;
      if (finalPhone) {
        finalPhone = finalPhone.replace(/\D/g, '');
        if (finalPhone.length >= 14 || finalPhone.startsWith('28351') || ownNumbers.has(finalPhone) || ownNumbers.has(finalPhone.slice(2))) {
          finalPhone = null;
        }
      }

      // Atualiza dados_lead do chat_sessions
      const updatedLeadData = {
        ...currentData,
        nome: finalName,
        telefone: finalPhone,
        servico: extractedService || currentData.servico || 'Decoração de Festas & Eventos',
        bairro_cidade: extractedAddress || currentData.bairro_cidade || null,
        data_evento: extractedDate || currentData.data_evento || null,
        is_lid: isLid
      };

      // Atualiza chat_sessions
      await query(
        `UPDATE chat_sessions 
         SET client_name = $1, dados_lead = $2
         WHERE id = $3 AND tenant_id = $4`,
        [finalName, JSON.stringify(updatedLeadData), s.id, tenantId]
      ).catch(() => {});

      // Atualiza customer_profiles
      await query(
        `INSERT INTO customer_profiles (tenant_id, remote_jid, nome, telefone, endereco_completo, metadados)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, remote_jid)
         DO UPDATE SET
           nome = COALESCE(NULLIF(customer_profiles.nome, 'Você'), EXCLUDED.nome),
           telefone = COALESCE(EXCLUDED.telefone, NULLIF(customer_profiles.telefone, '')) ,
           endereco_completo = COALESCE(EXCLUDED.endereco_completo, customer_profiles.endereco_completo),
           metadados = customer_profiles.metadados || EXCLUDED.metadados,
           updated_at = now()`,
        [
          tenantId,
          s.remote_jid,
          finalName,
          finalPhone,
          extractedAddress || null,
          JSON.stringify({ servico: updatedLeadData.servico, data_evento: updatedLeadData.data_evento })
        ]
      ).catch(() => {});

      if (extractedName || finalPhone || extractedAddress || extractedService) {
        enrichedCount++;
      }
    }

    console.log(`[LeadEnrich] Concluído! ${enrichedCount} de ${sessions.length} leads enriquecidos com sucesso.`);
    return {
      success: true,
      total: sessions.length,
      enriched: enrichedCount
    };
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
