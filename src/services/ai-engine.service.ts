// ==============================================================================
// SAAS MULTI-TENANT ENGINE - AI ENGINE & FUNCTION CALLING SERVICE (TYPESCRIPT)
// Dynamic Prompt Compiler, 10-message conversational window, tool calling
// ==============================================================================

import OpenAI from 'openai';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { query } from '../database/db';
import { evolutionService } from './evolution.service';
import { messageCache } from './message-cache.service';
import { promptCompiler } from './prompt-compiler.service';
import { CustomerService } from './customer.service';
import {
  Tenant,
  TenantAiConfig,
  ChatSession,
  ChatMessage
} from '../types/database.types';
import { AITurnInput } from '../types/evolution.types';
import {
  LeadQualificationArgs,
  LeadQualificationResult,
  StructuredLeadData,
  TurnProcessingOptions,
  TurnProcessingResult
} from '../types/ai.types';

const envPath = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

/**
 * Definição formal da Tool Obrigatória de Qualificação
 */
export const QUALIFICATION_TOOL: OpenAI.Chat.Completions.ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'salvar_lead_qualificado',
    description: 'Salva os dados de qualificação do lead (nome, serviço de interesse, bairro/cidade, urgência e detalhes) e dispara alerta estruturado para o WhatsApp da equipe técnica.',
    parameters: {
      type: 'object',
      properties: {
        nome: {
          type: 'string',
          description: 'Nome completo ou primeiro nome do cliente identificado na conversa'
        },
        servico: {
          type: 'string',
          description: 'Serviço desejado (ex: Instalação de CFTV, Manutenção de Câmeras, Configuração de Acesso Remoto)'
        },
        bairro_cidade: {
          type: 'string',
          description: 'Bairro e cidade onde o serviço será realizado (ex: Barreiro / Belo Horizonte)'
        },
        urgencia: {
          type: 'string',
          enum: ['baixa', 'media', 'alta', 'imediata'],
          description: 'Nível de urgência informado pelo cliente'
        },
        detalhes: {
          type: 'string',
          description: 'Observações complementares (quantidade de câmeras, modelo, problema relatado, restrições de horário)'
        }
      },
      required: ['nome', 'servico', 'bairro_cidade']
    }
  }
};

