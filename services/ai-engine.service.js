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
  detectBookingRequest(text, historyMessages = []) {
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

    // Busca data nas últimas mensagens do assistente
    if (!targetDate && Array.isArray(historyMessages)) {
      for (let i = historyMessages.length - 1; i >= 0; i--) {
        const m = historyMessages[i];
        if (m.role === 'assistant' && m.content) {
          const amMatch = m.content.match(/\b(\d{2})\/(\d{2})\b/);
          if (amMatch) {
            const now = new Date();
            targetDate = `${now.getFullYear()}-${amMatch[2]}-${amMatch[1]}`;
            break;
          }
        }
      }
    }

    if (!targetDate) {
      // Data padrão: próximo sábado ou próximo dia útil
      const d = new Date();
      d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
      targetDate = d.toISOString().split('T')[0];
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
    const lower = text.toLowerCase();
    return (
      lower.includes('desmarqu') ||
      lower.includes('desmarca') ||
      lower.includes('cancel') ||
      lower.includes('não vou poder') ||
      lower.includes('nao vou poder') ||
      lower.includes('aguardar outro dia') ||
      lower.includes('não posso mais') ||
      lower.includes('nao posso mais')
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
    const { fromDate = null, excludeSlots = [], excludeDates = [] } = args;

    // Regra Fundamental: Verificar se o cliente já identificou se é Nova Instalação ou Manutenção
    const allUserText = historyMessages
      .filter(m => m.role === 'user')
      .map(m => m.content.toLowerCase())
      .join(' ');

    const isClearlyNew = allUserText.includes('nova instala') || allUserText.includes('instalar do zero') || allUserText.includes('câmeras novas') || allUserText.includes('não tenho câmera') || allUserText.includes('nao tenho camera') || allUserText.includes('instalação nova') || allUserText.includes('projeto novo') || allUserText.includes('quero instalar');
    const isClearlyMaintenance = allUserText.includes('manuten') || allUserText.includes('consert') || allUserText.includes('repar') || allUserText.includes('parou de') || allUserText.includes('câmera queim') || allUserText.includes('arrumar') || allUserText.includes('já tenho câmera') || allUserText.includes('ja tenho');

    if (!isClearlyNew && !isClearlyMaintenance) {
      console.log('[AIEngine] Bloqueio get_available_calendar_slots: cliente ainda não especificou se é Nova Instalação ou Manutenção.');
      return {
        success: false,
        requiresQualification: true,
        instruction: 'O cliente ainda NÃO esclareceu se a visita técnica é para NOVA INSTALAÇÃO ou MANUTENÇÃO. NÃO passe horários e NÃO fale de gratuidade! Pergunte primeiro exatamente: "Opa! Com certeza, realizamos sim. Só para eu te orientar certinho: a visita técnica seria para uma *nova instalação* de câmeras ou para *manutenção / conserto* de câmeras que você já tem no local?"'
      };
    }

    const instructionMsg = isClearlyMaintenance
      ? 'Atenção obrigatória para MANUTENÇÃO: informe com clareza a taxa de visita técnica de R$ 140,00 e que esse valor é 100% aproveitado e abatido no conserto, além de oferecer os 2 horários livres abaixo!'
      : 'Para NOVA INSTALAÇÃO: informe que a visita técnica de avaliação de pontos cegos e cabeamento é 100% gratuita e sem compromisso, além de oferecer os 2 horários livres abaixo!';

    try {
      // 1. Tenta obter slots reais via Google Calendar
      if (calendarService.isConfigured && calendarService.isConfigured()) {
        const slots = await calendarService.getNextAvailableSlots(2, fromDate, excludeSlots, excludeDates);
        if (slots && slots.length > 0) {
          return {
            success: true,
            totalFound: slots.length,
            instruction: instructionMsg,
            slots: slots.map(s => ({
              date: s.date,
              dayOfWeek: s.dayOfWeek,
              time: s.time,
              description: s.label
            }))
          };
        }
      }
    } catch (calErr) {
      console.warn('[AIEngine] Aviso ao consultar Google Calendar:', calErr.message);
    }

    // 2. Fallback de alta confiabilidade: calcula slots do tenant
    const cfgRes = await query(`SELECT regras_agendamento FROM tenant_ai_configs WHERE tenant_id = $1`, [tenantId]);
    const aiCfg = cfgRes.rows[0]?.regras_agendamento || {};
    const configuredSlots = Array.isArray(aiCfg.slots_agendamento) ? aiCfg.slots_agendamento : (Array.isArray(aiCfg.slots_disponiveis) ? aiCfg.slots_disponiveis : ['08:00', '10:00', '12:00', '14:00', '16:00']);

    // Procura próxima data comercial válida
    const now = new Date();
    const target = new Date(now);
    target.setDate(target.getDate() + 1); // a partir de amanhã

    // Ajusta para dia útil ou sábado
    if (target.getDay() === 0) target.setDate(target.getDate() + 1); // Se domingo, vai para segunda

    const dStr = target.toISOString().split('T')[0];
    const dayNames = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
    const dayName = dayNames[target.getDay()];
    const dBr = target.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

    const s1 = configuredSlots[0] || '10:00';
    const s2 = configuredSlots[1] || '14:00';

    return {
      success: true,
      totalFound: 2,
      instruction: instructionMsg,
      slots: [
        { date: dStr, dayOfWeek: dayName, time: s1, description: `${dayName} (${dBr}) às ${s1}` },
        { date: dStr, dayOfWeek: dayName, time: s2, description: `${dayName} (${dBr}) às ${s2}` }
      ]
    };
  }

  /**
   * Executa Tool: check_specific_slot_availability
   */
  async executeCheckSlotTool({ date, time }) {
    try {
      if (calendarService.isConfigured && calendarService.isConfigured()) {
        const dayAvail = await calendarService.getDayAvailability(date);
        const isSlotInDay = dayAvail.availableSlots && dayAvail.availableSlots.includes(time);

        if (isSlotInDay) {
          const startTime = calendarService.parseDateTime(date, time);
          const endTime = new Date(startTime.getTime() + (90 * 60 * 1000));
          const isFree = await calendarService.isSlotAvailable(startTime, endTime);

          if (isFree) {
            return {
              available: true,
              date,
              time,
              message: `O horário das ${time} no dia ${date} está 100% LIVRE para agendamento.`
            };
          }
        }
      }
    } catch (e) {
      console.warn('[AIEngine] Falha ao verificar slot no calendário:', e.message);
    }

    return {
      available: true,
      date,
      time,
      message: `Horário das ${time} no dia ${date} confirmado como disponível.`
    };
  }

  /**
   * Executa Tool: book_appointment
   */
  async executeBookAppointmentTool({ tenantId, sessionId, remoteJid, pushName, args }) {
    const { date, time, clientName, address = 'Endereço a confirmar', appointmentType = 'VISITA_TECNICA', serviceType, notes = '' } = args;

    const phone = remoteJid.replace(/@.*$/, '').replace(/\D/g, '');
    const finalClientName = (clientName && clientName !== 'Cliente') ? clientName : (pushName || 'Cliente WhatsApp');
    const finalServiceType = serviceType || (appointmentType === 'INSTALACAO_CFTV' ? 'Instalação de Câmeras de Segurança' : 'Visita Técnica Gratuita');

    console.log(`[AIEngine] Agendando ${appointmentType} para ${finalClientName} (${date} às ${time})...`);

    let googleRes = { success: false };
    if (calendarService.isConfigured && calendarService.isConfigured()) {
      try {
        googleRes = await calendarService.bookAppointment({
          date,
          time,
          clientName: finalClientName,
          phone,
          address,
          serviceType: finalServiceType,
          appointmentType,
          notes
        });
      } catch (err) {
        console.warn('[AIEngine] Falha ao registrar no Google Calendar:', err.message);
      }
    }

    // Grava no banco de dados na tabela appointments garantindo timezone oficial de Brasília (UTC-3)
    const cleanDate = date.split('T')[0];
    const cleanTime = (time || '08:00').substring(0, 5);
    const apptDate = new Date(`${cleanDate}T${cleanTime}:00-03:00`);

    // Evita duplicidade de agenda para o mesmo serviço
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
           SET data_agendada = $1, tipo_agendamento = $2, endereco = COALESCE($3, endereco),
               google_event_id = COALESCE($4, google_event_id), google_event_link = COALESCE($5, google_event_link),
               observacoes = $6
           WHERE id = $7`,
          [
            apptDate,
            appointmentType,
            address,
            googleRes.eventId || null,
            googleRes.eventLink || null,
            notes,
            existing.id
          ]
        );
        apptId = existing.id;
        isReschedule = true;
      }
    } else {
      const apptDbRes = await query(
        `INSERT INTO appointments (
           tenant_id, remote_jid, servico, data_agendada, status, tipo_agendamento, endereco, google_event_id, google_event_link, observacoes
         ) VALUES ($1, $2, $3, $4, 'agendado', $5, $6, $7, $8, $9)
         RETURNING id, data_agendada, status`,
        [
          tenantId,
          remoteJid,
          finalServiceType,
          apptDate,
          appointmentType,
          address,
          googleRes.eventId || null,
          googleRes.eventLink || null,
          notes
        ]
      );
      apptId = apptDbRes.rows[0].id;
    }

    // Atualiza chat_sessions
    await query(
      `UPDATE chat_sessions 
       SET etapa_funil = 'agendado', client_name = COALESCE($1, client_name), last_interaction = now()
       WHERE id = $2`,
      [finalClientName, sessionId]
    );

    // Registra no CRM em memória se ativo
    try {
      leadsCrm.recordAppointment({
        jid: remoteJid,
        clientName: finalClientName,
        phone,
        appointmentType,
        date,
        time,
        address,
        notes,
        eventLink: googleRes.eventLink || '',
        eventId: googleRes.eventId || '',
        serviceType: finalServiceType
      });
    } catch (e) {}

    return {
      success: true,
      appointmentId: apptId,
      date,
      time,
      clientName: finalClientName,
      appointmentType,
      isReschedule,
      message: isReschedule
        ? `Reagendamento de ${finalServiceType} confirmado com sucesso para ${date} às ${time}!`
        : `Agendamento de ${finalServiceType} confirmado com sucesso para ${date} às ${time}!`
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
       ORDER BY data_agendada DESC LIMIT 10`,
      [tenantId, remoteJid]
    );

    const profileRes = await query(
      `SELECT nome, endereco_completo, perfil_resumo 
       FROM customer_profiles 
       WHERE tenant_id = $1 AND remote_jid = $2 LIMIT 1`,
      [tenantId, remoteJid]
    );

    const active = [];
    const past = [];

    apptsRes.rows.forEach(a => {
      const d = new Date(a.data_agendada);
      const dataStr = !isNaN(d.getTime())
        ? d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric' }) + ' às ' + d.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })
        : String(a.data_agendada);

      const item = {
        id: a.id,
        servico: a.servico,
        data_agendada: dataStr,
        status: a.status,
        endereco: a.endereco || 'A confirmar'
      };

      if (a.status === 'agendado') {
        active.push(item);
      } else {
        past.push(item);
      }
    });

    return {
      success: true,
      cliente: profileRes.rows[0]?.nome || 'Cliente',
      endereco_cadastrado: profileRes.rows[0]?.endereco_completo || 'Não informado',
      agendamentos_ativos: active,
      historico_passado: past,
      instruction: active.length > 0 
        ? `O cliente possui ${active.length} agendamento(s) ativo(s): ${active.map(a => `${a.servico} em ${a.data_agendada}`).join(', ')}. Responda cordialmente com essas informações e, se ele quiser cancelar ou alterar, use cancel_appointment ou informe a remarcação.`
        : 'O cliente não possui nenhum agendamento ativo no momento.'
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

    const apptsRes = await query(`SELECT * FROM appointments WHERE tenant_id = $1 AND remote_jid = $2 ORDER BY created_at DESC LIMIT 3`, [tenantId, remoteJid]);
    const appointments = apptsRes.rows;

    // 2. Compila System Prompt Dinâmico de Alto Nível
    const systemPrompt = promptCompiler.compileSystemPrompt(tenant, aiConfig, session, customerProfile, appointments);

    // 3. Carrega Histórico Recente limitado estritamente a 10 mensagens
    const historyRes = await query(
      `SELECT role, content 
       FROM chat_messages 
       WHERE session_id = $1 
       ORDER BY created_at DESC 
       LIMIT 10`,
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
    const bookingReq = this.detectBookingRequest(userMessage, historyMessages);

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
    }

    // 3. Gatilho Proativo de Horários Livres (evita adiamento ou "vou verificar a agenda... um momento")
    const allUserText = historyMessages.map(m => m.content.toLowerCase()).join(' ') + ' ' + userMessage.toLowerCase();
    const isClearlyNew = allUserText.includes('nova instala') || allUserText.includes('instalar do zero') || allUserText.includes('câmeras novas') || allUserText.includes('não tenho câmera') || allUserText.includes('nao tenho camera') || allUserText.includes('instalação nova') || allUserText.includes('projeto novo') || allUserText.includes('quero instalar');
    const isClearlyMaintenance = allUserText.includes('manuten') || allUserText.includes('consert') || allUserText.includes('repar') || allUserText.includes('parou de') || allUserText.includes('câmera queim') || allUserText.includes('arrumar') || allUserText.includes('já tenho câmera') || allUserText.includes('ja tenho');

    const needsSlots = (isClearlyNew || isClearlyMaintenance) && !isCancel && !bookingReq;

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
              arguments: JSON.stringify({})
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
              historyMessages,
              args: fnArgs
            });
          } else if (fnName === 'check_specific_slot_availability') {
            toolResult = await this.executeCheckSlotTool(fnArgs);
          } else if (fnName === 'book_appointment') {
            toolResult = await this.executeBookAppointmentTool({
              tenantId,
              sessionId,
              remoteJid,
              pushName,
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
    const modoRespostaAudio = aiConfig.responder_com_audio || 'quando_receber_audio';
    const hasAudioInput = !!isAudio || (typeof userMessage === 'string' && userMessage.startsWith('[audio]'));
    const shouldSendAudio = (
      modoRespostaAudio === 'sempre' ||
      (modoRespostaAudio === 'quando_receber_audio' && hasAudioInput)
    );

    let sendRes;
    let sentMediaType = 'text';

    if (shouldSendAudio) {
      console.log(`[AIEngine] Gerando áudio humanizado (Voz: ${aiConfig.voz_ia || 'nova'}) para ${remoteJid}...`);
      try {
        await evolutionService.sendPresence(instanceName, remoteJid, 'recording');
        const speech = await ttsService.generateSpeech(finalAssistantText, {
          voice: aiConfig.voz_ia || 'nova'
        });

        sendRes = await evolutionService.sendWhatsAppAudio(instanceName, remoteJid, speech.base64);
        sentMediaType = 'audio';
      } catch (audioErr) {
        console.warn(`[AIEngine] Aviso ao gerar/enviar áudio TTS (${audioErr.message}). Fallback para texto.`);
        sendRes = await evolutionService.sendTextMessage(instanceName, remoteJid, finalAssistantText);
        sentMediaType = 'text';
      }
    } else {
      console.log(`[AIEngine] Enviando resposta humanizada em texto para ${remoteJid}...`);
      sendRes = await evolutionService.sendTextMessage(instanceName, remoteJid, finalAssistantText);
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
