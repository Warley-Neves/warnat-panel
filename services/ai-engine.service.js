// ==============================================================================
// AI Engine & Tool de Qualificação Obrigatória - WarNat SaaS
// Prompt Compiler Dinâmico, Histórico Limitado a 10 Mensagens e Tool Calling
// ==============================================================================

const OpenAI = require('openai');
const path = require('path');
const fs = require('fs');
const { query } = require('../database/db');
const evolutionService = require('./evolution.service');
const messageCache = require('./message-cache.service');
const promptCompiler = require('./prompt-compiler.service');

// Carregar variáveis de ambiente
const envPath = path.resolve(__dirname, '..', '.env');
const envMap = {};
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      envMap[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
    }
  });
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || envMap['OPENAI_API_KEY'];

// ------------------------------------------------------------------------------
// DEFINIÇÃO DAS TOOLS (FUNCTION CALLING)
// ------------------------------------------------------------------------------
const TOOLS_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'salvar_lead_qualificado',
      description: 'Salva os dados do lead após qualificação completa (nome, serviço de interesse, bairro/cidade, urgência e observações). Dispara alerta estruturado para o WhatsApp da equipe técnica.',
      parameters: {
        type: 'object',
        properties: {
          nome: {
            type: 'string',
            description: 'Nome completo ou primeiro nome do cliente identificado na conversa'
          },
          servico: {
            type: 'string',
            description: 'Tipo de serviço desejado pelo cliente (ex: Nova Instalação CFTV, Manutenção de Câmeras, Configuração de Acesso Remoto, etc.)'
          },
          bairro_cidade: {
            type: 'string',
            description: 'Bairro e cidade onde o serviço será realizado (ex: Barreiro / Belo Horizonte)'
          },
          urgencia: {
            type: 'string',
            enum: ['baixa', 'media', 'alta', 'imediata'],
            description: 'Nível de urgência da solicitação'
          },
          detalhes: {
            type: 'string',
            description: 'Observações adicionais (quantidade de câmeras, defeito apresentado, preferências de data ou horários)'
          }
        },
        required: ['nome', 'servico', 'bairro_cidade']
      }
    }
  }
];

class AiEngineService {
  constructor() {
    this.openai = new OpenAI({
      apiKey: OPENAI_API_KEY
    });
  }

  /**
   * Executa a Tool de Qualificação Obrigatória:
   * 1. Atualiza chat_sessions.dados_lead e client_name no banco.
   * 2. Dispara alerta estruturado para o WhatsApp do responsável técnico.
   */
  async executeQualificationTool({ tenantId, instanceName, sessionId, remoteJid, args }) {
    const { nome, servico, bairro_cidade, urgencia = 'media', detalhes = '' } = args;

    console.log(`[AIEngine] Executando tool salvar_lead_qualificado para ${nome} (${remoteJid})...`);

    // 1. Atualiza chat_sessions com os dados estruturados do lead
    const dadosLead = {
      nome: nome.trim(),
      servico: servico.trim(),
      bairro_cidade: bairro_cidade.trim(),
      urgencia,
      detalhes: detalhes ? detalhes.trim() : '',
      qualificado_em: new Date().toISOString()
    };

    await query(
      `UPDATE chat_sessions 
       SET dados_lead = $1, client_name = $2, last_interaction = now()
       WHERE id = $3`,
      [JSON.stringify(dadosLead), nome.trim(), sessionId]
    );

    // 2. Busca configurações do tenant para disparo de notificação humana
    const configRes = await query(
      `SELECT t.nome_empresa, c.whatsapp_notificacao_humana
       FROM tenants t
       LEFT JOIN tenant_ai_configs c ON c.tenant_id = t.id
       WHERE t.id = $1`,
      [tenantId]
    );

    const tenantInfo = configRes.rows[0];
    const notifPhone = tenantInfo?.whatsapp_notificacao_humana;
    let notifSent = false;

    if (notifPhone && notifPhone.trim()) {
      const cleanPhone = notifPhone.replace(/\D/g, '');
      const clientPhone = remoteJid.replace(/@.*$/, '').replace(/\D/g, '');

      const alertMessage = 
`🚨 *NOVO LEAD QUALIFICADO (IA)* 🚨
━━━━━━━━━━━━━━━━━━━━━━━━━━
🏢 *Empresa:* ${tenantInfo.nome_empresa}
👤 *Cliente:* ${nome}
📱 *WhatsApp:* +${clientPhone}
🛠️ *Serviço:* ${servico}
📍 *Local:* ${bairro_cidade}
⚡ *Urgência:* ${urgencia.toUpperCase()}
📝 *Detalhes:* ${detalhes || 'Nenhuma observação extra informada.'}
⏰ *Data/Hora:* ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}
━━━━━━━━━━━━━━━━━━━━━━━━━━
_Lead salvo no banco de dados e disponível no Painel Multi-Tenant._`;

      try {
        const sendAlertRes = await evolutionService.sendTextMessage(instanceName, cleanPhone, alertMessage);
        if (sendAlertRes.messageId) {
          await messageCache.setBotSent(sendAlertRes.messageId, 60);
          notifSent = true;
          console.log(`[AIEngine] Alerta de lead enviado com sucesso para a equipe técnica (+${cleanPhone})!`);
        }
      } catch (alertErr) {
        console.warn(`[AIEngine] Falha ao enviar notificação para +${cleanPhone}:`, alertErr.message);
      }
    }

    return {
      success: true,
      message: 'Lead qualificado com sucesso! Os dados foram salvos e a equipe técnica foi notificada.',
      notifSent,
      lead: dadosLead
    };
  }

