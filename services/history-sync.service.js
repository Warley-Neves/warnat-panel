// ==============================================================================
// History Sync Service - Sincronização Completa do Histórico do WhatsApp
// Carrega conversas e mensagens históricas da Evolution API para o PostgreSQL
// Modo 100% manual e proteção anti-disparo automatizado
// ==============================================================================

const { query, getClient } = require('../database/db');
const evolutionService = require('./evolution.service');

class HistorySyncService {
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

    console.log(`[HistorySync] Iniciando sincronização completa de histórico para tenant ${tenantId}...`);

    // 1. Busca a instância conectada deste tenant
    const instRes = await query(
      `SELECT instance_name, status, numero_telefone 
       FROM tenant_whatsapp_instances 
       WHERE tenant_id = $1 LIMIT 1`,
      [tenantId]
    );

    if (instRes.rowCount === 0 || !instRes.rows[0].instance_name) {
      return {
        success: false,
        error: 'Nenhuma instância WhatsApp configurada para esta empresa.'
      };
    }

    const instanceName = instRes.rows[0].instance_name;

    // 2. Garante modo 100% manual e desativa qualquer resposta de automação
    await query(
      `UPDATE tenant_ai_configs 
       SET modo_atendimento = 'manual', updated_at = now() 
       WHERE tenant_id = $1`,
      [tenantId]
    ).catch(() => {});

    // 3. Ativa syncFullHistory na Evolution API para persistir dados continuamente
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

    // 4. Busca todos os contatos salvos no WhatsApp para associar nomes corretos aos números
    const contactMap = new Map(); // phone/jid -> { pushName, profilePicUrl }
    try {
      const contacts = await evolutionService.findContacts(instanceName);
      if (Array.isArray(contacts)) {
        for (const c of contacts) {
          if (!c.remoteJid || c.remoteJid.includes('@g.us')) continue;
          const cleanPhone = c.remoteJid.replace(/@.*$/, '').replace(/\D/g, '');
          const info = {
            pushName: (c.pushName || '').trim() || null,
            profilePicUrl: c.profilePicUrl || null
          };
          contactMap.set(c.remoteJid, info);
          if (cleanPhone) contactMap.set(cleanPhone, info);
        }
      }
      console.log(`[HistorySync] ${contactMap.size} contatos mapeados para ${instanceName}.`);
    } catch (cErr) {
      console.warn(`[HistorySync] Aviso ao buscar contatos de ${instanceName}:`, cErr.message);
    }

    // 5. Busca lista de chats para mapear LIDs e última atividade
    const lidToPhoneMap = new Map(); // '@lid' -> '@s.whatsapp.net'
    const chatSummaryMap = new Map(); // effectiveJid -> { updatedAt, pushName, unreadCount }

    try {
      const chats = await evolutionService.findChats(instanceName);
      if (Array.isArray(chats)) {
        for (const ch of chats) {
          const rawJid = ch.remoteJid || ch.id;
          if (!rawJid || rawJid.includes('@g.us') || rawJid === 'status@broadcast') continue;

          // Se tiver remoteJidAlt com @s.whatsapp.net, registra o mapeamento
          const altJid = ch.lastMessage?.key?.remoteJidAlt;
          if (rawJid.includes('@lid') && altJid && altJid.includes('@s.whatsapp.net')) {
            lidToPhoneMap.set(rawJid, altJid);
          }

          const effectiveJid = (rawJid.includes('@lid') && altJid) ? altJid : rawJid;
          chatSummaryMap.set(effectiveJid, {
            rawJid,
            updatedAt: ch.updatedAt ? new Date(ch.updatedAt) : new Date(),
            pushName: ch.pushName || ch.lastMessage?.pushName || null,
            unreadCount: ch.unreadCount || 0
          });
        }
      }
      console.log(`[HistorySync] ${chatSummaryMap.size} conversas identificadas em ${instanceName}.`);
    } catch (chErr) {
      console.warn(`[HistorySync] Aviso ao buscar chats de ${instanceName}:`, chErr.message);
    }

