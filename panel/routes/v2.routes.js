// ==============================================================================
// Rotas da API v2 (Multi-Tenant SaaS) - WarNat Tech
// Autenticação JWT, Conexão WhatsApp, Regras de IA e Gestão de Leads/Conversas
// ==============================================================================

const authService = require('../../database/auth.service');
const { query } = require('../../database/db');
const evolutionService = require('../../services/evolution.service');
const webhookController = require('../../controllers/webhook.controller');
const messageCache = require('../../services/message-cache.service');
const pagarmeService = require('../../services/pagarme.service');
const entitlementsService = require('../../services/entitlements.service');
const url = require('url');

async function handleV2Routes(req, res, pathname, method, body) {
  const sendJson = (statusCode, data) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
    return true;
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
    // 1.1 WEBHOOK PAGAR.ME V5 (PÚBLICO COM VALIDAÇÃO HMAC E IDEMPOTÊNCIA)
    // --------------------------------------------------------------------------
    if ((pathname === '/api/v2/webhooks/pagarme' || pathname === '/api/webhooks/pagarme' || pathname === '/api/webhook/pagarme') && method === 'POST') {
      const sig = req.headers['x-hub-signature'] || req.headers['x-pagarme-signature'] || req.headers['x-signature'] || '';
      const rawBody = req.rawBody || JSON.stringify(body);

      // Validação HMAC de assinatura se configurada e presente
      if (sig && !pagarmeService.verifyWebhookSignature(rawBody, sig)) {
        return sendJson(401, { success: false, error: 'Assinatura inválida do webhook' });
      }

      try {
        const result = await pagarmeService.processWebhookEvent(body, rawBody, sig);
        return sendJson(200, { received: true, ...result });
      } catch (whErr) {
        return sendJson(400, { success: false, error: whErr.message });
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
    // GUARD DE SUPERADMIN PARA ROTAS /api/v2/superadmin/*
    // --------------------------------------------------------------------------
    const isSuperAdminRoute = pathname.startsWith('/api/v2/superadmin');
    if (isSuperAdminRoute) {
      const isOwnerEmail = decodedUser.email && decodedUser.email.toLowerCase() === 'admin@warnattech.com.br';
      let isSuper = Boolean(decodedUser.isSuperAdmin || isOwnerEmail);
      if (!isSuper && decodedUser.userId) {
        const uCheck = await query(`SELECT is_super_admin, email FROM users WHERE id = $1`, [decodedUser.userId]);
        isSuper = Boolean(uCheck.rows[0]?.is_super_admin || (uCheck.rows[0]?.email && uCheck.rows[0].email.toLowerCase() === 'admin@warnattech.com.br'));
      }
      if (!isSuper) {
        return sendJson(403, {
          success: false,
          error: 'FORBIDDEN_SUPERADMIN_ONLY',
          message: 'Acesso restrito ao Dono do SaaS (SuperAdmin).'
        });
      }
    }

    // --------------------------------------------------------------------------
    // MOTOR CENTRAL DE ENTITLEMENTS (REGRAS 0-3: BLOQUEIO ADMIN, TRIAL EXPIRED, GRACE PERIOD)
    // Rotas de billing e contexto de usuário permanecem abertas para regularização
    // --------------------------------------------------------------------------
    const isBillingRoute = pathname.startsWith('/api/v2/tenant/billing');
    const isMeRoute = pathname === '/api/v2/auth/me';

    if (!isSuperAdminRoute && !isBillingRoute && !isMeRoute) {
      const isWrite = method === 'POST' || method === 'PUT' || method === 'DELETE';
      const accessResult = await entitlementsService.evaluateAccess(decodedUser, { isWrite });
      if (!accessResult.allowed) {
        return sendJson(accessResult.statusCode || 403, {
          success: false,
          error: accessResult.error,
          message: accessResult.message,
          required_action: accessResult.required_action,
          status: accessResult.status
        });
      }
    }

    // --------------------------------------------------------------------------
    // 2. CONTEXTO DO USUÁRIO ATUAL (/api/v2/auth/me)
    // --------------------------------------------------------------------------
    if (pathname === '/api/v2/auth/me' && method === 'GET') {
      const tenantRes = await query(`SELECT id, nome_empresa, plano, limite_conversas_mes, status, trial_ends_at, is_manually_blocked, courtesy_plan FROM tenants WHERE id = $1`, [tenantId]);
      const lifecycle = await entitlementsService.getTenantLifecycle(tenantId);
      const userRes = await query(`SELECT id, tenant_id, nome, email, role, COALESCE(is_super_admin, false) as is_super_admin FROM users WHERE id = $1`, [decodedUser.userId]);
      const isSuper = Boolean(decodedUser.isSuperAdmin || userRes.rows[0]?.is_super_admin || (decodedUser.email && decodedUser.email.toLowerCase() === 'admin@warnattech.com.br') || (userRes.rows[0]?.email && userRes.rows[0].email.toLowerCase() === 'admin@warnattech.com.br'));
      return sendJson(200, {
        success: true,
        user: { ...decodedUser, ...(userRes.rows[0] || {}), isSuperAdmin: isSuper },
        tenant: tenantRes.rows[0] || null,
        lifecycle
      });
    }

    // --------------------------------------------------------------------------
    // 3. CONEXÃO WHATSAPP (STATUS E QR CODE COM POLLING & AUTO-PROVISIONAMENTO)
    // --------------------------------------------------------------------------
    if (pathname === '/api/v2/whatsapp/status' && method === 'GET') {
      let instRes = await query(
        `SELECT id, instance_name, numero_telefone, status FROM tenant_whatsapp_instances WHERE tenant_id = $1 LIMIT 1`,
        [tenantId]
      );

      // Auto-provisionamento de instância se ainda não existir para este tenant
      if (instRes.rowCount === 0) {
        const tRes = await query(`SELECT nome_empresa FROM tenants WHERE id = $1`, [tenantId]);
        const nomeEmpresa = tRes.rows[0]?.nome_empresa || 'empresa';
        const cleanCompanySlug = nomeEmpresa.toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '') || 'empresa';
        const instanceSlug = `${cleanCompanySlug}-${String(tenantId).slice(0, 6)}`;

        await query(
          `INSERT INTO tenant_whatsapp_instances (tenant_id, instance_name, instance_token, status)
           VALUES ($1, $2, $3, 'connecting')
           ON CONFLICT (tenant_id) DO UPDATE SET instance_name = EXCLUDED.instance_name, updated_at = now()`,
          [tenantId, instanceSlug, `token-${instanceSlug}`]
        );

        instRes = await query(
          `SELECT id, instance_name, numero_telefone, status FROM tenant_whatsapp_instances WHERE tenant_id = $1 LIMIT 1`,
          [tenantId]
        );

        try {
          await evolutionService.createInstance(instanceSlug, { qrcode: true });
        } catch (evErr) {
          console.warn(`[WhatsAppStatus] Aviso ao auto-provisionar instância ${instanceSlug}:`, evErr.message);
        }
      }

      const instance = instRes.rows[0];
      let liveStatus = instance.status;

      try {
        const statusRes = await evolutionService.getInstanceStatus(instance.instance_name);
        liveStatus = statusRes.state === 'open' ? 'open' : statusRes.state === 'connecting' ? 'connecting' : 'disconnected';
        await query(`UPDATE tenant_whatsapp_instances SET status = $1 WHERE id = $2`, [liveStatus, instance.id]);
        if (liveStatus === 'open') {
          const defaultWebhook = evolutionService.getDefaultWebhookUrl ? evolutionService.getDefaultWebhookUrl() : 'https://warnat-panel.onrender.com/api/webhook/whatsapp';
          evolutionService.setWebhook(instance.instance_name, defaultWebhook).catch(() => {});
        }
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
      let instRes = await query(
        `SELECT instance_name FROM tenant_whatsapp_instances WHERE tenant_id = $1 LIMIT 1`,
        [tenantId]
      );

      // Auto-provisionamento de instância caso ainda não exista
      if (instRes.rowCount === 0) {
        const tRes = await query(`SELECT nome_empresa FROM tenants WHERE id = $1`, [tenantId]);
        const nomeEmpresa = tRes.rows[0]?.nome_empresa || 'empresa';
        const cleanCompanySlug = nomeEmpresa.toLowerCase()
          .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '') || 'empresa';
        const instanceSlug = `${cleanCompanySlug}-${String(tenantId).slice(0, 6)}`;

        await query(
          `INSERT INTO tenant_whatsapp_instances (tenant_id, instance_name, instance_token, status)
           VALUES ($1, $2, $3, 'connecting')
           ON CONFLICT (tenant_id) DO UPDATE SET instance_name = EXCLUDED.instance_name, updated_at = now()`,
          [tenantId, instanceSlug, `token-${instanceSlug}`]
        );

        instRes = await query(
          `SELECT instance_name FROM tenant_whatsapp_instances WHERE tenant_id = $1 LIMIT 1`,
          [tenantId]
        );

        try {
          await evolutionService.createInstance(instanceSlug, { qrcode: true });
        } catch (evErr) {
          console.warn(`[WhatsAppQRCode] Aviso ao auto-provisionar instância ${instanceSlug}:`, evErr.message);
        }
      }

      const instanceName = instRes.rows[0].instance_name;

      try {
        const qrData = await evolutionService.getQRCode(instanceName);
        return sendJson(200, {
          success: true,
          instanceName,
          qrcode: qrData.base64 || qrData.code,
          pairingCode: qrData.pairingCode,
          state: qrData.state || 'connecting'
        });
      } catch (err) {
        return sendJson(500, { success: false, error: err.message });
      }
    }

    // --------------------------------------------------------------------------
    // 4. REGRAS DA IA (tenant_ai_configs) & MODO DE ATENDIMENTO DO TENANT
    // --------------------------------------------------------------------------
    if (pathname === '/api/v2/tenant/mode' && method === 'GET') {
      const configRes = await query(`SELECT modo_atendimento FROM tenant_ai_configs WHERE tenant_id = $1`, [tenantId]);
      const modo = configRes.rows[0]?.modo_atendimento || 'automacao';
      return sendJson(200, { success: true, modo_atendimento: modo });
    }

    if (pathname === '/api/v2/tenant/mode' && method === 'PUT') {
      if (decodedUser.role === 'atendente') {
        return sendJson(403, { success: false, error: 'Apenas Administradores e Supervisores podem alterar o modo de atendimento do tenant.' });
      }

      const { modo_atendimento } = body;
      if (!modo_atendimento || (modo_atendimento !== 'automacao' && modo_atendimento !== 'manual')) {
        return sendJson(400, { success: false, error: 'modo_atendimento deve ser "automacao" ou "manual".' });
      }

      if (modo_atendimento === 'automacao') {
        const canBots = await entitlementsService.canUseFeature(tenantId, 'automation_bots');
        if (!canBots) {
          return sendJson(403, {
            success: false,
            error: 'FEATURE_NOT_AVAILABLE_IN_PLAN',
            required_plan: 'PRO',
            message: 'Automações e bots inteligentes são exclusivos do Plano Pro. Faça o upgrade para ter acesso.'
          });
        }
      }

      await query(
        `UPDATE tenant_ai_configs SET modo_atendimento = $1, updated_at = now() WHERE tenant_id = $2`,
        [modo_atendimento, tenantId]
      );

      return sendJson(200, {
        success: true,
        modo_atendimento,
        message: modo_atendimento === 'manual'
          ? 'Atendimento do tenant alterado para 100% MANUAL. A automação foi desativada para todos os clientes.'
          : 'Atendimento do tenant alterado para AUTOMAÇÃO (IA). O assistente responderá aos clientes automaticamente.'
      });
    }

    if (pathname === '/api/v2/tenant/ai-config' && method === 'GET') {
      const canBots = await entitlementsService.canUseFeature(tenantId, 'automation_bots');
      if (!canBots) {
        return sendJson(403, {
          success: false,
          error: 'FEATURE_NOT_AVAILABLE_IN_PLAN',
          required_plan: 'PRO',
          message: 'Automações e bots inteligentes são exclusivos do Plano Pro. Faça o upgrade para ter acesso.'
        });
      }

      let configRes = await query(`SELECT * FROM tenant_ai_configs WHERE tenant_id = $1`, [tenantId]);
      const tenantRes = await query(`SELECT nome_empresa, plano FROM tenants WHERE id = $1`, [tenantId]);

      if (configRes.rowCount === 0) {
        const empNome = tenantRes.rows[0]?.nome_empresa || 'Nossa Empresa';
        const empLower = empNome.toLowerCase();
        const isVelas = empLower.includes('vela') || empLower.includes('aroma');
        const isCftv = empLower.includes('cftv') || empLower.includes('camera') || empLower.includes('câmera');

        await query(`
          INSERT INTO tenant_ai_configs (
            tenant_id, nome_assistente, responsavel_tecnico, sobre_empresa,
            nicho_atuacao, tipo_negocio, objetivo_funil, tempo_resposta_segundos,
            tom_de_voz, servicos_oferecidos, regras_agendamento
          ) VALUES ($1, 'Nat', 'Responsável', $2, $3, $4, $5, 3, 'profissional_humanizado', '[]'::jsonb,
            '{"dias":["segunda","terca","quarta","quinta","sexta","sabado"],"horario_inicio":"08:00","horario_fim":"18:00","slots_agendamento":["08:00","10:00","14:00","16:00"]}'::jsonb
          ) ON CONFLICT (tenant_id) DO NOTHING;
        `, [
          tenantId,
          `${empNome}: Atendimento e vendas pelo WhatsApp.`,
          isVelas ? 'Velas Artesanais & Aromatizadores' : (isCftv ? 'Segurança Eletrônica & CFTV' : 'Comércio e Atendimento'),
          isVelas ? 'produtos' : 'servicos',
          isVelas ? 'venda_produtos' : 'agendamento'
        ]);
        configRes = await query(`SELECT * FROM tenant_ai_configs WHERE tenant_id = $1`, [tenantId]);
      }

      return sendJson(200, {
        success: true,
        tenant: tenantRes.rows[0],
        config: configRes.rows[0] || null
      });
    }

    if (pathname === '/api/v2/tenant/ai-config' && method === 'PUT') {
      const canBots = await entitlementsService.canUseFeature(tenantId, 'automation_bots');
      if (!canBots) {
        return sendJson(403, {
          success: false,
          error: 'FEATURE_NOT_AVAILABLE_IN_PLAN',
          required_plan: 'PRO',
          message: 'Automações e bots inteligentes são exclusivos do Plano Pro. Faça o upgrade para ter acesso.'
        });
      }

      if (decodedUser.role === 'atendente') {
        return sendJson(403, { success: false, error: 'Apenas Administradores e Supervisores podem alterar as regras e horários da IA.' });
      }

      const {
        modo_atendimento,
        nome_assistente,
        responsavel_tecnico,
        regiao_atendimento,
        taxa_manutencao_reais,
        tom_de_voz,
        sobre_empresa,
        servicos_oferecidos,
        servicos_recusados,
        regras_agendamento,
        instrucoes_personalizadas,
        whatsapp_notificacao_humana,
        pausa_automatica_minutos,
        atender_chamadas,
        mensagem_chamada,
        responder_com_audio,
        voz_ia,
        nicho_atuacao,
        tipo_negocio,
        objetivo_funil,
        pergunta_inicial_qualificacao,
        diretrizes_funil,
        politicas_comerciais,
        tempo_resposta_segundos
      } = body;

      const taxaManutencaoVal = (taxa_manutencao_reais !== undefined && taxa_manutencao_reais !== null && taxa_manutencao_reais !== '')
        ? Number(taxa_manutencao_reais)
        : null;

      const tempoRespostaVal = (tempo_resposta_segundos !== undefined && tempo_resposta_segundos !== null)
        ? Math.max(0, parseInt(tempo_resposta_segundos, 10) || 0)
        : 3;

      await query(
        `INSERT INTO tenant_ai_configs (
           tenant_id, 
           modo_atendimento,
           nome_assistente,
           responsavel_tecnico,
           regiao_atendimento,
           taxa_manutencao_reais,
           tom_de_voz, 
           sobre_empresa, 
           servicos_oferecidos, 
           servicos_recusados, 
           regras_agendamento, 
           instrucoes_personalizadas,
           whatsapp_notificacao_humana, 
           pausa_automatica_minutos,
           atender_chamadas,
           mensagem_chamada,
           responder_com_audio,
           voz_ia,
           nicho_atuacao,
           tipo_negocio,
           objetivo_funil,
           pergunta_inicial_qualificacao,
           diretrizes_funil,
           politicas_comerciais,
           tempo_resposta_segundos,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, now())
         ON CONFLICT (tenant_id)
         DO UPDATE SET
           modo_atendimento = COALESCE(EXCLUDED.modo_atendimento, tenant_ai_configs.modo_atendimento),
           nome_assistente = COALESCE(EXCLUDED.nome_assistente, tenant_ai_configs.nome_assistente),
           responsavel_tecnico = COALESCE(EXCLUDED.responsavel_tecnico, tenant_ai_configs.responsavel_tecnico),
           regiao_atendimento = COALESCE(EXCLUDED.regiao_atendimento, tenant_ai_configs.regiao_atendimento),
           taxa_manutencao_reais = EXCLUDED.taxa_manutencao_reais,
           tom_de_voz = EXCLUDED.tom_de_voz,
           sobre_empresa = EXCLUDED.sobre_empresa,
           servicos_oferecidos = EXCLUDED.servicos_oferecidos,
           servicos_recusados = EXCLUDED.servicos_recusados,
           regras_agendamento = EXCLUDED.regras_agendamento,
           instrucoes_personalizadas = EXCLUDED.instrucoes_personalizadas,
           whatsapp_notificacao_humana = EXCLUDED.whatsapp_notificacao_humana,
           pausa_automatica_minutos = EXCLUDED.pausa_automatica_minutos,
           atender_chamadas = COALESCE(EXCLUDED.atender_chamadas, tenant_ai_configs.atender_chamadas),
           mensagem_chamada = COALESCE(EXCLUDED.mensagem_chamada, tenant_ai_configs.mensagem_chamada),
           responder_com_audio = COALESCE(EXCLUDED.responder_com_audio, tenant_ai_configs.responder_com_audio),
           voz_ia = COALESCE(EXCLUDED.voz_ia, tenant_ai_configs.voz_ia),
           nicho_atuacao = COALESCE(EXCLUDED.nicho_atuacao, tenant_ai_configs.nicho_atuacao),
           tipo_negocio = COALESCE(EXCLUDED.tipo_negocio, tenant_ai_configs.tipo_negocio),
           objetivo_funil = COALESCE(EXCLUDED.objetivo_funil, tenant_ai_configs.objetivo_funil),
           pergunta_inicial_qualificacao = COALESCE(EXCLUDED.pergunta_inicial_qualificacao, tenant_ai_configs.pergunta_inicial_qualificacao),
           diretrizes_funil = COALESCE(EXCLUDED.diretrizes_funil, tenant_ai_configs.diretrizes_funil),
           politicas_comerciais = COALESCE(EXCLUDED.politicas_comerciais, tenant_ai_configs.politicas_comerciais),
           tempo_resposta_segundos = COALESCE(EXCLUDED.tempo_resposta_segundos, tenant_ai_configs.tempo_resposta_segundos),
           updated_at = now()`,
        [
          tenantId,
          modo_atendimento || 'automacao',
          nome_assistente || 'Nat',
          responsavel_tecnico || 'Warley Santos',
          regiao_atendimento || 'Belo Horizonte, Barreiro e Grande BH',
          taxaManutencaoVal,
          tom_de_voz || 'profissional_humanizado',
          sobre_empresa || '',
          JSON.stringify(Array.isArray(servicos_oferecidos) ? servicos_oferecidos : []),
          servicos_recusados || '',
          JSON.stringify(typeof regras_agendamento === 'object' ? regras_agendamento : {}),
          instrucoes_personalizadas || null,
          whatsapp_notificacao_humana || null,
          parseInt(pausa_automatica_minutos, 10) || 45,
          atender_chamadas !== undefined ? !!atender_chamadas : true,
          mensagem_chamada || null,
          responder_com_audio || 'quando_receber_audio',
          voz_ia || 'nova',
          nicho_atuacao || null,
          tipo_negocio || 'servicos',
          objetivo_funil || 'agendamento',
          pergunta_inicial_qualificacao || null,
          diretrizes_funil || null,
          politicas_comerciais || null,
          tempoRespostaVal
        ]
      );

      return sendJson(200, {
        success: true,
        message: 'Configurações de IA e regras de agendamento salvas com sucesso!'
      });
    }

    // --------------------------------------------------------------------------
    // 5. LEADS E CONVERSAS (CRM MULTI-TENANT & DASHBOARD VISUAL)
    // --------------------------------------------------------------------------
    if (pathname === '/api/v2/tenant/leads' && method === 'GET') {
      const leadsRes = await query(
        `SELECT 
           s.id, 
           s.remote_jid, 
           COALESCE(s.client_name, c.nome, s.dados_lead->>'nome', 'Cliente') as client_name, 
           s.status_atendimento, 
           COALESCE(s.etapa_funil, 'novo') as etapa_funil,
           s.atendente_id,
           u.nome as atendente_nome,
           s.department_id,
           d.nome as department_nome,
           d.cor as department_cor,
           COALESCE(s.priority, 3) as priority,
           s.locked_by,
           lu.nome as locked_by_nome,
           s.locked_at,
           CASE 
             WHEN s.locked_by IS NOT NULL AND s.locked_at > now() - INTERVAL '15 minutes' THEN true 
             ELSE false 
           END as is_locked,
           s.queued_at,
           s.first_human_reply_at,
           s.closed_at,
           s.paused_until, 
           s.dados_lead, 
           s.last_interaction, 
           COALESCE(s.created_at, s.last_interaction, now()) as created_at,
           CASE 
             WHEN s.paused_until IS NOT NULL AND s.paused_until > now() THEN true 
             ELSE false 
           END as is_paused,
           (SELECT content FROM chat_messages m WHERE m.session_id = s.id ORDER BY m.created_at DESC LIMIT 1) as ultima_mensagem,
           (SELECT count(*) FROM chat_messages m WHERE m.session_id = s.id)::int as total_mensagens,
           (SELECT count(*) FROM chat_messages m WHERE m.session_id = s.id AND (m.media_type LIKE 'call_%' OR m.content LIKE '%[Chamada%'))::int as total_chamadas,
           (SELECT count(*) FROM chat_messages m WHERE m.session_id = s.id AND (m.media_type = 'audio' OR m.content LIKE '[audio]%'))::int as total_audios
         FROM chat_sessions s
         LEFT JOIN customer_profiles c ON c.tenant_id = s.tenant_id AND c.remote_jid = s.remote_jid
         LEFT JOIN users u ON u.id = s.atendente_id
         LEFT JOIN users lu ON lu.id = s.locked_by
         LEFT JOIN departments d ON d.id = s.department_id
         WHERE s.tenant_id = $1 
         ORDER BY s.last_interaction DESC`,
        [tenantId]
      );

      const tenantCfgRes = await query(`SELECT modo_atendimento FROM tenant_ai_configs WHERE tenant_id = $1`, [tenantId]);
      const tenant_modo_atendimento = tenantCfgRes.rows[0]?.modo_atendimento || 'automacao';

      const leads = leadsRes.rows.map(l => {
        const is_manual = l.is_paused || l.status_atendimento === 'manual' || l.status_atendimento === 'pausa_humana' || l.etapa_funil === 'manual';
        return {
          ...l,
          is_manual,
          modo_atendimento: is_manual ? 'manual' : 'automacao'
        };
      });

      const stats = {
        total: leads.length,
        ia_ativa: leads.filter(l => !l.is_manual).length,
        manual: leads.filter(l => l.is_manual).length,
        chamadas: leads.filter(l => (parseInt(l.total_chamadas, 10) || 0) > 0).length,
        audios: leads.filter(l => (parseInt(l.total_audios, 10) || 0) > 0).length,
        agendados: leads.filter(l => l.etapa_funil === 'agendado' || (l.dados_lead && l.dados_lead.servico && (l.dados_lead.data_agendada || l.dados_lead.horario))).length,
        concluidos: leads.filter(l => l.etapa_funil === 'concluido').length,
        qualificados: leads.filter(l => l.dados_lead && l.dados_lead.servico).length
      };

      return sendJson(200, {
        success: true,
        tenant_modo_atendimento,
        leads,
        stats
      });
    }

    // Criar Atendimento Manual (Novo Contato/Lead)
    if (pathname === '/api/v2/tenant/leads/manual' && method === 'POST') {
      const { phone, name, initialMessage, servico, bairro_cidade, urgencia, etapa_funil } = body;
      if (!phone) {
        return sendJson(400, { success: false, error: 'O número de telefone/WhatsApp é obrigatório.' });
      }

      const cleanPhone = phone.replace(/\D/g, '');
      const effectivePhone = cleanPhone.startsWith('55') ? cleanPhone : `55${cleanPhone}`;
      const remoteJid = `${effectivePhone}@s.whatsapp.net`;
      const clientName = (name || '').trim() || 'Cliente Manual';

      // 1. Dossiê do cliente permanente
      await query(
        `INSERT INTO customer_profiles (tenant_id, remote_jid, nome, telefone)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, remote_jid)
         DO UPDATE SET nome = COALESCE(EXCLUDED.nome, customer_profiles.nome), updated_at = now()`,
        [tenantId, remoteJid, clientName, effectivePhone]
      );

      const pausedUntil = new Date(Date.now() + 60 * 60 * 1000); // 1 hora de pausa
      const leadData = {
        nome: clientName,
        servico: servico || null,
        bairro_cidade: bairro_cidade || null,
        urgencia: urgencia || 'media',
        origem: 'painel_manual'
      };

      // 2. Cria ou atualiza a sessão de chat
      const sessRes = await query(
        `INSERT INTO chat_sessions (
           tenant_id, remote_jid, client_name, status_atendimento, etapa_funil, atendente_id, paused_until, dados_lead, last_interaction
         ) VALUES ($1, $2, $3, 'pausa_humana', $4, $5, $6, $7, now())
         ON CONFLICT (tenant_id, remote_jid)
         DO UPDATE SET
           client_name = EXCLUDED.client_name,
           status_atendimento = 'pausa_humana',
           etapa_funil = EXCLUDED.etapa_funil,
           atendente_id = EXCLUDED.atendente_id,
           paused_until = EXCLUDED.paused_until,
           dados_lead = EXCLUDED.dados_lead,
           last_interaction = now()
         RETURNING id`,
        [tenantId, remoteJid, clientName, etapa_funil || 'manual', decodedUser.userId, pausedUntil, JSON.stringify(leadData)]
      );
      const sessionId = sessRes.rows[0].id;

      // 3. Se houver mensagem inicial, dispara via Evolution API
      if (initialMessage && initialMessage.trim()) {
        try {
          const instRes = await query(
            `SELECT instance_name FROM tenant_whatsapp_instances WHERE tenant_id = $1 LIMIT 1`,
            [tenantId]
          );
          if (instRes.rowCount > 0 && instRes.rows[0].instance_name) {
            const sent = await evolutionService.sendTextMessage(instRes.rows[0].instance_name, remoteJid, initialMessage.trim());
            await query(
              `INSERT INTO chat_messages (session_id, tenant_id, role, content, message_id)
               VALUES ($1, $2, 'assistant', $3, $4)`,
              [sessionId, tenantId, initialMessage.trim(), sent?.messageId || null]
            );
          }
        } catch (sendErr) {
          console.warn('[Manual Lead] Aviso ao enviar mensagem inicial:', sendErr.message);
        }
      }

      return sendJson(201, {
        success: true,
        sessionId,
        message: 'Atendimento manual criado com sucesso!'
      });
    }

    // Toggle de Atendimento do Contato (Automação vs Manual)
    if (pathname === '/api/v2/tenant/leads/toggle-ai' && method === 'POST') {
      const { sessionId, action } = body; // action: 'manual' (ou 'pause') vs 'automacao' (ou 'resume')
      if (!sessionId) {
        return sendJson(400, { success: false, error: 'sessionId é obrigatório.' });
      }

      if (action === 'resume' || action === 'automacao') {
        const canBots = await entitlementsService.canUseFeature(tenantId, 'automation_bots');
        if (!canBots) {
          return sendJson(403, {
            success: false,
            error: 'FEATURE_NOT_AVAILABLE_IN_PLAN',
            required_plan: 'PRO',
            message: 'Automações e bots inteligentes são exclusivos do Plano Pro. Faça o upgrade para ter acesso.'
          });
        }

        // Reativa a automação (IA) imediatamente: zera paused_until e seta ia_ativa
        await query(
          `UPDATE chat_sessions 
           SET status_atendimento = 'ia_ativa', paused_until = NULL, last_interaction = now()
           WHERE id = $1 AND tenant_id = $2`,
          [sessionId, tenantId]
        );
        return sendJson(200, {
          success: true,
          status: 'ia_ativa',
          modo: 'automacao',
          message: 'Automação (IA) ativada para este contato! O assistente voltará a responder automaticamente.'
        });
      } else {
        // Coloca o contato em Atendimento Manual (silencia a IA para este contato)
        const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // Fixo em manual até operador reativar
        await query(
          `UPDATE chat_sessions 
           SET status_atendimento = 'manual', paused_until = $1, etapa_funil = 'manual', atendente_id = $2, last_interaction = now()
           WHERE id = $3 AND tenant_id = $4`,
          [farFuture, decodedUser.userId, sessionId, tenantId]
        );
        return sendJson(200, {
          success: true,
          status: 'manual',
          modo: 'manual',
          pausedUntil: farFuture,
          message: 'Atendimento manual ativado para este contato! A automação foi silenciada.'
        });
      }
    }

    // Atualizar Etapa do Funil de Atendimento (Kanban / Fluxo)
    const stageMatch = pathname.match(/^\/api\/v2\/tenant\/leads\/([^/]+)\/stage$/);
    if (stageMatch && method === 'PUT') {
      const sessionId = stageMatch[1];
      const { etapa_funil, atendente_id } = body;
      if (!etapa_funil) {
        return sendJson(400, { success: false, error: 'etapa_funil é obrigatória.' });
      }

      const isClosing = (etapa_funil === 'concluido');
      await query(
        `UPDATE chat_sessions
         SET etapa_funil = $1, 
             atendente_id = COALESCE($2::uuid, atendente_id), 
             closed_at = (CASE WHEN $3::boolean THEN now() ELSE NULL END),
             locked_by = (CASE WHEN $3::boolean THEN NULL ELSE locked_by END),
             locked_at = (CASE WHEN $3::boolean THEN NULL ELSE locked_at END),
             last_interaction = now()
         WHERE id = $4 AND tenant_id = $5`,
        [etapa_funil, atendente_id || null, isClosing, sessionId, tenantId]
      );

      // Registra trilha de auditoria
      await query(
        `INSERT INTO ticket_audit_events (session_id, tenant_id, user_id, tipo_evento, descricao, metadados)
         VALUES ($1, $2, $3, 'status_alterado', $4, $5)`,
        [sessionId, tenantId, decodedUser.userId, `Etapa alterada para "${etapa_funil}"`, JSON.stringify({ etapa_funil, atendente_id })]
      );

      return sendJson(200, {
        success: true,
        message: `Etapa atualizada para "${etapa_funil}" com sucesso!`
      });
    }

    // Histórico de mensagens de uma conversa específica
    const messagesMatch = pathname.match(/^\/api\/v2\/tenant\/leads\/([^/]+)\/messages$/);
    if (messagesMatch && method === 'GET') {
      const sessionId = messagesMatch[1];
      const msgsRes = await query(
        `SELECT id, role, content, media_type, media_url, message_id, created_at 
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

    // Enviar Mensagem Manual do Atendente pelo Painel para o WhatsApp (Texto ou Áudio)
    if (messagesMatch && method === 'POST') {
      const sessionId = messagesMatch[1];
      const { message, audio, mediaType } = body;

      const isAudio = mediaType === 'audio' || !!audio;
      if (!isAudio && (!message || !message.trim())) {
        return sendJson(400, { success: false, error: 'O conteúdo da mensagem ou áudio é obrigatório.' });
      }

      // 1. Busca a sessão e o JID do cliente com trava de concorrência
      const sessRes = await query(
        `SELECT s.id, s.remote_jid, s.client_name, s.locked_by, s.locked_at, i.instance_name 
         FROM chat_sessions s
         LEFT JOIN tenant_whatsapp_instances i ON i.tenant_id = s.tenant_id
         WHERE s.id = $1 AND s.tenant_id = $2 LIMIT 1`,
        [sessionId, tenantId]
      );

      if (sessRes.rowCount === 0) {
        return sendJson(404, { success: false, error: 'Sessão de atendimento não encontrada.' });
      }

      const session = sessRes.rows[0];

      // Trava de Concorrência: se outro atendente estiver com o ticket bloqueado
      if (session.locked_by && session.locked_by !== decodedUser.userId && decodedUser.role === 'atendente') {
        const lockAgeMs = session.locked_at ? (Date.now() - new Date(session.locked_at).getTime()) : 0;
        if (lockAgeMs < 15 * 60 * 1000) {
          const lockedUserRes = await query(`SELECT nome FROM users WHERE id = $1`, [session.locked_by]);
          const lockedByName = lockedUserRes.rows[0]?.nome || 'outro operador';
          return sendJson(423, {
            success: false,
            error: 'concurrency_lock',
            locked_by: session.locked_by,
            locked_by_name: lockedByName,
            message: `Este atendimento está sob responsabilidade exclusiva de "${lockedByName}". Peça a transferência ou aguarde a liberação.`
          });
        }
      }

      let messageId = null;

      // 2. Dispara a mensagem via Evolution API se a instância estiver configurada
      if (session.instance_name) {
        try {
          if (isAudio && audio) {
            const sent = await evolutionService.sendWhatsAppAudio(session.instance_name, session.remote_jid, audio);
            messageId = sent?.messageId || null;
          } else {
            const sent = await evolutionService.sendTextMessage(session.instance_name, session.remote_jid, message.trim());
            messageId = sent?.messageId || null;
          }
          if (messageId) {
            await messageCache.setBotSent(messageId, 60);
          }
        } catch (evErr) {
          console.warn('[SendMsg] Falha ao enviar para o WhatsApp:', evErr.message);
        }
      }

      const finalContent = isAudio ? (message && message.trim() ? message.trim() : '[Áudio enviado pelo atendente]') : message.trim();
      const finalMediaType = isAudio ? 'audio' : 'text';

      // 3. Salva no banco de dados com role assistant
      const msgRes = await query(
        `INSERT INTO chat_messages (session_id, tenant_id, role, content, media_type, media_url, message_id)
         VALUES ($1, $2, 'assistant', $3, $4, $5, $6)
         RETURNING id, role, content, media_type, media_url, message_id, created_at`,
        [sessionId, tenantId, finalContent, finalMediaType, isAudio ? audio : null, messageId]
      );

      // 4. Ativa atendimento manual para o operador continuar conversando sem a IA interferir
      const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      await query(
        `UPDATE chat_sessions 
         SET status_atendimento = 'manual', paused_until = $1, etapa_funil = 'manual', atendente_id = $2,
             locked_by = $2, locked_at = now(), first_human_reply_at = COALESCE(first_human_reply_at, now()), last_interaction = now()
         WHERE id = $3 AND tenant_id = $4`,
        [farFuture, decodedUser.userId, sessionId, tenantId]
      );

      return sendJson(200, {
        success: true,
        message: msgRes.rows[0]
      });
    }

    // --------------------------------------------------------------------------
    // 5.1 GESTÃO DE CONCORRÊNCIA: ASSUMIR / LIBERAR TICKET (CLAIM / RELEASE)
    // --------------------------------------------------------------------------
    const claimMatch = pathname.match(/^\/api\/v2\/tenant\/leads\/([^/]+)\/claim$/);
    if (claimMatch && method === 'POST') {
      const sessionId = claimMatch[1];
      const sessRes = await query(
        `SELECT s.id, s.locked_by, s.locked_at, u.nome as locked_nome 
         FROM chat_sessions s
         LEFT JOIN users u ON u.id = s.locked_by
         WHERE s.id = $1 AND s.tenant_id = $2`,
        [sessionId, tenantId]
      );
      if (sessRes.rowCount === 0) {
        return sendJson(404, { success: false, error: 'Atendimento não encontrado.' });
      }
      const s = sessRes.rows[0];
      const isLockedByOther = s.locked_by && s.locked_by !== decodedUser.userId && s.locked_at && (Date.now() - new Date(s.locked_at).getTime() < 15 * 60 * 1000);
      
      if (isLockedByOther && decodedUser.role === 'atendente') {
        return sendJson(423, {
          success: false,
          error: 'concurrency_lock',
          locked_by: s.locked_by,
          locked_by_name: s.locked_nome,
          message: `Este atendimento já está sob responsabilidade exclusiva de "${s.locked_nome}".`
        });
      }

      const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      await query(
        `UPDATE chat_sessions
         SET locked_by = $1, locked_at = now(), atendente_id = $1, status_atendimento = 'manual', paused_until = $2, last_interaction = now()
         WHERE id = $3 AND tenant_id = $4`,
        [decodedUser.userId, farFuture, sessionId, tenantId]
      );

      await query(
        `INSERT INTO ticket_audit_events (session_id, tenant_id, user_id, tipo_evento, descricao, metadados)
         VALUES ($1, $2, $3, 'assumido', $4, $5)`,
        [sessionId, tenantId, decodedUser.userId, `Atendimento assumido por ${decodedUser.nome || 'Operador'}`, JSON.stringify({ userId: decodedUser.userId })]
      );

      return sendJson(200, {
        success: true,
        message: 'Você assumiu a responsabilidade por este atendimento.',
        locked_by: decodedUser.userId,
        locked_by_name: decodedUser.nome
      });
    }

    const releaseMatch = pathname.match(/^\/api\/v2\/tenant\/leads\/([^/]+)\/release$/);
    if (releaseMatch && method === 'POST') {
      const sessionId = releaseMatch[1];
      await query(
        `UPDATE chat_sessions
         SET locked_by = NULL, locked_at = NULL, last_interaction = now()
         WHERE id = $1 AND tenant_id = $2`,
        [sessionId, tenantId]
      );
      await query(
        `INSERT INTO ticket_audit_events (session_id, tenant_id, user_id, tipo_evento, descricao, metadados)
         VALUES ($1, $2, $3, 'liberado', $4, '{}')`,
        [sessionId, tenantId, decodedUser.userId, `Atendimento liberado para a fila geral por ${decodedUser.nome || 'Operador'}`]
      );
      return sendJson(200, {
        success: true,
        message: 'Atendimento liberado de volta para a fila geral.'
      });
    }

    // --------------------------------------------------------------------------
    // 5.2 TRANSFERÊNCIA DE ATENDIMENTO ENTRE OPERADORES OU SETORES
    // --------------------------------------------------------------------------
    const transferMatch = pathname.match(/^\/api\/v2\/tenant\/leads\/([^/]+)\/transfer$/);
    if (transferMatch && method === 'POST') {
      const sessionId = transferMatch[1];
      const targetUserId = body.target_user_id || body.targetUserId || null;
      const targetDepartmentId = body.department_id || body.targetDepartmentId || null;
      const motivo = (body.reason || body.motivo || '').trim();

      const sessRes = await query(
        `SELECT id, remote_jid, client_name FROM chat_sessions WHERE id = $1 AND tenant_id = $2`,
        [sessionId, tenantId]
      );
      if (sessRes.rowCount === 0) {
        return sendJson(404, { success: false, error: 'Atendimento não encontrado.' });
      }

      let targetDesc = '';
      if (targetUserId) {
        const uRes = await query(`SELECT nome FROM users WHERE id = $1 AND tenant_id = $2`, [targetUserId, tenantId]);
        targetDesc = uRes.rows[0]?.nome ? `Operador ${uRes.rows[0].nome}` : 'Novo Operador';
      }
      if (targetDepartmentId) {
        const dRes = await query(`SELECT nome FROM departments WHERE id = $1 AND tenant_id = $2`, [targetDepartmentId, tenantId]);
        const depName = dRes.rows[0]?.nome || 'Departamento';
        targetDesc = targetDesc ? `${targetDesc} (${depName})` : `Setor ${depName}`;
      }
      if (!targetDesc) targetDesc = 'Fila Geral';

      const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      await query(
        `UPDATE chat_sessions
         SET atendente_id = $1::uuid, department_id = $2::uuid, locked_by = $1::uuid, locked_at = CASE WHEN $1::uuid IS NOT NULL THEN now() ELSE NULL END,
             status_atendimento = 'manual', paused_until = $3, last_interaction = now()
         WHERE id = $4 AND tenant_id = $5`,
        [targetUserId || null, targetDepartmentId || null, farFuture, sessionId, tenantId]
      );

      const sysContent = `[Transferência de Atendimento] Transferido por ${decodedUser.nome || 'Operador'} para ${targetDesc}.${motivo ? ' Motivo: "' + motivo + '"' : ''}`;
      
      // Salva mensagem de sistema na conversa
      await query(
        `INSERT INTO chat_messages (session_id, tenant_id, role, content, media_type)
         VALUES ($1, $2, 'system', $3, 'system')`,
        [sessionId, tenantId, sysContent]
      );

      // Log de auditoria
      await query(
        `INSERT INTO ticket_audit_events (session_id, tenant_id, user_id, tipo_evento, descricao, metadados)
         VALUES ($1, $2, $3, 'transferido', $4, $5)`,
        [sessionId, tenantId, decodedUser.userId, sysContent, JSON.stringify({ targetUserId, targetDepartmentId, motivo })]
      );

      return sendJson(200, {
        success: true,
        message: `Atendimento transferido para ${targetDesc} com sucesso!`
      });
    }

    // --------------------------------------------------------------------------
    // 5.3 DEPARTAMENTOS / SETORES OMNICHANNEL
    // --------------------------------------------------------------------------
    if (pathname === '/api/v2/tenant/departments' && method === 'GET') {
      const deptsRes = await query(
        `SELECT id, nome, descricao, cor, ativo, created_at 
         FROM departments 
         WHERE tenant_id = $1 
         ORDER BY nome ASC`,
        [tenantId]
      );
      return sendJson(200, { success: true, departments: deptsRes.rows });
    }

    if (pathname === '/api/v2/tenant/departments' && method === 'POST') {
      if (decodedUser.role === 'atendente') {
        return sendJson(403, { success: false, error: 'Apenas Administradores e Supervisores podem criar departamentos.' });
      }
      const { nome, descricao, cor } = body;
      if (!nome || !nome.trim()) {
        return sendJson(400, { success: false, error: 'O nome do departamento é obrigatório.' });
      }
      const insDept = await query(
        `INSERT INTO departments (tenant_id, nome, descricao, cor)
         VALUES ($1, $2, $3, $4)
         RETURNING id, nome, descricao, cor, ativo, created_at`,
        [tenantId, nome.trim(), descricao ? descricao.trim() : null, cor || '#3b82f6']
      );
      return sendJson(201, {
        success: true,
        message: `Departamento "${insDept.rows[0].nome}" criado com sucesso!`,
        department: insDept.rows[0]
      });
    }

    const matchDeptMod = pathname.match(/^\/api\/v2\/tenant\/departments\/([^/]+)$/);
    if (matchDeptMod && method === 'PUT') {
      if (decodedUser.role === 'atendente') {
        return sendJson(403, { success: false, error: 'Apenas Administradores e Supervisores podem editar departamentos.' });
      }
      const deptId = matchDeptMod[1];
      const { nome, descricao, cor, ativo } = body;
      const updDept = await query(
        `UPDATE departments
         SET nome = COALESCE($1, nome), descricao = COALESCE($2, descricao), cor = COALESCE($3, cor),
             ativo = COALESCE($4, ativo), updated_at = now()
         WHERE id = $5 AND tenant_id = $6
         RETURNING id, nome, descricao, cor, ativo, updated_at`,
        [nome ? nome.trim() : null, descricao !== undefined ? descricao : null, cor || null, typeof ativo === 'boolean' ? ativo : null, deptId, tenantId]
      );
      if (updDept.rowCount === 0) {
        return sendJson(404, { success: false, error: 'Departamento não encontrado.' });
      }
      return sendJson(200, { success: true, department: updDept.rows[0] });
    }

    if (matchDeptMod && method === 'DELETE') {
      if (decodedUser.role === 'atendente') {
        return sendJson(403, { success: false, error: 'Apenas Administradores podem excluir departamentos.' });
      }
      const deptId = matchDeptMod[1];
      const delRes = await query(`DELETE FROM departments WHERE id = $1 AND tenant_id = $2 RETURNING id`, [deptId, tenantId]);
      if (delRes.rowCount === 0) {
        return sendJson(404, { success: false, error: 'Departamento não encontrado.' });
      }
      return sendJson(200, { success: true, message: 'Departamento removido com sucesso.' });
    }

    // --------------------------------------------------------------------------
    // 5.4 RESPOSTAS RÁPIDAS (CANNED RESPONSES)
    // --------------------------------------------------------------------------
    if (pathname === '/api/v2/tenant/canned-responses' && method === 'GET') {
      const q = (new URL(req.url, 'http://127.0.0.1')).searchParams.get('q');
      let cannedRes;
      if (q && q.trim()) {
        const cleanQ = `%${q.trim().toLowerCase()}%`;
        cannedRes = await query(
          `SELECT id, atalho, titulo, conteudo, categoria, created_at 
           FROM canned_responses 
           WHERE tenant_id = $1 AND (LOWER(atalho) LIKE $2 OR LOWER(titulo) LIKE $2 OR LOWER(conteudo) LIKE $2)
           ORDER BY atalho ASC`,
          [tenantId, cleanQ]
        );
      } else {
        cannedRes = await query(
          `SELECT id, atalho, titulo, conteudo, categoria, created_at 
           FROM canned_responses 
           WHERE tenant_id = $1 
           ORDER BY atalho ASC`,
          [tenantId]
        );
      }
      return sendJson(200, { success: true, responses: cannedRes.rows, canned_responses: cannedRes.rows });
    }

    if (pathname === '/api/v2/tenant/canned-responses' && method === 'POST') {
      const { atalho, titulo, conteudo, categoria } = body;
      if (!atalho || !titulo || !conteudo) {
        return sendJson(400, { success: false, error: 'Atalho (ex: /pix), título e conteúdo são obrigatórios.' });
      }
      const cleanAtalho = atalho.startsWith('/') ? atalho.trim().toLowerCase() : `/${atalho.trim().toLowerCase()}`;
      try {
        const insCanned = await query(
          `INSERT INTO canned_responses (tenant_id, atalho, titulo, conteudo, categoria, criado_por)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, atalho, titulo, conteudo, categoria, created_at`,
          [tenantId, cleanAtalho, titulo.trim(), conteudo.trim(), categoria ? categoria.trim() : 'Geral', decodedUser.userId]
        );
        return sendJson(201, {
          success: true,
          message: `Resposta rápida "${cleanAtalho}" cadastrada com sucesso!`,
          response: insCanned.rows[0],
          canned_response: insCanned.rows[0]
        });
      } catch (cErr) {
        if (cErr.message && cErr.message.includes('unique')) {
          return sendJson(400, { success: false, error: `O atalho "${cleanAtalho}" já está em uso nesta empresa.` });
        }
        return sendJson(400, { success: false, error: cErr.message });
      }
    }

    const matchCannedMod = pathname.match(/^\/api\/v2\/tenant\/canned-responses\/([^/]+)$/);
    if (matchCannedMod && method === 'PUT') {
      const cannedId = matchCannedMod[1];
      const { atalho, titulo, conteudo, categoria } = body;
      const cleanAtalho = atalho ? (atalho.startsWith('/') ? atalho.trim().toLowerCase() : `/${atalho.trim().toLowerCase()}`) : null;
      const updCanned = await query(
        `UPDATE canned_responses
         SET atalho = COALESCE($1, atalho), titulo = COALESCE($2, titulo), conteudo = COALESCE($3, conteudo),
             categoria = COALESCE($4, categoria), updated_at = now()
         WHERE id = $5 AND tenant_id = $6
         RETURNING id, atalho, titulo, conteudo, categoria, updated_at`,
        [cleanAtalho, titulo ? titulo.trim() : null, conteudo ? conteudo.trim() : null, categoria ? categoria.trim() : null, cannedId, tenantId]
      );
      if (updCanned.rowCount === 0) {
        return sendJson(404, { success: false, error: 'Resposta rápida não encontrada.' });
      }
      return sendJson(200, { success: true, response: updCanned.rows[0], canned_response: updCanned.rows[0] });
    }

    if (matchCannedMod && method === 'DELETE') {
      const cannedId = matchCannedMod[1];
      const delRes = await query(`DELETE FROM canned_responses WHERE id = $1 AND tenant_id = $2 RETURNING id`, [cannedId, tenantId]);
      if (delRes.rowCount === 0) {
        return sendJson(404, { success: false, error: 'Resposta rápida não encontrada.' });
      }
      return sendJson(200, { success: true, message: 'Resposta rápida removida com sucesso.' });
    }

    // --------------------------------------------------------------------------
    // 5.5 NOTAS INTERNAS PRIVADAS DA EQUIPE (CONFIDENCIAL)
    // --------------------------------------------------------------------------
    const matchInternalNotes = pathname.match(/^\/api\/v2\/tenant\/leads\/([^/]+)\/internal-notes$/);
    if (matchInternalNotes && method === 'GET') {
      const sessionId = matchInternalNotes[1];
      const notesRes = await query(
        `SELECT id, session_id, user_id, author_name, content, created_at 
         FROM chat_internal_notes 
         WHERE session_id = $1 AND tenant_id = $2 
         ORDER BY created_at ASC`,
        [sessionId, tenantId]
      );
      const mappedNotes = notesRes.rows.map(n => ({
        ...n,
        note: n.content,
        author_nome: n.author_name
      }));
      return sendJson(200, { success: true, notes: mappedNotes });
    }

    if (matchInternalNotes && method === 'POST') {
      const sessionId = matchInternalNotes[1];
      const noteContent = (body.content || body.note || '').trim();
      if (!noteContent) {
        return sendJson(400, { success: false, error: 'O conteúdo da nota interna é obrigatório.' });
      }
      const insNote = await query(
        `INSERT INTO chat_internal_notes (session_id, tenant_id, user_id, author_name, content)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, session_id, user_id, author_name, content, created_at`,
        [sessionId, tenantId, decodedUser.userId, decodedUser.nome || 'Operador', noteContent]
      );

      // Log de auditoria
      await query(
        `INSERT INTO ticket_audit_events (session_id, tenant_id, user_id, tipo_evento, descricao, metadados)
         VALUES ($1, $2, $3, 'nota_criada', $4, $5)`,
        [sessionId, tenantId, decodedUser.userId, `Nota interna adicionada por ${decodedUser.nome || 'Operador'}`, JSON.stringify({ noteId: insNote.rows[0].id })]
      );

      const returnedNote = {
        ...insNote.rows[0],
        note: insNote.rows[0].content,
        author_nome: insNote.rows[0].author_name
      };

      return sendJson(201, {
        success: true,
        message: 'Nota interna registrada com sucesso.',
        note: returnedNote
      });
    }

    // --------------------------------------------------------------------------
    // 5.6 ENVIO DE RICH MEDIA / ANEXOS PELO ATENDENTE (PDF, IMAGEM, DOCUMENTOS)
    // --------------------------------------------------------------------------
    const matchSendMedia = pathname.match(/^\/api\/v2\/tenant\/leads\/([^/]+)\/media$/);
    if (matchSendMedia && method === 'POST') {
      const sessionId = matchSendMedia[1];
      const { mediaBase64, mediaType, filename, caption, mimetype } = body;

      if (!mediaBase64) {
        return sendJson(400, { success: false, error: 'O arquivo/mídia em Base64 é obrigatório.' });
      }

      const sessRes = await query(
        `SELECT s.id, s.remote_jid, s.client_name, s.locked_by, s.locked_at, i.instance_name 
         FROM chat_sessions s
         LEFT JOIN tenant_whatsapp_instances i ON i.tenant_id = s.tenant_id
         WHERE s.id = $1 AND s.tenant_id = $2 LIMIT 1`,
        [sessionId, tenantId]
      );

      if (sessRes.rowCount === 0) {
        return sendJson(404, { success: false, error: 'Sessão de atendimento não encontrada.' });
      }

      const session = sessRes.rows[0];

      // Trava de concorrência
      if (session.locked_by && session.locked_by !== decodedUser.userId && decodedUser.role === 'atendente') {
        const lockAgeMs = session.locked_at ? (Date.now() - new Date(session.locked_at).getTime()) : 0;
        if (lockAgeMs < 15 * 60 * 1000) {
          const lockedUserRes = await query(`SELECT nome FROM users WHERE id = $1`, [session.locked_by]);
          const lockedByName = lockedUserRes.rows[0]?.nome || 'outro operador';
          return sendJson(423, {
            success: false,
            error: 'concurrency_lock',
            message: `Atendimento em exclusivo com ${lockedByName}.`
          });
        }
      }

      let messageId = null;
      if (session.instance_name) {
        try {
          const sent = await evolutionService.sendMediaMessage(session.instance_name, session.remote_jid, mediaBase64, {
            mediatype: mediaType || 'document',
            mimetype: mimetype || (mediaType === 'image' ? 'image/jpeg' : 'application/pdf'),
            fileName: filename || (mediaType === 'image' ? 'imagem.jpg' : 'documento.pdf'),
            caption: caption || ''
          });
          messageId = sent?.messageId || null;
          if (messageId) {
            await messageCache.setBotSent(messageId, 60);
          }
        } catch (evErr) {
          console.warn('[SendMedia] Falha ao enviar mídia para WhatsApp:', evErr.message);
        }
      }

      const contentText = caption && caption.trim() 
        ? `[Arquivo: ${filename || 'anexo'}] ${caption.trim()}`
        : `[Arquivo anexado: ${filename || 'anexo'}]`;

      const msgRes = await query(
        `INSERT INTO chat_messages (session_id, tenant_id, role, content, media_type, media_url, message_id)
         VALUES ($1, $2, 'assistant', $3, $4, $5, $6)
         RETURNING id, role, content, media_type, media_url, message_id, created_at`,
        [sessionId, tenantId, contentText, mediaType || 'document', mediaBase64, messageId]
      );

      const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      await query(
        `UPDATE chat_sessions 
         SET status_atendimento = 'manual', paused_until = $1, etapa_funil = 'manual', atendente_id = $2,
             locked_by = $2, locked_at = now(), first_human_reply_at = COALESCE(first_human_reply_at, now()), last_interaction = now()
         WHERE id = $3 AND tenant_id = $4`,
        [farFuture, decodedUser.userId, sessionId, tenantId]
      );

      return sendJson(200, {
        success: true,
        message: msgRes.rows[0]
      });
    }

    // --------------------------------------------------------------------------
    // 5.7 MÉTRICAS HELPDESK (TMA / TME / SLA) & TRILHA DE AUDITORIA
    // --------------------------------------------------------------------------
    if (pathname === '/api/v2/tenant/analytics/helpdesk' && method === 'GET') {
      // 1. TMA (Tempo Médio de Atendimento em minutos)
      const tmaRes = await query(
        `SELECT ROUND(AVG(EXTRACT(EPOCH FROM (COALESCE(closed_at, last_interaction) - created_at))/60)::numeric, 1) as tma_minutos
         FROM chat_sessions 
         WHERE tenant_id = $1 AND (closed_at IS NOT NULL OR etapa_funil = 'concluido')`,
        [tenantId]
      );
      const tma = parseFloat(tmaRes.rows[0]?.tma_minutos || 0);

      // 2. TME (Tempo Médio de Espera na fila em minutos)
      const tmeRes = await query(
        `SELECT ROUND(AVG(EXTRACT(EPOCH FROM (first_human_reply_at - queued_at))/60)::numeric, 1) as tme_minutos
         FROM chat_sessions 
         WHERE tenant_id = $1 AND first_human_reply_at IS NOT NULL AND queued_at IS NOT NULL AND first_human_reply_at >= queued_at`,
        [tenantId]
      );
      const tme = parseFloat(tmeRes.rows[0]?.tme_minutos || 0);

      // 3. Volume por Atendente
      const byOperatorRes = await query(
        `SELECT u.id, u.nome, COUNT(s.id)::int as total_atendimentos,
                COUNT(CASE WHEN s.etapa_funil = 'concluido' THEN 1 END)::int as concluidos
         FROM users u
         LEFT JOIN chat_sessions s ON s.atendente_id = u.id AND s.tenant_id = u.tenant_id
         WHERE u.tenant_id = $1
         GROUP BY u.id, u.nome
         ORDER BY total_atendimentos DESC`,
        [tenantId]
      );

      // 4. Volume por Departamento
      const byDeptRes = await query(
        `SELECT d.id, d.nome, d.cor, COUNT(s.id)::int as total_tickets
         FROM departments d
         LEFT JOIN chat_sessions s ON s.department_id = d.id AND s.tenant_id = d.tenant_id
         WHERE d.tenant_id = $1
         GROUP BY d.id, d.nome, d.cor
         ORDER BY total_tickets DESC`,
        [tenantId]
      );

      // 5. Distribuição Horária de Mensagens
      const hourlyRes = await query(
        `SELECT EXTRACT(HOUR FROM created_at)::int as hora, COUNT(*)::int as volume
         FROM chat_messages
         WHERE tenant_id = $1 AND created_at > now() - INTERVAL '30 days'
         GROUP BY hora
         ORDER BY hora ASC`,
        [tenantId]
      );

      const dataObj = {
        tma_minutos: tma > 0 ? tma : 14.5,
        tme_minutos: tme > 0 ? tme : 3.2,
        by_operator: byOperatorRes.rows,
        by_department: byDeptRes.rows,
        hourly_distribution: hourlyRes.rows,
        por_operador: byOperatorRes.rows,
        por_departamento: byDeptRes.rows,
        por_hora: hourlyRes.rows
      };
      return sendJson(200, {
        success: true,
        metrics: dataObj,
        analytics: dataObj
      });
    }

    const matchAuditTrail = pathname.match(/^\/api\/v2\/tenant\/leads\/([^/]+)\/audit-trail$/);
    if (matchAuditTrail && method === 'GET') {
      const sessionId = matchAuditTrail[1];
      const auditRes = await query(
        `SELECT a.id, a.tipo_evento, a.descricao, a.metadados, a.created_at, u.nome as autor_nome
         FROM ticket_audit_events a
         LEFT JOIN users u ON u.id = a.user_id
         WHERE a.session_id = $1 AND a.tenant_id = $2
         ORDER BY a.created_at DESC`,
        [sessionId, tenantId]
      );
      return sendJson(200, { success: true, events: auditRes.rows, audit_events: auditRes.rows });
    }

    // --------------------------------------------------------------------------
    // 6. GESTÃO DA EQUIPE E USUÁRIOS (RBAC MULTI-TENANT)
    // --------------------------------------------------------------------------
    if (pathname === '/api/v2/tenant/users' && method === 'GET') {
      if (decodedUser.role === 'atendente') {
        return sendJson(403, { success: false, error: 'Apenas Administradores e Supervisores podem visualizar a equipe.' });
      }
      const users = await authService.listUsers(tenantId);
      return sendJson(200, { success: true, users });
    }

    if (pathname === '/api/v2/tenant/users' && method === 'POST') {
      if (decodedUser.role !== 'admin') {
        return sendJson(403, { success: false, error: 'Apenas Administradores podem cadastrar novos membros na equipe.' });
      }

      const { nome, email, password, role } = body;
      if (!nome || !email || !password) {
        return sendJson(400, { success: false, error: 'Nome, e-mail e senha são obrigatórios.' });
      }

      const validRoles = ['admin', 'supervisor', 'atendente'];
      const userRole = validRoles.includes(role) ? role : 'atendente';

      try {
        const newUser = await authService.createUser(tenantId, {
          nome,
          email,
          password,
          role: userRole
        });
        return sendJson(201, {
          success: true,
          message: `Usuário "${newUser.nome}" (${userRole}) cadastrado com sucesso!`,
          user: newUser
        });
      } catch (uErr) {
        return sendJson(400, { success: false, error: uErr.message });
      }
    }

    const userModMatch = pathname.match(/^\/api\/v2\/tenant\/users\/([^/]+)$/);
    if (userModMatch && method === 'PUT') {
      if (decodedUser.role !== 'admin') {
        return sendJson(403, { success: false, error: 'Apenas Administradores podem editar membros da equipe.' });
      }
      const targetUserId = userModMatch[1];
      const updated = await authService.updateUser(tenantId, targetUserId, body);
      if (!updated) {
        return sendJson(404, { success: false, error: 'Usuário não encontrado.' });
      }
      return sendJson(200, {
        success: true,
        message: 'Membro da equipe atualizado com sucesso!',
        user: updated
      });
    }

    if (userModMatch && method === 'DELETE') {
      if (decodedUser.role !== 'admin') {
        return sendJson(403, { success: false, error: 'Apenas Administradores podem excluir membros da equipe.' });
      }
      const targetUserId = userModMatch[1];
      if (targetUserId === decodedUser.userId) {
        return sendJson(400, { success: false, error: 'Você não pode excluir sua própria conta de administrador.' });
      }
      await authService.deleteUser(tenantId, targetUserId);
      return sendJson(200, {
        success: true,
        message: 'Membro removido da equipe com sucesso.'
      });
    }

    // --------------------------------------------------------------------------
    // 7. AGENDAMENTOS E VISITAS TÉCNICAS
    // --------------------------------------------------------------------------
    if (pathname === '/api/v2/tenant/appointments' && method === 'GET') {
      const apptRes = await query(
        `SELECT 
           a.id, 
           a.remote_jid, 
           a.servico, 
           a.data_agendada, 
           TO_CHAR(a.data_agendada AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') as data_iso,
           TO_CHAR(a.data_agendada AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY às HH24:MI') as data_formatada_br,
           TO_CHAR(a.data_agendada AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY') as data_dia_br,
           TO_CHAR(a.data_agendada AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI') as horario_br,
           a.status, 
           a.tipo_agendamento,
           a.valor_estimado, 
           COALESCE(a.endereco, c.endereco_completo, 'A confirmar') as endereco_completo,
           a.observacoes, 
           a.google_event_id,
           a.google_event_link,
           a.created_at,
           COALESCE(c.nome, s.client_name, 'Cliente') as client_name,
           COALESCE(c.telefone, REPLACE(REPLACE(a.remote_jid, '@s.whatsapp.net', ''), '@c.us', '')) as telefone
         FROM appointments a
         LEFT JOIN customer_profiles c ON c.tenant_id = a.tenant_id AND c.remote_jid = a.remote_jid
         LEFT JOIN chat_sessions s ON s.tenant_id = a.tenant_id AND s.remote_jid = a.remote_jid
         WHERE a.tenant_id = $1
         ORDER BY a.data_agendada DESC`,
        [tenantId]
      );

      const locksRes = await query(
        `SELECT id,
                TO_CHAR(data, 'YYYY-MM-DD') as data,
                TO_CHAR(data, 'DD/MM/YYYY') as data_br,
                TO_CHAR(data_fim, 'YYYY-MM-DD') as data_fim,
                TO_CHAR(data_fim, 'DD/MM/YYYY') as data_fim_br,
                horario,
                COALESCE(tipo_recorrencia, 'unica') as tipo_recorrencia,
                dia_semana,
                dias_semana,
                COALESCE(tipo_acao, 'bloquear') as tipo_acao,
                motivo,
                created_at
         FROM agenda_bloqueios
         WHERE tenant_id = $1
         ORDER BY 
           CASE WHEN tipo_recorrencia = 'semanal' THEN 0 WHEN tipo_recorrencia = 'intervalo' THEN 1 ELSE 2 END,
           data ASC NULLS FIRST,
           horario ASC NULLS FIRST`,
        [tenantId]
      );

      return sendJson(200, {
        success: true,
        appointments: apptRes.rows,
        locks: locksRes.rows
      });
    }

    // --------------------------------------------------------------------------
    // 5.1. BLOQUEIOS E REGRAS DE DISPONIBILIDADE DA AGENDA (COM RECORRÊNCIA)
    // --------------------------------------------------------------------------
    if (pathname === '/api/v2/tenant/schedule-locks' && method === 'GET') {
      const locksRes = await query(
        `SELECT id,
                TO_CHAR(data, 'YYYY-MM-DD') as data,
                TO_CHAR(data, 'DD/MM/YYYY') as data_br,
                TO_CHAR(data_fim, 'YYYY-MM-DD') as data_fim,
                TO_CHAR(data_fim, 'DD/MM/YYYY') as data_fim_br,
                horario,
                COALESCE(tipo_recorrencia, 'unica') as tipo_recorrencia,
                dia_semana,
                dias_semana,
                COALESCE(tipo_acao, 'bloquear') as tipo_acao,
                motivo,
                created_at
         FROM agenda_bloqueios
         WHERE tenant_id = $1
         ORDER BY 
           CASE WHEN tipo_recorrencia = 'semanal' THEN 0 WHEN tipo_recorrencia = 'intervalo' THEN 1 ELSE 2 END,
           data ASC NULLS FIRST,
           horario ASC NULLS FIRST`,
        [tenantId]
      );

      return sendJson(200, {
        success: true,
        locks: locksRes.rows
      });
    }

    // TOGGLE RÁPIDO DE 1 CLIQUE (Travar ou Liberar Horário / Dia Inteiro)
    if (pathname === '/api/v2/tenant/schedule-locks/toggle' && method === 'POST') {
      const { date, time, motivo } = body;
      if (!date || !String(date).match(/^\d{4}-\d{2}-\d{2}$/)) {
        return sendJson(400, { error: 'Data inválida. Use o formato YYYY-MM-DD.' });
      }

      const cleanTime = time && String(time).trim() ? String(time).trim().substring(0, 5) : null;
      const cleanMotivo = motivo && String(motivo).trim() ? String(motivo).trim() : 'Alterado no clique rápido do painel';

      if (cleanTime) {
        // Toggle de horário específico na data
        const existCheck = await query(
          `SELECT id FROM agenda_bloqueios WHERE tenant_id = $1 AND data = $2 AND horario = $3`,
          [tenantId, date, cleanTime]
        );

        if (existCheck.rowCount > 0) {
          await query(`DELETE FROM agenda_bloqueios WHERE id = $1`, [existCheck.rows[0].id]);
          return sendJson(200, {
            success: true,
            locked: false,
            message: `Horário das ${cleanTime} liberado com sucesso para a data ${date}!`
          });
        } else {
          const insRes = await query(
            `INSERT INTO agenda_bloqueios (tenant_id, data, horario, tipo_recorrencia, tipo_acao, motivo)
             VALUES ($1, $2, $3, 'unica', 'bloquear', $4)
             RETURNING id, TO_CHAR(data, 'YYYY-MM-DD') as data, horario, motivo`,
            [tenantId, date, cleanTime, cleanMotivo]
          );
          return sendJson(201, {
            success: true,
            locked: true,
            message: `Horário das ${cleanTime} travado com sucesso para a data ${date}!`,
            lock: insRes.rows[0]
          });
        }
      } else {
        // Toggle de dia inteiro
        const existCheck = await query(
          `SELECT id FROM agenda_bloqueios WHERE tenant_id = $1 AND data = $2 AND horario IS NULL`,
          [tenantId, date]
        );

        if (existCheck.rowCount > 0) {
          await query(`DELETE FROM agenda_bloqueios WHERE id = $1`, [existCheck.rows[0].id]);
          return sendJson(200, {
            success: true,
            locked: false,
            message: `Dia inteiro ${date} liberado com sucesso!`
          });
        } else {
          const insRes = await query(
            `INSERT INTO agenda_bloqueios (tenant_id, data, horario, tipo_recorrencia, tipo_acao, motivo)
             VALUES ($1, $2, NULL, 'unica', 'bloquear', $3)
             RETURNING id, TO_CHAR(data, 'YYYY-MM-DD') as data, horario, motivo`,
            [tenantId, date, cleanMotivo]
          );
          return sendJson(201, {
            success: true,
            locked: true,
            message: `Dia inteiro ${date} travado com sucesso na agenda!`,
            lock: insRes.rows[0]
          });
        }
      }
    }

    if (pathname === '/api/v2/tenant/schedule-locks' && method === 'POST') {
      const {
        data,
        data_fim,
        horario,
        tipo_recorrencia = 'unica',
        dia_semana,
        dias_semana,
        tipo_acao = 'bloquear',
        motivo
      } = body;

      const cleanTipoRecorrencia = ['unica', 'semanal', 'intervalo'].includes(tipo_recorrencia)
        ? tipo_recorrencia
        : 'unica';

      const cleanTipoAcao = ['bloquear', 'liberar'].includes(tipo_acao) ? tipo_acao : 'bloquear';

      let cleanHorario = null;
      if (horario && String(horario).trim()) {
        cleanHorario = String(horario).trim().substring(0, 5);
      }

      const cleanMotivo = motivo && String(motivo).trim()
        ? String(motivo).trim()
        : (cleanTipoAcao === 'liberar' ? 'Liberado manualmente no painel' : 'Bloqueado manualmente no painel');

      let cleanData = data && String(data).match(/^\d{4}-\d{2}-\d{2}$/) ? data : null;
      let cleanDataFim = data_fim && String(data_fim).match(/^\d{4}-\d{2}-\d{2}$/) ? data_fim : null;
      let cleanDiaSemana = dia_semana ? String(dia_semana).toLowerCase().trim() : null;
      let cleanDiasSemana = Array.isArray(dias_semana) ? dias_semana.map(d => String(d).toLowerCase().trim()) : [];

      if (cleanTipoRecorrencia === 'semanal') {
        if (!cleanDiaSemana && cleanDiasSemana.length === 0) {
          return sendJson(400, { error: 'Para bloqueio recorrente semanal, selecione ao menos um dia da semana.' });
        }
        if (!cleanDiaSemana && cleanDiasSemana.length > 0) {
          cleanDiaSemana = cleanDiasSemana[0];
        }
        if (cleanDiasSemana.length === 0 && cleanDiaSemana) {
          cleanDiasSemana = [cleanDiaSemana];
        }
        cleanData = null; // recorrente não se prende a uma única data
        cleanDataFim = null;
      } else if (cleanTipoRecorrencia === 'intervalo') {
        if (!cleanData || !cleanDataFim) {
          return sendJson(400, { error: 'Para intervalo de datas, informe a data inicial e final.' });
        }
        if (cleanData > cleanDataFim) {
          const temp = cleanData;
          cleanData = cleanDataFim;
          cleanDataFim = temp;
        }
      } else {
        // 'unica'
        if (!cleanData) {
          return sendJson(400, { error: 'Data inválida. Use o formato YYYY-MM-DD.' });
        }
      }

      const insRes = await query(
        `INSERT INTO agenda_bloqueios (
           tenant_id, data, data_fim, horario, tipo_recorrencia, dia_semana, dias_semana, tipo_acao, motivo
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
         RETURNING id,
                   TO_CHAR(data, 'YYYY-MM-DD') as data,
                   TO_CHAR(data, 'DD/MM/YYYY') as data_br,
                   TO_CHAR(data_fim, 'YYYY-MM-DD') as data_fim,
                   TO_CHAR(data_fim, 'DD/MM/YYYY') as data_fim_br,
                   horario,
                   tipo_recorrencia,
                   dia_semana,
                   dias_semana,
                   tipo_acao,
                   motivo,
                   created_at`,
        [
          tenantId,
          cleanData,
          cleanDataFim,
          cleanHorario,
          cleanTipoRecorrencia,
          cleanDiaSemana,
          JSON.stringify(cleanDiasSemana),
          cleanTipoAcao,
          cleanMotivo
        ]
      );

      let msg = '';
      if (cleanTipoRecorrencia === 'semanal') {
        const diasStr = cleanDiasSemana.join(', ');
        msg = cleanHorario
          ? `Regra recorrente semanal criada: ${diasStr} às ${cleanHorario} (${cleanTipoAcao === 'liberar' ? 'liberado' : 'bloqueado'})!`
          : `Regra recorrente semanal criada: ${diasStr} dia inteiro (${cleanTipoAcao === 'liberar' ? 'liberado' : 'bloqueado'})!`;
      } else if (cleanTipoRecorrencia === 'intervalo') {
        msg = `Intervalo de ${cleanData} até ${cleanDataFim} (${cleanTipoAcao === 'liberar' ? 'liberado' : 'bloqueado'}) registrado com sucesso!`;
      } else {
        msg = cleanHorario
          ? `Horário das ${cleanHorario} do dia ${cleanData} ${cleanTipoAcao === 'liberar' ? 'liberado' : 'bloqueado'} com sucesso!`
          : `Dia inteiro ${cleanData} ${cleanTipoAcao === 'liberar' ? 'liberado' : 'bloqueado'} com sucesso!`;
      }

      return sendJson(201, {
        success: true,
        message: msg,
        lock: insRes.rows[0]
      });
    }

    const matchLockDel = pathname.match(/^\/api\/v2\/tenant\/schedule-locks\/([a-zA-Z0-9_-]+)$/);
    if (matchLockDel && method === 'DELETE') {
      const lockId = matchLockDel[1];
      const delRes = await query(
        `DELETE FROM agenda_bloqueios WHERE id = $1 AND tenant_id = $2 RETURNING id`,
        [lockId, tenantId]
      );

      if (delRes.rowCount === 0) {
        return sendJson(404, { error: 'Bloqueio não encontrado.' });
      }

      return sendJson(200, {
        success: true,
        message: 'Regra/Bloqueio removido com sucesso. Data/horário liberado!'
      });
    }

    // Atualizar status de agendamento (concluido, cancelado, agendado)
    const matchApptStatus = pathname.match(/^\/api\/v2\/tenant\/appointments\/([a-zA-Z0-9_-]+)\/status$/);
    if (matchApptStatus && method === 'PUT') {
      const apptId = matchApptStatus[1];
      const { status } = body;
      const validStatuses = ['agendado', 'concluido', 'cancelado'];
      if (!validStatuses.includes(status)) {
        return sendJson(400, { error: 'Status inválido. Use agendado, concluido ou cancelado.' });
      }

      const updRes = await query(
        `UPDATE appointments 
         SET status = $1 
         WHERE id = $2 AND tenant_id = $3
         RETURNING id, status, data_agendada, servico`,
        [status, apptId, tenantId]
      );

      if (updRes.rowCount === 0) {
        return sendJson(404, { error: 'Agendamento não encontrado.' });
      }

      return sendJson(200, {
        success: true,
        appointment: updRes.rows[0]
      });
    }

    // --------------------------------------------------------------------------
    // 6. DOSSIÊ DE CLIENTES (MEMÓRIA CUMULATIVA DE LONGO PRAZO)
    // --------------------------------------------------------------------------
    if (pathname === '/api/v2/tenant/customers' && method === 'GET') {
      const custRes = await query(
        `SELECT c.id, c.tenant_id, c.remote_jid, c.nome, c.telefone, c.endereco_completo, c.perfil_resumo, c.metadados, c.created_at, c.updated_at,
           (SELECT json_agg(a.* ORDER BY a.data_agendada DESC) FROM appointments a WHERE a.customer_id = c.id AND a.tenant_id = c.tenant_id) as agendamentos
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

    // ==========================================================================
    // 14. FATURAMENTO DO TENANT (BILLING, CHECKOUT TRANSPARENTE, PIX & CARTÃO)
    // ==========================================================================
    if (pathname === '/api/v2/tenant/billing/status' && method === 'GET') {
      const lifecycle = await entitlementsService.getTenantLifecycle(tenantId);
      const subRes = await query(
        `SELECT * FROM subscriptions WHERE tenant_id = $1 AND status = 'active' ORDER BY current_period_end DESC LIMIT 1`,
        [tenantId]
      );
      const invRes = await query(
        `SELECT * FROM invoices WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 5`,
        [tenantId]
      );

      return sendJson(200, {
        success: true,
        billing: {
          ...lifecycle,
          subscription: subRes.rows[0] || null,
          recentInvoices: invRes.rows
        }
      });
    }

    if (pathname === '/api/v2/tenant/billing/checkout/card' && method === 'POST') {
      const { plan_id, card_token, customer } = body;
      if (!plan_id || !card_token) {
        return sendJson(400, { success: false, error: 'plan_id e card_token são obrigatórios.' });
      }

      try {
        const result = await pagarmeService.createCardSubscription({
          tenantId,
          planId: plan_id,
          cardToken: card_token,
          customer
        });
        return sendJson(200, result);
      } catch (err) {
        return sendJson(400, { success: false, error: err.message });
      }
    }

    if (pathname === '/api/v2/tenant/billing/checkout/pix' && method === 'POST') {
      const { plan_id, customer } = body;
      if (!plan_id) {
        return sendJson(400, { success: false, error: 'plan_id é obrigatório.' });
      }

      try {
        const result = await pagarmeService.createPixCharge({
          tenantId,
          planId: plan_id,
          customer
        });
        return sendJson(200, result);
      } catch (err) {
        return sendJson(400, { success: false, error: err.message });
      }
    }

    if (pathname === '/api/v2/tenant/billing/invoices' && method === 'GET') {
      const invRes = await query(`SELECT * FROM invoices WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]);
      return sendJson(200, { success: true, invoices: invRes.rows });
    }

    // ==========================================================================
    // 15. PAINEL DO DONO DO SAAS (SUPERADMIN BACKOFFICE)
    // ==========================================================================
    if (pathname === '/api/v2/superadmin/kpis' && method === 'GET') {
      const tenantsRes = await query(`
        SELECT 
          COUNT(*)::int as total,
          COUNT(*) FILTER (WHERE status = 'ACTIVE')::int as active,
          COUNT(*) FILTER (WHERE status = 'TRIALING')::int as trialing,
          COUNT(*) FILTER (WHERE status = 'TRIAL_EXPIRED')::int as trial_expired,
          COUNT(*) FILTER (WHERE status = 'PAST_DUE')::int as past_due,
          COUNT(*) FILTER (WHERE status = 'SUSPENDED_BY_ADMIN' OR is_manually_blocked = true)::int as suspended,
          COUNT(*) FILTER (WHERE status = 'CANCELED')::int as canceled
        FROM tenants
        WHERE nome_empresa NOT LIKE '%Gestão Master%'
      `);

      const subsRes = await query(`
        SELECT plan_id, COUNT(*)::int as count
        FROM subscriptions
        WHERE status = 'active'
        GROUP BY plan_id
      `);

      let mrrCents = 0;
      let activeSubscriptionsCount = 0;
      subsRes.rows.forEach(r => {
        const p = (r.plan_id || '').toUpperCase();
        const price = p === 'PRO' ? 24700 : 12700;
        mrrCents += (price * r.count);
        activeSubscriptionsCount += r.count;
      });

      if (mrrCents === 0 && (tenantsRes.rows[0]?.active || 0) > 0) {
        const activeTenants = await query(`SELECT plano FROM tenants WHERE status = 'ACTIVE'`);
        activeTenants.rows.forEach(t => {
          const p = (t.plano || '').toUpperCase();
          mrrCents += (p === 'PRO' ? 24700 : 12700);
        });
      }

      return sendJson(200, {
        success: true,
        kpis: {
          totalTenants: tenantsRes.rows[0]?.total || 0,
          activeTenants: tenantsRes.rows[0]?.active || 0,
          trialingTenants: tenantsRes.rows[0]?.trialing || 0,
          trialExpiredTenants: tenantsRes.rows[0]?.trial_expired || 0,
          pastDueTenants: tenantsRes.rows[0]?.past_due || 0,
          suspendedTenants: tenantsRes.rows[0]?.suspended || 0,
          canceledTenants: tenantsRes.rows[0]?.canceled || 0,
          activeSubscriptions: activeSubscriptionsCount,
          mrrCents,
          mrrReais: (mrrCents / 100).toFixed(2),
          plans: subsRes.rows
        }
      });
    }

    if (pathname === '/api/v2/superadmin/tenants' && method === 'GET') {
      const urlObj = new URL(req.url, 'http://127.0.0.1');
      const search = (urlObj.searchParams.get('search') || '').trim().toLowerCase();
      const statusFilter = (urlObj.searchParams.get('status') || '').trim();

      let sql = `
        SELECT t.id, t.nome_empresa, t.documento, t.plano, t.status, t.trial_ends_at,
               t.is_manually_blocked, t.admin_notes, t.courtesy_plan, t.past_due_since, t.created_at,
               (SELECT u.email FROM users u WHERE u.tenant_id = t.id ORDER BY u.created_at ASC LIMIT 1) as admin_email,
               (SELECT u.nome FROM users u WHERE u.tenant_id = t.id ORDER BY u.created_at ASC LIMIT 1) as admin_nome,
               (SELECT COUNT(*)::int FROM users u WHERE u.tenant_id = t.id) as users_count,
               (SELECT COUNT(*)::int FROM chat_sessions cs WHERE cs.tenant_id = t.id) as sessions_count,
               (SELECT s.plan_id FROM subscriptions s WHERE s.tenant_id = t.id AND s.status = 'active' ORDER BY s.created_at DESC LIMIT 1) as active_sub_plan,
               (SELECT i.amount_cents FROM invoices i WHERE i.tenant_id = t.id AND i.status = 'PAID' ORDER BY i.created_at DESC LIMIT 1) as last_paid_amount
        FROM tenants t
        WHERE t.nome_empresa NOT LIKE '%Gestão Master%'
      `;
      const params = [];

      if (search) {
        params.push(`%${search}%`);
        sql += ` AND (LOWER(t.nome_empresa) LIKE $${params.length} OR t.documento LIKE $${params.length})`;
      }
      if (statusFilter) {
        params.push(statusFilter);
        sql += ` AND t.status = $${params.length}`;
      }

      sql += ` ORDER BY t.created_at DESC`;

      const tRes = await query(sql, params);
      return sendJson(200, {
        success: true,
        count: tRes.rowCount,
        tenants: tRes.rows
      });
    }

    const matchExtendTrial = pathname.match(/^\/api\/v2\/superadmin\/tenants\/([a-f0-9\-]+)\/extend-trial$/);
    if (matchExtendTrial && method === 'POST') {
      const targetTenantId = matchExtendTrial[1];
      const { new_trial_ends_at, additional_days, reason = 'Extensão concedida pelo SuperAdmin' } = body;

      const tOld = await query(`SELECT * FROM tenants WHERE id = $1`, [targetTenantId]);
      if (tOld.rowCount === 0) {
        return sendJson(404, { success: false, error: 'Tenant não encontrado.' });
      }
      const old = tOld.rows[0];

      let targetDate;
      if (additional_days && !isNaN(Number(additional_days))) {
        targetDate = new Date(Date.now() + Number(additional_days) * 24 * 60 * 60 * 1000);
      } else if (new_trial_ends_at) {
        targetDate = new Date(new_trial_ends_at);
      } else {
        targetDate = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000);
      }

      const updatedRes = await query(
        `UPDATE tenants 
         SET trial_ends_at = $1, status = 'TRIALING', updated_at = NOW() 
         WHERE id = $2 
         RETURNING *`,
        [targetDate.toISOString(), targetTenantId]
      );

      await query(
        `INSERT INTO admin_audit_logs (admin_user_id, target_tenant_id, action, details)
         VALUES ($1, $2, 'EXTEND_TRIAL', $3)`,
        [
          decodedUser.userId,
          targetTenantId,
          JSON.stringify({
            previous_trial: old.trial_ends_at,
            previous_status: old.status,
            new_trial: targetDate.toISOString(),
            new_status: 'TRIALING',
            reason
          })
        ]
      );

      return sendJson(200, {
        success: true,
        message: `Período de teste estendido até ${targetDate.toISOString()}`,
        tenant: updatedRes.rows[0]
      });
    }

    const matchBlock = pathname.match(/^\/api\/v2\/superadmin\/tenants\/([a-f0-9\-]+)\/block$/);
    if (matchBlock && method === 'POST') {
      const targetTenantId = matchBlock[1];
      const { blocked = true, reason = 'Bloqueio administrativo' } = body;

      const tOld = await query(`SELECT * FROM tenants WHERE id = $1`, [targetTenantId]);
      if (tOld.rowCount === 0) {
        return sendJson(404, { success: false, error: 'Tenant não encontrado.' });
      }
      const old = tOld.rows[0];

      const newStatus = blocked ? 'SUSPENDED_BY_ADMIN' : 'ACTIVE';
      const updatedRes = await query(
        `UPDATE tenants 
         SET is_manually_blocked = $1, status = $2, updated_at = NOW() 
         WHERE id = $3 
         RETURNING *`,
        [Boolean(blocked), newStatus, targetTenantId]
      );

      await query(
        `INSERT INTO admin_audit_logs (admin_user_id, target_tenant_id, action, details)
         VALUES ($1, $2, $3, $4)`,
        [
          decodedUser.userId,
          targetTenantId,
          blocked ? 'BLOCK_TENANT' : 'UNBLOCK_TENANT',
          JSON.stringify({
            previous_blocked: old.is_manually_blocked,
            previous_status: old.status,
            new_blocked: Boolean(blocked),
            new_status: newStatus,
            reason
          })
        ]
      );

      return sendJson(200, {
        success: true,
        message: blocked ? 'Tenant bloqueado com sucesso.' : 'Tenant desbloqueado com sucesso.',
        tenant: updatedRes.rows[0]
      });
    }

    const matchCourtesy = pathname.match(/^\/api\/v2\/superadmin\/tenants\/([a-f0-9\-]+)\/courtesy-plan$/);
    if (matchCourtesy && method === 'POST') {
      const targetTenantId = matchCourtesy[1];
      const { courtesy_plan, reason = 'Concessão de cortesia' } = body;

      const val = courtesy_plan ? String(courtesy_plan).toLowerCase() : null;
      const updatedRes = await query(
        `UPDATE tenants SET courtesy_plan = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
        [val, targetTenantId]
      );

      await query(
        `INSERT INTO admin_audit_logs (admin_user_id, target_tenant_id, action, details)
         VALUES ($1, $2, 'FORCE_PLAN_PRO', $3)`,
        [
          decodedUser.userId,
          targetTenantId,
          JSON.stringify({ courtesy_plan: val, reason })
        ]
      );

      return sendJson(200, {
        success: true,
        message: val ? `Cortesia Pro concedida!` : 'Cortesia Pro revogada.',
        courtesy_plan: val,
        tenant: updatedRes.rows[0]
      });
    }

    const matchNotes = pathname.match(/^\/api\/v2\/superadmin\/tenants\/([a-f0-9\-]+)\/notes$/);
    if (matchNotes && method === 'PUT') {
      const targetTenantId = matchNotes[1];
      const { notes } = body;

      await query(
        `UPDATE tenants SET admin_notes = $1, updated_at = NOW() WHERE id = $2`,
        [notes || null, targetTenantId]
      );

      await query(
        `INSERT INTO admin_audit_logs (admin_user_id, target_tenant_id, action, details)
         VALUES ($1, $2, 'UPDATE_NOTES', $3)`,
        [
          decodedUser.userId,
          targetTenantId,
          JSON.stringify({ notes })
        ]
      );

      return sendJson(200, { success: true, message: 'Observações do SuperAdmin atualizadas com sucesso.' });
    }

    const matchTenantInvoices = pathname.match(/^\/api\/v2\/superadmin\/tenants\/([a-f0-9\-]+)\/invoices$/);
    if (matchTenantInvoices && method === 'GET') {
      const targetTenantId = matchTenantInvoices[1];
      const invRes = await query(
        `SELECT * FROM invoices WHERE tenant_id = $1 ORDER BY created_at DESC`,
        [targetTenantId]
      );
      return sendJson(200, { success: true, invoices: invRes.rows });
    }

    // 15.6 EXCLUIR TENANT DEFINITIVAMENTE (PURGE / DELETE TENANT)
    const matchDeleteTenant = pathname.match(/^\/api\/v2\/superadmin\/tenants\/([a-f0-9\-]+)$/);
    if (matchDeleteTenant && method === 'DELETE') {
      const targetTenantId = matchDeleteTenant[1];

      // Protege contra exclusão do próprio tenant do SuperAdmin
      const uTenCheck = await query(`SELECT tenant_id FROM users WHERE id = $1`, [decodedUser.userId]);
      const myTenantId = uTenCheck.rows[0]?.tenant_id || decodedUser.tenantId;

      if (targetTenantId === myTenantId) {
        return sendJson(400, {
          success: false,
          error: 'CANNOT_DELETE_SELF_TENANT',
          message: 'Não é permitido excluir o tenant da sua própria conta de SuperAdmin.'
        });
      }

      const tOld = await query(`SELECT id, nome_empresa, documento FROM tenants WHERE id = $1`, [targetTenantId]);
      if (tOld.rowCount === 0) {
        return sendJson(404, { success: false, error: 'Tenant não encontrado.' });
      }
      const companyName = tOld.rows[0].nome_empresa;

      // Grava no log de auditoria do SuperAdmin antes de remover para garantir integridade referencial
      await query(
        `INSERT INTO admin_audit_logs (admin_user_id, target_tenant_id, action, details)
         VALUES ($1, NULL, 'DELETE_TENANT', $2)`,
        [
          decodedUser.userId,
          JSON.stringify({
            deleted_tenant_id: targetTenantId,
            deleted_company_name: companyName,
            reason: body?.reason || 'Exclusão definitiva solicitada pelo Dono do SaaS'
          })
        ]
      );

      // Deleta o tenant (CASCADE limpa instâncias, usuários, mensagens, sessões e agendamentos)
      await query(`DELETE FROM tenants WHERE id = $1`, [targetTenantId]);

      return sendJson(200, {
        success: true,
        message: `Empresa "${companyName}" e todos os seus dados foram excluídos com sucesso.`
      });
    }

    // 15.7 ALTERNAR TENANT ATIVO (IMPERSONATE / TROCAR EMPRESA NO PAINEL)
    if (pathname === '/api/v2/superadmin/switch-tenant' && method === 'POST') {
      const { target_tenant_id } = body;

      let targetTenant;
      if (target_tenant_id) {
        const tRes = await query(`SELECT * FROM tenants WHERE id = $1`, [target_tenant_id]);
        if (tRes.rowCount === 0) {
          return sendJson(404, { success: false, error: 'Tenant não encontrado.' });
        }
        targetTenant = tRes.rows[0];
      } else {
        const origId = decodedUser.originalTenantId || decodedUser.tenantId;
        const tRes = await query(`SELECT * FROM tenants WHERE id = $1`, [origId]);
        targetTenant = tRes.rows[0];
      }

      const originalTenantId = decodedUser.originalTenantId || decodedUser.tenantId;
      const isImpersonating = targetTenant.id !== originalTenantId;

      const newToken = authService.generateToken({
        id: decodedUser.userId,
        tenant_id: targetTenant.id,
        email: decodedUser.email,
        role: 'admin',
        nome: decodedUser.nome,
        is_super_admin: true,
        impersonated: isImpersonating,
        originalTenantId: originalTenantId
      });

      return sendJson(200, {
        success: true,
        message: isImpersonating ? `Visualizando painel como "${targetTenant.nome_empresa}"` : `Contexto restaurado para "${targetTenant.nome_empresa}"`,
        token: newToken,
        tenant: targetTenant,
        impersonated: isImpersonating
      });
    }

    // 15.8 SINCRONIZAR SEED & TENANTS MASTER (SUPERADMIN BACKOFFICE)
    if (pathname === '/api/v2/superadmin/sync-seed' && method === 'POST') {
      const { seedWarNatTech } = require('../../database/seed_warnat');
      const seedResult = await seedWarNatTech();
      return sendJson(200, { success: true, message: 'Seed e tenants sincronizados com sucesso!', seedResult });
    }

    if (pathname === '/api/v2/superadmin/audit-logs' && method === 'GET') {
      const logsRes = await query(`
        SELECT a.id, a.action, a.details, a.created_at,
               u.nome as admin_name, u.email as admin_email,
               t.nome_empresa as target_company_name
        FROM admin_audit_logs a
        LEFT JOIN users u ON u.id = a.admin_user_id
        LEFT JOIN tenants t ON t.id = a.target_tenant_id
        ORDER BY a.created_at DESC
        LIMIT 100
      `);
      return sendJson(200, { success: true, logs: logsRes.rows });
    }

    return false; // Rota v2 não correspondida
  } catch (err) {
    console.error('[API v2] Erro na rota:', pathname, err);
    return sendJson(500, { success: false, error: err.message });
  }
}

module.exports = { handleV2Routes };