  /**
   * Processa a rodada de atendimento (turn) da IA para a mensagem do cliente
   */
  async processTurn({ tenantId, instanceName, sessionId, remoteJid, pushName, userMessage }) {
    // 1. Carrega dados do Tenant e Configuração de IA
    const tenantRes = await query(`SELECT id, nome_empresa, plano FROM tenants WHERE id = $1`, [tenantId]);
    if (tenantRes.rowCount === 0) throw new Error(`Tenant não encontrado: ${tenantId}`);
    const tenant = tenantRes.rows[0];

    const aiConfigRes = await query(`SELECT * FROM tenant_ai_configs WHERE tenant_id = $1`, [tenantId]);
    const aiConfig = aiConfigRes.rows[0] || {};

    const sessionRes = await query(`SELECT * FROM chat_sessions WHERE id = $1`, [sessionId]);
    const session = sessionRes.rows[0] || {};

    // 2. Compila System Prompt Dinâmico
    const systemPrompt = promptCompiler.compileSystemPrompt(tenant, aiConfig, session);

    // 3. Carrega Histórico Recente limitado estritamente a 10 mensagens
    const historyRes = await query(
      `SELECT role, content 
       FROM chat_messages 
       WHERE session_id = $1 
       ORDER BY created_at DESC 
       LIMIT 10`,
      [sessionId]
    );

    // Reverte para ordem cronológica (mais antiga -> mais nova)
    const historyMessages = historyRes.rows.reverse().map(m => ({
      role: m.role === 'tool' ? 'tool' : m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    }));

    // Monta mensagens para a API OpenAI
    const messagesToSend = [
      { role: 'system', content: systemPrompt },
      ...historyMessages
    ];

    // Se a última mensagem do histórico não for a userMessage atual, adiciona
    const lastMsg = messagesToSend[messagesToSend.length - 1];
    if (!lastMsg || lastMsg.role !== 'user' || lastMsg.content !== userMessage) {
      messagesToSend.push({ role: 'user', content: userMessage });
    }

    console.log(`[AIEngine] Chamando OpenAI (gpt-4o-mini) para ${remoteJid} com histórico de ${historyMessages.length} msgs...`);

    let toolCallCount = 0;
    let finalAssistantText = '';

    // Loop de chamada de ferramentas (até no máximo 3 iterações)
    while (toolCallCount < 3) {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: messagesToSend,
        tools: TOOLS_DEFINITIONS,
        tool_choice: 'auto',
        temperature: 0.3
      });

      const responseMessage = response.choices[0].message;

      // O modelo decidiu chamar uma ferramenta?
      if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
        toolCallCount++;
        messagesToSend.push(responseMessage);

        for (const toolCall of responseMessage.tool_calls) {
          const fnName = toolCall.function.name;
          let fnArgs = {};
          try {
            fnArgs = JSON.parse(toolCall.function.arguments);
          } catch (e) {
            fnArgs = {};
          }

          let toolResult = { success: false, error: 'Ferramenta desconhecida' };

          if (fnName === 'salvar_lead_qualificado') {
            toolResult = await this.executeQualificationTool({
              tenantId,
              instanceName,
              sessionId,
              remoteJid,
              args: fnArgs
            });
          }

          messagesToSend.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult)
          });
        }
      } else {
        // Resposta de texto final para o cliente
        finalAssistantText = responseMessage.content || '';
        break;
      }
    }

    if (!finalAssistantText || !finalAssistantText.trim()) {
      console.warn('[AIEngine] LLM não retornou texto final legível.');
      return null;
    }

    // 4. Envia resposta ao WhatsApp via Evolution API
    console.log(`[AIEngine] Enviando resposta da IA para ${remoteJid}...`);
    const sendRes = await evolutionService.sendTextMessage(instanceName, remoteJid, finalAssistantText);

    if (sendRes.messageId) {
      // 5. Grava no Cache Anti-Loop (TTL 60s)
      await messageCache.setBotSent(sendRes.messageId, 60);

      // 6. Salva no banco de dados na tabela chat_messages
      await query(
        `INSERT INTO chat_messages (session_id, tenant_id, role, content, message_id)
         VALUES ($1, $2, 'assistant', $3, $4)`,
        [sessionId, tenantId, finalAssistantText.trim(), sendRes.messageId]
      );

      // 7. Atualiza interação na sessão
      await query(`UPDATE chat_sessions SET last_interaction = now() WHERE id = $1`, [sessionId]);

      console.log(`[AIEngine] Resposta enviada e persistida com sucesso (messageId: ${sendRes.messageId}).`);
    }

    return {
      success: true,
      messageId: sendRes.messageId,
      replyText: finalAssistantText
    };
  }
}

module.exports = new AiEngineService();
module.exports.AiEngineService = AiEngineService;
module.exports.TOOLS_DEFINITIONS = TOOLS_DEFINITIONS;
