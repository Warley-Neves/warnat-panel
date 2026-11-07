// ==============================================================================
// AI Engine & Tool Calling Especialista - Multi-Tenant SaaS
// Prompt Compiler Dinâmico, 6 Ferramentas Comerciais, Google Calendar e GPT-4o mini
// ==============================================================================

const OpenAI = require('openai');
const path = require('path');
const fs = require('fs');
const { query } = require('../database/db');
const evolutionService = require('./evolution.service');
const messageCache = require('./message-cache.service');
const promptCompiler = require('./prompt-compiler.service');
const calendarService = require('../calendar/google-calendar');
const leadsCrm = require('../crm/leads-crm');
const ttsService = require('./tts.service');

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

// Dias da semana em português (0 = Domingo, 1 = Segunda-feira, ..., 6 = Sábado)
const DIAS_SEMANA_NOMES = [
  'Domingo',
  'Segunda-feira',
  'Terça-feira',
  'Quarta-feira',
  'Quinta-feira',
  'Sexta-feira',
  'Sábado'
];

// Mapeamento dos identificadores configurados no painel
const DIA_KEY_TO_INDEX = {
  'domingo': 0,
  'segunda': 1,
  'segunda-feira': 1,
  'terca': 2,
  'terça': 2,
  'terca-feira': 2,
  'terça-feira': 2,
  'quarta': 3,
  'quarta-feira': 3,
  'quinta': 4,
  'quinta-feira': 4,
  'sexta': 5,
  'sexta-feira': 5,
  'sabado': 6,
  'sábado': 6
};

/**
 * Cria um objeto Date seguro no meio-dia (12:00) para evitar desvio de timezone UTC-3
 */
function parseLocalDate(dateVal) {
  if (!dateVal) return new Date();
  if (dateVal instanceof Date) {
    if (isNaN(dateVal.getTime())) return new Date();
    return new Date(dateVal.getFullYear(), dateVal.getMonth(), dateVal.getDate(), 12, 0, 0);
  }
  const str = String(dateVal).trim();
  const ymdMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (ymdMatch) {
    return new Date(parseInt(ymdMatch[1], 10), parseInt(ymdMatch[2], 10) - 1, parseInt(ymdMatch[3], 10), 12, 0, 0);
  }
  const dmyMatch = str.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (dmyMatch) {
    const d = parseInt(dmyMatch[1], 10);
    const m = parseInt(dmyMatch[2], 10);
    let y = dmyMatch[3] ? parseInt(dmyMatch[3], 10) : new Date().getFullYear();
    if (y < 100) y += 2000;
    return new Date(y, m - 1, d, 12, 0, 0);
  }
  const fallback = new Date(str);
  if (!isNaN(fallback.getTime())) {
    if (str.includes('T')) {
      const brStr = fallback.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      const [dd, mm, yyyy] = brStr.split('/').map(Number);
      return new Date(yyyy, mm - 1, dd, 12, 0, 0);
    }
    return new Date(fallback.getFullYear(), fallback.getMonth(), fallback.getDate(), 12, 0, 0);
  }
  return new Date();
}

/**
 * Retorna o dia da semana correto em português e a data formatada no padrão brasileiro
 */
function getDayOfWeekInfo(dateVal) {
  const d = parseLocalDate(dateVal);
  const dayIndex = d.getDay();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return {
    dayOfWeek: DIAS_SEMANA_NOMES[dayIndex],
    dayIndex,
    formattedBr: `${dd}/${mm}`,
    formattedFullBr: `${dd}/${mm}/${yyyy}`,
    isoDate: `${yyyy}-${mm}-${dd}`
  };
}

/**
 * Padrões de regex para identificar quando o cliente quer outra data / outro dia / outro sábado
 */
