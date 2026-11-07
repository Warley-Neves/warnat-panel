// ==============================================================================
// Rotas da API v2 (Multi-Tenant SaaS) - WarNat Tech
// Autenticação JWT, Conexão WhatsApp, Regras de IA e Gestão de Leads/Conversas
// ==============================================================================

const authService = require('../../database/auth.service');
const { query } = require('../../database/db');
const evolutionService = require('../../services/evolution.service');
const webhookController = require('../../controllers/webhook.controller');
const messageCache = require('../../services/message-cache.service');

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

      await query(
        `UPDATE chat_sessions
         SET etapa_funil = $1, atendente_id = COALESCE($2, atendente_id), last_interaction = now()
         WHERE id = $3 AND tenant_id = $4`,
        [etapa_funil, atendente_id || null, sessionId, tenantId]
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

      // 1. Busca a sessão e o JID do cliente
      const sessRes = await query(
        `SELECT s.id, s.remote_jid, s.client_name, i.instance_name 
         FROM chat_sessions s
         LEFT JOIN tenant_whatsapp_instances i ON i.tenant_id = s.tenant_id
         WHERE s.id = $1 AND s.tenant_id = $2 LIMIT 1`,
        [sessionId, tenantId]
      );

      if (sessRes.rowCount === 0) {
        return sendJson(404, { success: false, error: 'Sessão de atendimento não encontrada.' });
      }

      const session = sessRes.rows[0];
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
         SET status_atendimento = 'manual', paused_until = $1, etapa_funil = 'manual', atendente_id = $2, last_interaction = now()
         WHERE id = $3`,
        [farFuture, decodedUser.userId, sessionId]
      );

      return sendJson(200, {
        success: true,
        message: msgRes.rows[0]
      });
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

      return sendJson(200, {
        success: true,
        appointments: apptRes.rows
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
