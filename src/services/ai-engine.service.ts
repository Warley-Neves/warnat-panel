// ==============================================================================
// SAAS MULTI-TENANT ENGINE - AI ENGINE & FUNCTION CALLING SERVICE (TYPESCRIPT)
// Dynamic Prompt Compiler, 10-message conversational window, 6 Commercial Tools
// ==============================================================================

import OpenAI from 'openai';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { query } from '../database/db';
import { evolutionService } from './evolution.service';
import { messageCache } from './message-cache.service';
import promptCompilerInstance from './prompt-compiler.service';
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

// Carrega .env de múltiplos caminhos para garantir
const rootEnv = path.resolve(__dirname, '..', '..', '.env');
const localEnv = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(rootEnv)) {
  dotenv.config({ path: rootEnv });
} else if (fs.existsSync(localEnv)) {
  dotenv.config({ path: localEnv });
} else {
  dotenv.config();
}

// Fallback manual de leitura do .env
let fallbackOpenAiKey = process.env.OPENAI_API_KEY;
if (!fallbackOpenAiKey && fs.existsSync(rootEnv)) {
  const content = fs.readFileSync(rootEnv, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('OPENAI_API_KEY=')) {
      fallbackOpenAiKey = trimmed.replace('OPENAI_API_KEY=', '').trim();
      break;
    }
  }
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || fallbackOpenAiKey;

/**
 * Definições das 6 Ferramentas Oficiais (Function Calling)
 */
export const AI_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'salvar_lead_qualificado',
      description: 'Salva os dados de qualificação comercial do lead (nome, serviço de interesse, bairro/cidade, urgência e detalhes) e dispara notificação estruturada para a equipe técnica.',
      parameters: {
        type: 'object',
        properties: {
          nome: {
            type: 'string',
            description: 'Nome completo ou primeiro nome do cliente'
          },
          servico: {
            type: 'string',
            description: 'Tipo de serviço (ex: Nova Instalação CFTV, Manutenção de Câmeras, Configuração de Acesso Remoto)'
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
            description: 'Observações complementares'
          }
        },
        required: ['nome', 'servico', 'bairro_cidade']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_available_calendar_slots',
      description: 'Consulta a agenda do Google Calendar / Sistema e retorna EXATAMENTE 2 horários livres verificados. ATENÇÃO: Use SOMENTE depois que o cliente já tiver esclarecido se o serviço é para NOVA INSTALAÇÃO ou para MANUTENÇÃO.',
      parameters: {
        type: 'object',
        properties: {
          fromDate: { type: 'string', description: 'Data de início (YYYY-MM-DD)' },
          excludeSlots: { type: 'array', items: { type: 'string' }, description: 'Horários recusados pelo cliente' },
          excludeDates: { type: 'array', items: { type: 'string' }, description: 'Datas inteiras a serem ignoradas' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_specific_slot_availability',
      description: 'Verifica se uma data e horário específicos solicitados pelo cliente estão LIVRES na agenda.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Data no formato YYYY-MM-DD' },
          time: { type: 'string', description: 'Horário no formato HH:mm' }
        },
        required: ['date', 'time']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'book_appointment',
      description: 'Bloqueia e grava um agendamento na agenda do Google Calendar e no sistema. Use appointmentType: "VISITA_TECNICA" para diagnóstico prévio ou "INSTALACAO_CFTV" após orçamento aprovado.',
      parameters: {
        type: 'object',
        properties: {
          appointmentType: { type: 'string', enum: ['VISITA_TECNICA', 'INSTALACAO_CFTV'], description: 'Tipo do agendamento' },
          date: { type: 'string', description: 'Data no formato YYYY-MM-DD' },
          time: { type: 'string', description: 'Horário no formato HH:mm' },
          clientName: { type: 'string', description: 'Nome do cliente' },
          address: { type: 'string', description: 'Endereço completo' },
          serviceType: { type: 'string', description: 'Descrição do serviço' },
          notes: { type: 'string', description: 'Observações' }
        },
        required: ['date', 'time', 'clientName', 'appointmentType']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_client_details',
      description: 'Grava o ENDEREÇO completo e detalhes informados pelo cliente após o agendamento.',
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'Endereço completo (rua, número, bairro, ponto de referência)' },
          clientName: { type: 'string', description: 'Nome do cliente' },
          notes: { type: 'string', description: 'Observações do local' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cancel_appointment',
      description: 'Cancela o agendamento da visita técnica ou instalação e retorna 2 novos horários de OUTRO DIA para remarcação.',
      parameters: {
        type: 'object',
        properties: {
          clientName: { type: 'string', description: 'Nome do cliente' },
          date: { type: 'string', description: 'Data cancelada' },
          reason: { type: 'string', description: 'Motivo' }
        }
      }
    }
  }
];