const ANOTHER_DATE_INTENTS = [
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
function extractDatesFromText(text) {
  const dates = [];
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

// ------------------------------------------------------------------------------
// DEFINIÇÃO DAS 6 TOOLS OFICIAIS (FUNCTION CALLING)
// ------------------------------------------------------------------------------
const TOOLS_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'salvar_lead_qualificado',
      description: 'Salva os dados do lead após qualificação comercial (nome, serviço de interesse, bairro/cidade, urgência e observações). Dispara alerta estruturado para o WhatsApp da equipe técnica.',
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
  },
  {
    type: 'function',
    function: {
      name: 'get_available_calendar_slots',
      description: 'Consulta a agenda do Google Calendar / Sistema em tempo real e retorna EXATAMENTE 2 horários livres verificados. ATENÇÃO OBRIGATÓRIA: Use esta função SOMENTE DEPOIS que o cliente já tiver esclarecido se o serviço é para NOVA INSTALAÇÃO ou para MANUTENÇÃO. NUNCA chame se o cliente apenas pediu "visita técnica", "orçamento" ou "valores" de forma genérica sem ter especificado se é nova instalação ou manutenção. Se o cliente pediu "outro dia", "outra data" ou recusou uma data anterior, passe a data antiga em excludeDates!',
      parameters: {
        type: 'object',
        properties: {
          fromDate: {
            type: 'string',
            description: 'Data de início no formato YYYY-MM-DD. Se omitido, busca a partir do próximo dia útil.'
          },
          excludeSlots: {
            type: 'array',
            items: { type: 'string' },
            description: 'Lista de horários ou datas específicas que o cliente já recusou anteriormente (ex: ["08:00", "10:00"]).'
          },
          excludeDates: {
            type: 'array',
            items: { type: 'string' },
            description: 'Lista de DATAS inteiras (YYYY-MM-DD ou DD/MM) que devem ser TOTALMENTE IGNORADAS.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_specific_slot_availability',
      description: 'Verifica se uma data e horário específicos solicitados pelo cliente estão LIVRES na agenda do Google Calendar / Sistema. Se estiver ocupado, retorna os horários livres alternativos.',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: 'Data no formato YYYY-MM-DD (ex: "2026-11-07")'
          },
          time: {
            type: 'string',
            description: 'Horário no formato HH:mm (ex: "10:00" ou "14:00")'
          }
        },
        required: ['date', 'time']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'book_appointment',
      description: 'Grava e bloqueia um agendamento na agenda do Google Calendar e no banco de dados. ANALISE O CONTEXTO: use appointmentType: "VISITA_TECNICA" para diagnóstico e orçamento prévio, OU appointmentType: "INSTALACAO_CFTV" quando o cliente já aprovou o orçamento e está agendando a instalação definitiva das câmeras.',
      parameters: {
        type: 'object',
        properties: {
          appointmentType: {
            type: 'string',
            enum: ['VISITA_TECNICA', 'INSTALACAO_CFTV'],
            description: 'Tipo de agendamento: VISITA_TECNICA (avaliação inicial de pontos cegos e orçamento) ou INSTALACAO_CFTV (montagem/instalação das câmeras após serviço fechado).'
          },
          date: {
            type: 'string',
            description: 'Data confirmada no formato YYYY-MM-DD'
          },
          time: {
            type: 'string',
            description: 'Horário confirmado no formato HH:mm'
          },
          clientName: {
            type: 'string',
            description: 'Nome do cliente'
          },
          address: {
            type: 'string',
            description: 'Endereço completo (com número e bairro) onde o técnico comparecerá'
          },
          serviceType: {
            type: 'string',
            description: 'Descrição do serviço (ex: "Visita Técnica Gratuita", "Manutenção e Diagnóstico" ou "Instalação de Câmeras de Segurança")'
          },
          notes: {
            type: 'string',
            description: 'Observações adicionais (quantidade de câmeras, modelo, detalhes do local)'
          }
        },
        required: ['date', 'time', 'clientName', 'appointmentType']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_client_details',
      description: 'Grava o ENDEREÇO (e nome/observações) informados pelo cliente no evento da agenda e no CRM, depois que o agendamento já foi criado. Chame assim que o cliente informar o endereço do local da visita/instalação.',
      parameters: {
        type: 'object',
        properties: {
          address: {
            type: 'string',
            description: 'Endereço completo informado pelo cliente (rua, número, bairro, referência)'
          },
          clientName: {
            type: 'string',
            description: 'Nome do cliente (se informado)'
          },
          notes: {
            type: 'string',
            description: 'Observações úteis (ponto de referência, quantidade de câmeras, etc.)'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cancel_appointment',
      description: 'Cancela e desmarca DEFINITIVAMENTE o agendamento da visita técnica ou instalação. DEVE ser chamada sempre que o cliente pedir para desmarcar, cancelar ou adiar ("desmarcar", "cancelar", "não vou poder", "vou aguardar outro dia"). Retorna automaticamente os próximos 2 horários livres verificados de OUTRO DIA para remarcação imediata.',
      parameters: {
        type: 'object',
        properties: {
          clientName: {
            type: 'string',
            description: 'Nome do cliente'
          },
          date: {
            type: 'string',
            description: 'Data do agendamento cancelado no formato YYYY-MM-DD (se mencionada)'
          },
          reason: {
            type: 'string',
            description: 'Motivo do cancelamento (opcional)'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'consultar_historico_cliente',
      description: 'Consulta no banco de dados o histórico completo deste cliente (visitas agendadas, concluídas, canceladas, endereço e perfil cadastrado). Chame sempre que o cliente perguntar sobre seus agendamentos, quiser verificar o que foi marcado ou detalhes de atendimentos anteriores.',
      parameters: {
        type: 'object',
        properties: {}
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
   * Detecta se a mensagem do cliente confirma data/horário para agendamento
   */
  detectBookingRequest(text, historyMessages = [], aiConfig = {}) {
    if (!text) return null;
    const lower = text.toLowerCase().trim();

    if (lower.includes('desmarqu') || lower.includes('cancel') || lower.includes('outro dia') || lower.includes('não posso') || lower.includes('nao posso')) {
      return null;
    }

    const hasBookingVerb = (
      lower.includes('pode marcar') ||
      lower.includes('pode agendar') ||
      lower.includes('pode ser') ||
      lower.includes('marca') ||
      lower.includes('agendar') ||
      lower.includes('confirmo') ||
      lower.includes('fica bom') ||
      lower.includes('fechado') ||
      lower.includes('combinado') ||
      lower.includes('quero') ||
      lower.startsWith('as ') ||
      lower.startsWith('às ')
    );

    const isQuestion = lower.includes('?') || lower.includes('tem vaga') || lower.includes('teria vaga') || lower.includes('consegue');
    if (isQuestion) return null;

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

    const timeMatch = lower.match(/\b([01]?\d|2[0-3])(?::([0-5]\d)|h(?:oras?)?|\s*horas?)\b/) ||
                      lower.match(/às\s*([01]?\d|2[0-3])\b/);

    let targetTime = null;
    if (timeMatch) {
      const hour = String(timeMatch[1]).padStart(2, '0');
      const minute = timeMatch[2] ? String(timeMatch[2]).padStart(2, '0') : '00';
      targetTime = `${hour}:${minute}`;
    }

    if (!hasBookingVerb || !targetTime) return null;

    // Busca data explícita no texto (ex: 07/11 ou 2026-11-07)
    let targetDate = null;
    const dateMatch = text.match(/\b(\d{1,2})\/(\d{1,2})\b/);
    if (dateMatch) {
      const now = new Date();
      const d = String(dateMatch[1]).padStart(2, '0');
      const m = String(dateMatch[2]).padStart(2, '0');
      targetDate = `${now.getFullYear()}-${m}-${d}`;
    }

    // Busca data nas últimas mensagens do assistente (ex: Sábado (07/11))
    if (!targetDate && Array.isArray(historyMessages)) {
      for (let i = historyMessages.length - 1; i >= 0; i--) {
        const m = historyMessages[i];
        if (m.role === 'assistant' && m.content) {
          const amMatch = m.content.match(/\b(\d{2})\/(\d{2})\b/);
          if (amMatch) {
            const now = new Date();
            const d = String(amMatch[1]).padStart(2, '0');
            const mo = String(amMatch[2]).padStart(2, '0');
            targetDate = `${now.getFullYear()}-${mo}-${d}`;
            break;
          }
        }
      }
    }

    if (!targetDate) {
      // Data padrão: próximo dia permitido nas regras de agendamento do tenant
      const r = aiConfig?.regras_agendamento || {};
      const allowedDaysList = (Array.isArray(r.dias_atendimento) && r.dias_atendimento.length > 0)
        ? r.dias_atendimento
        : ((Array.isArray(r.dias) && r.dias.length > 0) ? r.dias : ['sabado']);
      const allowedIndices = allowedDaysList.map(k => DIA_KEY_TO_INDEX[String(k).toLowerCase().trim()]).filter(v => v !== undefined);
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
   * Detecta se o cliente deseja cancelar / desmarcar
   */
  detectCancelRequest(text) {
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
  detectConsultarHistoricoRequest(text) {
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
      lower.includes('quando é minha visita') ||
      lower.includes('quando e minha visita') ||
      lower.includes('agendamento confirmado?') ||
      lower.includes('visita confirmada?') ||
      lower.includes('tenho visita marcada') ||
      lower.includes('histórico de visita') ||
      lower.includes('historico de visita') ||
      lower.includes('visita anterior') ||
      lower.includes('visitas anteriores') ||
      lower.includes('visitas cumpridas') ||
      lower.includes('visitas canceladas')
    );
  }

  /**
   * Executa Tool: salvar_lead_qualificado
   */
  async executeQualificationTool({ tenantId, instanceName, sessionId, remoteJid, args }) {
    const { nome, servico, bairro_cidade, urgencia = 'media', detalhes = '' } = args;

    console.log(`[AIEngine] Executando tool salvar_lead_qualificado para ${nome} (${remoteJid})...`);

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
       SET dados_lead = $1, client_name = $2, etapa_funil = 'qualificacao', last_interaction = now()
       WHERE id = $3`,
      [JSON.stringify(dadosLead), nome.trim(), sessionId]
    );

    // Atualiza ou cria customer_profile
    await query(
      `INSERT INTO customer_profiles (tenant_id, remote_jid, nome, perfil_resumo)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, remote_jid)
       DO UPDATE SET nome = EXCLUDED.nome, perfil_resumo = COALESCE(customer_profiles.perfil_resumo || E'\n', '') || EXCLUDED.perfil_resumo, updated_at = now()`,
      [tenantId, remoteJid, nome.trim(), `Interesse: ${servico} em ${bairro_cidade} (Urgência: ${urgencia}).`]
    );

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
_Lead salvo no banco de dados e sincronizado no CRM._`;

      try {
        const sendAlertRes = await evolutionService.sendTextMessage(instanceName, cleanPhone, alertMessage);
        if (sendAlertRes.messageId) {
          await messageCache.setBotSent(sendAlertRes.messageId, 60);
          notifSent = true;
          console.log(`[AIEngine] Alerta de lead enviado com sucesso para a equipe (+${cleanPhone})!`);
        }
      } catch (alertErr) {
        console.warn(`[AIEngine] Falha ao enviar notificação para +${cleanPhone}:`, alertErr.message);
      }
    }

    return {
      success: true,
      message: 'Lead qualificado com sucesso! Dados registrados no CRM e equipe notificada.',
      notifSent,
      lead: dadosLead
    };
  }

  /**
   * Executa Tool: get_available_calendar_slots
   */
  async executeGetSlotsTool({ tenantId, historyMessages = [], args = {} }) {
    let { fromDate = null, excludeSlots = [], excludeDates = [] } = args;

    if (!Array.isArray(excludeDates)) {
      excludeDates = excludeDates ? [excludeDates] : [];
    }
    if (!Array.isArray(excludeSlots)) {
      excludeSlots = excludeSlots ? [excludeSlots] : [];
    }

    // Regra Fundamental: Verificar se o cliente já identificou se é Nova Instalação ou Manutenção
    const allUserText = historyMessages
      .filter(m => m.role === 'user')
      .map(m => m.content.toLowerCase())
      .join(' ');

    const allAssistantText = historyMessages
      .filter(m => m.role === 'assistant')
      .map(m => m.content.toLowerCase())
      .join(' ');

    const isClearlyNew = allUserText.includes('nova instala') || allUserText.includes('instalar do zero') || allUserText.includes('câmeras novas') || allUserText.includes('não tenho câmera') || allUserText.includes('nao tenho camera') || allUserText.includes('instalação nova') || allUserText.includes('projeto novo') || allUserText.includes('quero instalar') || allAssistantText.includes('nova instalação') || allAssistantText.includes('nova instalacao');
    const isClearlyMaintenance = allUserText.includes('manuten') || allUserText.includes('consert') || allUserText.includes('repar') || allUserText.includes('parou de') || allUserText.includes('câmera queim') || allUserText.includes('arrumar') || allUserText.includes('já tenho câmera') || allUserText.includes('ja tenho') || allAssistantText.includes('manutenção') || allAssistantText.includes('manutencao');

    if (!isClearlyNew && !isClearlyMaintenance) {
      console.log('[AIEngine] Bloqueio get_available_calendar_slots: cliente ainda não especificou se é Nova Instalação ou Manutenção.');
      return {
        success: false,
        requiresQualification: true,
        instruction: 'O cliente ainda NÃO esclareceu se a visita técnica é para NOVA INSTALAÇÃO ou MANUTENÇÃO. NÃO passe horários e NÃO fale de gratuidade! Pergunte primeiro exatamente: "Opa! Com certeza, realizamos sim. Só para eu te orientar certinho: a visita técnica seria para uma *nova instalação* de câmeras ou para *manutenção / conserto* de câmeras que você já tem no local?"'
      };
    }

    // 1. Extrai todas as datas previamente sugeridas pelo assistente no histórico da conversa
    const previouslyOfferedDates = [];
    for (const msg of historyMessages) {
      if (msg.role === 'assistant' && msg.content) {
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
      .map(m => m.content || '')
      .join(' ');

    const isAskingAnotherDate = ANOTHER_DATE_INTENTS.some(regex => regex.test(recentUserMsgs));
    const userMentionedDates = extractDatesFromText(recentUserMsgs);

    if (isAskingAnotherDate || excludeDates.length > 0) {
      // Exclui todas as datas já oferecidas ao cliente para não insistir
      for (const d of previouslyOfferedDates) {
        if (!excludeDates.includes(d)) excludeDates.push(d);
      }
      for (const d of userMentionedDates) {
        if (!excludeDates.includes(d)) excludeDates.push(d);
      }

      // Se não veio fromDate explícito nos args, calcula o fromDate avançando para o dia seguinte da data recusada
      if (!fromDate && excludeDates.length > 0) {
        const sortedDates = [...excludeDates].sort();
        const latestDateStr = sortedDates[sortedDates.length - 1];
        const latestDate = parseLocalDate(latestDateStr);
        latestDate.setDate(latestDate.getDate() + 1);
        fromDate = getDayOfWeekInfo(latestDate).isoDate;
      }
    }

    // Se o cliente pediu especificamente uma data futura sem intenção de recusa genérica
    if (!isAskingAnotherDate && userMentionedDates.length > 0 && !fromDate) {
      fromDate = userMentionedDates[0];
    }

    // Se o cliente pediu "mês que vem" ou "próximo mês"
    if ((recentUserMsgs.toLowerCase().includes('mês que vem') || recentUserMsgs.toLowerCase().includes('mes que vem') || recentUserMsgs.toLowerCase().includes('próximo mês') || recentUserMsgs.toLowerCase().includes('proximo mes')) && !fromDate) {
      const now = new Date();
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 12, 0, 0);
      fromDate = getDayOfWeekInfo(nextMonth).isoDate;
    }

    const normExcludeDates = (excludeDates || []).map(d => String(d).trim());
    const normExcludeSlots = (excludeSlots || []).map(s => String(s).trim());

    let instructionMsg;
    if (isAskingAnotherDate) {
      instructionMsg = 'O cliente pediu outra data ou não pode na data anterior. NUNCA insista nem repita a data já recusada! Apresente com simpatia e acolhimento os NOVOS horários livres encontrados para o PRÓXIMO dia disponível na agenda. Pergunte se algum desses novos horários fica bom para ele.';
    } else if (isClearlyMaintenance) {
      instructionMsg = 'Atenção obrigatória para MANUTENÇÃO: informe com clareza a taxa de visita técnica de R$ 140,00 e que esse valor é 100% aproveitado e abatido no conserto, além de oferecer os 2 horários livres abaixo!';
    } else {
      instructionMsg = 'Para NOVA INSTALAÇÃO: informe que a visita técnica de avaliação de pontos cegos e cabeamento é 100% gratuita e sem compromisso, além de oferecer os 2 horários livres abaixo!';
    }

    try {
      // 1. Tenta obter slots reais via Google Calendar
      if (calendarService.isConfigured && calendarService.isConfigured()) {
        const slots = await calendarService.getNextAvailableSlots(2, fromDate, normExcludeSlots, normExcludeDates);
        if (slots && slots.length > 0) {
          // Filtra contra agendamentos existentes no banco de dados para evitar conflito
          const safeCalendarSlots = [];
          for (const s of slots) {
            const slotTimestamp = new Date(`${s.date}T${s.time}:00-03:00`);
            const busyCheck = await query(
              `SELECT id FROM appointments 
               WHERE tenant_id = $1 AND data_agendada = $2 AND status = 'agendado' LIMIT 1`,
              [tenantId, slotTimestamp]
            );
            if (busyCheck.rowCount === 0) {
              safeCalendarSlots.push({
                date: s.date,
                dayOfWeek: s.dayOfWeek,
                time: s.time,
                description: s.label
              });
            }
          }

          if (safeCalendarSlots.length > 0) {
            return {
              success: true,
              totalFound: safeCalendarSlots.length,
              instruction: instructionMsg,
              slots: safeCalendarSlots,
              resolvedArgs: {
                fromDate,
                excludeDates: Array.from(new Set(normExcludeDates)),
                excludeSlots: normExcludeSlots
              }
            };
          }
        }
      }
    } catch (calErr) {
      console.warn('[AIEngine] Aviso ao consultar Google Calendar:', calErr.message);
    }

    // 2. Fallback de alta confiabilidade: calcula slots do tenant respeitando estritamente os dias e horários permitidos
    const cfgRes = await query(`SELECT regras_agendamento FROM tenant_ai_configs WHERE tenant_id = $1`, [tenantId]);
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
      .map(k => DIA_KEY_TO_INDEX[String(k).toLowerCase().trim()])
      .filter(idx => idx !== undefined);

    let cursorDate;
    if (fromDate) {
      cursorDate = parseLocalDate(fromDate);
    } else {
      const now = new Date();
      cursorDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12, 0, 0);
    }

    const freeSlots = [];
    let daysChecked = 0;

    while (freeSlots.length < 2 && daysChecked < 60) {
      const info = getDayOfWeekInfo(cursorDate);

      // Trava de dias de atendimento: se o dia não for permitido, pula
      if (allowedIndices.includes(info.dayIndex)) {
        const isExcluded = normExcludeDates.some(ex => ex === info.isoDate || ex === info.formattedBr || info.isoDate.endsWith(ex));
        if (!isExcluded) {
          for (const slotTime of configuredSlots) {
            const cleanTime = slotTime.substring(0, 5);
            const slotKey = `${info.isoDate} ${cleanTime}`;
            if (normExcludeSlots.includes(slotKey) || normExcludeSlots.includes(cleanTime)) {
              continue;
            }

            // Trava anti-duplicidade no banco de dados: confere se horário já está reservado
            const slotTimestamp = new Date(`${info.isoDate}T${cleanTime}:00-03:00`);
            const busyCheck = await query(
              `SELECT id FROM appointments 
               WHERE tenant_id = $1 AND data_agendada = $2 AND status = 'agendado' LIMIT 1`,
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
   * Executa Tool: check_specific_slot_availability
   */
  async executeCheckSlotTool({ tenantId, date, time, historyMessages = [] }) {
    const info = getDayOfWeekInfo(date);
    const cleanTime = (time || '08:00').substring(0, 5);
    const slotTimestamp = new Date(`${info.isoDate}T${cleanTime}:00-03:00`);

    const cfgRes = await query(`SELECT regras_agendamento FROM tenant_ai_configs WHERE tenant_id = $1`, [tenantId]);
    const aiCfg = cfgRes.rows[0]?.regras_agendamento || {};

    const allowedDaysList = (Array.isArray(aiCfg.dias_atendimento) && aiCfg.dias_atendimento.length > 0)
      ? aiCfg.dias_atendimento
      : ((Array.isArray(aiCfg.dias) && aiCfg.dias.length > 0)
          ? aiCfg.dias
          : ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado']);

    const allowedIndices = allowedDaysList
      .map(k => DIA_KEY_TO_INDEX[String(k).toLowerCase().trim()])
      .filter(idx => idx !== undefined);
    const allowedDaysNames = allowedIndices.map(idx => DIAS_SEMANA_NOMES[idx]);

    // 1. Trava de dia da semana permitido
    if (!allowedIndices.includes(info.dayIndex)) {
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
       WHERE tenant_id = $1 AND data_agendada = $2 AND status = 'agendado' LIMIT 1`,
      [tenantId, slotTimestamp]
    );

    if (busyCheck.rowCount > 0) {
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
  async executeBookAppointmentTool({ tenantId, sessionId, remoteJid, pushName, historyMessages = [], args }) {
    const { date, time, clientName, address = 'Endereço a confirmar', appointmentType = 'VISITA_TECNICA', serviceType, notes = '' } = args;

    const info = getDayOfWeekInfo(date);
    const cleanDate = info.isoDate;
    const cleanTime = (time || '08:00').substring(0, 5);
    const apptDate = new Date(`${cleanDate}T${cleanTime}:00-03:00`);

    const finalClientName = (clientName && clientName !== 'Cliente') ? clientName : (pushName || 'Cliente WhatsApp');
    const finalServiceType = serviceType || (appointmentType === 'INSTALACAO_CFTV' ? 'Instalação de Câmeras de Segurança' : 'Visita Técnica Gratuita');

    // 1. Validação de Dias Permitidos do Tenant
    const cfgRes = await query(`SELECT regras_agendamento FROM tenant_ai_configs WHERE tenant_id = $1`, [tenantId]);
    const aiCfg = cfgRes.rows[0]?.regras_agendamento || {};

    const allowedDaysList = (Array.isArray(aiCfg.dias_atendimento) && aiCfg.dias_atendimento.length > 0)
      ? aiCfg.dias_atendimento
      : ((Array.isArray(aiCfg.dias) && aiCfg.dias.length > 0)
          ? aiCfg.dias
          : ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado']);

    const allowedIndices = allowedDaysList
      .map(k => DIA_KEY_TO_INDEX[String(k).toLowerCase().trim()])
      .filter(idx => idx !== undefined);
    const allowedDaysNames = allowedIndices.map(idx => DIAS_SEMANA_NOMES[idx]);

    if (!allowedIndices.includes(info.dayIndex)) {
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
       WHERE tenant_id = $1 AND data_agendada = $2 AND status = 'agendado' AND remote_jid != $3 LIMIT 1`,
      [tenantId, apptDate, remoteJid]
    );

    if (occupiedCheck.rowCount > 0) {
      console.warn(`[AIEngine] Bloqueio book_appointment: horário ${cleanDate} às ${cleanTime} já ocupado por outro cliente.`);
      const nextSlots = await this.executeGetSlotsTool({
        tenantId,
        historyMessages: historyMessages.length > 0 ? historyMessages : [{ role: 'user', content: 'nova instalação' }],
        args: { excludeSlots: [`${cleanDate} ${cleanTime}`, cleanTime], excludeDates: [cleanDate] }
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
       ORDER BY data_agendada DESC LIMIT 1`,
      [tenantId, remoteJid, finalServiceType]
    );

    let apptId;
    let isReschedule = false;

    if (existingApptRes.rowCount > 0) {
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
           WHERE id = $5`,
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
         RETURNING id`,
        [tenantId, remoteJid, finalServiceType, apptDate, appointmentType, address, notes]
      );
      apptId = apptDbRes.rows[0].id;
    }

    await query(
      `UPDATE chat_sessions 
       SET etapa_funil = 'agendado', client_name = COALESCE($1, client_name), last_interaction = now()
       WHERE id = $2`,
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
  async executeSaveClientDetailsTool({ tenantId, sessionId, remoteJid, args }) {
    const { address, clientName, notes } = args;

    console.log(`[AIEngine] Salvando detalhes do cliente para ${remoteJid}: endereço="${address}"`);

    // Atualiza último agendamento do cliente
    if (address) {
      await query(
        `UPDATE appointments 
         SET endereco = $1 
         WHERE id = (
           SELECT id FROM appointments 
           WHERE tenant_id = $2 AND remote_jid = $3 
           ORDER BY created_at DESC LIMIT 1
         )`,
        [address.trim(), tenantId, remoteJid]
      );
    }

    // Atualiza customer_profiles
    await query(
      `INSERT INTO customer_profiles (tenant_id, remote_jid, nome, endereco_completo)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, remote_jid)
       DO UPDATE SET 
         endereco_completo = COALESCE(EXCLUDED.endereco_completo, customer_profiles.endereco_completo),
         nome = COALESCE(EXCLUDED.nome, customer_profiles.nome),
         updated_at = now()`,
      [tenantId, remoteJid, clientName ? clientName.trim() : null, address ? address.trim() : null]
    );

    // Atualiza session
    if (clientName) {
      await query(
        `UPDATE chat_sessions SET client_name = $1, last_interaction = now() WHERE id = $2`,
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
  async executeCancelAppointmentTool({ tenantId, sessionId, remoteJid, args }) {
    const { clientName, date } = args;

    console.log(`[AIEngine] Cancelando agendamento para ${remoteJid}...`);

    // Cancela no Google Calendar se configurado
    if (calendarService.isConfigured && calendarService.isConfigured()) {
      try {
        const phone = remoteJid.replace(/@.*$/, '').replace(/\D/g, '');
        await calendarService.cancelAppointment({ phone, clientName, date });
      } catch (err) {
        console.warn('[AIEngine] Aviso ao cancelar no Google Calendar:', err.message);
      }
    }

    // Atualiza no banco
    await query(
      `UPDATE appointments 
       SET status = 'cancelado' 
       WHERE tenant_id = $1 AND remote_jid = $2 AND status = 'agendado'`,
      [tenantId, remoteJid]
    );

    await query(
      `UPDATE chat_sessions SET etapa_funil = 'qualificacao', last_interaction = now() WHERE id = $1`,
      [sessionId]
    );

    // Obtém 2 novos slots de outro dia para reagendamento imediato
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
  async executeConsultarHistoricoTool({ tenantId, remoteJid }) {
    console.log(`[AIEngine] Consultando histórico no banco de dados para ${remoteJid}...`);
    const apptsRes = await query(
      `SELECT id, servico, data_agendada, status, tipo_agendamento, endereco, observacoes
       FROM appointments 
       WHERE tenant_id = $1 AND remote_jid = $2
       ORDER BY data_agendada DESC LIMIT 20`,
      [tenantId, remoteJid]
    );

    const profileRes = await query(
      `SELECT nome, endereco_completo, perfil_resumo 
       FROM customer_profiles 
       WHERE tenant_id = $1 AND remote_jid = $2 LIMIT 1`,
      [tenantId, remoteJid]
    );

    const agendasMarcadas = [];
    const agendasCumpridas = [];
    const agendasCanceladas = [];

    apptsRes.rows.forEach(a => {
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
   * Processa a rodada de atendimento (turn) da IA para a mensagem do cliente
   */
  async processTurn({ tenantId, instanceName, sessionId, remoteJid, pushName, userMessage, isAudio }) {
    // 1. Carrega dados do Tenant e Configuração de IA
    const tenantRes = await query(`SELECT id, nome_empresa, plano FROM tenants WHERE id = $1`, [tenantId]);
    if (tenantRes.rowCount === 0) throw new Error(`Tenant não encontrado: ${tenantId}`);
    const tenant = tenantRes.rows[0];

    const aiConfigRes = await query(`SELECT * FROM tenant_ai_configs WHERE tenant_id = $1`, [tenantId]);
    const aiConfig = aiConfigRes.rows[0] || {};

    const sessionRes = await query(`SELECT * FROM chat_sessions WHERE id = $1`, [sessionId]);
    const session = sessionRes.rows[0] || {};

    const profileRes = await query(`SELECT * FROM customer_profiles WHERE tenant_id = $1 AND remote_jid = $2`, [tenantId, remoteJid]);
    const customerProfile = profileRes.rows[0] || null;

    const apptsRes = await query(`SELECT * FROM appointments WHERE tenant_id = $1 AND remote_jid = $2 ORDER BY created_at DESC LIMIT 15`, [tenantId, remoteJid]);
    const appointments = apptsRes.rows;

    // 2. Compila System Prompt Dinâmico de Alto Nível
    const systemPrompt = promptCompiler.compileSystemPrompt(tenant, aiConfig, session, customerProfile, appointments);

    // 3. Carrega Histórico Recente expandido (até 50 mensagens para leitura completa do contexto)
    const historyRes = await query(
      `SELECT role, content 
       FROM chat_messages 
       WHERE session_id = $1 
       ORDER BY created_at DESC 
       LIMIT 50`,
      [sessionId]
    );

    const historyMessages = historyRes.rows.reverse().map(m => ({
      role: m.role === 'tool' ? 'tool' : m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content
    }));

    // Monta mensagens para a API OpenAI
    const messagesToSend = [
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

    console.log(`[AIEngine] Chamando OpenAI (gpt-4o-mini) para ${remoteJid} com histórico de ${historyMessages.length} msgs...`);

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
      const allText = historyMessages.map(m => m.content.toLowerCase()).join(' ') + ' ' + userMessage.toLowerCase();
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

    // 3. Gatilho Proativo de Horários Livres (evita adiamento ou "vou verificar a agenda... um momento")
    const allUserText = historyMessages.map(m => m.content.toLowerCase()).join(' ') + ' ' + userMessage.toLowerCase();
    const isClearlyNew = allUserText.includes('nova instala') || allUserText.includes('instalar do zero') || allUserText.includes('câmeras novas') || allUserText.includes('não tenho câmera') || allUserText.includes('nao tenho camera') || allUserText.includes('instalação nova') || allUserText.includes('projeto novo') || allUserText.includes('quero instalar');
    const isClearlyMaintenance = allUserText.includes('manuten') || allUserText.includes('consert') || allUserText.includes('repar') || allUserText.includes('parou de') || allUserText.includes('câmera queim') || allUserText.includes('arrumar') || allUserText.includes('já tenho câmera') || allUserText.includes('ja tenho');
    const isAppointmentReq = allUserText.includes('agendar visita') || allUserText.includes('marcar visita') || allUserText.includes('horário livre') || allUserText.includes('horario livre') || allUserText.includes('vaga na agenda') || allUserText.includes('outro dia') || allUserText.includes('outra data') || allUserText.includes('outro sábado') || allUserText.includes('outro sabado') || allUserText.includes('mais pra frente') || allUserText.includes('mais para frente');

    const isSchedulingTenant = aiConfig.objetivo_funil === 'agendamento' || (!aiConfig.objetivo_funil && !String(tenant.nome_empresa).toLowerCase().includes('velas') && aiConfig.tipo_negocio !== 'produtos');
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

    let toolCallCount = 0;
    let finalAssistantText = '';

    // Loop de chamada de ferramentas (até no máximo 4 iterações)
    while (toolCallCount < 4) {
      const response = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: messagesToSend,
        tools: TOOLS_DEFINITIONS,
        tool_choice: 'auto',
        temperature: 0.3
      });

      const responseMessage = response.choices[0].message;

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

    if (!finalAssistantText || !finalAssistantText.trim()) {
      console.warn('[AIEngine] LLM não retornou texto final legível.');
      return null;
    }

    // 4. Decide se a resposta será enviada em Áudio (TTS) ou Texto
    const modoRespostaAudio = aiConfig.responder_com_audio || 'texto';
    const hasAudioInput = !!isAudio || (typeof userMessage === 'string' && userMessage.startsWith('[audio]'));
    const shouldSendAudio = (
      modoRespostaAudio === 'sempre' ||
      (modoRespostaAudio === 'quando_receber_audio' && hasAudioInput)
    );

    const tempoRespostaSeg = Math.max(0, parseInt(aiConfig.tempo_resposta_segundos !== undefined ? aiConfig.tempo_resposta_segundos : 3, 10));
    const delayMs = tempoRespostaSeg * 1000;

    let sendRes;
    let sentMediaType = 'text';

    if (shouldSendAudio) {
      console.log(`[AIEngine] Gerando áudio humanizado (Voz: ${aiConfig.voz_ia || 'nova'}) para ${remoteJid} (delay: ${tempoRespostaSeg}s)...`);
      try {
        await evolutionService.sendPresence(instanceName, remoteJid, 'recording');
        const speech = await ttsService.generateSpeech(finalAssistantText, {
          voice: aiConfig.voz_ia || 'nova'
        });

        sendRes = await evolutionService.sendWhatsAppAudio(instanceName, remoteJid, speech.base64, { delay: delayMs });
        sentMediaType = 'audio';
      } catch (audioErr) {
        console.warn(`[AIEngine] Aviso ao gerar/enviar áudio TTS (${audioErr.message}). Fallback para texto.`);
        sendRes = await evolutionService.sendTextMessage(instanceName, remoteJid, finalAssistantText, { delay: delayMs });
        sentMediaType = 'text';
      }
    } else {
      console.log(`[AIEngine] Enviando resposta humanizada em texto para ${remoteJid} (delay: ${tempoRespostaSeg}s)...`);
      await evolutionService.sendPresence(instanceName, remoteJid, 'composing');
      sendRes = await evolutionService.sendTextMessage(instanceName, remoteJid, finalAssistantText, { delay: delayMs });
      sentMediaType = 'text';
    }

    if (sendRes && sendRes.messageId) {
      // 5. Grava no Cache Anti-Loop (TTL 60s)
      await messageCache.setBotSent(sendRes.messageId, 60);

      // 6. Salva no banco de dados na tabela chat_messages
      await query(
        `INSERT INTO chat_messages (session_id, tenant_id, role, content, media_type, message_id)
         VALUES ($1, $2, 'assistant', $3, $4, $5)`,
        [sessionId, tenantId, finalAssistantText.trim(), sentMediaType, sendRes.messageId]
      );

      // 7. Atualiza interação na sessão
      await query(`UPDATE chat_sessions SET last_interaction = now() WHERE id = $1`, [sessionId]);

      console.log(`[AIEngine] Resposta enviada (${sentMediaType}) e persistida com sucesso (messageId: ${sendRes.messageId}).`);
    }

    return {
      success: true,
      messageId: sendRes ? sendRes.messageId : null,
      replyText: finalAssistantText,
      mediaType: sentMediaType
    };
  }
}

module.exports = new AiEngineService();
module.exports.AiEngineService = AiEngineService;
module.exports.TOOLS_DEFINITIONS = TOOLS_DEFINITIONS;