    // 6. Busca todas as mensagens paginadas da Evolution API
    let page = 1;
    let totalMessagesFound = 0;
    let importedMessagesCount = 0;
    const maxPages = options.limitPages || 35; // Até 3.500 mensagens
    const allRecords = [];

    while (page <= maxPages) {
      try {
        const msgRes = await evolutionService.findMessages(instanceName, { page, limit: 100 });
        const records = msgRes.messages?.records || msgRes.records || [];
        const total = msgRes.messages?.total || 0;
        const totalPages = msgRes.messages?.pages || Math.ceil(total / 100) || 1;

        totalMessagesFound = total || (totalMessagesFound + records.length);

        if (records.length === 0) break;

        for (const r of records) {
          allRecords.push(r);

          // Alimenta mapa de LIDs conforme encontra nas mensagens
          const rJid = r.key?.remoteJid;
          const altJid = r.key?.remoteJidAlt;
          if (rJid && rJid.includes('@lid') && altJid && altJid.includes('@s.whatsapp.net')) {
            lidToPhoneMap.set(rJid, altJid);
          }
        }

        if (page >= totalPages) break;
        page++;
      } catch (pageErr) {
        console.warn(`[HistorySync] Erro ao buscar página ${page} de mensagens:`, pageErr.message);
        break;
      }
    }

    console.log(`[HistorySync] Total de ${allRecords.length} mensagens recuperadas da Evolution API. Processando importação...`);

    // 7. Ordena mensagens cronologicamente (ASC) para preservar o fluxo temporal exato
    allRecords.sort((a, b) => {
      const tsA = a.messageTimestamp || 0;
      const tsB = b.messageTimestamp || 0;
      return tsA - tsB;
    });

    // 8. Cache de sessões criadas ou encontradas nesta sincronização
    // Key: effectiveJid -> { sessionId, lastInteraction }
    const sessionCache = new Map();

    // Carrega sessões já existentes no banco para este tenant
    const existingSessions = await query(
      `SELECT id, remote_jid, last_interaction, client_name 
       FROM chat_sessions 
       WHERE tenant_id = $1`,
      [tenantId]
    );
    for (const s of existingSessions.rows) {
      sessionCache.set(s.remote_jid, {
        id: s.id,
        lastInteraction: s.last_interaction ? new Date(s.last_interaction) : new Date(0),
        clientName: s.client_name
      });
    }

