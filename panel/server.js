// ==============================================================================
// Multi-Tenant WhatsApp & Operation Manager - Warnat Tech (com Autenticação)
// ==============================================================================

const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');
const calendarService = require('../calendar/google-calendar');
const schedulerAgent = require('../agent/whatsapp-scheduler');
const leadsCrm = require('../crm/leads-crm');
const settingsStore = require('../config/settings-store');
const { handleV2Routes } = require('./routes/v2.routes');
const webhookController = require('../controllers/webhook.controller');

// Carregar variáveis de ambiente do .env
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

const PORT = process.env.PORT || envMap['PANEL_PORT'] || 3100;
const ADMIN_PASSWORD = process.env.PANEL_ADMIN_PASSWORD || envMap['PANEL_ADMIN_PASSWORD'] || 'WarnatAdmin2026!';
const JWT_SECRET = process.env.PANEL_JWT_SECRET || envMap['PANEL_JWT_SECRET'] || 'warnat-tech-master-secret-key-2026';
const EVOLUTION_URL = process.env.SERVER_URL || envMap['SERVER_URL'] || 'http://localhost:8085';
const EVOLUTION_API_KEY = process.env.AUTHENTICATION_API_KEY || envMap['AUTHENTICATION_API_KEY'] || 'SUA_CHAVE_GLOBAL_AQUI_123456';
const CHATWOOT_PORT = process.env.CHATWOOT_PORT || 3000;
const CHATWOOT_URL = process.env.CHATWOOT_URL || `http://localhost:${CHATWOOT_PORT}`;

// Inicializa serviço do Google Calendar em background
calendarService.init(process.env.GOOGLE_CALENDAR_ID || envMap['GOOGLE_CALENDAR_ID']).catch(err => {
  console.warn('[GoogleCalendar] Aviso ao inicializar:', err.message);
});

// ------------------------------------------------------------------------------
// Funções de Autenticação Segura (HMAC SHA-256)
// ------------------------------------------------------------------------------
function generateAdminToken() {
  const timestamp = Date.now().toString();
  const signature = crypto.createHmac('sha256', JWT_SECRET)
    .update(`${ADMIN_PASSWORD}:${timestamp}`)
    .digest('hex');
  return `${timestamp}.${signature}`;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;

  const [timestampStr, signature] = parts;
  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp)) return false;

  // Expira em 7 dias (7 * 24 * 60 * 60 * 1000 ms)
  const maxAge = 7 * 24 * 60 * 60 * 1000;
  if (Date.now() - timestamp > maxAge) return false;

  const expectedSig = crypto.createHmac('sha256', JWT_SECRET)
    .update(`${ADMIN_PASSWORD}:${timestampStr}`)
    .digest('hex');

  try {
    const sigBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expectedSig, 'hex');
    if (sigBuffer.length !== expectedBuffer.length) return false;
    return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
  } catch (e) {
    return false;
  }
}

// Helper para chamadas HTTP à Evolution API
async function evolutionFetch(endpoint, options = {}) {
  const targetUrl = `${EVOLUTION_URL}${endpoint}`;
  const headers = {
    'apikey': EVOLUTION_API_KEY,
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };

  const res = await fetch(targetUrl, {
    ...options,
    headers
  });

  const text = await res.text();
  try {
    return { status: res.status, ok: res.ok, data: JSON.parse(text) };
  } catch (e) {
    return { status: res.status, ok: res.ok, data: text };
  }
}

// Helper para executar comandos Rails dentro do container Chatwoot
function execRailsRunner(rubyCode) {
  return new Promise((resolve) => {
    const escapedCode = rubyCode.replace(/"/g, '\\"');
    const cmd = `docker exec chatwoot_web bundle exec rails runner "${escapedCode}"`;
    exec(cmd, { timeout: 25000 }, (error, stdout, stderr) => {
      if (error) {
        console.error('Rails Runner Error:', stderr || error.message);
        return resolve({ success: false, error: stderr || error.message });
      }
      try {
        const lines = stdout.trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          const l = lines[i].trim();
          if (l.startsWith('{') || l.startsWith('[')) {
            return resolve({ success: true, data: JSON.parse(l) });
          }
        }
        resolve({ success: true, data: stdout.trim() });
      } catch (err) {
        resolve({ success: true, data: stdout.trim() });
      }
    });
  });
}

