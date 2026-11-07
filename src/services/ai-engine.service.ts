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
import { ttsService } from './tts.service';
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

export const DIAS_SEMANA_NOMES = [
  'Domingo',
  'Segunda-feira',
  'Terça-feira',
  'Quarta-feira',
  'Quinta-feira',
  'Sexta-feira',
  'Sábado'
];

export const DIAS_SEMANA_SLUGS: string[] = [
  'domingo',
  'segunda',
  'terca',
  'quarta',
  'quinta',
  'sexta',
  'sabado'
];

export const DIA_KEY_TO_INDEX: Record<string, number> = {
  domingo: 0,
  dom: 0,
  segunda: 1,
  seg: 1,
  'segunda-feira': 1,
  terca: 2,
  terça: 2,
  ter: 2,
  'terca-feira': 2,
  'terça-feira': 2,
  quarta: 3,
  qua: 3,
  'quarta-feira': 3,
  quinta: 4,
  qui: 4,
  'quinta-feira': 4,
  sexta: 5,
  sex: 5,
  'sexta-feira': 5,
  sabado: 6,
  sábado: 6,
  sab: 6,
  'sabado-feira': 6
};

export function parseLocalDate(dateInput: any): Date {
  if (!dateInput) {
    const fallback = new Date();
    fallback.setHours(12, 0, 0, 0);
    return fallback;
  }
  if (dateInput instanceof Date && !isNaN(dateInput.getTime())) {
    return new Date(dateInput.getFullYear(), dateInput.getMonth(), dateInput.getDate(), 12, 0, 0, 0);
  }
  const dateStr = String(dateInput).trim();
  const isoMatch = dateStr.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    const y = parseInt(isoMatch[1], 10);
    const m = parseInt(isoMatch[2], 10) - 1;
    const d = parseInt(isoMatch[3], 10);
    return new Date(y, m, d, 12, 0, 0, 0);
  }
  const brMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (brMatch) {
    const d = parseInt(brMatch[1], 10);
    const m = parseInt(brMatch[2], 10) - 1;
    const y = parseInt(brMatch[3], 10);
    return new Date(y, m, d, 12, 0, 0, 0);
  }
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) {
    return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 12, 0, 0, 0);
  }
  const fallback = new Date();
  fallback.setHours(12, 0, 0, 0);
  return fallback;
}

export function getDayOfWeekInfo(dateInput: any): {
  dateObj: Date;
  isoDate: string;
  dayIndex: number;
  dayOfWeek: string;
  formattedBr: string;
} {
  const d = parseLocalDate(dateInput);
  const dayIndex = d.getDay();
  const dayOfWeek = DIAS_SEMANA_NOMES[dayIndex];
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const isoDate = `${year}-${month}-${day}`;
  const formattedBr = `${day}/${month}`;
  return { dateObj: d, isoDate, dayIndex, dayOfWeek, formattedBr };
}

/**
 * Padrões de regex para identificar quando o cliente quer outra data / outro dia / outro sábado
 */
export const ANOTHER_DATE_INTENTS = [
  /outro\s+dia/i,
  /outra\s+data/i,
  /outro\s+s[aá]bado/i,
  /outros?\s+dias?/i,
  /outras?\s+datas?/i,
  /outra\s+semana/i,
  /semana\s+que\s+vem/i,
  /pr[oó]xim[ao]\s+semana/i,
  /pr[oó]xim[ao]\s+s[aá]bado/i,
  /pr[oó]xim[ao]\s+fim\s+de\s+semana/i,
  /pr[oó]xim[ao]\s+final\s+de\s+semana/i,
  /mais\s+pra\s+frente/i,
  /mais\s+para\s+frente/i,
  /mais\s+adiante/i,
  /mais\s+al[eé]m/i,
  /mudar\s+(de\s+)?data/i,
  /trocar\s+(de\s+)?data/i,
  /data\s+diferente/i,
  /dia\s+diferente/i,
  /tem\s+outro\s+dia/i,
  /tem\s+outra\s+data/i,
  /tem\s+outro\s+s[aá]bado/i,
  /algum\s+outro\s+dia/i,
  /alguma\s+outra\s+data/i,
  /n[aã]o\s+posso\s+(no|nesse|naquele|neste|nessa|nesta)\s+(dia|data|s[aá]bado|semana)/i,
  /n[aã]o\s+d[aá]\s+(no|nesse|naquele|neste|nessa|nesta)\s+(dia|data|s[aá]bado|semana)/i,
  /n[aã]o\s+consigo\s+(no|nesse|naquele|neste|nessa|nesta)\s+(dia|data|s[aá]bado|semana)/i,
  /n[aã]o\s+posso\s+dia/i,
  /n[aã]o\s+posso\s+no\s+dia/i,
  /n[aã]o\s+d[aá]\s+dia/i,
  /n[aã]o\s+d[aá]\s+no\s+dia/i,
  /n[aã]o\s+consigo\s+dia/i,
  /n[aã]o\s+consigo\s+no\s+dia/i,
  /ocupad[ao]\s+(no|nesse|naquele|neste)\s+(dia|s[aá]bado)/i,
  /indispon[ií]vel\s+(no|nesse|naquele|neste)\s+(dia|s[aá]bado)/i,
  /sem\s+disponibilidade\s+(no|nesse|naquele|neste)\s+(dia|s[aá]bado)/i,
  /n[aã]o\s+tenho\s+como\s+(no|nesse|naquele|neste|nessa|nesta)\s+(dia|data|s[aá]bado|semana)/i,
  /n[aã]o\s+tenho\s+disponibilidade\s+(no|nesse|naquele|neste|nessa|nesta)\s+(dia|data|s[aá]bado|semana)/i,
  /nesse\s+s[aá]bado\s+n[aã]o\s+(posso|d[aá]|consigo)/i,
  /nessa\s+data\s+n[aã]o\s+(posso|d[aá]|consigo)/i,
  /nesse\s+dia\s+n[aã]o\s+(posso|d[aá]|consigo)/i,
  /(dia|data|s[aá]bado)[\s\S]{0,15}n[aã]o\s+(d[aá]|posso|consigo)/i,
  /n[aã]o\s+(d[aá]|posso|consigo)[\s\S]{0,15}(dia|data|s[aá]bado)/i,
  /s[aá]bado\s+seguinte/i,
  /dia\s+seguinte/i,
  /semana\s+seguinte/i,
  /tem\s+outr[ao]\??$/i,
  /algum\s+outr[ao]\??$/i,
  /n[aã]o\s+posso\s+em\s+nenhum/i,
  /n[aã]o\s+posso\s+ness[ae]s/i,
  /n[aã]o\s+posso\s*,?\s*tem/i
];

/**
 * Extrai datas no formato YYYY-MM-DD e DD/MM de mensagens de texto
 */