    // Função auxiliar para obter ou criar sessão de atendimento
    const getOrCreateSession = async (effectiveJid, pushNameFromMsg, msgTimestamp) => {
      if (sessionCache.has(effectiveJid)) {
        const cached = sessionCache.get(effectiveJid);
        if (msgTimestamp > cached.lastInteraction) {
          cached.lastInteraction = msgTimestamp;
        }
        return cached.id;
      }

      const cleanPhone = effectiveJid.replace(/@.*$/, '').replace(/\D/g, '');
      const contactInfo = contactMap.get(effectiveJid) || contactMap.get(cleanPhone);
      const chatInfo = chatSummaryMap.get(effectiveJid);

      const resolvedName = (
        pushNameFromMsg ||
        contactInfo?.pushName ||
        chatInfo?.pushName ||
        (cleanPhone ? `+${cleanPhone}` : 'Cliente')
      ).trim();

      // Upsert permanente em customer_profiles
      await query(
        `INSERT INTO customer_profiles (tenant_id, remote_jid, nome, telefone)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, remote_jid)
         DO UPDATE SET nome = COALESCE(customer_profiles.nome, EXCLUDED.nome), updated_at = now()`,
        [tenantId, effectiveJid, resolvedName, cleanPhone]
      ).catch(() => {});

      // Upsert em chat_sessions com modo 100% manual e pausa permanente de IA
      const farFuture = new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000); // 100 anos no futuro
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
           client_name = COALESCE(chat_sessions.client_name, EXCLUDED.client_name),
           status_atendimento = 'manual',
           etapa_funil = 'manual',
           paused_until = $4,
           last_interaction = GREATEST(chat_sessions.last_interaction, EXCLUDED.last_interaction)
         RETURNING id`,
        [tenantId, effectiveJid, resolvedName, farFuture, JSON.stringify(leadData), msgTimestamp]
      );

      const sessionId = sessRes.rows[0].id;
      sessionCache.set(effectiveJid, {
        id: sessionId,
        lastInteraction: msgTimestamp,
        clientName: resolvedName
      });
      return sessionId;
    };

    // 9. Itera sobre todas as mensagens e persiste no banco
    for (const record of allRecords) {
      const key = record.key || {};
      const rawJid = key.remoteJid;
      if (!rawJid || rawJid.includes('@g.us') || rawJid === 'status@broadcast') continue;

      // Resolve o JID efetivo (trocando LID pelo número WhatsApp real)
      let effectiveJid = rawJid;
      if (key.remoteJidAlt && key.remoteJidAlt.includes('@s.whatsapp.net')) {
        effectiveJid = key.remoteJidAlt;
      } else if (rawJid.includes('@lid') && lidToPhoneMap.has(rawJid)) {
        effectiveJid = lidToPhoneMap.get(rawJid);
      }

      if (effectiveJid.includes('@g.us') || effectiveJid === 'status@broadcast') continue;

      const parsed = this.extractMessageContent(record);
      if (!parsed) continue;

      const messageId = key.id || record.id || `hist_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      const fromMe = !!key.fromMe;
      const role = fromMe ? 'assistant' : 'user';
      const msgDate = record.messageTimestamp ? new Date(record.messageTimestamp * 1000) : new Date();

      try {
        const sessionId = await getOrCreateSession(effectiveJid, record.pushName, msgDate);

        // Insere a mensagem apenas se ela ainda não existir no histórico do banco
        const insertRes = await query(
          `INSERT INTO chat_messages (session_id, tenant_id, role, content, media_type, media_url, message_id, created_at)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8
           WHERE NOT EXISTS (
             SELECT 1 FROM chat_messages WHERE tenant_id = $2 AND message_id = $7
           )`,
          [sessionId, tenantId, role, parsed.content, parsed.mediaType, parsed.mediaUrl, messageId, msgDate]
        );

        if (insertRes.rowCount > 0) {
          importedMessagesCount++;
        }
      } catch (msgErr) {
        console.warn(`[HistorySync] Aviso ao importar mensagem ${messageId}:`, msgErr.message);
      }
    }

    // 10. Atualiza os timestamps de última interação de todas as sessões sincronizadas
    for (const [jid, sessionData] of sessionCache.entries()) {
      await query(
        `UPDATE chat_sessions 
         SET last_interaction = $1, status_atendimento = 'manual'
         WHERE id = $2 AND tenant_id = $3`,
        [sessionData.lastInteraction, sessionData.id, tenantId]
      ).catch(() => {});
    }

    // 11. Para chats identificados que eventualmente não tiveram mensagens nas páginas buscadas, garante a sessão criada
    let emptyChatsCreated = 0;
    for (const [effectiveJid, chatData] of chatSummaryMap.entries()) {
      if (!sessionCache.has(effectiveJid)) {
        try {
          await getOrCreateSession(effectiveJid, chatData.pushName, chatData.updatedAt);
          emptyChatsCreated++;
        } catch (e) {}
      }
    }

    console.log(`[HistorySync] Concluído para ${instanceName}! ${sessionCache.size} conversas ativas, ${importedMessagesCount} mensagens importadas.`);

    return {
      success: true,
      instanceName,
      tenantId,
      modoAtendimento: 'manual',
      totalConversas: sessionCache.size,
      mensagensImportadas: importedMessagesCount,
      totalMensagensEvolution: totalMessagesFound,
      novosChatsSemMensagem: emptyChatsCreated
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