export class AiEngineService {
  private openai: OpenAI | null = null;

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey && apiKey.startsWith('sk-')) {
      this.openai = new OpenAI({ apiKey });
    }
  }

  /**
   * Executa a Tool de Qualificação Obrigatória:
   * 1. Atualiza chat_sessions.dados_lead
   * 2. Atualiza dossiê cumulativo em customer_profiles
   * 3. Dispara alerta estruturado para whatsapp_notificacao_humana
   */
  public async executeQualificationTool(params: {
    tenantId: string;
    instanceName: string;
    sessionId: string;
    remoteJid: string;
    args: LeadQualificationArgs;
  }): Promise<LeadQualificationResult> {
    const { tenantId, instanceName, sessionId, remoteJid, args } = params;
    const {
      nome,
      servico,
      bairro_cidade,
      urgencia = 'media',
      detalhes = ''
    } = args;

    console.log(`🎯 [AIEngine] Executando tool salvar_lead_qualificado para ${nome} (${remoteJid})...`);

    const structuredLead: StructuredLeadData = {
      nome: nome.trim(),
      servico: servico.trim(),
      bairro_cidade: bairro_cidade.trim(),
      urgencia,
      detalhes: detalhes ? detalhes.trim() : '',
      qualificado_em: new Date().toISOString()
    };

    // 1. Atualiza dados_lead na sessão do chat
    await query(
      `UPDATE chat_sessions 
       SET dados_lead = $1::jsonb, last_interaction = NOW()
       WHERE id = $2;`,
      [JSON.stringify(structuredLead), sessionId]
    );

    // 2. Atualiza dossiê de longo prazo em customer_profiles
    await CustomerService.findOrCreateProfile(tenantId, remoteJid, {
      nome: nome.trim(),
      telefone: remoteJid.replace(/@.*$/, ''),
      endereco_completo: bairro_cidade.trim()
    });

    await CustomerService.appendToDossier(
      tenantId,
      remoteJid,
      `Lead qualificado para ${servico.trim()} em ${bairro_cidade.trim()} (Urgência: ${urgencia}). Detalhes: ${detalhes || 'N/A'}`,
      { ultimo_lead: structuredLead }
    );

    // 3. Busca telefone de notificação humana configurado no tenant_ai_configs
    const configRes = await query<{ nome_empresa: string; whatsapp_notificacao_humana: string | null }>(
      `SELECT t.nome_empresa, c.whatsapp_notificacao_humana
       FROM tenants t
       LEFT JOIN tenant_ai_configs c ON c.tenant_id = t.id
       WHERE t.id = $1;`,
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
_Lead gravado no banco de dados e sincronizado no CRM Multi-Tenant._`;

      try {
        const sendAlertRes = await evolutionService.sendTextMessage(instanceName, cleanPhone, alertMessage);
        if (sendAlertRes.messageId) {
          await messageCache.setBotSent(sendAlertRes.messageId, 60);
          notifSent = true;
          console.log(`📢 [AIEngine] Alerta de lead qualificado enviado para a equipe técnica (+${cleanPhone})!`);
        }
      } catch (alertErr: any) {
        console.warn(`⚠️ [AIEngine] Falha ao enviar notificação humana para +${cleanPhone}:`, alertErr.message);
      }
    }

    return {
      success: true,
      message: 'Lead qualificado com sucesso! Dados armazenados no CRM e notificação enviada.',
      notifSent,
      lead: structuredLead
    };
  }

  /**
   * Processa a rodada completa de atendimento da IA para a mensagem do cliente
   */
  public async processTurn(
    turn: AITurnInput,
    options: TurnProcessingOptions = {}
  ): Promise<TurnProcessingResult> {
    const { tenantId, instanceName, sessionId, remoteJid, userMessage } = turn;

    // 1. Carrega dados do Tenant, Configurações de IA e Sessão
    const tenantRes = await query<Tenant>(
      `SELECT id, nome_empresa, documento, plano, limite_conversas_mes, ativo, created_at, updated_at 
       FROM tenants WHERE id = $1;`,
      [tenantId]
    );
    if (tenantRes.rows.length === 0) {
      throw new Error(`Tenant não encontrado: ${tenantId}`);
    }
    const tenant = tenantRes.rows[0];

    const aiConfigRes = await query<TenantAiConfig>(
      `SELECT tenant_id, tom_de_voz, sobre_empresa, servicos_oferecidos, servicos_recusados, regras_agendamento, whatsapp_notificacao_humana, pausa_automatica_minutos, updated_at
       FROM tenant_ai_configs WHERE tenant_id = $1;`,
      [tenantId]
    );
    const aiConfig = aiConfigRes.rows[0] || {
      tenant_id: tenantId,
      tom_de_voz: 'profissional_amigavel',
      sobre_empresa: 'Empresa especializada em soluções tecnológicas.',
      servicos_oferecidos: [],
      servicos_recusados: null,
      regras_agendamento: {},
      pausa_automatica_minutos: 45,
      updated_at: new Date()
    };

    const sessionRes = await query<ChatSession>(
      `SELECT id, tenant_id, remote_jid, status_atendimento, paused_until, dados_lead, last_interaction 
       FROM chat_sessions WHERE id = $1;`,
      [sessionId]
    );
    const session = sessionRes.rows[0] || {
      id: sessionId,
      tenant_id: tenantId,
      remote_jid: remoteJid,
      status_atendimento: 'ia_ativa',
      dados_lead: {},
      last_interaction: new Date()
    };

    // 2. Carrega dossiê permanente e agendamentos anteriores
    const customerHistory = await CustomerService.getCustomerHistory(tenantId, remoteJid);

    // 3. Compila System Prompt Dinâmico com todo o contexto do Tenant e Dossiê
    const systemPrompt = promptCompiler.compileSystemPrompt(
      tenant,
      aiConfig,
      session,
      customerHistory.profile,
      customerHistory.appointments
    );

    // 4. Carrega Histórico Recente limitado estritamente a 10 mensagens
    const historyRes = await query<ChatMessage>(
      `SELECT role, content 
       FROM chat_messages 
       WHERE session_id = $1 
       ORDER BY created_at DESC 
       LIMIT 10;`,
      [sessionId]
    );

    // Reverte para ordem cronológica (mais antiga -> mais recente)
    const historyMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = historyRes.rows.reverse().map((m) => {
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      return {
        role,
        content: m.content
      };
    });

    const messagesToSend: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...historyMessages
    ];

    // Garante que a mensagem mais recente do usuário esteja presente no final
    const lastMsg = messagesToSend[messagesToSend.length - 1];
    if (!lastMsg || lastMsg.role !== 'user' || lastMsg.content !== userMessage) {
      messagesToSend.push({ role: 'user', content: userMessage });
    }

    console.log(`🤖 [AIEngine] Invocando LLM para ${remoteJid} (Janela: ${historyMessages.length} msgs)...`);

    const toolCallsExecuted: string[] = [];
    let finalAssistantText = '';

    // Se o cliente OpenAI estiver configurado, processa completions com function calling
    if (this.openai) {
      try {
        let toolCallCount = 0;
        const maxIterations = options.maxToolIterations || 3;

        while (toolCallCount < maxIterations) {
          const completion = await this.openai.chat.completions.create({
            model: options.model || 'gpt-4o-mini',
            messages: messagesToSend,
            tools: [QUALIFICATION_TOOL],
            tool_choice: 'auto',
            temperature: options.temperature || 0.3
          });

          const responseMessage = completion.choices[0]?.message;
          if (!responseMessage) break;

          if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
            toolCallCount++;
            messagesToSend.push(responseMessage);

            for (const toolCall of responseMessage.tool_calls) {
              const fnName = toolCall.function.name;
              toolCallsExecuted.push(fnName);

              let fnArgs: any = {};
              try {
                fnArgs = JSON.parse(toolCall.function.arguments);
              } catch {
                fnArgs = {};
              }

              let toolResult: any = { success: false, error: 'Ferramenta desconhecida' };

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
            finalAssistantText = responseMessage.content || '';
            break;
          }
        }
      } catch (llmError: any) {
        console.warn('⚠️ [AIEngine] Erro na chamada à OpenAI:', llmError.message);
        finalAssistantText = `Olá! Agradecemos o seu contato com a ${tenant.nome_empresa}. Como posso ajudar você hoje com nossos serviços?`;
      }
    } else {
      // Modo offline determinístico
      finalAssistantText = `Olá! Sou a assistente virtual da ${tenant.nome_empresa}. Nossos serviços incluem: CFTV, Segurança e Atendimento. Como posso te ajudar?`;
    }

    if (!finalAssistantText || !finalAssistantText.trim()) {
      finalAssistantText = `Olá! Como posso ajudar você hoje com os serviços da ${tenant.nome_empresa}?`;
    }

    // 5. Envia resposta ao WhatsApp via Evolution API
    console.log(`📤 [AIEngine] Enviando resposta para ${remoteJid}...`);
    const sendRes = await evolutionService.sendTextMessage(instanceName, remoteJid, finalAssistantText);

    if (sendRes.messageId) {
      // 6. Registra no Cache Anti-Loop (TTL 60s)
      await messageCache.setBotSent(sendRes.messageId, 60);

      // 7. Persiste a mensagem do assistente no banco
      await query(
        `INSERT INTO chat_messages (session_id, tenant_id, role, content, message_id)
         VALUES ($1, $2, 'assistant', $3, $4);`,
        [sessionId, tenantId, finalAssistantText.trim(), sendRes.messageId]
      );

      // 8. Atualiza horário da última interação
      await query(`UPDATE chat_sessions SET last_interaction = NOW() WHERE id = $1;`, [sessionId]);
    }

    return {
      success: true,
      messageId: sendRes.messageId,
      replyText: finalAssistantText,
      toolCallsExecuted
    };
  }
}

export const aiEngineService = new AiEngineService();