export function extractDatesFromText(text: string): string[] {
  const dates: string[] = [];
  if (!text || typeof text !== 'string') return dates;
  const now = new Date();

  // YYYY-MM-DD
  const isoMatches = text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g);
  for (const m of isoMatches) {
    if (!dates.includes(m[0])) dates.push(m[0]);
  }

  // DD/MM/YYYY ou DD/MM
  const brMatches = text.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g);
  for (const m of brMatches) {
    const d = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
      let y = m[3] ? parseInt(m[3], 10) : now.getFullYear();
      if (y < 100) y += 2000;
      const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      if (!dates.includes(iso)) dates.push(iso);
    }
  }

  return dates;
}

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
  },
  {
    type: 'function',
    function: {
      name: 'consultar_historico_cliente',
      description: 'Consulta o histórico completo do cliente no banco de dados: visitas técnicas e instalações já marcadas (ativas), cumpridas no passado ou canceladas, além do endereço cadastrado. Use sempre que o cliente perguntar o que foi marcado, consultar visitas, alterar, remarcar ou confirmar informações anteriores.',
      parameters: {
        type: 'object',
        properties: {
          motivo_consulta: {
            type: 'string',
            description: 'Motivo da consulta ao histórico'
          }
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
   * Detecta se a mensagem indica intenção de cancelamento
   */
  public detectCancelRequest(text: string): boolean {
    if (!text) return false;
    const lower = text.toLowerCase().trim();

    // Se o cliente estiver pedindo outro dia/outra data, NÃO é cancelamento puro e sim reagendamento/troca de data
    if (
      lower.includes('outro dia') ||
      lower.includes('outra data') ||
      lower.includes('outro sábado') ||
      lower.includes('outro sabado') ||
      lower.includes('tem outro') ||
      lower.includes('tem outra') ||
      lower.includes('algum outro') ||
      lower.includes('alguma outra')
    ) {
      return false;
    }

    return (
      lower.includes('desmarqu') ||
      lower.includes('desmarca') ||
      lower.includes('cancel') ||
      lower.includes('não posso mais comparecer') ||
      lower.includes('nao posso mais comparecer') ||
      lower.includes('não vou poder comparecer') ||
      lower.includes('nao vou poder comparecer') ||
      lower.includes('não posso mais') ||
      lower.includes('nao posso mais')
    );
  }

  /**
   * Detecta se o cliente deseja consultar seus agendamentos / histórico
   */
  public detectConsultarHistoricoRequest(text: string): boolean {
    if (!text) return false;
    const lower = text.toLowerCase().trim();
    return (
      lower.includes('consultar agendamento') ||
      lower.includes('consultar agenda') ||
      lower.includes('meus agendamentos') ||
      lower.includes('minhas visitas') ||
      lower.includes('minha visita') ||
      lower.includes('o que foi marcado') ||
      lower.includes('o que está agendado') ||
      lower.includes('o que esta agendado') ||
      lower.includes('qual dia foi marcado') ||
      lower.includes('qual horário foi marcado') ||
      lower.includes('qual horario foi marcado') ||
      lower.includes('ver agendamento') ||
      lower.includes('minha agenda') ||
      lower.includes('visitas anteriores') ||
      lower.includes('visitas cumpridas') ||
      lower.includes('visitas canceladas')
    );
  }

  /**
   * Detecta se o cliente confirmou um agendamento ou horário específico
   */
  public detectBookingRequest(text: string, historyMessages: any[] = [], aiConfig: any = {}): { date: string; time: string } | null {
    if (!text) return null;
    const lower = text.toLowerCase().trim();

    if (this.detectCancelRequest(lower) || this.detectConsultarHistoricoRequest(lower)) {
      return null;
    }

    // Se o cliente estiver expressando recusa ou pedindo outro dia, NÃO é confirmação de agendamento
    const isRejectionOrAnotherDate = (
      lower.includes('não posso') ||
      lower.includes('nao posso') ||
      lower.includes('não dá') ||
      lower.includes('nao da') ||
      lower.includes('não consigo') ||
      lower.includes('nao consigo') ||
      lower.includes('outro dia') ||
      lower.includes('outra data') ||
      lower.includes('outro sábado') ||
      lower.includes('outro sabado') ||
      lower.includes('outros horários') ||
      lower.includes('outros horarios')
    );
    if (isRejectionOrAnotherDate) return null;

    const hasAffirmation = (
      lower.includes('pode ser') ||
      lower.includes('fechado') ||
      lower.includes('confirmo') ||
      lower.includes('confirmado') ||
      lower.includes('agendar') ||
      lower.includes('marca') ||
      lower.includes('vamos marcar') ||
      lower.includes('perfeito') ||
      lower.includes('combinado') ||
      lower.includes('prefiro') ||
      lower.includes('quero') ||
      lower.includes('às ') ||
      lower.includes('as ') ||
      lower.includes('pode marcar') ||
      lower.includes('fica bom') ||
      lower.includes('sábado') ||
      lower.includes('sabado')
    );

    const timeMatch = lower.match(/\b([01]?[0-9]|2[0-3])[:h]([0-5][0-9])\b/) || lower.match(/\b([01]?[0-9]|2[0-3])\s*h(?:oras)?\b/);
    if (!hasAffirmation && !timeMatch) {
      return null;
    }

    let targetTime = '08:00';
    if (timeMatch) {
      const h = timeMatch[1].padStart(2, '0');
      const m = timeMatch[2] ? timeMatch[2].padStart(2, '0') : '00';
      targetTime = `${h}:${m}`;
    }

    let targetDate: string | null = null;
    const dateMatchIso = lower.match(/\b(202[4-9])-(\d{2})-(\d{2})\b/);
    const dateMatchBr = lower.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);

    if (dateMatchIso) {
      targetDate = dateMatchIso[0];
    } else if (dateMatchBr) {
      const d = parseInt(dateMatchBr[1], 10);
      const m = parseInt(dateMatchBr[2], 10) - 1;
      const y = dateMatchBr[3] ? (dateMatchBr[3].length === 2 ? 2000 + parseInt(dateMatchBr[3], 10) : parseInt(dateMatchBr[3], 10)) : new Date().getFullYear();
      targetDate = getDayOfWeekInfo(new Date(y, m, d, 12, 0, 0)).isoDate;
    }

    if (!targetDate) {
      const allHistText = historyMessages
        .slice(-4)
        .map((m: any) => (typeof m.content === 'string' ? m.content : ''))
        .join(' ');
      const histIsoMatch = allHistText.match(/\b(202[4-9])-(\d{2})-(\d{2})\b/);
      if (histIsoMatch) {
        targetDate = histIsoMatch[0];
      }
    }

    if (!targetDate) {
      const r = aiConfig?.regras_agendamento || {};
      const allowedDaysList = (Array.isArray(r.dias_atendimento) && r.dias_atendimento.length > 0)
        ? r.dias_atendimento
        : ((Array.isArray(r.dias) && r.dias.length > 0) ? r.dias : ['sabado']);
      const allowedIndices = allowedDaysList.map((k: string) => DIA_KEY_TO_INDEX[String(k).toLowerCase().trim()]).filter((v: number | undefined) => v !== undefined);
      const targetIdx = allowedIndices.length > 0 ? allowedIndices[0] : 6;

      const now = new Date();
      let cur = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12, 0, 0);
      for (let step = 0; step < 14; step++) {
        if (cur.getDay() === targetIdx) {
          break;
        }
        cur.setDate(cur.getDate() + 1);
      }
      targetDate = getDayOfWeekInfo(cur).isoDate;
    } else {
      targetDate = getDayOfWeekInfo(targetDate).isoDate;
    }

    return {
      date: targetDate,
      time: targetTime
    };
  }

  /**
   * Executa Tool: get_available_calendar_slots
   */
  public async executeGetSlotsTool(params: {
    tenantId: string;
    historyMessages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
    args?: any;
  }): Promise<any> {
    const { tenantId, historyMessages, args = {} } = params;
    let { fromDate = null, excludeSlots = [], excludeDates = [] } = args;

    if (!Array.isArray(excludeDates)) {
      excludeDates = excludeDates ? [excludeDates] : [];
    }
    if (!Array.isArray(excludeSlots)) {
      excludeSlots = excludeSlots ? [excludeSlots] : [];
    }

    const allUserText = historyMessages
      .filter(m => m.role === 'user')
      .map(m => (typeof m.content === 'string' ? m.content : '').toLowerCase())
      .join(' ');

    const allAssistantText = historyMessages
      .filter(m => m.role === 'assistant')
      .map(m => (typeof m.content === 'string' ? m.content : '').toLowerCase())
      .join(' ');

    const isClearlyNew = allUserText.includes('nova instala') || allUserText.includes('instalar do zero') || allUserText.includes('câmeras novas') || allUserText.includes('não tenho câmera') || allUserText.includes('nao tenho camera') || allUserText.includes('instalação nova') || allUserText.includes('projeto novo') || allUserText.includes('quero instalar') || allAssistantText.includes('nova instalação') || allAssistantText.includes('nova instalacao');
    const isClearlyMaintenance = allUserText.includes('manuten') || allUserText.includes('consert') || allUserText.includes('repar') || allUserText.includes('parou de') || allUserText.includes('câmera queim') || allUserText.includes('arrumar') || allUserText.includes('já tenho câmera') || allUserText.includes('ja tenho') || allAssistantText.includes('manutenção') || allAssistantText.includes('manutencao');

    if (!isClearlyNew && !isClearlyMaintenance) {
      return {
        success: false,
        requiresQualification: true,
        instruction: 'O cliente ainda NÃO esclareceu se a visita técnica é para NOVA INSTALAÇÃO ou MANUTENÇÃO. NÃO passe horários e NÃO fale de gratuidade! Pergunte primeiro exatamente: "Opa! Com certeza, realizamos sim. Só para eu te orientar certinho: a visita técnica seria para uma *nova instalação* de câmeras ou para *manutenção / conserto* de câmeras que você já tem no local?"'
      };
    }

    // 1. Extrai todas as datas previamente sugeridas pelo assistente no histórico
    const previouslyOfferedDates: string[] = [];
    for (const msg of historyMessages) {
      if (msg.role === 'assistant' && typeof msg.content === 'string') {
        const found = extractDatesFromText(msg.content);
        for (const f of found) {
          if (!previouslyOfferedDates.includes(f)) previouslyOfferedDates.push(f);
        }
      }
    }

    // 2. Analisa as mensagens recentes do cliente para detectar se pediu outro dia / outro sábado / recusou a data anterior
    const recentUserMsgs = historyMessages
      .filter(m => m.role === 'user')
      .slice(-2)
      .map(m => (typeof m.content === 'string' ? m.content : ''))
      .join(' ');

    const isAskingAnotherDate = ANOTHER_DATE_INTENTS.some(regex => regex.test(recentUserMsgs));
    const userMentionedDates = extractDatesFromText(recentUserMsgs);

    if (isAskingAnotherDate || excludeDates.length > 0) {
      for (const d of previouslyOfferedDates) {
        if (!excludeDates.includes(d)) excludeDates.push(d);
      }
      for (const d of userMentionedDates) {
        if (!excludeDates.includes(d)) excludeDates.push(d);
      }

      if (!fromDate && excludeDates.length > 0) {
        const sortedDates = [...excludeDates].sort();
        const latestDateStr = sortedDates[sortedDates.length - 1];
        const latestDate = parseLocalDate(latestDateStr);
        latestDate.setDate(latestDate.getDate() + 1);
        fromDate = getDayOfWeekInfo(latestDate).isoDate;
      }
    }

    if (!isAskingAnotherDate && userMentionedDates.length > 0 && !fromDate) {
      fromDate = userMentionedDates[0];
    }

    if ((recentUserMsgs.toLowerCase().includes('mês que vem') || recentUserMsgs.toLowerCase().includes('mes que vem') || recentUserMsgs.toLowerCase().includes('próximo mês') || recentUserMsgs.toLowerCase().includes('proximo mes')) && !fromDate) {
      const now = new Date();
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 12, 0, 0);
      fromDate = getDayOfWeekInfo(nextMonth).isoDate;
    }

    // 3. Lê bloqueios e regras de disponibilidade manuais cadastrados pelo painel (pontual, semanal e intervalo)
    let activeLocks: any[] = [];
    try {
      const panelLocksRes = await query<{
        id: string;
        data: string | null;
        data_fim: string | null;
        horario: string | null;
        tipo_recorrencia: string;
        dia_semana: string | null;
        dias_semana: any;
        tipo_acao: string;
        motivo: string;
      }>(
        `SELECT id,
                TO_CHAR(data, 'YYYY-MM-DD') as data,
                TO_CHAR(data_fim, 'YYYY-MM-DD') as data_fim,
                horario,
                COALESCE(tipo_recorrencia, 'unica') as tipo_recorrencia,
                dia_semana,
                dias_semana,
                COALESCE(tipo_acao, 'bloquear') as tipo_acao,
                motivo 
         FROM agenda_bloqueios 
         WHERE tenant_id = $1
           AND (
             tipo_recorrencia = 'semanal'
             OR (tipo_recorrencia = 'intervalo' AND (data_fim >= CURRENT_DATE - INTERVAL '1 day' OR data_fim IS NULL))
             OR (data IS NOT NULL AND data >= CURRENT_DATE - INTERVAL '1 day')
           )`,
        [tenantId]
      );
      activeLocks = panelLocksRes.rows || [];

      for (const lock of activeLocks) {
        if (lock.tipo_recorrencia === 'unica' && lock.data) {
          if (lock.tipo_acao === 'bloquear') {
            if (!lock.horario) {
              if (!excludeDates.includes(lock.data)) {
                excludeDates.push(lock.data);
              }
            } else {
              const cleanLockTime = lock.horario.substring(0, 5);
              const lockSlotKey = `${lock.data} ${cleanLockTime}`;
              if (!excludeSlots.includes(lockSlotKey)) {
                excludeSlots.push(lockSlotKey);
              }
            }
          }
        }
      }
    } catch (lockErr: any) {
      console.warn('[AIEngine] Aviso ao consultar agenda_bloqueios:', lockErr.message);
    }

    const normExcludeDates = (excludeDates || []).map((d: any) => String(d).trim());
    const normExcludeSlots = (excludeSlots || []).map((s: any) => String(s).trim());

    let instructionMsg: string;
    if (isAskingAnotherDate) {
      instructionMsg = 'O cliente pediu outra data ou não pode na data anterior. NUNCA insista nem repita a data já recusada! Apresente com simpatia e acolhimento os NOVOS horários livres encontrados para o PRÓXIMO dia disponível na agenda. Pergunte se algum desses novos horários fica bom para ele.';
    } else if (isClearlyMaintenance) {
      instructionMsg = 'Atenção obrigatória para MANUTENÇÃO: informe com clareza a taxa de visita técnica de R$ 140,00 e que esse valor é 100% aproveitado e abatido no conserto, além de oferecer os 2 horários livres abaixo!';
    } else {
      instructionMsg = 'Para NOVA INSTALAÇÃO: informe que a visita técnica de avaliação de pontos cegos e cabeamento é 100% gratuita e sem compromisso, além de oferecer os 2 horários livres abaixo!';
    }

    const cfgRes = await query<{ regras_agendamento: any }>(
      `SELECT regras_agendamento FROM tenant_ai_configs WHERE tenant_id = $1;`,
      [tenantId]
    );
    const aiCfg = cfgRes.rows[0]?.regras_agendamento || {};

    const configuredSlots = (Array.isArray(aiCfg.slots_agendamento) && aiCfg.slots_agendamento.length > 0)
      ? aiCfg.slots_agendamento
      : ((Array.isArray(aiCfg.slots_disponiveis) && aiCfg.slots_disponiveis.length > 0)
          ? aiCfg.slots_disponiveis
          : ['08:00', '10:00', '12:00', '14:00', '16:00']);

    const allowedDaysList = (Array.isArray(aiCfg.dias_atendimento) && aiCfg.dias_atendimento.length > 0)
      ? aiCfg.dias_atendimento
      : ((Array.isArray(aiCfg.dias) && aiCfg.dias.length > 0)
          ? aiCfg.dias
          : ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado']);

    const allowedIndices = allowedDaysList
      .map((k: string) => DIA_KEY_TO_INDEX[String(k).toLowerCase().trim()])
      .filter((idx: number | undefined) => idx !== undefined);

    let cursorDate: Date;
    if (fromDate) {
      cursorDate = parseLocalDate(fromDate);
    } else {
      const now = new Date();
      cursorDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12, 0, 0);
    }

    const freeSlots: any[] = [];
    let daysChecked = 0;

    while (freeSlots.length < 2 && daysChecked < 60) {
      const info = getDayOfWeekInfo(cursorDate);
      const daySlug = DIAS_SEMANA_SLUGS[info.dayIndex];

      // Regra de Liberação Explícita (exceção aberta no painel para agendar mesmo se o dia da semana não for padrão)
      const hasExplicitDayRelease = activeLocks.some(l => 
        l.tipo_acao === 'liberar' && (
          (l.tipo_recorrencia === 'unica' && l.data === info.isoDate) ||
          (l.tipo_recorrencia === 'intervalo' && info.isoDate >= l.data && (!l.data_fim || info.isoDate <= l.data_fim)) ||
          (l.tipo_recorrencia === 'semanal' && (l.dia_semana === daySlug || (Array.isArray(l.dias_semana) && l.dias_semana.includes(daySlug))))
        )
      );

      // Trava de dias de atendimento: se o dia não for permitido E não tiver liberação explícita, pula
      if (allowedIndices.includes(info.dayIndex) || hasExplicitDayRelease) {
        // Bloqueio de dia inteiro por intervalo de datas ou recorrência semanal
        const isDayBlockedByRecurrence = activeLocks.some(l => 
          l.tipo_acao === 'bloquear' && !l.horario && (
            (l.tipo_recorrencia === 'intervalo' && info.isoDate >= l.data && (!l.data_fim || info.isoDate <= l.data_fim)) ||
            (l.tipo_recorrencia === 'semanal' && (l.dia_semana === daySlug || (Array.isArray(l.dias_semana) && l.dias_semana.includes(daySlug))))
          )
        );

        const isExcluded = isDayBlockedByRecurrence || normExcludeDates.some((ex: string) => ex === info.isoDate || ex === info.formattedBr || info.isoDate.endsWith(ex));
        if (!isExcluded) {
          for (const slotTime of configuredSlots) {
            const cleanTime = String(slotTime).substring(0, 5);
            const slotKey = `${info.isoDate} ${cleanTime}`;

            // Bloqueio de horário específico por intervalo ou recorrência semanal
            const isSlotBlockedByRecurrence = activeLocks.some(l => 
              l.tipo_acao === 'bloquear' && l.horario === cleanTime && (
                (l.tipo_recorrencia === 'intervalo' && info.isoDate >= l.data && (!l.data_fim || info.isoDate <= l.data_fim)) ||
                (l.tipo_recorrencia === 'semanal' && (l.dia_semana === daySlug || (Array.isArray(l.dias_semana) && l.dias_semana.includes(daySlug))))
              )
            );

            if (isSlotBlockedByRecurrence || normExcludeSlots.includes(slotKey) || normExcludeSlots.includes(cleanTime)) {
              continue;
            }

            const slotTimestamp = new Date(`${info.isoDate}T${cleanTime}:00-03:00`);
            const busyCheck = await query(
              `SELECT id FROM appointments 
               WHERE tenant_id = $1 AND data_agendada = $2 AND status = 'agendado' LIMIT 1;`,
              [tenantId, slotTimestamp]
            );

            if (busyCheck.rowCount === 0) {
              freeSlots.push({
                date: info.isoDate,
                dayOfWeek: info.dayOfWeek,
                time: cleanTime,
                description: `${info.dayOfWeek} (${info.formattedBr}) às ${cleanTime}`
              });
              if (freeSlots.length >= 2) break;
            }
          }
        }
      }

      cursorDate.setDate(cursorDate.getDate() + 1);
      daysChecked++;
    }

    return {
      success: true,
      totalFound: freeSlots.length,
      instruction: instructionMsg,
      slots: freeSlots,
      resolvedArgs: {
        fromDate,
        excludeDates: Array.from(new Set(normExcludeDates)),
        excludeSlots: normExcludeSlots
      }
    };
  }

  /**
   * Consulta bloqueios ou liberações aplicáveis a uma data e horário (pontual, intervalo ou recorrente semanal)
   */
  public async getMatchingScheduleLock(tenantId: string, cleanDate: string, cleanTime: string): Promise<any> {
    try {
      const dayIndex = new Date(`${cleanDate}T12:00:00-03:00`).getDay();
      const daySlug = DIAS_SEMANA_SLUGS[dayIndex] || 'sabado';
      const dayJson = JSON.stringify([daySlug]);

      const res = await query(
        `SELECT id, motivo, horario, tipo_recorrencia, dia_semana, dias_semana, data, data_fim, tipo_acao
         FROM agenda_bloqueios 
         WHERE tenant_id = $1 
           AND (
             -- 1. Pontual (data específica)
             ((tipo_recorrencia = 'unica' OR tipo_recorrencia IS NULL) AND data = $2 AND (horario IS NULL OR horario = $3))
             OR
             -- 2. Intervalo de datas (recesso / férias)
             (tipo_recorrencia = 'intervalo' AND data <= $2 AND (data_fim >= $2 OR data_fim IS NULL) AND (horario IS NULL OR horario = $3))
             OR
             -- 3. Recorrente semanal (toda semana)
             (tipo_recorrencia = 'semanal' AND (dia_semana = $4 OR dias_semana @> $5::jsonb) AND (horario IS NULL OR horario = $3))
           )
         ORDER BY 
           CASE WHEN tipo_acao = 'liberar' THEN 0 ELSE 1 END,
           CASE WHEN horario = $3 THEN 0 ELSE 1 END,
           CASE WHEN tipo_recorrencia = 'unica' THEN 0 WHEN tipo_recorrencia = 'intervalo' THEN 1 ELSE 2 END
         LIMIT 1`,
        [tenantId, cleanDate, cleanTime, daySlug, dayJson]
      );
      return res.rows[0] || null;
    } catch (err: any) {
      console.warn('[AIEngine] Erro ao consultar bloqueio na agenda:', err.message);
      return null;
    }
  }

  /**
   * Executa Tool: check_specific_slot_availability
   */
  public async executeCheckSlotTool(params: {
    tenantId: string;
    date: string;
    time: string;
    historyMessages?: any[];
  }): Promise<any> {
    const { tenantId, date, time, historyMessages = [] } = params;
    const info = getDayOfWeekInfo(date);
    const cleanTime = (time || '08:00').substring(0, 5);
    const slotTimestamp = new Date(`${info.isoDate}T${cleanTime}:00-03:00`);

    // 0. Trava de Bloqueio Manual / Regras de Recorrência pelo Painel
    try {
      const lock = await this.getMatchingScheduleLock(tenantId, info.isoDate, cleanTime);

      if (lock && lock.tipo_acao === 'bloquear') {
        const nextSlots = await this.executeGetSlotsTool({
          tenantId,
          historyMessages: historyMessages.length > 0 ? historyMessages : [{ role: 'user', content: 'nova instalação' }],
          args: {
            excludeDates: lock.horario ? [] : [info.isoDate],
            excludeSlots: lock.horario ? [`${info.isoDate} ${cleanTime}`, cleanTime] : []
          }
        });

        return {
          available: false,
          date: info.isoDate,
          dayOfWeek: info.dayOfWeek,
          formattedBr: info.formattedBr,
          time: cleanTime,
          reason: lock.horario ? 'horario_bloqueado_painel' : 'dia_bloqueado_painel',
          motivo: lock.motivo,
          message: lock.horario
            ? `O horário das ${cleanTime} no dia ${info.dayOfWeek} (${info.formattedBr}) está temporariamente bloqueado na agenda (${lock.motivo}).`
            : `O dia ${info.dayOfWeek} (${info.formattedBr}) está temporariamente bloqueado para atendimentos (${lock.motivo}).`,
          suggestedSlots: nextSlots.slots || [],
          instruction: `Atenção: A data/horário solicitada foi BLOQUEADA MANUALMENTE pelo administrador no painel (${lock.motivo})! Não confirme este agendamento. Explique cordialmente e ofereça os horários livres alternativos em suggestedSlots!`
        };
      }
    } catch (lockErr: any) {
      console.warn('[AIEngine] Aviso ao verificar bloqueio de horário no painel:', lockErr.message);
    }

    // 1. Trava de dia da semana permitido (verificando se não há liberação explícita)
    let hasExplicitDayRelease = false;
    try {
      const daySlug = DIAS_SEMANA_SLUGS[info.dayIndex];
      const relRes = await query(
        `SELECT id FROM agenda_bloqueios 
         WHERE tenant_id = $1 AND tipo_acao = 'liberar' AND (
           (tipo_recorrencia = 'unica' AND data = $2) OR
           (tipo_recorrencia = 'intervalo' AND data <= $2 AND (data_fim >= $2 OR data_fim IS NULL)) OR
           (tipo_recorrencia = 'semanal' AND (dia_semana = $3 OR dias_semana @> $4::jsonb))
         ) LIMIT 1`,
        [tenantId, info.isoDate, daySlug, JSON.stringify([daySlug])]
      );
      hasExplicitDayRelease = relRes.rowCount > 0;
    } catch (relErr) {
      // Ignora erro
    }

    const cfgRes = await query<{ regras_agendamento: any }>(
      `SELECT regras_agendamento FROM tenant_ai_configs WHERE tenant_id = $1;`,
      [tenantId]
    );
    const aiCfg = cfgRes.rows[0]?.regras_agendamento || {};

    const allowedDaysList = (Array.isArray(aiCfg.dias_atendimento) && aiCfg.dias_atendimento.length > 0)
      ? aiCfg.dias_atendimento
      : ((Array.isArray(aiCfg.dias) && aiCfg.dias.length > 0)
          ? aiCfg.dias
          : ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado']);

    const allowedIndices = allowedDaysList
      .map((k: string) => DIA_KEY_TO_INDEX[String(k).toLowerCase().trim()])
      .filter((idx: number | undefined) => idx !== undefined);
    const allowedDaysNames = allowedIndices.map((idx: number) => DIAS_SEMANA_NOMES[idx]);

    // 1. Trava de dia da semana permitido
    if (!allowedIndices.includes(info.dayIndex) && !hasExplicitDayRelease) {
      const nextSlots = await this.executeGetSlotsTool({
        tenantId,
        historyMessages: historyMessages.length > 0 ? historyMessages : [{ role: 'user', content: 'nova instalação' }],
        args: {}
      });

      return {
        available: false,
        date: info.isoDate,
        dayOfWeek: info.dayOfWeek,
        formattedBr: info.formattedBr,
        time: cleanTime,
        reason: 'dia_nao_permitido',
        allowedDays: allowedDaysNames,
        message: `Não realizamos visitas técnicas às ${info.dayOfWeek.toLowerCase()}s. Nossos atendimentos são realizados exclusivamente em: ${allowedDaysNames.join(', ')}.`,
        suggestedSlots: nextSlots.slots || [],
        instruction: `Atenção obrigatória: O dia solicitado (${info.dayOfWeek}, ${info.formattedBr}) NÃO é um dia de atendimento permitido pelo tenant! Explique com simpatia e clareza que as visitas técnicas ocorrem exclusivamente nos dias autorizados (${allowedDaysNames.join(', ')}). Em seguida, ofereça os horários livres sugeridos em suggestedSlots!`
      };
    }

    // 2. Trava de horário ocupado / anti-choque no banco
    const busyCheck = await query(
      `SELECT id, servico FROM appointments 
       WHERE tenant_id = $1 AND data_agendada = $2 AND status = 'agendado' LIMIT 1;`,
      [tenantId, slotTimestamp]
    );

    if (busyCheck.rowCount && busyCheck.rowCount > 0) {
      const nextSlots = await this.executeGetSlotsTool({
        tenantId,
        historyMessages: historyMessages.length > 0 ? historyMessages : [{ role: 'user', content: 'nova instalação' }],
        args: { excludeSlots: [`${info.isoDate} ${cleanTime}`, cleanTime] }
      });

      return {
        available: false,
        date: info.isoDate,
        dayOfWeek: info.dayOfWeek,
        formattedBr: info.formattedBr,
        time: cleanTime,
        reason: 'horario_ocupado',
        message: `O horário das ${cleanTime} no dia ${info.dayOfWeek} (${info.formattedBr}) já está reservado.`,
        suggestedSlots: nextSlots.slots || [],
        instruction: `Atenção: O horário das ${cleanTime} no dia ${info.dayOfWeek} (${info.formattedBr}) já está OCUPADO na agenda! Não confirme este horário. Explique cordialmente que a vaga já foi preenchida e ofereça os horários livres alternativos em suggestedSlots!`
      };
    }

    return {
      available: true,
      date: info.isoDate,
      dayOfWeek: info.dayOfWeek,
      formattedBr: `${info.formattedBr} (${info.dayOfWeek})`,
      time: cleanTime,
      message: `Horário das ${cleanTime} de ${info.dayOfWeek} (${info.formattedBr}) confirmado como 100% LIVRE.`
    };
  }

  /**
   * Executa Tool: book_appointment
   */
  public async executeBookAppointmentTool(params: {
    tenantId: string;
    sessionId: string;
    remoteJid: string;
    pushName?: string;
    historyMessages?: any[];
    args: any;
  }): Promise<any> {
    const { tenantId, sessionId, remoteJid, pushName, historyMessages = [], args } = params;
    const { date, time, clientName, address = 'Endereço a confirmar', appointmentType = 'VISITA_TECNICA', serviceType, notes = '' } = args;

    const info = getDayOfWeekInfo(date);
    const cleanDate = info.isoDate;
    const cleanTime = (time || '08:00').substring(0, 5);
    const apptDate = new Date(`${cleanDate}T${cleanTime}:00-03:00`);

    const finalClientName = (clientName && clientName !== 'Cliente') ? clientName : (pushName || 'Cliente WhatsApp');
    const finalServiceType = serviceType || (appointmentType === 'INSTALACAO_CFTV' ? 'Instalação de Câmeras de Segurança' : 'Visita Técnica Gratuita');

    // 0. Trava de Bloqueio Manual / Regras de Recorrência pelo Painel
    try {
      const lock = await this.getMatchingScheduleLock(tenantId, cleanDate, cleanTime);

      if (lock && lock.tipo_acao === 'bloquear') {
        console.warn(`[AIEngine] Bloqueio book_appointment: ${cleanDate} ${cleanTime} bloqueado pelo painel (${lock.motivo}).`);
        const nextSlots = await this.executeGetSlotsTool({
          tenantId,
          historyMessages: historyMessages.length > 0 ? historyMessages : [{ role: 'user', content: 'nova instalação' }],
          args: {
            excludeDates: lock.horario ? [] : [cleanDate],
            excludeSlots: lock.horario ? [`${cleanDate} ${cleanTime}`, cleanTime] : []
          }
        });

        return {
          success: false,
          error: lock.horario ? 'horario_bloqueado_painel' : 'dia_bloqueado_painel',
          motivo: lock.motivo,
          date: cleanDate,
          dayOfWeek: info.dayOfWeek,
          time: cleanTime,
          message: lock.horario
            ? `O horário das ${cleanTime} no dia ${info.dayOfWeek} (${info.formattedBr}) está temporariamente bloqueado na agenda (${lock.motivo}).`
            : `O dia ${info.dayOfWeek} (${info.formattedBr}) está temporariamente bloqueado para atendimentos (${lock.motivo}).`,
          suggestedSlots: nextSlots.slots || [],
          instruction: `Atenção: O agendamento foi recusado porque esta data/horário está BLOQUEADA no painel pelo administrador (${lock.motivo})! Explique educadamente ao cliente e ofereça os horários em suggestedSlots!`
        };
      }
    } catch (lockErr: any) {
      console.warn('[AIEngine] Aviso ao verificar bloqueio de agendamento no painel:', lockErr.message);
    }

    // 1. Validação de Dias Permitidos do Tenant (verificando se não há liberação explícita)
    let hasExplicitDayRelease = false;
    try {
      const daySlug = DIAS_SEMANA_SLUGS[info.dayIndex];
      const relRes = await query(
        `SELECT id FROM agenda_bloqueios 
         WHERE tenant_id = $1 AND tipo_acao = 'liberar' AND (
           (tipo_recorrencia = 'unica' AND data = $2) OR
           (tipo_recorrencia = 'intervalo' AND data <= $2 AND (data_fim >= $2 OR data_fim IS NULL)) OR
           (tipo_recorrencia = 'semanal' AND (dia_semana = $3 OR dias_semana @> $4::jsonb))
         ) LIMIT 1`,
        [tenantId, cleanDate, daySlug, JSON.stringify([daySlug])]
      );
      hasExplicitDayRelease = relRes.rowCount > 0;
    } catch (relErr) {
      // Ignora erro
    }

    const cfgRes = await query<{ regras_agendamento: any }>(
      `SELECT regras_agendamento FROM tenant_ai_configs WHERE tenant_id = $1;`,
      [tenantId]
    );
    const aiCfg = cfgRes.rows[0]?.regras_agendamento || {};

    const allowedDaysList = (Array.isArray(aiCfg.dias_atendimento) && aiCfg.dias_atendimento.length > 0)
      ? aiCfg.dias_atendimento
      : ((Array.isArray(aiCfg.dias) && aiCfg.dias.length > 0)
          ? aiCfg.dias
          : ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado']);

    const allowedIndices = allowedDaysList
      .map((k: string) => DIA_KEY_TO_INDEX[String(k).toLowerCase().trim()])
      .filter((idx: number | undefined) => idx !== undefined);
    const allowedDaysNames = allowedIndices.map((idx: number) => DIAS_SEMANA_NOMES[idx]);

    if (!allowedIndices.includes(info.dayIndex) && !hasExplicitDayRelease) {
      console.warn(`[AIEngine] Bloqueio book_appointment: ${info.dayOfWeek} (${cleanDate}) não é permitido para este tenant.`);
      const nextSlots = await this.executeGetSlotsTool({
        tenantId,
        historyMessages: historyMessages.length > 0 ? historyMessages : [{ role: 'user', content: 'nova instalação' }],
        args: {}
      });

      return {
        success: false,
        error: 'dia_nao_permitido',
        date: cleanDate,
        dayOfWeek: info.dayOfWeek,
        formattedBr: `${info.dayOfWeek} (${info.formattedBr})`,
        allowedDays: allowedDaysNames,
        message: `Não realizamos visitas técnicas às ${info.dayOfWeek.toLowerCase()}s. Nossos dias de atendimento são: ${allowedDaysNames.join(', ')}.`,
        suggestedSlots: nextSlots.slots || [],
        instruction: `Atenção: O agendamento para ${info.dayOfWeek} (${info.formattedBr}) foi recusado pelo sistema porque a equipe só atende em: ${allowedDaysNames.join(', ')}. Explique educadamente ao cliente e ofereça os horários em suggestedSlots!`
      };
    }

    // 2. Trava Anti-Choque: Verifica se outra pessoa já agendou esse horário exato
    const occupiedCheck = await query(
      `SELECT id, remote_jid FROM appointments 
       WHERE tenant_id = $1 AND data_agendada = $2 AND status = 'agendado' AND remote_jid != $3 LIMIT 1;`,
      [tenantId, apptDate, remoteJid]
    );

    if (occupiedCheck.rowCount && occupiedCheck.rowCount > 0) {
      console.warn(`[AIEngine] Bloqueio book_appointment: horário ${cleanDate} às ${cleanTime} já ocupado por outro cliente.`);
      const nextSlots = await this.executeGetSlotsTool({
        tenantId,
        historyMessages: [{ role: 'user', content: 'nova instalação' }],
        args: { excludeSlots: [`${cleanDate} ${cleanTime}`, cleanTime] }
      });

      return {
        success: false,
        error: 'horario_ocupado',
        date: cleanDate,
        dayOfWeek: info.dayOfWeek,
        time: cleanTime,
        message: `O horário das ${cleanTime} no dia ${info.dayOfWeek} (${info.formattedBr}) já está reservado para outro cliente.`,
        suggestedSlots: nextSlots.slots || [],
        instruction: `Atenção: Este horário já está OCUPADO por outro cliente! Não confirme. Informe educadamente que a vaga foi preenchida e ofereça os horários sugeridos em suggestedSlots!`
      };
    }

    console.log(`[AIEngine] Agendando ${appointmentType} para ${finalClientName} (${cleanDate} às ${cleanTime})...`);

    // Evita duplicidade de agenda para o mesmo serviço do mesmo cliente
    const existingApptRes = await query(
      `SELECT id, data_agendada, status FROM appointments 
       WHERE tenant_id = $1 AND remote_jid = $2 AND servico = $3 AND status = 'agendado'
       ORDER BY data_agendada DESC LIMIT 1;`,
      [tenantId, remoteJid, finalServiceType]
    );

    let apptId: string | number;
    let isReschedule = false;

    if (existingApptRes.rowCount && existingApptRes.rowCount > 0) {
      const existing = existingApptRes.rows[0];
      const existingTime = new Date(existing.data_agendada).getTime();
      const newTime = apptDate.getTime();

      if (Math.abs(existingTime - newTime) < 60000) {
        console.log(`[AIEngine] Agendamento já existente identificado (${existing.id}). Evitando duplicata.`);
        apptId = existing.id;
      } else {
        console.log(`[AIEngine] Reagendando visita existente (${existing.id}) para ${apptDate.toISOString()} sem duplicidade.`);
        await query(
          `UPDATE appointments 
           SET data_agendada = $1, tipo_agendamento = $2, endereco = COALESCE($3, endereco), observacoes = $4
           WHERE id = $5;`,
          [apptDate, appointmentType, address, notes, existing.id]
        );
        apptId = existing.id;
        isReschedule = true;
      }
    } else {
      const apptDbRes = await query(
        `INSERT INTO appointments (
           tenant_id, remote_jid, servico, data_agendada, status, tipo_agendamento, endereco, observacoes
         ) VALUES ($1, $2, $3, $4, 'agendado', $5, $6, $7)
         RETURNING id;`,
        [tenantId, remoteJid, finalServiceType, apptDate, appointmentType, address, notes]
      );
      apptId = apptDbRes.rows[0].id;
    }

    await query(
      `UPDATE chat_sessions 
       SET etapa_funil = 'agendado', client_name = COALESCE($1, client_name), last_interaction = now()
       WHERE id = $2;`,
      [finalClientName, sessionId]
    );

    return {
      success: true,
      appointmentId: apptId,
      date: cleanDate,
      dayOfWeek: info.dayOfWeek,
      formattedBr: `${info.dayOfWeek} (${info.formattedBr})`,
      time: cleanTime,
      clientName: finalClientName,
      appointmentType,
      isReschedule,
      message: isReschedule
        ? `Reagendamento de ${finalServiceType} confirmado com sucesso para ${info.dayOfWeek} (${info.formattedBr}) às ${cleanTime}!`
        : `Agendamento de ${finalServiceType} confirmado com sucesso para ${info.dayOfWeek} (${info.formattedBr}) às ${cleanTime}!`
    };
  }

  /**
   * Executa Tool: save_client_details
   */
  public async executeSaveClientDetailsTool(params: {
    tenantId: string;
    sessionId: string;
    remoteJid: string;
    args: any;
  }): Promise<any> {
    const { tenantId, sessionId, remoteJid, args } = params;
    const { address, clientName } = args;

    if (address) {
      await query(
        `UPDATE appointments 
         SET endereco = $1 
         WHERE id = (
           SELECT id FROM appointments 
           WHERE tenant_id = $2 AND remote_jid = $3 
           ORDER BY created_at DESC LIMIT 1
         );`,
        [address.trim(), tenantId, remoteJid]
      );

      await query(
        `INSERT INTO customer_profiles (tenant_id, remote_jid, nome, endereco_completo)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, remote_jid)
         DO UPDATE SET 
           endereco_completo = COALESCE(EXCLUDED.endereco_completo, customer_profiles.endereco_completo),
           nome = COALESCE(EXCLUDED.nome, customer_profiles.nome),
           updated_at = now();`,
        [tenantId, remoteJid, clientName ? clientName.trim() : null, address.trim()]
      );
    }

    if (clientName) {
      await query(
        `UPDATE chat_sessions SET client_name = $1, last_interaction = now() WHERE id = $2;`,
        [clientName.trim(), sessionId]
      );
    }

    return {
      success: true,
      address,
      clientName,
      instruction: 'Dados cadastrais e endereço gravados no sistema com sucesso. Confirme educadamente ao cliente que o endereço e ponto de referência foram anotados!'
    };
  }

  /**
   * Executa Tool: cancel_appointment
   */
  public async executeCancelAppointmentTool(params: {
    tenantId: string;
    sessionId: string;
    remoteJid: string;
    args?: any;
  }): Promise<any> {
    const { tenantId, sessionId, remoteJid, args = {} } = params;
    const { date } = args;

    await query(
      `UPDATE appointments 
       SET status = 'cancelado' 
       WHERE tenant_id = $1 AND remote_jid = $2 AND status = 'agendado';`,
      [tenantId, remoteJid]
    );

    await query(
      `UPDATE chat_sessions SET etapa_funil = 'qualificacao', last_interaction = now() WHERE id = $1;`,
      [sessionId]
    );

    const nextSlotsResult = await this.executeGetSlotsTool({
      tenantId,
      historyMessages: [{ role: 'user', content: 'nova instalação' }],
      args: { excludeDates: date ? [date] : [] }
    });

    return {
      success: true,
      cancelled: true,
      message: 'Agendamento desmarcado com sucesso.',
      suggestedAlternativeSlots: nextSlotsResult.slots || [],
      instruction: 'Confirme a desmarcação com acolhimento e simpatia. Em seguida, ofereça imediatamente os DOIS novos horários livres retornados em suggestedAlternativeSlots (em outro dia) para que o cliente possa remarcar se desejar.'
    };
  }

  /**
   * Executa Tool: consultar_historico_cliente
   */
  public async executeConsultarHistoricoTool(params: {
    tenantId: string;
    remoteJid: string;
  }): Promise<any> {
    const { tenantId, remoteJid } = params;
    const apptsRes = await query(
      `SELECT id, servico, data_agendada, status, tipo_agendamento, endereco, observacoes
       FROM appointments 
       WHERE tenant_id = $1 AND remote_jid = $2
       ORDER BY data_agendada DESC LIMIT 20;`,
      [tenantId, remoteJid]
    );

    const profileRes = await query(
      `SELECT nome, endereco_completo, perfil_resumo 
       FROM customer_profiles 
       WHERE tenant_id = $1 AND remote_jid = $2 LIMIT 1;`,
      [tenantId, remoteJid]
    );

    const agendasMarcadas: any[] = [];
    const agendasCumpridas: any[] = [];
    const agendasCanceladas: any[] = [];

    apptsRes.rows.forEach((a: any) => {
      const info = getDayOfWeekInfo(a.data_agendada);
      const timeStr = !isNaN(new Date(a.data_agendada).getTime())
        ? new Date(a.data_agendada).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })
        : '08:00';

      const item = {
        id: a.id,
        servico: a.servico,
        data: info.isoDate,
        dia_da_semana: info.dayOfWeek,
        horario: timeStr,
        descricao_formatada: `${info.dayOfWeek} (${info.formattedBr}) às ${timeStr}`,
        status: a.status,
        tipo_agendamento: a.tipo_agendamento,
        endereco: a.endereco || 'A confirmar',
        observacoes: a.observacoes || ''
      };

      if (a.status === 'agendado') {
        agendasMarcadas.push(item);
      } else if (a.status === 'concluido') {
        agendasCumpridas.push(item);
      } else if (a.status === 'cancelado') {
        agendasCanceladas.push(item);
      }
    });

    let instruction = '';
    if (agendasMarcadas.length > 0) {
      instruction += `O cliente possui ${agendasMarcadas.length} agenda(s) marcada(s) e ativa(s): ${agendasMarcadas.map(a => `${a.servico} em ${a.descricao_formatada}`).join(', ')}. `;
    } else {
      instruction += 'O cliente não possui nenhuma visita técnica agendada ativa no momento. ';
    }
    if (agendasCumpridas.length > 0) {
      instruction += `Já realizou ${agendasCumpridas.length} visita(s) técnica(s) cumprida(s)/concluída(s) no passado (${agendasCumpridas.map(a => `${a.servico} em ${a.descricao_formatada}`).join(', ')}). `;
    }
    if (agendasCanceladas.length > 0) {
      instruction += `Possui ${agendasCanceladas.length} agendamento(s) cancelado(s) anteriormente (${agendasCanceladas.map(a => `${a.servico} em ${a.descricao_formatada}`).join(', ')}). `;
    }
    instruction += 'Responda com total clareza, simpatia e precisão, informando dia da semana e horário corretos!';

    return {
      success: true,
      cliente: profileRes.rows[0]?.nome || 'Cliente',
      endereco_cadastrado: profileRes.rows[0]?.endereco_completo || 'Não informado',
      agendas_marcadas_ativas: agendasMarcadas,
      agendas_cumpridas_concluidas: agendasCumpridas,
      agendas_canceladas: agendasCanceladas,
      agendamentos_ativos: agendasMarcadas,
      historico_passado: [...agendasCumpridas, ...agendasCanceladas],
      instruction
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
      nome_assistente: 'Nat',
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

    // 2. Carrega perfil e agendamentos (ampliado para histórico completo)
    const profileRes = await query(`SELECT * FROM customer_profiles WHERE tenant_id = $1 AND remote_jid = $2;`, [tenantId, remoteJid]);
    const customerProfile = profileRes.rows[0] || null;

    const apptsRes = await query(`SELECT * FROM appointments WHERE tenant_id = $1 AND remote_jid = $2 ORDER BY created_at DESC LIMIT 15;`, [tenantId, remoteJid]);
    const appointments = apptsRes.rows;

    // 3. Compila System Prompt Dinâmico com todo o contexto do Tenant e Dossiê
    const systemPrompt = promptCompilerInstance.compileSystemPrompt(
      tenant,
      aiConfig,
      session,
      customerProfile,
      appointments
    );

    // 4. Carrega Histórico Recente expandido (até 50 mensagens para leitura completa de contexto)
    const historyRes = await query<ChatMessage>(
      `SELECT role, content 
       FROM chat_messages 
       WHERE session_id = $1 
       ORDER BY created_at DESC 
       LIMIT 50;`,
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

    const isFirstAssistantTurn = !historyMessages.some(m => m.role === 'assistant');
    if (isFirstAssistantTurn) {
      messagesToSend.push({
        role: 'system',
        content: `LEMBRETE OBRIGATÓRIO (PRIMEIRA MENSAGEM): Esta é a sua primeira mensagem neste atendimento. Você DEVE se apresentar como a Nat, assistente virtual da ${tenant.nome_empresa || 'WarNat Tech'}, e avisar com simpatia que se o cliente preferir pode solicitar o atendimento por um atendente/especialista humano a qualquer momento.`
      });
    }

    const lastMsg = messagesToSend[messagesToSend.length - 1];
    if (!lastMsg || lastMsg.role !== 'user' || lastMsg.content !== userMessage) {
      messagesToSend.push({ role: 'user', content: userMessage });
    }

    console.log(`🤖 [AIEngine] Invocando OpenAI gpt-4o-mini para ${remoteJid} (${historyMessages.length} msgs histórico)...`);

    // ============================================================================
    // GATILHOS PROATIVOS DE FERRAMENTAS (GARANTE DISPARO SEM ALUCINAÇÃO)
    // ============================================================================
    const isCancel = this.detectCancelRequest(userMessage);
    const bookingReq = this.detectBookingRequest(userMessage, historyMessages, aiConfig);
    const isConsultar = this.detectConsultarHistoricoRequest(userMessage);

    if (isCancel) {
      console.log(`[AIEngine] Gatilho proativo: Intenção de cancelamento detectada para ${remoteJid}.`);
      const cancelResult = await this.executeCancelAppointmentTool({
        tenantId,
        sessionId,
        remoteJid,
        args: { clientName: pushName || session.client_name }
      });

      messagesToSend.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_proactive_cancel',
          type: 'function',
          function: { name: 'cancel_appointment', arguments: JSON.stringify({}) }
        }]
      });
      messagesToSend.push({
        role: 'tool',
        tool_call_id: 'call_proactive_cancel',
        content: JSON.stringify(cancelResult)
      });
    } else if (bookingReq) {
      console.log(`[AIEngine] Gatilho proativo: Confirmação de agendamento detectada (${bookingReq.date} às ${bookingReq.time}).`);
      const allText = historyMessages.map(m => (typeof m.content === 'string' ? m.content : '').toLowerCase()).join(' ') + ' ' + userMessage.toLowerCase();
      const isInstallation = allText.includes('instalação das câmeras') || allText.includes('orçamento aprovado');
      const appointmentType = isInstallation ? 'INSTALACAO_CFTV' : 'VISITA_TECNICA';

      const bookResult = await this.executeBookAppointmentTool({
        tenantId,
        sessionId,
        remoteJid,
        pushName,
        args: {
          date: bookingReq.date,
          time: bookingReq.time,
          clientName: pushName || session.client_name || 'Cliente WhatsApp',
          appointmentType,
          serviceType: isInstallation ? 'Instalação de Câmeras de Segurança' : 'Visita Técnica Gratuita'
        }
      });

      messagesToSend.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_proactive_book',
          type: 'function',
          function: {
            name: 'book_appointment',
            arguments: JSON.stringify({
              date: bookingReq.date,
              time: bookingReq.time,
              clientName: pushName || session.client_name || 'Cliente WhatsApp',
              appointmentType
            })
          }
        }]
      });
      messagesToSend.push({
        role: 'tool',
        tool_call_id: 'call_proactive_book',
        content: JSON.stringify(bookResult)
      });
    } else if (isConsultar) {
      console.log(`[AIEngine] Gatilho proativo: Consulta de histórico/agendamentos solicitada por ${remoteJid}.`);
      const historicoResult = await this.executeConsultarHistoricoTool({
        tenantId,
        remoteJid
      });

      messagesToSend.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_proactive_consultar',
          type: 'function',
          function: {
            name: 'consultar_historico_cliente',
            arguments: JSON.stringify({})
          }
        }]
      });
      messagesToSend.push({
        role: 'tool',
        tool_call_id: 'call_proactive_consultar',
        content: JSON.stringify(historicoResult)
      });
    }

    // Gatilho Proativo de Horários Livres
    const allUserText = historyMessages.map(m => (typeof m.content === 'string' ? m.content : '').toLowerCase()).join(' ') + ' ' + userMessage.toLowerCase();
    const isClearlyNew = allUserText.includes('nova instala') || allUserText.includes('instalar do zero') || allUserText.includes('câmeras novas') || allUserText.includes('não tenho câmera') || allUserText.includes('nao tenho camera') || allUserText.includes('instalação nova') || allUserText.includes('projeto novo') || allUserText.includes('quero instalar');
    const isClearlyMaintenance = allUserText.includes('manuten') || allUserText.includes('consert') || allUserText.includes('repar') || allUserText.includes('parou de') || allUserText.includes('câmera queim') || allUserText.includes('arrumar') || allUserText.includes('já tenho câmera') || allUserText.includes('ja tenho');

    const isAppointmentReq = allUserText.includes('agendar visita') || allUserText.includes('marcar visita') || allUserText.includes('horário livre') || allUserText.includes('horario livre') || allUserText.includes('vaga na agenda') || allUserText.includes('outro dia') || allUserText.includes('outra data') || allUserText.includes('outro sábado') || allUserText.includes('outro sabado') || allUserText.includes('mais pra frente') || allUserText.includes('mais para frente');
    const isSchedulingTenant = (aiConfig as any).objetivo_funil === 'agendamento' || (!(aiConfig as any).objetivo_funil && !String(tenant.nome_empresa).toLowerCase().includes('velas') && (aiConfig as any).tipo_negocio !== 'produtos');
    const needsSlots = isSchedulingTenant && (isClearlyNew || isClearlyMaintenance || isAppointmentReq) && !isCancel && !bookingReq && !isConsultar;

    if (needsSlots) {
      console.log(`[AIEngine] Gatilho proativo: Cliente qualificado para horários. Consultando agenda em tempo real...`);
      const slotsResult = await this.executeGetSlotsTool({
        tenantId,
        historyMessages: [...historyMessages, { role: 'user', content: userMessage }],
        args: {}
      });

      if (slotsResult && slotsResult.success) {
        messagesToSend.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_proactive_slots',
            type: 'function',
            function: {
              name: 'get_available_calendar_slots',
              arguments: JSON.stringify(slotsResult.resolvedArgs || {})
            }
          }]
        });
        messagesToSend.push({
          role: 'tool',
          tool_call_id: 'call_proactive_slots',
          content: JSON.stringify(slotsResult)
        });
      }
    }

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

            for (const rawToolCall of responseMessage.tool_calls) {
              const toolCall = rawToolCall as any;
              const fnName = toolCall.function?.name;
              if (!fnName) continue;
              toolCallsExecuted.push(fnName);

              let fnArgs: any = {};
              try {
                fnArgs = JSON.parse(toolCall.function?.arguments || '{}');
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
                  historyMessages: [...historyMessages, { role: 'user', content: userMessage }],
                  args: fnArgs
                });
              } else if (fnName === 'check_specific_slot_availability') {
                toolResult = await this.executeCheckSlotTool({
                  ...fnArgs,
                  tenantId,
                  historyMessages: [...historyMessages, { role: 'user', content: userMessage }]
                });
              } else if (fnName === 'book_appointment') {
                toolResult = await this.executeBookAppointmentTool({
                  tenantId,
                  sessionId,
                  remoteJid,
                  pushName,
                  historyMessages: [...historyMessages, { role: 'user', content: userMessage }],
                  args: fnArgs
                });
              } else if (fnName === 'save_client_details') {
                toolResult = await this.executeSaveClientDetailsTool({
                  tenantId,
                  sessionId,
                  remoteJid,
                  args: fnArgs
                });
              } else if (fnName === 'cancel_appointment') {
                toolResult = await this.executeCancelAppointmentTool({
                  tenantId,
                  sessionId,
                  remoteJid,
                  args: fnArgs
                });
              } else if (fnName === 'consultar_historico_cliente') {
                toolResult = await this.executeConsultarHistoricoTool({
                  tenantId,
                  remoteJid
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
        finalAssistantText = 'Opa! Tive uma pequena instabilidade aqui no sistema, mas já estou de volta. Como posso te orientar certinho sobre o seu sistema de câmeras de segurança?';
      }
    }

    if (!finalAssistantText || !finalAssistantText.trim()) {
      finalAssistantText = 'Opa, com certeza! Só para eu te orientar certinho: a visita técnica seria para uma *nova instalação* de câmeras ou para *manutenção / conserto* de câmeras que você já tem no local?';
    }

    // 5. Envia resposta ao WhatsApp via Evolution API (Áudio TTS ou Texto)
    const modoRespostaAudio = (aiConfig as any).responder_com_audio || 'texto';
    const hasAudioInput = !!turn.isAudio || (typeof userMessage === 'string' && userMessage.startsWith('[audio]'));
    const shouldSendAudio = (
      modoRespostaAudio === 'sempre' ||
      (modoRespostaAudio === 'quando_receber_audio' && hasAudioInput)
    );

    const tempoRespostaSeg = Math.max(0, parseInt((aiConfig as any)?.tempo_resposta_segundos !== undefined ? (aiConfig as any).tempo_resposta_segundos : 3, 10));
    const delayMs = tempoRespostaSeg * 1000;

    let sendRes: any;
    let sentMediaType = 'text';

    if (shouldSendAudio) {
      console.log(`🎙️ [AIEngine] Gerando áudio humanizado (Voz: ${(aiConfig as any).voz_ia || 'nova'}) para ${remoteJid} (delay: ${tempoRespostaSeg}s)...`);
      try {
        await evolutionService.sendPresence(instanceName, remoteJid, 'recording');
        const speech = await ttsService.generateSpeech(finalAssistantText, {
          voice: (aiConfig as any).voz_ia || 'nova'
        });
        sendRes = await evolutionService.sendWhatsAppAudio(instanceName, remoteJid, speech.base64, { delay: delayMs });
        sentMediaType = 'audio';
      } catch (audioErr: any) {
        console.warn(`⚠️ [AIEngine] Falha ao sintetizar áudio TTS (${audioErr.message}). Fallback para texto.`);
        sendRes = await evolutionService.sendTextMessage(instanceName, remoteJid, finalAssistantText, { delay: delayMs });
        sentMediaType = 'text';
      }
    } else {
      console.log(`📤 [AIEngine] Enviando resposta humanizada em texto para ${remoteJid} (delay: ${tempoRespostaSeg}s)...`);
      await evolutionService.sendPresence(instanceName, remoteJid, 'composing');
      sendRes = await evolutionService.sendTextMessage(instanceName, remoteJid, finalAssistantText, { delay: delayMs });
      sentMediaType = 'text';
    }

    if (sendRes?.messageId) {
      await messageCache.setBotSent(sendRes.messageId, 60);

      await query(
        `INSERT INTO chat_messages (session_id, tenant_id, role, content, media_type, message_id)
         VALUES ($1, $2, 'assistant', $3, $4, $5);`,
        [sessionId, tenantId, finalAssistantText.trim(), sentMediaType, sendRes.messageId]
      );

      await query(`UPDATE chat_sessions SET last_interaction = NOW() WHERE id = $1;`, [sessionId]);
    }

    return {
      success: true,
      messageId: sendRes?.messageId,
      replyText: finalAssistantText,
      mediaType: sentMediaType,
      toolCallsExecuted
    };
  }
}

export const aiEngineService = new AiEngineService();