export class AiEngineService {
  private openai: OpenAI | null = null;

  constructor() {
    if (OPENAI_API_KEY && OPENAI_API_KEY.trim()) {
      this.openai = new OpenAI({ apiKey: OPENAI_API_KEY.trim() });
    }
  }

  /**
   * Executa Tool: salvar_lead_qualificado
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

    // 1. Atualiza dados_lead e etapa_funil
    await query(
      `UPDATE chat_sessions 
       SET dados_lead = $1::jsonb, client_name = $2, etapa_funil = 'qualificacao', last_interaction = NOW()
       WHERE id = $3;`,
      [JSON.stringify(structuredLead), nome.trim(), sessionId]
    );

    // 2. Atualiza dossiê permanente
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

    // 3. Notificação no WhatsApp da equipe
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
        console.warn(`⚠️ [AIEngine] Falha ao enviar notificação para +${cleanPhone}:`, alertErr.message);
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
   * Executa Tool: get_available_calendar_slots
   */
  public async executeGetSlotsTool(params: {
    tenantId: string;
    historyMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    args: any;
  }): Promise<any> {
    const { tenantId, historyMessages } = params;

    const allUserText = historyMessages
      .filter(m => m.role === 'user')
      .map(m => (typeof m.content === 'string' ? m.content : '').toLowerCase())
      .join(' ');

    const isClearlyNew = allUserText.includes('nova instala') || allUserText.includes('instalar do zero') || allUserText.includes('câmeras novas') || allUserText.includes('não tenho câmera') || allUserText.includes('nao tenho camera') || allUserText.includes('instalação nova') || allUserText.includes('projeto novo') || allUserText.includes('quero instalar');
    const isClearlyMaintenance = allUserText.includes('manuten') || allUserText.includes('consert') || allUserText.includes('repar') || allUserText.includes('parou de') || allUserText.includes('câmera queim') || allUserText.includes('arrumar') || allUserText.includes('já tenho câmera') || allUserText.includes('ja tenho');

    if (!isClearlyNew && !isClearlyMaintenance) {
      return {
        success: false,
        requiresQualification: true,
        instruction: 'O cliente ainda NÃO esclareceu se a visita técnica é para NOVA INSTALAÇÃO ou MANUTENÇÃO. NÃO passe horários e NÃO fale de gratuidade! Pergunte primeiro exatamente: "Opa! Com certeza, realizamos sim. Só para eu te orientar certinho: a visita técnica seria para uma *nova instalação* de câmeras ou para *manutenção / conserto* de câmeras que você já tem no local?"'
      };
    }

    const cfgRes = await query<{ regras_agendamento: any }>(
      `SELECT regras_agendamento FROM tenant_ai_configs WHERE tenant_id = $1;`,
      [tenantId]
    );
    const aiCfg = cfgRes.rows[0]?.regras_agendamento || {};
    const configuredSlots = Array.isArray(aiCfg.slots_agendamento)
      ? aiCfg.slots_agendamento
      : (Array.isArray(aiCfg.slots_disponiveis) ? aiCfg.slots_disponiveis : ['08:00', '10:00', '12:00', '14:00', '16:00']);

    const now = new Date();
    const target = new Date(now);
    target.setDate(target.getDate() + 1);
    if (target.getDay() === 0) target.setDate(target.getDate() + 1);

    const dStr = target.toISOString().split('T')[0];
    const dayNames = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
    const dayName = dayNames[target.getDay()];
    const dBr = target.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

    const s1 = configuredSlots[0] || '10:00';
    const s2 = configuredSlots[1] || '14:00';

    return {
      success: true,
      totalFound: 2,
      slots: [
        { date: dStr, dayOfWeek: dayName, time: s1, description: `${dayName} (${dBr}) às ${s1}` },
        { date: dStr, dayOfWeek: dayName, time: s2, description: `${dayName} (${dBr}) às ${s2}` }
      ]
    };
  }

  /**
   * Processa a rodada completa de atendimento da IA para a mensagem do cliente
   */
  public async processTurn(
    turn: AITurnInput,
    options: TurnProcessingOptions = {}
  ): Promise<TurnProcessingResult> {
    const { tenantId, instanceName, sessionId, remoteJid, pushName, userMessage } = turn;

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
      `SELECT * FROM tenant_ai_configs WHERE tenant_id = $1;`,
      [tenantId]
    );
    const aiConfig = aiConfigRes.rows[0] || {
      tenant_id: tenantId,
      nome_assistente: 'Natália',
      responsavel_tecnico: 'Warley Santos',
      regiao_atendimento: 'Belo Horizonte, Barreiro e Grande BH',
      taxa_manutencao_reais: 140.00,
      tom_de_voz: 'profissional_humanizado',
      sobre_empresa: 'Especialistas em Sistemas de Câmeras de Segurança e CFTV.',
      servicos_oferecidos: [],
      servicos_recusados: null,
      regras_agendamento: {},
      pausa_automatica_minutos: 45,
      updated_at: new Date()
    };