// Servidor HTTP Principal
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-token, apikey');

  if (method === 'OPTIONS') {
    res.writeHead(200);
    return res.end();
  }

  // Parse JSON Body
  let body = {};
  if (method === 'POST' || method === 'PUT') {
    try {
      const buffers = [];
      for await (const chunk of req) {
        buffers.push(chunk);
      }
      const dataStr = Buffer.concat(buffers).toString();
      if (dataStr) {
        body = JSON.parse(dataStr);
      }
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'JSON inválido' }));
    }
  }

  // Resposta utilitária JSON
  const sendJson = (statusCode, data) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  };

  try {
    // --------------------------------------------------------------------------
    // ROTAS DA API V2 (MULTI-TENANT SAAS)
    // --------------------------------------------------------------------------
    if (pathname.startsWith('/api/v2/')) {
      const handled = await handleV2Routes(req, res, pathname, method, body);
      if (handled !== false) return;
    }

    // --------------------------------------------------------------------------
    // ROTAS PÚBLICAS DE AUTENTICAÇÃO LEGADA
    
    // Login com Senha Administrativa
    if (pathname === '/api/auth/login' && method === 'POST') {
      const { password } = body;
      if (!password) {
        return sendJson(400, { error: 'Senha não fornecida' });
      }

      if (password === ADMIN_PASSWORD) {
        const token = generateAdminToken();
        return sendJson(200, {
          success: true,
          message: 'Autenticado com sucesso!',
          token,
          expiresIn: 7 * 24 * 3600
        });
      } else {
        return sendJson(401, {
          success: false,
          error: 'Senha administrativa incorreta!'
        });
      }
    }

    // Verificar se o Token Atual é Válido
    if (pathname === '/api/auth/check' && method === 'GET') {
      const authHeader = req.headers['authorization'] || '';
      const customHeader = req.headers['x-admin-token'] || '';
      const token = authHeader.replace(/^Bearer\s+/i, '') || customHeader;

      const isValid = verifyAdminToken(token);
      return sendJson(200, { authenticated: isValid });
    }

    // --------------------------------------------------------------------------
    // MIDDLEWARE DE PROTEÇÃO: TODAS AS ROTAS /api/* EXIGEM AUTENTICAÇÃO
    // --------------------------------------------------------------------------
    const isCalendarRoute = pathname.startsWith('/api/calendar');
    const isWebhookRoute = pathname.startsWith('/api/webhook');
    const isPublicRoute = pathname.startsWith('/api/public/');

    const reqKey = req.headers['apikey'] || parsedUrl.query.apikey || '';
    if (pathname.startsWith('/api/') && !isCalendarRoute && !isWebhookRoute && !isPublicRoute) {
      const authHeader = req.headers['authorization'] || '';
      const customHeader = req.headers['x-admin-token'] || '';
      const token = authHeader.replace(/^Bearer\s+/i, '') || customHeader;

      if (reqKey !== EVOLUTION_API_KEY && !verifyAdminToken(token)) {
        return sendJson(401, {
          error: 'Acesso negado. Por favor, faça login com a Senha Administrativa.'
        });
      }
    }

    // --------------------------------------------------------------------------
    // WEBHOOK DA EVOLUTION API (RECEBIMENTO DE MENSAGENS WHATSAPP & ÁUDIO)
    // --------------------------------------------------------------------------
    if (pathname === '/api/webhook/whatsapp' && method === 'POST') {
      try {
        webhookController.handleWebhook(body).catch(e => console.error('[Webhook] Async error:', e.message));
        return sendJson(200, { received: true });
      } catch (e) {
        console.error('[Panel] Erro ao processar webhook whatsapp:', e.message);
        return sendJson(500, { error: e.message });
      }
    }

    // --------------------------------------------------------------------------
    // CONFIGURAÇÃO: TEMPO DE RESPOSTA HUMANIZADO (SIMULAÇÃO HUMANA)
    // --------------------------------------------------------------------------
    if (pathname === '/api/settings/response-delay') {
      if (method === 'GET') {
        const delaySeconds = schedulerAgent.getResponseDelay ? schedulerAgent.getResponseDelay() : 120;
        return sendJson(200, {
          delaySeconds,
          delayMinutes: (delaySeconds / 60).toFixed(1),
          message: `Tempo de resposta atual: ${delaySeconds}s (${(delaySeconds / 60).toFixed(1)} min)`
        });
      }
      if (method === 'POST') {
        const { delaySeconds } = body;
        if (delaySeconds === undefined || isNaN(Number(delaySeconds))) {
          return sendJson(400, { error: 'Informe delaySeconds em segundos (ex: 120 para 2 minutos).' });
        }
        const val = Number(delaySeconds);
        if (schedulerAgent.setResponseDelay) {
          schedulerAgent.setResponseDelay(val);
        }
        // Persistir no arquivo .env
        try {
          let envContent = fs.readFileSync(envPath, 'utf8');
          if (envContent.includes('RESPONSE_DELAY_SECONDS=')) {
            envContent = envContent.replace(/RESPONSE_DELAY_SECONDS=\d+/, `RESPONSE_DELAY_SECONDS=${val}`);
          } else {
            envContent += `\nRESPONSE_DELAY_SECONDS=${val}\n`;
          }
          fs.writeFileSync(envPath, envContent, 'utf8');
        } catch (err) {
          console.warn('[Panel] Aviso ao persistir delay no .env:', err.message);
        }
        return sendJson(200, {
          success: true,
          delaySeconds: val,
          delayMinutes: (val / 60).toFixed(1),
          message: `Tempo de resposta atualizado para ${val} segundos (${(val / 60).toFixed(1)} min)!`
        });
      }
    }

    // --------------------------------------------------------------------------
    // CONFIGURAÇÕES DO TENANT (PAINEL ADMIN -> POSTGRESQL): horários, janelas de visita,
    // endereço base e mensagens/identidade da assistente. Reflexo imediato no motor.
    // --------------------------------------------------------------------------
    const buildSettingsView = (tenantId) => {
      const settings = settingsStore.getSettings(tenantId);
      const vars = settingsStore.buildTemplateVars(settings);
      return {
        tenantId,
        settings,
        meta: settingsStore.store.getMeta(tenantId),
        db: settingsStore.store.status(),
        engineTenant: settingsStore.DEFAULT_TENANT,
        live: {
          openNow: settingsStore.isOpenAt(settings),
          nextOpening: (settingsStore.getNextOpening(settings) || {}).label || null,
          hoursText: settingsStore.describeBusinessHours(settings),
          bookingText: settingsStore.describeBookingWindows(settings)
        },
        preview: {
          greeting: settingsStore.renderTemplate(settings.greetingMessage, vars),
          disclosureLine: settingsStore.renderTemplate(settings.disclosureLine, vars),
          humanHandoff: settingsStore.renderTemplate(settings.humanHandoffMessage, vars),
          outOfHours: settingsStore.renderTemplate(settings.outOfHoursMessage, vars),
          opening: settingsStore.renderTemplate(settings.openingMessage, vars)
        }
      };
    };

    if (pathname === '/api/settings/tenants' && method === 'GET') {
      const ids = new Set(await settingsStore.store.listTenantIds());
      let instances = [];
      try {
        const r = await evolutionFetch('/instance/fetchInstances');
        if (Array.isArray(r.data)) instances = r.data.map(i => ({ id: i.name, name: i.profileName || i.name, status: i.connectionStatus || 'close' }));
      } catch (e) { /* Evolution offline: lista só o que existe no banco */ }
      instances.forEach(i => ids.add(i.id));
      return sendJson(200, {
        engineTenant: settingsStore.DEFAULT_TENANT,
        db: settingsStore.store.status(),
        tenants: [...ids].map(id => {
          const inst = instances.find(i => i.id === id);
          return { id, name: inst ? inst.name : id, status: inst ? inst.status : 'unknown', hasSavedSettings: !!settingsStore.store.getMeta(id) };
        })
      });
    }

    const settingsMatch = pathname.match(/^\/api\/settings\/tenant\/([a-z0-9-]+)$/);
    if (settingsMatch) {
      const tenantId = settingsMatch[1];
      if (method === 'GET') {
        return sendJson(200, { success: true, ...buildSettingsView(tenantId) });
      }
      if (method === 'PUT') {
        try {
          await settingsStore.saveSettings(tenantId, body.settings || body, 'painel-admin');
          return sendJson(200, { success: true, message: 'Configurações gravadas no PostgreSQL e já em vigor!', ...buildSettingsView(tenantId) });
        } catch (err) {
          if (err.code === 'VALIDATION') return sendJson(400, { success: false, error: 'Configuração inválida', details: err.details });
          if (err.code === 'DB_DOWN') return sendJson(503, { success: false, error: err.message });
          console.error('[Panel] Erro ao salvar configurações:', err.message);
          return sendJson(500, { success: false, error: err.message });
        }
      }
    }

    // Preview das mensagens sem gravar (valida + renderiza placeholders)
    if (pathname === '/api/settings/preview' && method === 'POST') {
      const merged = settingsStore.mergeSettings(settingsStore.getSettings(body.tenantId || settingsStore.DEFAULT_TENANT), body.settings || {});
      const v = settingsStore.validateSettings(merged);
      const vars = settingsStore.buildTemplateVars(v.value);
      return sendJson(200, {
        ok: v.ok, errors: v.errors,
        preview: {
          greeting: settingsStore.renderTemplate(v.value.greetingMessage, vars),
          disclosureLine: settingsStore.renderTemplate(v.value.disclosureLine, vars),
          humanHandoff: settingsStore.renderTemplate(v.value.humanHandoffMessage, vars),
          outOfHours: settingsStore.renderTemplate(v.value.outOfHoursMessage, vars),
          opening: settingsStore.renderTemplate(v.value.openingMessage, vars)
        }
      });
    }

    // Variáveis para o Typebot/fluxo externo (HTTP Request com header "apikey")
    const pubMatch = pathname.match(/^\/api\/public\/tenant-config\/([a-z0-9-]+)$/);
    if (pubMatch && method === 'GET') {
      const s = settingsStore.getSettings(pubMatch[1]);
      const vars = settingsStore.buildTemplateVars(s);
      return sendJson(200, {
        assistantName: s.assistantName,
        companyName: s.companyName,
        greeting: settingsStore.renderTemplate(s.greetingMessage, vars),
        outOfHoursMessage: settingsStore.renderTemplate(s.outOfHoursMessage, vars),
        openNow: settingsStore.isOpenAt(s),
        nextOpening: (settingsStore.getNextOpening(s) || {}).label || null,
        businessHours: settingsStore.describeBusinessHours(s),
        bookingWindows: settingsStore.describeBookingWindows(s),
        bookingDays: [...new Set(s.bookingWindows.map(w => w.day))],
        baseAddress: s.baseAddress || '',
        updatedAt: (settingsStore.store.getMeta(pubMatch[1]) || {}).updatedAt || null
      });
    }

    // --------------------------------------------------------------------------
    // HOMOLOGAÇÃO: simula mensagem do cliente SOMENTE para o número de teste (HOMOLOGATION_PHONE).
    // O jid vem do .env, nunca do corpo da requisição.
    // --------------------------------------------------------------------------
    if (pathname.startsWith('/api/homologation/')) {
      const testPhone = String(envMap['HOMOLOGATION_PHONE'] || '').replace(/\D/g, '');
      if (!testPhone) return sendJson(400, { error: 'HOMOLOGATION_PHONE não configurado no .env.' });
      const testJid = `${testPhone}@s.whatsapp.net`;

      if (pathname === '/api/homologation/simulate' && method === 'POST') {
        const text = String(body.text || '').trim();
        if (!text) return sendJson(400, { error: 'Informe "text".' });
        const before = schedulerAgent.getConversation(testJid).messages.length;
        await schedulerAgent.processIncomingMessage(testJid, 'Teste Homologação', text);
        const after = schedulerAgent.getConversation(testJid).messages;
        return sendJson(200, {
          success: true, to: testPhone,
          replies: after.slice(before).filter(m => m.role === 'assistant').map(m => m.content),
          lead: leadsCrm.getLead(testJid) || null
        });
      }

      if (pathname === '/api/homologation/reset' && method === 'POST') {
        const report = { to: testPhone, calendarRemoved: false, crmRemoved: false, unmuted: false };
        const lead = leadsCrm.getLead(testJid);
        if (lead && lead.appointment && lead.appointment.eventId) {
          const r = await calendarService.cancelAppointment({ eventId: lead.appointment.eventId, phone: testPhone });
          report.calendarRemoved = !!r.success;
        }
        report.crmRemoved = leadsCrm.removeLead(testJid);
        if (schedulerAgent.isContactMuted(testJid)) { schedulerAgent.unmuteContact(testJid); report.unmuted = true; }
        schedulerAgent.resetConversation(testJid);
        return sendJson(200, { success: true, ...report });
      }
    }

    // --------------------------------------------------------------------------
    // GERENCIAMENTO DE CONTATOS: AUTOMAÇÃO IA vs ATENDIMENTO MANUAL
    // --------------------------------------------------------------------------
    if (pathname === '/api/contacts') {
      if (method === 'GET') {
        try {
          const contacts = await schedulerAgent.getContactsList();
          const manualCount = contacts.filter(c => c.isManual).length;
          const autoCount = contacts.length - manualCount;
          return sendJson(200, {
            success: true,
            contacts,
            total: contacts.length,
            manualCount,
            autoCount
          });
        } catch (err) {
          console.error('[Panel] Erro ao buscar contatos:', err.message);
          return sendJson(500, { error: err.message });
        }
      }
    }

    if (pathname === '/api/contacts/toggle' && method === 'POST') {
      try {
        const { jid, manual, name } = body;
        if (!jid) {
          return sendJson(400, { error: 'O parâmetro jid é obrigatório.' });
        }
        let result;
        if (manual === true) {
          result = schedulerAgent.muteContact(jid, name);
        } else {
          result = schedulerAgent.unmuteContact(jid);
        }
        return sendJson(200, {
          success: true,
          ...result,
          message: manual
            ? 'Contato alterado para Atendimento Manual Exclusivo (Automação silenciada).'
            : 'Contato reativado para Atendimento Automático com IA.'
        });
      } catch (err) {
        console.error('[Panel] Erro ao alternar modo do contato:', err.message);
        return sendJson(500, { error: err.message });
      }
    }

    if (pathname === '/api/contacts/add-manual' && method === 'POST') {
      try {
        const { phone, name } = body;
        if (!phone) {
          return sendJson(400, { error: 'O número de telefone é obrigatório.' });
        }
        const result = schedulerAgent.muteContact(phone, name);
        return sendJson(200, {
          success: true,
          ...result,
          message: `Contato ${name || phone} adicionado para Atendimento Manual!`
        });
      } catch (err) {
        console.error('[Panel] Erro ao adicionar contato manual:', err.message);
        return sendJson(500, { error: err.message });
      }
    }

    // --------------------------------------------------------------------------
    // ROTAS DO CRM (PAINEL DE CLIENTES ATENDIDOS, VISITAS E INSTALAÇÕES)
    // --------------------------------------------------------------------------
    if (pathname === '/api/crm/dashboard' && method === 'GET') {
      try {
        const data = leadsCrm.getDashboardMetrics();
        return sendJson(200, {
          success: true,
          ...data
        });
      } catch (err) {
        console.error('[Panel] Erro ao obter dados do CRM:', err.message);
        return sendJson(500, { error: err.message });
      }
    }

    if (pathname === '/api/crm/update-lead' && method === 'POST') {
      try {
        const { jid, status, notes, clientName } = body;
        if (!jid) {
          return sendJson(400, { error: 'O parâmetro jid é obrigatório.' });
        }

        // Se o lead foi marcado como RECUSADO ou CANCELADO, remove agendamento do Google Calendar
        if (status === 'RECUSADO') {
          const lead = leadsCrm.getLead(jid);
          if (lead && lead.appointment) {
            const eventId = lead.appointment.eventId;
            await calendarService.cancelAppointment({
              eventId,
              phone: lead.phone,
              clientName: lead.name,
              date: lead.appointment.date
            });
            leadsCrm.cancelAppointment(jid, lead.phone);
          }
        }

        const result = leadsCrm.updateLeadStatus(jid, status, notes, clientName);
        return sendJson(200, {
          success: true,
          ...result,
          message: 'Lead atualizado com sucesso no CRM!'
        });
      } catch (err) {
        console.error('[Panel] Erro ao atualizar lead:', err.message);
        return sendJson(500, { error: err.message });
      }
    }

    if (pathname === '/api/crm/cancel-appointment' && method === 'POST') {
      try {
        const { jid, phone } = body;
        if (!jid && !phone) {
          return sendJson(400, { error: 'O parâmetro jid ou phone é obrigatório.' });
        }
        const lead = leadsCrm.getLead(jid, phone);
        const eventId = lead?.appointment?.eventId;
        const calRes = await calendarService.cancelAppointment({
          eventId,
          phone: lead?.phone || phone,
          clientName: lead?.name,
          date: lead?.appointment?.date
        });
        const crmRes = leadsCrm.cancelAppointment(jid, phone);
        return sendJson(200, {
          success: true,
          calendar: calRes,
          crm: crmRes,
          message: 'Agendamento desmarcado e removido da agenda do Google Calendar com sucesso!'
        });
      } catch (err) {
        console.error('[Panel] Erro ao desmarcar agendamento:', err.message);
        return sendJson(500, { error: err.message });
      }
    }

    if (pathname === '/api/crm/calendar-events' && method === 'GET') {
      try {
        const events = await calendarService.listUpcomingEvents(30);
        return sendJson(200, {
          success: true,
          total: events.length,
          events: events.map(e => ({
            id: e.id,
            summary: e.summary,
            description: e.description,
            location: e.location,
            start: e.start?.dateTime || e.start?.date,
            end: e.end?.dateTime || e.end?.date,
            htmlLink: e.htmlLink,
            colorId: e.colorId
          }))
        });
      } catch (err) {
        return sendJson(500, { error: err.message });
      }
    }

    // --------------------------------------------------------------------------
    // ROTAS GOOGLE CALENDAR (AGENDAMENTO & VERIFICAÇÃO DE HORÁRIOS OCUPADOS)
    // --------------------------------------------------------------------------
    if (isCalendarRoute) {
      const reqKey = req.headers['apikey'] || parsedUrl.query.apikey || '';
      const authHeader = req.headers['authorization'] || '';
      const customHeader = req.headers['x-admin-token'] || '';
      const token = authHeader.replace(/^Bearer\s+/i, '') || customHeader;

      // Aceita ou a API Key global ou o Admin Token
      if (reqKey !== EVOLUTION_API_KEY && !verifyAdminToken(token)) {
        return sendJson(401, {
          error: 'Acesso negado ao calendário. Informe a apikey no cabeçalho ou query param.'
        });
      }

      // Status do serviço de calendário
      if (pathname === '/api/calendar/status' && method === 'GET') {
        return sendJson(200, {
          configured: calendarService.isConfigured(),
          calendarId: calendarService.calendarId || envMap['GOOGLE_CALENDAR_ID'] || 'primary'
        });
      }

      // Consulta de horários livres vs ocupados para um dia (YYYY-MM-DD)
      if (pathname === '/api/calendar/availability' && method === 'GET') {
        const date = parsedUrl.query.date;
        if (!date) {
          return sendJson(400, { error: 'O parâmetro date (YYYY-MM-DD) é obrigatório.' });
        }
        try {
          const avail = await calendarService.getDayAvailability(date);
          return sendJson(200, { success: true, ...avail });
        } catch (err) {
          return sendJson(500, { error: err.message });
        }
      }

      // Agendamento automático com bloqueio de conflitos
      if (pathname === '/api/calendar/book' && method === 'POST') {
        const { date, time, clientName, phone, address, notes, serviceType } = body;
        if (!date || !time || !clientName) {
          return sendJson(400, { error: 'Campos obrigatórios: date (YYYY-MM-DD), time (HH:MM), clientName' });
        }

        try {
          const result = await calendarService.bookAppointment({
            date,
            time,
            clientName,
            phone: phone || '',
            address: address || '',
            notes: notes || '',
            serviceType: serviceType || 'Visita Técnica Gratuita'
          });

          if (result.conflict) {
            return sendJson(409, result); // 409 Conflict: Horário ocupado!
          }

          return sendJson(201, result); // 201 Created
        } catch (err) {
          return sendJson(500, { error: err.message });
        }
      }
    }

    // --------------------------------------------------------------------------
    // ROTAS DE ÁUDIO & TRANSCRIÇÃO (WHISPER / SPEECH-TO-TEXT)
    // --------------------------------------------------------------------------
    if (pathname === '/api/audio/status' && method === 'GET') {
      const instance = parsedUrl.query.instance || 'warnat-tech';
      let credsRes = { ok: false, data: [] };
      let settingsRes = { ok: false, data: {} };
      try {
        credsRes = await evolutionFetch(`/openai/creds/${instance}`);
        settingsRes = await evolutionFetch(`/openai/fetchSettings/${instance}`);
      } catch (e) {}

      const hasCreds = Array.isArray(credsRes.data) && credsRes.data.length > 0;
      const speechToTextActive = !!(settingsRes.data && settingsRes.data.speechToText);
      const currentKey = hasCreds ? credsRes.data[0].apiKey : (envMap['OPENAI_API_KEY'] || '');
      const maskedKey = currentKey ? `${currentKey.substring(0, 7)}...${currentKey.slice(-4)}` : '';

      // Testar se a chave atual é aceita pela OpenAI
      let keyValid = false;
      let keyError = null;
      if (currentKey) {
        try {
          const testRes = await fetch('https://api.openai.com/v1/models', {
            headers: { 'Authorization': `Bearer ${currentKey}` }
          });
          if (testRes.ok) {
            keyValid = true;
          } else {
            const errJson = await testRes.json().catch(() => ({}));
            keyError = errJson.error?.message || `HTTP ${testRes.status}`;
          }
        } catch (e) {
          keyError = e.message;
        }
      }

      return sendJson(200, {
        instance,
        speechToText: speechToTextActive,
        configured: hasCreds,
        keyConfigured: !!currentKey,
        keyMasked: maskedKey,
        keyValid,
        keyError
      });
    }

    if (pathname === '/api/audio/configure' && method === 'POST') {
      const apiKey = (body.apiKey || '').trim();
      const instance = body.instance || 'warnat-tech';

      if (!apiKey) {
        return sendJson(400, { error: 'O campo apiKey é obrigatório.' });
      }

      // Validar chave na OpenAI antes de salvar
      try {
        const testRes = await fetch('https://api.openai.com/v1/models', {
          headers: { 'Authorization': `Bearer ${apiKey}` }
        });
        if (!testRes.ok) {
          const errJson = await testRes.json().catch(() => ({}));
          return sendJson(400, {
            error: `Chave OpenAI inválida ou sem permissão: ${errJson.error?.message || `HTTP ${testRes.status}`}`
          });
        }
      } catch (e) {
        return sendJson(500, { error: `Erro ao validar chave na OpenAI: ${e.message}` });
      }

      // Atualizar no .env local
      try {
        if (fs.existsSync(envPath)) {
          let envContent = fs.readFileSync(envPath, 'utf8');
          if (envContent.includes('OPENAI_API_KEY=')) {
            envContent = envContent.replace(/OPENAI_API_KEY=.*/, `OPENAI_API_KEY=${apiKey}`);
          } else {
            envContent += `\nOPENAI_API_KEY=${apiKey}\n`;
          }
          fs.writeFileSync(envPath, envContent, 'utf8');
          envMap['OPENAI_API_KEY'] = apiKey;
        }
      } catch (e) {
        console.warn('Erro ao atualizar .env:', e.message);
      }

      // Criar credenciais na Evolution API
      let credId = null;
      try {
        const credRes = await evolutionFetch(`/openai/creds/${instance}`, {
          method: 'POST',
          body: JSON.stringify({ name: `openai_${instance}`, apiKey })
        });
        if (credRes.ok && credRes.data?.id) {
          credId = credRes.data.id;
        }
      } catch (e) {
        console.warn('Erro ao registrar credenciais:', e.message);
      }

      // Se já existia credencial, obter o ID
      if (!credId) {
        try {
          const existing = await evolutionFetch(`/openai/creds/${instance}`);
          if (Array.isArray(existing.data) && existing.data.length > 0) {
            credId = existing.data[0].id;
          }
        } catch (e) {}
      }

      // Ativar speechToText nas configurações da instância
      if (credId) {
        await evolutionFetch(`/openai/settings/${instance}`, {
          method: 'POST',
          body: JSON.stringify({
            openaiCredsId: credId,
            expire: 20,
            keywordFinish: '#parar',
            delayMessage: 1500,
            unknownMessage: 'Desculpe, não compreendi. Poderia repetir?',
            listeningFromMe: false,
            stopBotFromMe: true,
            keepOpen: false,
            debounceTime: 10,
            speechToText: true,
            ignoreJids: []
          })
        });
      }

      return sendJson(200, {
        success: true,
        message: 'Transcrição de áudio (Speech-to-Text via Whisper) ativada com sucesso!',
        instance,
        speechToText: true,
        keyMasked: `${apiKey.substring(0, 7)}...${apiKey.slice(-4)}`
      });
    }

    // --------------------------------------------------------------------------
    // API: Status dos Serviços
    // --------------------------------------------------------------------------
    if (pathname === '/api/status' && method === 'GET') {
      let evoOk = false;
      let cwOk = false;
      const calOk = calendarService.isConfigured();

      try {
        const evoRes = await fetch(`${EVOLUTION_URL}/`);
        evoOk = evoRes.ok || evoRes.status === 200;
      } catch (e) {}

      try {
        const cwRes = await fetch(`${CHATWOOT_URL}/app/login`);
        cwOk = cwRes.ok || cwRes.status === 200;
      } catch (e) {}

      return sendJson(200, {
        evolution: evoOk,
        chatwoot: cwOk,
        nat: true,
        calendar: calOk,
        evolutionUrl: EVOLUTION_URL,
        chatwootUrl: CHATWOOT_URL,
        panelPort: PORT
      });
    }

    // --------------------------------------------------------------------------
    // API: Listar Todos os Tenants (Operações)
    // --------------------------------------------------------------------------
    if (pathname === '/api/tenants' && method === 'GET') {
      const instancesRes = await evolutionFetch('/instance/fetchInstances');
      const instances = Array.isArray(instancesRes.data) ? instancesRes.data : [];

      const cwAccountsRes = await execRailsRunner(
        'puts Account.all.map { |a| { id: a.id, name: a.name, inboxes: a.inboxes.pluck(:id, :name), users: a.users.pluck(:id, :name, :email) } }.to_json'
      );
      const cwAccounts = (cwAccountsRes.success && Array.isArray(cwAccountsRes.data)) ? cwAccountsRes.data : [];

      const tenants = [];
      for (const inst of instances) {
        let typebotInfo = { enabled: false };
        try {
          const tbRes = await evolutionFetch(`/typebot/find/${inst.name}`);
          if (Array.isArray(tbRes.data) && tbRes.data.length > 0) {
            const tb = tbRes.data[0];
            typebotInfo = {
              enabled: tb.enabled,
              slug: tb.typebot,
              url: tb.url,
              debounce: tb.debounceTime
            };
          }
        } catch (e) {}

        const cwAccount = cwAccounts.find(a => inst.Chatwoot && String(a.id) === String(inst.Chatwoot.accountId));

        tenants.push({
          id: inst.id,
          name: inst.profileName || inst.name,
          slug: inst.name,
          status: inst.connectionStatus || 'close',
          phone: inst.ownerJid ? inst.ownerJid.split('@')[0] : (inst.number || null),
          profilePic: inst.profilePicUrl || null,
          chatwoot: inst.Chatwoot ? {
            enabled: inst.Chatwoot.enabled,
            accountId: inst.Chatwoot.accountId,
            inboxName: inst.Chatwoot.nameInbox,
            accountName: cwAccount ? cwAccount.name : null,
            users: cwAccount ? cwAccount.users : []
          } : null,
          typebot: typebotInfo,
          stats: inst._count || { Message: 0, Contact: 0, Chat: 0 },
          createdAt: inst.createdAt
        });
      }

      return sendJson(200, {
        tenants,
        totalTenants: tenants.length,
        connectedCount: tenants.filter(t => t.status === 'open').length,
        chatwootAccounts: cwAccounts
      });
    }

    // --------------------------------------------------------------------------
    // API: Criar Novo Tenant (Isolamento Completo)
    // --------------------------------------------------------------------------
    if (pathname === '/api/tenants' && method === 'POST') {
      const {
        name,
        slug,
        typebotUrl,
        typebotSlug,
        agentName,
        agentEmail,
        agentPassword
      } = body;

      if (!name || !slug) {
        return sendJson(400, { error: 'Nome e Identificador (slug) são obrigatórios' });
      }

      const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

      // 1. Criar Conta isolada no Chatwoot
      const rubyCreateAccount = `
        account = Account.create!(name: "${name.replace(/"/g, '')}")
        admin = User.first
        AccountUser.find_or_create_by!(account: account, user: admin, role: :administrator)
        
        agent_data = nil
        if "${agentEmail || ''}".present? && "${agentPassword || ''}".present?
          agent = User.find_by(email: "${agentEmail}")
          if agent.nil?
            agent = User.create!(
              email: "${agentEmail}",
              name: "${(agentName || name).replace(/"/g, '')}",
              password: "${agentPassword}",
              confirmed_at: Time.current
            )
          end
          AccountUser.find_or_create_by!(account: account, user: agent, role: :agent)
          agent_data = { id: agent.id, email: agent.email }
        end
        
        puts({ account_id: account.id, admin_token: admin.access_token.token, agent: agent_data }.to_json)
      `;

      const railsRes = await execRailsRunner(rubyCreateAccount);
      if (!railsRes.success || !railsRes.data || !railsRes.data.account_id) {
        return sendJson(500, { error: 'Falha ao provisionar Conta isolada no Chatwoot', details: railsRes.error });
      }

      const accountId = railsRes.data.account_id;
      const adminToken = railsRes.data.admin_token;

      // 2. Criar Instância no Evolution API
      const createInstRes = await evolutionFetch('/instance/create', {
        method: 'POST',
        body: JSON.stringify({
          instanceName: cleanSlug,
          token: `token-${cleanSlug}-${Date.now()}`,
          qrcode: true,
          integration: 'WHATSAPP-BAILEYS'
        })
      });

      if (!createInstRes.ok) {
        return sendJson(500, { error: 'Falha ao criar instância na Evolution API', details: createInstRes.data });
      }

      // 3. Conectar Instância à Conta Exclusiva do Chatwoot
      await evolutionFetch(`/chatwoot/set/${cleanSlug}`, {
        method: 'POST',
        body: JSON.stringify({
          enabled: true,
          accountId: String(accountId),
          token: adminToken,
          url: 'http://chatwoot-web:3000',
          nameInbox: `${name} WhatsApp`,
          autoCreate: true,
          signMsg: false,
          reopenConversation: true,
          conversationPending: false,
          importContacts: true,
          importMessages: true,
          daysLimitImportMessages: 7
        })
      });

      // 4. Ajustar Webhook do Channel::Api dentro da rede Docker (de localhost para evolution_api:8080)
      const rubyFixWebhook = `
        inbox = Inbox.where(account_id: ${accountId}).last
        if inbox&.channel
          inbox.channel.update!(webhook_url: "http://evolution_api:8080/chatwoot/webhook/${cleanSlug}")
        end
        puts({ webhook_ok: true }.to_json)
      `;
      await execRailsRunner(rubyFixWebhook);

      // 5. Configurar Typebot se informado
      if (typebotSlug) {
        await evolutionFetch(`/typebot/create/${cleanSlug}`, {
          method: 'POST',
          body: JSON.stringify({
            enabled: true,
            url: typebotUrl || 'https://typebot.co',
            typebot: typebotSlug,
            triggerType: 'all',
            expire: 20,
            keywordFinish: '#sair',
            delayMessage: 1000,
            unknownMessage: 'Desculpe, não entendi.',
            listeningFromMe: false,
            stopBotFromMe: true,
            keepOpen: false,
            debounceTime: 10
          })
        });
      }

      // 6. Solicitar QR Code inicial da nova instância
      let qrData = null;
      try {
        const qrRes = await evolutionFetch(`/instance/connect/${cleanSlug}`);
        if (qrRes.ok) {
          qrData = qrRes.data;
        }
      } catch (e) {}

      return sendJson(201, {
        success: true,
        message: `Operação ${name} provisionada com 100% de isolamento!`,
        slug: cleanSlug,
        accountId: accountId,
        agentCreated: railsRes.data.agent || null,
        qrcode: qrData
      });
    }

    // --------------------------------------------------------------------------
    // API: Obter QR Code em Tempo Real de um Tenant
    // --------------------------------------------------------------------------
    const qrMatch = pathname.match(/^\/api\/tenants\/([^/]+)\/qrcode$/);
    if (qrMatch && method === 'GET') {
      const slug = qrMatch[1];
      const qrRes = await evolutionFetch(`/instance/connect/${slug}`);
      const stateRes = await evolutionFetch(`/instance/connectionState/${slug}`);

      const state = stateRes.ok && stateRes.data && stateRes.data.instance
        ? stateRes.data.instance.state
        : 'unknown';

      return sendJson(200, {
        slug,
        state,
        qrcode: qrRes.ok ? qrRes.data : null
      });
    }

    // --------------------------------------------------------------------------
    // API: Status de Conexão de um Tenant
    // --------------------------------------------------------------------------
    const stateMatch = pathname.match(/^\/api\/tenants\/([^/]+)\/status$/);
    if (stateMatch && method === 'GET') {
      const slug = stateMatch[1];
      const stateRes = await evolutionFetch(`/instance/connectionState/${slug}`);
      return sendJson(200, stateRes.data || { state: 'close' });
    }

    // --------------------------------------------------------------------------
    // API: Desconectar WhatsApp do Tenant
    // --------------------------------------------------------------------------
    const logoutMatch = pathname.match(/^\/api\/tenants\/([^/]+)\/disconnect$/);
    if (logoutMatch && method === 'POST') {
      const slug = logoutMatch[1];
      const resLogout = await evolutionFetch(`/instance/logout/${slug}`, { method: 'DELETE' });
      return sendJson(200, { success: true, details: resLogout.data });
    }

    // --------------------------------------------------------------------------
    // API: Reiniciar / Reconectar Instância
    // --------------------------------------------------------------------------
    const restartMatch = pathname.match(/^\/api\/tenants\/([^/]+)\/restart$/);
    if (restartMatch && method === 'POST') {
      const slug = restartMatch[1];
      const resRestart = await evolutionFetch(`/instance/restart/${slug}`, { method: 'PUT' });
      return sendJson(200, { success: true, details: resRestart.data });
    }

    // --------------------------------------------------------------------------
    // API: Configurar Typebot do Tenant
    // --------------------------------------------------------------------------
    const tbMatch = pathname.match(/^\/api\/tenants\/([^/]+)\/typebot$/);
    if (tbMatch && method === 'POST') {
      const slug = tbMatch[1];
      const { enabled, url: tbUrl, slug: tbSlug, debounce } = body;

      const tbRes = await evolutionFetch(`/typebot/create/${slug}`, {
        method: 'POST',
        body: JSON.stringify({
          enabled: Boolean(enabled),
          url: tbUrl || 'https://typebot.co',
          typebot: tbSlug,
          triggerType: 'all',
          expire: 20,
          keywordFinish: '#sair',
          delayMessage: 1000,
          unknownMessage: 'Desculpe, não entendi.',
          listeningFromMe: false,
          stopBotFromMe: true,
          keepOpen: false,
          debounceTime: Number(debounce) || 10
        })
      });

      return sendJson(200, { success: true, data: tbRes.data });
    }

    // --------------------------------------------------------------------------
    // API: Excluir Tenant / Operação
    // --------------------------------------------------------------------------
    const deleteMatch = pathname.match(/^\/api\/tenants\/([^/]+)$/);
    if (deleteMatch && method === 'DELETE') {
      const slug = deleteMatch[1];
      const delRes = await evolutionFetch(`/instance/delete/${slug}`, { method: 'DELETE' });
      return sendJson(200, { success: true, details: delRes.data });
    }

    // --------------------------------------------------------------------------
    // Servir Arquivos Estáticos (Front-End do Painel)
    // --------------------------------------------------------------------------
    let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const mimeTypes = {
        '.html': 'text/html; charset=utf-8',
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
        '.json': 'application/json'
      };
      res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
      return fs.createReadStream(filePath).pipe(res);
    }

    // 404
    sendJson(404, { error: 'Rota não encontrada' });

  } catch (err) {
    console.error('Erro no servidor:', err);
    sendJson(500, { error: 'Erro interno no servidor', details: err.message });
  }
});

const { runMigration } = require('../database/migrator');
const { seedWarNatTech } = require('../database/seed_warnat');

server.listen(PORT, '0.0.0.0', () => {
  console.log(`==========================================================`);
  console.log(`  Painel Multi-Tenant WhatsApp & Operações (Warnat Tech)  `);
  console.log(`  Autenticação: ATIVADA (Protegido por Senha Master)      `);
  console.log(`  Acesse no navegador: http://localhost:${PORT}             `);
  console.log(`==========================================================`);

  // Executa migração idempotente e seed da WarNat Tech em background ao iniciar o servidor
  runMigration()
    .then(() => {
      console.log('✅ [Database] Schema multi-tenant (8 tabelas) sincronizado com sucesso.');
      return seedWarNatTech();
    })
    .catch((err) => console.warn('⚠️ [Database Warning] Falha na auto-migração/seed de inicialização:', err.message));
});
