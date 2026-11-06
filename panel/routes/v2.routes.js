// ==============================================================================
// Rotas da API v2 (Multi-Tenant SaaS) - WarNat Tech
// Autenticação JWT, Conexão WhatsApp, Regras de IA e Gestão de Leads/Conversas
// ==============================================================================

const authService = require('../../database/auth.service');
const { query } = require('../../database/db');
const evolutionService = require('../../services/evolution.service');
const webhookController = require('../../controllers/webhook.controller');

async function handleV2Routes(req, res, pathname, method, body) {
  const sendJson = (statusCode, data) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };

  try {
    // --------------------------------------------------------------------------
    // 1. AUTENTICAÇÃO PÚBLICA (LOGIN & AUTO-CADASTRO)
    // --------------------------------------------------------------------------
    if (pathname === '/api/v2/auth/register' && method === 'POST') {
      const { nome_empresa, documento, plano, nome, email, password, sobre_empresa } = body;
      if (!nome_empresa || !nome || !email || !password) {
        return sendJson(400, { success: false, error: 'Campos obrigatórios: nome_empresa, nome, email e password.' });
      }

      try {
        const result = await authService.registerTenantAndAdmin({
          nome_empresa,
          documento,
          plano,
          nome,
          email,
          password,
          sobre_empresa
        });
        return sendJson(201, {
          success: true,
          message: 'Empresa cadastrada com sucesso!',
          ...result
        });
      } catch (regErr) {
        return sendJson(400, { success: false, error: regErr.message });
      }
    }

    if (pathname === '/api/v2/auth/login' && method === 'POST') {
      const { email, password } = body;
      if (!email || !password) {
        return sendJson(400, { success: false, error: 'E-mail e senha são obrigatórios.' });
      }

      try {
        const result = await authService.login(email, password);
        return sendJson(200, {
          success: true,
          message: 'Autenticado com sucesso!',
          ...result
        });
      } catch (authErr) {
        return sendJson(401, { success: false, error: authErr.message });
      }
    }

    // --------------------------------------------------------------------------
    // MIDDLEWARE DE PROTEÇÃO JWT: Todas as demais rotas /api/v2/* exigem token
    // --------------------------------------------------------------------------
    const decodedUser = authService.authenticateRequest(req);
    if (!decodedUser) {
      return sendJson(401, { success: false, error: 'Acesso negado. Token JWT inválido ou expirado.' });
    }

    const tenantId = decodedUser.tenantId;

    // --------------------------------------------------------------------------
    // 2. CONTEXTO DO USUÁRIO ATUAL (/api/v2/auth/me)
    // --------------------------------------------------------------------------
    if (pathname === '/api/v2/auth/me' && method === 'GET') {
      const tenantRes = await query(`SELECT id, nome_empresa, plano, limite_conversas_mes FROM tenants WHERE id = $1`, [tenantId]);
      return sendJson(200, {
        success: true,
        user: decodedUser,
        tenant: tenantRes.rows[0] || null
      });
    }

    // --------------------------------------------------------------------------
    // 3. CONEXÃO WHATSAPP (STATUS E QR CODE COM POLLING)
    // --------------------------------------------------------------------------
    if (pathname === '/api/v2/whatsapp/status' && method === 'GET') {
      const instRes = await query(
        `SELECT id, instance_name, numero_telefone, status FROM tenant_whatsapp_instances WHERE tenant_id = $1 LIMIT 1`,
        [tenantId]
      );

      if (instRes.rowCount === 0) {
        return sendJson(200, {
          success: true,
          configured: false,
          status: 'disconnected',
          message: 'Nenhuma instância configurada para este tenant.'
        });
      }

      const instance = instRes.rows[0];
      let liveStatus = instance.status;

      try {
        const statusRes = await evolutionService.getInstanceStatus(instance.instance_name);
        liveStatus = statusRes.state === 'open' ? 'open' : statusRes.state === 'connecting' ? 'connecting' : 'disconnected';
        await query(`UPDATE tenant_whatsapp_instances SET status = $1 WHERE id = $2`, [liveStatus, instance.id]);
      } catch (e) {
        // Fallback para status salvo no banco se a Evolution API não responder
      }

      return sendJson(200, {
        success: true,
        configured: true,
        instanceName: instance.instance_name,
        numeroTelefone: instance.numero_telefone,
        status: liveStatus
      });
    }

    if (pathname === '/api/v2/whatsapp/qrcode' && method === 'GET') {
      const instRes = await query(
        `SELECT instance_name FROM tenant_whatsapp_instances WHERE tenant_id = $1 LIMIT 1`,
        [tenantId]
      );

      if (instRes.rowCount === 0) {
        return sendJson(404, { success: false, error: 'Instância não configurada para este tenant.' });
      }

      const instanceName = instRes.rows[0].instance_name;

      try {
        const qrData = await evolutionService.getQRCode(instanceName);
        return sendJson(200, {
          success: true,
          instanceName,
          qrcode: qrData.base64 || qrData.code,
          pairingCode: qrData.pairingCode
        });
      } catch (err) {
        return sendJson(500, { success: false, error: err.message });
      }
    }

    // --------------------------------------------------------------------------
    // 4. REGRAS DA IA (tenant_ai_configs)
    // --------------------------------------------------------------------------
    if (pathname === '/api/v2/tenant/ai-config' && method === 'GET') {
      const configRes = await query(`SELECT * FROM tenant_ai_configs WHERE tenant_id = $1`, [tenantId]);
      const tenantRes = await query(`SELECT nome_empresa, plano FROM tenants WHERE id = $1`, [tenantId]);

      return sendJson(200, {
        success: true,
        tenant: tenantRes.rows[0],
        config: configRes.rows[0] || null
      });
    }

    if (pathname === '/api/v2/tenant/ai-config' && method === 'PUT') {
      const {
        tom_de_voz,
        sobre_empresa,
        servicos_oferecidos,
        servicos_recusados,
        regras_agendamento,
        whatsapp_notificacao_humana,
        pausa_automatica_minutos
      } = body;

      await query(
        `INSERT INTO tenant_ai_configs (
           tenant_id, 
           tom_de_voz, 
           sobre_empresa, 
           servicos_oferecidos, 
           servicos_recusados, 
           regras_agendamento, 
           whatsapp_notificacao_humana, 
           pausa_automatica_minutos,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
         ON CONFLICT (tenant_id)
         DO UPDATE SET
           tom_de_voz = EXCLUDED.tom_de_voz,
           sobre_empresa = EXCLUDED.sobre_empresa,
           servicos_oferecidos = EXCLUDED.servicos_oferecidos,
           servicos_recusados = EXCLUDED.servicos_recusados,
           regras_agendamento = EXCLUDED.regras_agendamento,
           whatsapp_notificacao_humana = EXCLUDED.whatsapp_notificacao_humana,
           pausa_automatica_minutos = EXCLUDED.pausa_automatica_minutos,
           updated_at = now()`,
        [
          tenantId,
          tom_de_voz || 'profissional_humanizado',
          sobre_empresa || '',
          JSON.stringify(Array.isArray(servicos_oferecidos) ? servicos_oferecidos : []),
          servicos_recusados || '',
          JSON.stringify(typeof regras_agendamento === 'object' ? regras_agendamento : {}),
          whatsapp_notificacao_humana || null,
          parseInt(pausa_automatica_minutos, 10) || 45
        ]
      );

      return sendJson(200, {
        success: true,
        message: 'Configurações de IA salvas com sucesso!'
      });
    }

    // --------------------------------------------------------------------------
    // 5. LEADS E CONVERSAS (CRM MULTI-TENANT)
    // --------------------------------------------------------------------------
    if (pathname === '/api/v2/tenant/leads' && method === 'GET') {
      const leadsRes = await query(
        `SELECT 
           s.id, 
           s.remote_jid, 
           COALESCE(s.client_name, c.nome, s.dados_lead->>'nome', 'Cliente') as client_name, 
           s.status_atendimento, 
           s.paused_until, 
           s.dados_lead, 
           s.last_interaction, 
           COALESCE(s.created_at, s.last_interaction, now()) as created_at,
           CASE 
             WHEN s.paused_until IS NOT NULL AND s.paused_until > now() THEN true 
             ELSE false 
           END as is_paused
         FROM chat_sessions s
         LEFT JOIN customer_profiles c ON c.tenant_id = s.tenant_id AND c.remote_jid = s.remote_jid
         WHERE s.tenant_id = $1 
         ORDER BY s.last_interaction DESC`,
        [tenantId]
      );

      return sendJson(200, {
        success: true,
        leads: leadsRes.rows
      });
    }

    // Toggle de Pausa da IA (Zera paused_until ou ativa pausa humana imediata)
    if (pathname === '/api/v2/tenant/leads/toggle-ai' && method === 'POST') {
      const { sessionId, action } = body; // action: 'pause' ou 'resume'
      if (!sessionId) {
        return sendJson(400, { success: false, error: 'sessionId é obrigatório.' });
      }

      if (action === 'resume') {
        // Reativa a IA imediatamente: zera paused_until e seta ia_ativa
        await query(
          `UPDATE chat_sessions 
           SET status_atendimento = 'ia_ativa', paused_until = NULL, last_interaction = now()
           WHERE id = $1 AND tenant_id = $2`,
          [sessionId, tenantId]
        );
        return sendJson(200, {
          success: true,
          status: 'ia_ativa',
          message: 'IA reativada com sucesso! O assistente voltará a responder automaticamente.'
        });
      } else {
        // Pausa a IA para atendimento humano (45 minutos)
        const pausedUntil = new Date(Date.now() + 45 * 60 * 1000);
        await query(
          `UPDATE chat_sessions 
           SET status_atendimento = 'pausa_humana', paused_until = $1, last_interaction = now()
           WHERE id = $2 AND tenant_id = $3`,
          [pausedUntil, sessionId, tenantId]
        );
        return sendJson(200, {
          success: true,
          status: 'pausa_humana',
          pausedUntil,
          message: 'Atendimento manual ativado! A IA foi pausada para esta conversa.'
        });
      }
    }

    // Histórico de mensagens de uma conversa específica
    const messagesMatch = pathname.match(/^\/api\/v2\/tenant\/leads\/([^/]+)\/messages$/);
    if (messagesMatch && method === 'GET') {
      const sessionId = messagesMatch[1];
      const msgsRes = await query(
        `SELECT id, role, content, message_id, created_at 
         FROM chat_messages 
         WHERE session_id = $1 AND tenant_id = $2 
         ORDER BY created_at ASC`,
        [sessionId, tenantId]
      );

      return sendJson(200, {
        success: true,
        sessionId,
        messages: msgsRes.rows
      });
    }

    // --------------------------------------------------------------------------
    // 6. DOSSIÊ DE CLIENTES (MEMÓRIA CUMULATIVA DE LONGO PRAZO)
    // --------------------------------------------------------------------------
    if (pathname === '/api/v2/tenant/customers' && method === 'GET') {
      const custRes = await query(
        `SELECT c.id, c.tenant_id, c.remote_jid, c.nome, c.telefone, c.endereco_completo, c.perfil_resumo, c.metadados, c.created_at, c.updated_at,
           (SELECT json_agg(a.* ORDER BY a.data_agendada DESC) FROM appointments a WHERE a.customer_id = c.id) as agendamentos
         FROM customer_profiles c
         WHERE c.tenant_id = $1
         ORDER BY c.updated_at DESC`,
        [tenantId]
      );

      return sendJson(200, {
        success: true,
        customers: custRes.rows
      });
    }

    return false; // Rota v2 não correspondida
  } catch (err) {
    console.error('[API v2] Erro na rota:', pathname, err);
    return sendJson(500, { success: false, error: err.message });
  }
}

module.exports = { handleV2Routes };
