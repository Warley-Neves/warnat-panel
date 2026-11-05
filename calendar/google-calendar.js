// ==============================================================================
// Módulo de Integração com Google Calendar - WarNat Tech
// Verificação de Conflitos (Free/Busy) e Agendamento Automático
// ==============================================================================

const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

// Carregar variáveis de ambiente do .env se não estiverem no process.env
const envPath = path.resolve(__dirname, '..', '.env');
const envMap = {};
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  content.split('\n').forEach(line => {
    const match = line.match(/^\s*([^#=]+)=(.*)$/);
    if (match) {
      envMap[match[1].trim()] = match[2].trim();
    }
  });
}

// Configurações vindas do Painel Admin (PostgreSQL via settings-store). Nada de horario/dia fixo em codigo.
const settingsStore = require('../config/settings-store');
const TIMEZONE = process.env.CALENDAR_TIMEZONE || envMap['CALENDAR_TIMEZONE'] || 'America/Sao_Paulo';

/**
 * Regras de agendamento do tenant ativo, lidas do cache do settings-store (sincrono).
 * windowsByDay: { 6: [{start:'08:00', end:'18:00'}] }
 */
function getCalendarConfig() {
  const s = settingsStore.getSettings();
  const windowsByDay = {};
  for (const w of s.bookingWindows) (windowsByDay[w.day] = windowsByDay[w.day] || []).push({ start: w.start, end: w.end });
  return {
    allowedDays: Object.keys(windowsByDay).map(Number).sort(),
    windowsByDay,
    durationMinutes: s.visitDurationMinutes,
    bufferMinutes: s.bufferMinutes,
    minLeadHours: s.minLeadHours,
    baseAddress: s.baseAddress || ''
  };
}

/** Horarios de INICIO gerados para uma janela: de start ate caber a duracao da visita, em passos de duracao+intervalo. */
function slotsForWindow(win, durationMinutes, bufferMinutes) {
  const out = [];
  const step = durationMinutes + bufferMinutes;
  for (let m = settingsStore.toMin(win.start); m + durationMinutes <= settingsStore.toMin(win.end); m += step) {
    out.push(String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'));
  }
  return out;
}

// Caminho do arquivo de credenciais da Conta de Serviço do Google Cloud
const CREDENTIALS_PATH = process.env.GOOGLE_CREDENTIALS_PATH || path.resolve(__dirname, '..', 'google-credentials.json');

class GoogleCalendarService {
  constructor() {
    this.calendar = null;
    this.calendarId = null;
    this.initialized = false;
  }

  /**
   * Inicializa o cliente da API do Google com a Service Account
   */
  async init(calendarIdFromEnv = null) {
    if (this.initialized) return true;

    try {
      let auth = null;
      const credsEnv = process.env.GOOGLE_CREDENTIALS_JSON || envMap['GOOGLE_CREDENTIALS_JSON'];
      if (credsEnv) {
        try {
          const parsedCreds = typeof credsEnv === 'string' ? JSON.parse(credsEnv) : credsEnv;
          auth = new google.auth.GoogleAuth({
            credentials: parsedCreds,
            scopes: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events'],
          });
          console.log('[GoogleCalendar] Autenticação carregada via GOOGLE_CREDENTIALS_JSON.');
        } catch (parseErr) {
          console.warn('[GoogleCalendar] Falha ao ler GOOGLE_CREDENTIALS_JSON:', parseErr.message);
        }
      }

      if (!auth) {
        if (!fs.existsSync(CREDENTIALS_PATH)) {
          console.warn(`[GoogleCalendar] Arquivo de credenciais não encontrado em: ${CREDENTIALS_PATH}`);
          return false;
        }
        auth = new google.auth.GoogleAuth({
          keyFile: CREDENTIALS_PATH,
          scopes: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/calendar.events'],
        });
      }

      const authClient = await auth.getClient();
      this.calendar = google.calendar({ version: 'v3', auth: authClient });

      // O Calendar ID pode ser o e-mail do proprietário da agenda (ex: warnattech@gmail.com)
      this.calendarId = calendarIdFromEnv || process.env.GOOGLE_CALENDAR_ID || envMap['GOOGLE_CALENDAR_ID'] || 'primary';
      this.initialized = true;

      console.log(`[GoogleCalendar] Inicializado com sucesso para o calendário: ${this.calendarId}`);
      return true;
    } catch (error) {
      console.error('[GoogleCalendar] Erro ao inicializar cliente Google:', error.message);
      return false;
    }
  }

  /**
   * Checa se o serviço está pronto para uso
   */
  isConfigured() {
    return this.initialized && this.calendar !== null;
  }

  /**
   * Converte data e hora para objeto Date no fuso de São Paulo
   */
  parseDateTime(dateStr, timeStr) {
    // dateStr: "YYYY-MM-DD", timeStr: "HH:mm"
    const [year, month, day] = dateStr.split('-').map(Number);
    const [hours, minutes] = timeStr.split(':').map(Number);
    
    // Criamos a data em formato ISO com o offset de Brasília (-03:00)
    const pad = (n) => String(n).padStart(2, '0');
    const isoString = `${year}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(minutes)}:00-03:00`;
    return new Date(isoString);
  }

  /**
   * Consulta a API do Google Calendar para saber os intervalos ocupados em um período.
   * CAMADA DUPLA DE PROTEÇÃO:
   * 1. API FreeBusy (Verifica status de ocupado global)
   * 2. API Events.list (Verifica diretamente todos os eventos marcados na agenda)
   * Isso garante que NUNCA um horário existente seja sobrescrito.
   */
  async getBusyIntervals(timeMin, timeMax) {
    if (!this.isConfigured()) throw new Error('Google Calendar não configurado.');

    const intervals = [];

    // CAMADA 1: FreeBusy Query
    try {
      const response = await this.calendar.freebusy.query({
        requestBody: {
          timeMin: timeMin.toISOString(),
          timeMax: timeMax.toISOString(),
          timeZone: TIMEZONE,
          items: [{ id: this.calendarId }],
        },
      });

      const calendars = response.data.calendars;
      if (calendars && calendars[this.calendarId]) {
        for (const b of (calendars[this.calendarId].busy || [])) {
          intervals.push({
            start: new Date(b.start),
            end: new Date(b.end)
          });
        }
      }
    } catch (e) {
      console.warn('[GoogleCalendar] Aviso na consulta FreeBusy:', e.message);
    }

    // CAMADA 2: Events List (Confirmação Direta de Todos os Compromissos)
    try {
      const eventsRes = await this.calendar.events.list({
        calendarId: this.calendarId,
        timeMin: timeMin.toISOString(),
        timeMax: timeMax.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
      });

      for (const ev of (eventsRes.data.items || [])) {
        if (ev.status === 'cancelled') continue;
        const start = ev.start?.dateTime ? new Date(ev.start.dateTime) : (ev.start?.date ? new Date(`${ev.start.date}T00:00:00-03:00`) : null);
        const end = ev.end?.dateTime ? new Date(ev.end.dateTime) : (ev.end?.date ? new Date(`${ev.end.date}T23:59:59-03:00`) : null);
        if (start && end) {
          intervals.push({ start, end });
        }
      }
    } catch (e) {
      console.warn('[GoogleCalendar] Aviso na consulta Events.list:', e.message);
    }

    return intervals;
  }

  /**
   * REGRA DE OURO: Verifica se um horário específico está 100% LIVRE.
   * Retorna true se livre, false se houver colisão com qualquer compromisso já existente.
   */
  async isSlotAvailable(startTime, endTime) {
    const busyIntervals = await this.getBusyIntervals(startTime, endTime);
    if (busyIntervals.length === 0) return true;

    // Se houver qualquer sobreposição
    for (const busy of busyIntervals) {
      if (startTime.getTime() < busy.end.getTime() && endTime.getTime() > busy.start.getTime()) {
        return false; // Conflito detectado!
      }
    }
    return true;
  }

  /**
   * Dias da semana liberados para visita/instalacao (0 = domingo), conforme o Painel Admin.
   */
  getAllowedDays() {
    return getCalendarConfig().allowedDays;
  }

  /**
   * Nomes dos dias liberados (ex: "sábados" ou "terças-feiras e sábados").
   */
  getAllowedDaysNames() {
    const config = getCalendarConfig();
    const weekdaysPt = ['domingos', 'segundas-feiras', 'terças-feiras', 'quartas-feiras', 'quintas-feiras', 'sextas-feiras', 'sábados'];
    return config.allowedDays.map(d => weekdaysPt[d]).join(' e ');
  }

  /**
   * Descricao interna das janelas liberadas (usada no prompt da assistente; NAO deve ser dita ao cliente como "so atendemos em X").
   */
  getAllowedScheduleDescription() {
    return settingsStore.describeBookingWindows(settingsStore.getSettings());
  }

  /**
   * Expressao natural para "a proxima data liberada" (ex: "o próximo sábado" quando so ha um dia liberado).
   */
  getNextWindowPhrase() {
    const config = getCalendarConfig();
    if (config.allowedDays.length === 1) {
      const names = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
      const d = config.allowedDays[0];
      return `o próximo ${names[d]}`;
    }
    return 'a próxima data liberada';
  }

  /**
   * Lista horarios de inicio possiveis em um dia (sem olhar a agenda), segundo as janelas do painel.
   */
  getWindowSlotsForDate(dateStr) {
    const config = getCalendarConfig();
    const [year, month, day] = dateStr.split('-').map(Number);
    const dayOfWeek = new Date(year, month - 1, day).getDay();
    const wins = config.windowsByDay[dayOfWeek] || [];
    const slots = [];
    for (const w of wins) slots.push(...slotsForWindow(w, config.durationMinutes, config.bufferMinutes));
    return slots;
  }

  /**
   * Lista horários disponíveis para um determinado dia (YYYY-MM-DD),
   * excluindo qualquer horário ocupado no Google Calendar ou fora da antecedência minima.
   * Respeita rigorosamente os dias e janelas configurados no Painel Admin.
   */
  async getDayAvailability(dateStr) {
    if (!this.isConfigured()) throw new Error('Google Calendar não configurado.');

    const config = getCalendarConfig();
    const slotTimes = this.getWindowSlotsForDate(dateStr);

    // Dia fora das janelas liberadas
    if (slotTimes.length === 0) {
      return { date: dateStr, availableSlots: [], busySlots: [], totalAvailable: 0 };
    }

    const slotDuration = config.durationMinutes * 60 * 1000;
    const first = this.parseDateTime(dateStr, slotTimes[0]);
    const last = this.parseDateTime(dateStr, slotTimes[slotTimes.length - 1]);
    const busyIntervals = await this.getBusyIntervals(first, new Date(last.getTime() + slotDuration));

    const availableSlots = [];
    const busySlots = [];
    const now = new Date();
    const minLeadTimeMs = config.minLeadHours * 60 * 60 * 1000;

    for (const timeFormat of slotTimes) {
      const slotStart = this.parseDateTime(dateStr, timeFormat);
      const slotEnd = new Date(slotStart.getTime() + slotDuration);
      const isPastOrTooSoon = slotStart.getTime() < (now.getTime() + minLeadTimeMs);
      const isBusy = busyIntervals.some(b => slotStart.getTime() < b.end.getTime() && slotEnd.getTime() > b.start.getTime());
      (isBusy || isPastOrTooSoon ? busySlots : availableSlots).push(timeFormat);
    }

    return { date: dateStr, availableSlots, busySlots, totalAvailable: availableSlots.length };
  }

  /**
   * Busca os próximos N horários livres na agenda (pulando domingos e horários ocupados).
   * Suporta exclusão de horários previamente recusados pelo cliente e exclusão de datas completas (ex: reagendamento em OUTRO DIA).
   */
  async getNextAvailableSlots(count = 2, fromDate = null, excludeSlots = [], excludeDates = []) {
    if (!this.isConfigured()) throw new Error('Google Calendar não configurado.');

    const pad = (n) => String(n).padStart(2, '0');
    let startDay;

    if (fromDate) {
      const [y, m, d] = fromDate.split('-').map(Number);
      startDay = new Date(y, m - 1, d);
    } else {
      const now = new Date();
      startDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      // Se já passou das 15h, busca a partir de amanhã
      if (now.getHours() >= 15) {
        startDay.setDate(startDay.getDate() + 1);
      }
    }

    const weekdaysPt = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
    const results = [];
    let daysChecked = 0;
    const currentCursor = new Date(startDay.getTime());

    // Normaliza excludeDates para comparação simples
    const normalizedExcludeDates = (excludeDates || []).map(dt => {
      if (!dt) return '';
      return String(dt).trim();
    });

    const config = getCalendarConfig();

    while (results.length < count && daysChecked < 35) {
      const dayOfWeek = currentCursor.getDay();

      // Checa se o dia da semana está entre os dias permitidos no .env (ex: somente sábados)
      if (config.allowedDays.includes(dayOfWeek)) {
        const y = currentCursor.getFullYear();
        const m = pad(currentCursor.getMonth() + 1);
        const d = pad(currentCursor.getDate());
        const dateStr = `${y}-${m}-${d}`;
        const shortDateStr = `${d}/${m}`;
        const dayName = weekdaysPt[dayOfWeek];

        // Se a data inteira estiver na lista de exclusão (ex: data cancelada ou recusada), pula o dia todo!
        const isExcludedDate = normalizedExcludeDates.some(ex => ex === dateStr || ex === shortDateStr || dateStr.endsWith(ex));
        if (isExcludedDate) {
          currentCursor.setDate(currentCursor.getDate() + 1);
          daysChecked++;
          continue;
        }

        try {
          const avail = await this.getDayAvailability(dateStr);
          for (const time of avail.availableSlots) {
            const slotKey = `${dateStr} ${time}`;
            if (excludeSlots && (excludeSlots.includes(slotKey) || excludeSlots.includes(time))) {
              continue;
            }

            results.push({
              date: dateStr,
              dayOfWeek: dayName,
              time: time,
              label: `${dayName} (${d}/${m}) às ${time}`,
              formatted: `${d}/${m} (${dayName}) às ${time}`
            });

            if (results.length >= count) break;
          }
        } catch (e) {
          console.warn(`[GoogleCalendar] Erro ao checar ${dateStr}:`, e.message);
        }
      }

      currentCursor.setDate(currentCursor.getDate() + 1);
      daysChecked++;
    }

    return results;
  }

  /**
   * Cria o agendamento no Google Calendar com bloqueio rigoroso contra horários ocupados.
   */
  async bookAppointment({ date, time, clientName, phone, address, serviceType = 'Visita Técnica Gratuita', appointmentType = 'VISITA_TECNICA', notes = '' }) {
    if (!this.isConfigured()) {
      throw new Error('Google Calendar não configurado. Por favor, adicione o arquivo google-credentials.json.');
    }

    const isInstallation = (appointmentType === 'INSTALACAO_CFTV') ||
      (serviceType && (serviceType.toLowerCase().includes('instalação') || serviceType.toLowerCase().includes('instalacao')));

    const finalServiceType = isInstallation ? 'Instalação de Câmeras de Segurança' : (serviceType || 'Visita Técnica Gratuita');
    const config = getCalendarConfig();
    const durationMinutes = isInstallation ? Math.max(120, config.durationMinutes) : config.durationMinutes;

    const startTime = this.parseDateTime(date, time);
    const endTime = new Date(startTime.getTime() + (durationMinutes * 60 * 1000));
    const nextWindow = this.getNextWindowPhrase();

    // 0. CHECAGEM DE DIA/HORARIO LIBERADO NO PAINEL ADMIN (janelas de agendamento)
    const windowSlots = this.getWindowSlotsForDate(date);

    if (windowSlots.length === 0) {
      const nextSlots = await this.getNextAvailableSlots(2);
      return {
        success: false,
        conflict: true,
        reason: 'DAY_NOT_ALLOWED',
        message: `Essa data não está liberada para visitas. No momento só temos a data sugerida ou ${nextWindow} (${nextSlots.map(s => s.label).join(' ou ')}). Caso abra uma vaga em outro dia ou horário, entramos em contato!`,
        suggestedSlots: nextSlots.map(s => s.label)
      };
    }

    if (!windowSlots.includes(time)) {
      const dayAvail = await this.getDayAvailability(date);
      const nextSlots = await this.getNextAvailableSlots(2);
      return {
        success: false,
        conflict: true,
        reason: 'TIME_NOT_ALLOWED',
        message: `Esse horário não está liberado para visitas. No momento só temos a data sugerida ou ${nextWindow}. Caso abra uma vaga em outro dia ou horário, entramos em contato!`,
        suggestedSlots: dayAvail.availableSlots.length > 0 ? dayAvail.availableSlots : nextSlots.map(s => s.label)
      };
    }

    if (startTime.getTime() < Date.now() + config.minLeadHours * 3600 * 1000) {
      const nextSlots = await this.getNextAvailableSlots(2);
      return {
        success: false,
        conflict: true,
        reason: 'TOO_SOON',
        message: `Esse horário já passou ou está muito próximo (antecedência mínima de ${config.minLeadHours}h). Opções livres: ${nextSlots.map(s => s.label).join(' ou ')}.`,
        suggestedSlots: nextSlots.map(s => s.label)
      };
    }

    // 1. CHECAGEM OBRIGATÓRIA DE DISPONIBILIDADE NO GOOGLE CALENDAR (ANTI-CONFLITO)
    const isFree = await this.isSlotAvailable(startTime, endTime);
    if (!isFree) {
      const dayAvail = await this.getDayAvailability(date);
      const nextSlots = await this.getNextAvailableSlots(2);
      return {
        success: false,
        conflict: true,
        reason: 'BUSY',
        message: `O horário das ${time} na data ${date} já está ocupado no calendário. No momento só temos a data sugerida ou ${nextWindow}. Caso abra uma vaga em outro dia ou horário, entramos em contato!`,
        suggestedSlots: dayAvail.availableSlots.length > 0 ? dayAvail.availableSlots : nextSlots.map(s => s.label)
      };
    }

    // 2. CRIAÇÃO DO EVENTO NO GOOGLE CALENDAR
    const prefix = isInstallation ? '[INSTALAÇÃO CFTV]' : '[VISITA TÉCNICA]';
    const summary = `${prefix} ${clientName} (${address ? address.split(',')[0] : 'Cliente'})`;
    
    const description = [
      `🔧 TIPO: ${finalServiceType}`,
      `👤 CLIENTE: ${clientName}`,
      `📱 WHATSAPP: ${phone}`,
      `📍 ENDEREÇO: ${address || 'A confirmar'}`,
      ...(config.baseAddress ? [`🚗 BASE DE PARTIDA: ${config.baseAddress}`] : []),
      `📝 OBSERVAÇÕES: ${notes || `Agendado automaticamente pela assistente virtual ${settingsStore.getSettings().assistantName}`}`,
      `\n⚠️ Responsável Técnico: Warley Santos - ${settingsStore.getSettings().companyName}`
    ].join('\n');

    const eventPayload = {
      summary: summary,
      description: description,
      location: address || '',
      start: {
        dateTime: startTime.toISOString(),
        timeZone: TIMEZONE,
      },
      end: {
        dateTime: endTime.toISOString(),
        timeZone: TIMEZONE,
      },
      colorId: isInstallation ? '9' : '10', // 9 = Azul (Instalação Fechada), 10 = Verde (Visita Técnica)
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'popup', minutes: 24 * 60 }, // 1 dia antes
          { method: 'popup', minutes: 120 },     // 2 horas antes
          { method: 'popup', minutes: 30 },      // 30 minutos antes
        ],
      },
    };

    const createdEvent = await this.calendar.events.insert({
      calendarId: this.calendarId,
      requestBody: eventPayload,
    });

    return {
      success: true,
      conflict: false,
      appointmentType: isInstallation ? 'INSTALACAO_CFTV' : 'VISITA_TECNICA',
      serviceType: finalServiceType,
      eventId: createdEvent.data.id,
      eventLink: createdEvent.data.htmlLink,
      summary: createdEvent.data.summary,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      formattedTime: `${date} às ${time}`
    };
  }

  /**
   * Atualiza endereco / nome / observacoes de um evento ja criado (coleta de dados apos o agendamento).
   */
  async updateAppointmentDetails({ eventId, address, clientName, notes } = {}) {
    if (!this.isConfigured()) throw new Error('Google Calendar não configurado.');
    if (!eventId) return { success: false, error: 'eventId ausente' };
    const ev = await this.calendar.events.get({ calendarId: this.calendarId, eventId });
    let desc = ev.data.description || '';
    const replaceLine = (label, value) => {
      const re = new RegExp('^' + label + '.*$', 'm');
      const line = label + ' ' + value;
      desc = re.test(desc) ? desc.replace(re, line) : desc + '\n' + line;
    };
    if (address) replaceLine('📍 ENDEREÇO:', address);
    if (clientName) replaceLine('👤 CLIENTE:', clientName);
    if (notes) replaceLine('📝 OBSERVAÇÕES:', notes);
    const patch = { description: desc };
    if (address) patch.location = address;
    if (clientName) patch.summary = (ev.data.summary || '').replace(/^(\[[^\]]+\])\s.*$/, '$1 ' + clientName + (address ? ' (' + address.split(',')[0] + ')' : ''));
    await this.calendar.events.patch({ calendarId: this.calendarId, eventId, requestBody: patch });
    return { success: true, eventId, address: address || null };
  }

  async listUpcomingEvents(maxResults = 50) {
    if (!this.isConfigured()) return [];
    try {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const res = await this.calendar.events.list({
        calendarId: this.calendarId,
        timeMin: startOfMonth.toISOString(),
        maxResults,
        singleEvents: true,
        orderBy: 'startTime'
      });
      return (res.data.items || []).filter(e => e.status !== 'cancelled');
    } catch (e) {
      console.warn('[GoogleCalendar] Erro ao listar eventos:', e.message);
      return [];
    }
  }

  /**
   * Remove/cancela um agendamento do Google Calendar definitivamente.
   * Suporta remoção por eventId direto ou busca inteligente por telefone / nome / data.
   */
  async cancelAppointment({ eventId, phone, clientName, date } = {}) {
    if (!this.isConfigured()) {
      throw new Error('Google Calendar não configurado.');
    }

    let targetEventId = eventId;

    // Se o eventId não foi informado diretamente, localiza o evento na agenda
    if (!targetEventId && (phone || clientName || date)) {
      try {
        const events = await this.listUpcomingEvents(100);
        const cleanPhone = phone ? String(phone).replace(/\D/g, '') : '';
        const lowerName = clientName ? String(clientName).toLowerCase().trim() : '';

        for (const ev of events) {
          if (ev.status === 'cancelled') continue;
          const desc = ev.description || '';
          const summary = (ev.summary || '').toLowerCase();
          const location = ev.location || '';
          const evDate = ev.start ? (ev.start.dateTime || ev.start.date || '').slice(0, 10) : '';

          let match = false;
          // Confere telefone (últimos 8 dígitos ou número completo)
          if (cleanPhone && cleanPhone.length >= 8) {
            const shortPhone = cleanPhone.slice(-8);
            if (desc.includes(cleanPhone) || desc.includes(shortPhone) || location.includes(shortPhone) || summary.includes(shortPhone)) {
              match = true;
            }
          }
          // Confere nome se tiver ao menos 3 caracteres
          if (!match && lowerName && lowerName.length >= 3 && summary.includes(lowerName)) {
            match = true;
          }
          // Se especificou data, confere compatibilidade
          if (match && date && evDate && evDate !== date) {
            match = false;
          }

          if (match) {
            targetEventId = ev.id;
            break;
          }
        }
      } catch (err) {
        console.warn('[GoogleCalendar] Aviso na busca de evento para cancelamento:', err.message);
      }
    }

    if (!targetEventId) {
      console.warn('[GoogleCalendar] Nenhum evento correspondente encontrado para deletar.');
      return {
        success: false,
        notFound: true,
        message: 'Nenhum agendamento encontrado no Google Calendar para os dados fornecidos.'
      };
    }

    try {
      console.log(`[GoogleCalendar] Removendo evento ${targetEventId} da agenda ${this.calendarId}...`);
      await this.calendar.events.delete({
        calendarId: this.calendarId,
        eventId: targetEventId
      });
      console.log(`[GoogleCalendar] Evento ${targetEventId} removido da agenda com sucesso.`);
      return {
        success: true,
        deletedEventId: targetEventId,
        message: 'Agendamento removido da agenda do Google Calendar com sucesso.'
      };
    } catch (e) {
      console.error(`[GoogleCalendar] Erro ao deletar evento ${targetEventId}:`, e.message);
      if (e.code === 404 || e.code === 410) {
        return {
          success: true,
          deletedEventId: targetEventId,
          message: 'O agendamento já havia sido removido da agenda.'
        };
      }
      return {
        success: false,
        error: e.message
      };
    }
  }
}

module.exports = new GoogleCalendarService();