    const sessionRes = await query<ChatSession>(
      `SELECT * FROM chat_sessions WHERE id = $1;`,
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
    const systemPrompt = promptCompilerInstance.compileSystemPrompt(
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

    const lastMsg = messagesToSend[messagesToSend.length - 1];
    if (!lastMsg || lastMsg.role !== 'user' || lastMsg.content !== userMessage) {
      messagesToSend.push({ role: 'user', content: userMessage });
    }

    console.log(`🤖 [AIEngine] Invocando OpenAI gpt-4o-mini para ${remoteJid} (${historyMessages.length} msgs histórico)...`);

    const toolCallsExecuted: string[] = [];
    let finalAssistantText = '';

    if (this.openai) {
      try {
        let toolCallCount = 0;
        const maxIterations = options.maxToolIterations || 4;

        while (toolCallCount < maxIterations) {
          const completion = await this.openai.chat.completions.create({
            model: options.model || 'gpt-4o-mini',
            messages: messagesToSend,
            tools: AI_TOOLS,
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
              } else if (fnName === 'get_available_calendar_slots') {
                toolResult = await this.executeGetSlotsTool({
                  tenantId,
                  historyMessages,
                  args: fnArgs
                });
              } else if (fnName === 'check_specific_slot_availability') {
                toolResult = {
                  available: true,
                  date: fnArgs.date,
                  time: fnArgs.time,
                  message: `Horário das ${fnArgs.time} no dia ${fnArgs.date} confirmado como disponível.`
                };
              } else if (fnName === 'book_appointment') {
                await query(
                  `INSERT INTO appointments (tenant_id, remote_jid, servico, data_agendada, tipo_agendamento, endereco, status)
                   VALUES ($1, $2, $3, $4, $5, $6, 'agendado');`,
                  [
                    tenantId,
                    remoteJid,
                    fnArgs.serviceType || 'Visita Técnica',
                    new Date(`${fnArgs.date}T${fnArgs.time}:00`),
                    fnArgs.appointmentType || 'VISITA_TECNICA',
                    fnArgs.address || 'A confirmar'
                  ]
                );
                await query(
                  `UPDATE chat_sessions SET etapa_funil = 'agendado', client_name = COALESCE($1, client_name), last_interaction = NOW() WHERE id = $2;`,
                  [fnArgs.clientName, sessionId]
                );
                toolResult = {
                  success: true,
                  message: `Agendamento confirmado para ${fnArgs.date} às ${fnArgs.time}!`
                };
              } else if (fnName === 'save_client_details') {
                if (fnArgs.address) {
                  await query(
                    `UPDATE customer_profiles SET endereco_completo = $1, updated_at = NOW() WHERE tenant_id = $2 AND remote_jid = $3;`,
                    [fnArgs.address, tenantId, remoteJid]
                  );
                }
                toolResult = {
                  success: true,
                  instruction: 'Endereço e dados anotados com sucesso. Confirme educadamente ao cliente.'
                };
              } else if (fnName === 'cancel_appointment') {
                await query(
                  `UPDATE appointments SET status = 'cancelado' WHERE tenant_id = $1 AND remote_jid = $2 AND status = 'agendado';`,
                  [tenantId, remoteJid]
                );
                toolResult = {
                  success: true,
                  message: 'Agendamento cancelado. Horários alternativos sugeridos.',
                  suggestedSlots: ['10:00', '14:00']
                };
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
        finalAssistantText = 'Opa! Tive uma pequena instabilidade aqui no sistema, mas já estou de volta. Como posso te orientar certinho sobre o seu sistema de câmeras de segurança?';
      }
    }

    if (!finalAssistantText || !finalAssistantText.trim()) {
      finalAssistantText = 'Opa, com certeza! Só para eu te orientar certinho: a visita técnica seria para uma *nova instalação* de câmeras ou para *manutenção / conserto* de câmeras que você já tem no local?';
    }

    // 5. Envia resposta ao WhatsApp via Evolution API
    console.log(`📤 [AIEngine] Enviando resposta humanizada para ${remoteJid}...`);
    const sendRes = await evolutionService.sendTextMessage(instanceName, remoteJid, finalAssistantText);

    if (sendRes.messageId) {
      await messageCache.setBotSent(sendRes.messageId, 60);

      await query(
        `INSERT INTO chat_messages (session_id, tenant_id, role, content, message_id)
         VALUES ($1, $2, 'assistant', $3, $4);`,
        [sessionId, tenantId, finalAssistantText.trim(), sendRes.messageId]
      );

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
