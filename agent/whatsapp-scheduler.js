// ==============================================================================
// Agente Inteligente de Vendas & Agendamento com Google Calendar (WarNat Tech)
// Conexão em Tempo Real com a Agenda - Zero Conflito / Anti-Choque
// ==============================================================================

const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const calendarService = require('../calendar/google-calendar');
const leadsCrm = require('../crm/leads-crm');
const settingsStore = require('../config/settings-store');

// Carregar variáveis de ambiente do .env
const envPath = path.resolve(__dirname, '..', '.env');
const envMap = {};
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  content.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.substring(0, eqIdx).trim();
      const val = trimmed.substring(eqIdx + 1).trim();
      envMap[key] = val;
    }
  });
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || envMap['OPENAI_API_KEY'];
const EVOLUTION_URL = process.env.SERVER_URL || envMap['SERVER_URL'] || 'http://localhost:8085';
const EVOLUTION_API_KEY = process.env.AUTHENTICATION_API_KEY || envMap['AUTHENTICATION_API_KEY'] || 'SUA_CHAVE_GLOBAL_AQUI_123456';
const INSTANCE_NAME = process.env.INSTANCE_NAME || envMap['INSTANCE_NAME'] || 'warnat-tech';
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || envMap['GOOGLE_CALENDAR_ID'] || 'warnattech@gmail.com';

// Configuração de Tempo de Resposta Humanizado (padrão: 60 segundos / 1 minuto)
let RESPONSE_DELAY_SECONDS = parseInt(process.env.RESPONSE_DELAY_SECONDS || envMap['RESPONSE_DELAY_SECONDS'] || '60', 10);
if (isNaN(RESPONSE_DELAY_SECONDS) || RESPONSE_DELAY_SECONDS < 0) {
  RESPONSE_DELAY_SECONDS = 60;
}
console.log(`[SchedulerAgent] Delay de resposta humanizada: ${RESPONSE_DELAY_SECONDS}s (${(RESPONSE_DELAY_SECONDS / 60).toFixed(1)} min)`);

function getResponseDelay() {
  return RESPONSE_DELAY_SECONDS;
}

function setResponseDelay(seconds) {
  const val = parseInt(seconds, 10);
  if (!isNaN(val) && val >= 0) {
    RESPONSE_DELAY_SECONDS = val;
    console.log(`[SchedulerAgent] Delay de resposta atualizado para ${RESPONSE_DELAY_SECONDS}s`);
    return true;
  }
  return false;
}

// ==============================================================================
// Configurações do Tenant (Painel Admin -> PostgreSQL) + Horário de Atendimento
// ==============================================================================
const morningQueueFile = path.resolve(__dirname, '..', 'data', 'morning_queue.json');

/** Configurações vigentes do tenant (leitura síncrona do cache; atualizada na hora pelo painel). */
function getTenantSettings() {
  return settingsStore.getSettings();
}

function templateVars(extra = {}) {
  return settingsStore.buildTemplateVars(getTenantSettings(), extra);
}

/** Dentro do horário de atendimento configurado no painel? */
function isWithinBusinessHours(date = new Date()) {
  return settingsStore.isOpenAt(getTenantSettings(), date);
}

/**
 * Verifica se há um atendimento em andamento no período de encerramento.
 * "Se tiver um atendimento em andamento no periodo de final de atendimento, o atendimento deve seguir ate a marcação do horario para visita tecnica ou instalação."
 */
function isOngoingConversation(jid) {
  if (!jid) return false;
  const conv = conversationStore.get(jid);
  if (!conv || !conv.messages || conv.messages.length < 2) return false;

  // Se já tem agendamento concluído, não está em negociação pendente
  const lead = leadsCrm.getLead(jid);
  if (lead && lead.appointment && lead.appointment.eventId) return false;

  // Se o cliente já está trocando mensagens sobre visita/instalação, segue até fechar
  const allText = conv.messages.map(m => m.content.toLowerCase()).join(' ');
  return allText.includes('visita') || allText.includes('instala') || allText.includes('câmera') || allText.includes('orçamento');
}

function queueForMorningService(jid, pushName, text) {
  try {
    let queue = {};
    if (fs.existsSync(morningQueueFile)) {
      queue = JSON.parse(fs.readFileSync(morningQueueFile, 'utf8'));
    }
    queue[jid] = {
      jid,
      pushName: pushName || '',
      phone: jid.split('@')[0],
      lastMessage: text || '',
      queuedAt: new Date().toISOString()
    };
    fs.writeFileSync(morningQueueFile, JSON.stringify(queue, null, 2), 'utf8');
    console.log(`[SchedulerAgent] Cliente ${pushName || jid} adicionado à fila de abertura do expediente.`);
  } catch (e) {
    console.warn('[SchedulerAgent] Erro ao salvar fila de abertura:', e.message);
  }
}

/**
 * Fila de abertura: assim que o expediente abre (conforme o painel), dispara a mensagem de início
 * de atendimento para quem escreveu fora do horário. Funciona para qualquer dia/horário configurado.
 */
let openingDispatchRunning = false;
function startMorningQueueChecker() {
  const timer = setInterval(async () => {
    if (openingDispatchRunning) return;
    try {
      if (!isWithinBusinessHours()) return;
      if (!fs.existsSync(morningQueueFile)) return;

      const queue = JSON.parse(fs.readFileSync(morningQueueFile, 'utf8'));
      const jids = Object.keys(queue);
      if (jids.length === 0) return;

      openingDispatchRunning = true;
      console.log(`[SchedulerAgent] Expediente aberto! Iniciando atendimento de ${jids.length} cliente(s) da fila de abertura...`);

      for (const jid of jids) {
        const item = queue[jid];
        delete queue[jid];
        fs.writeFileSync(morningQueueFile, JSON.stringify(queue, null, 2), 'utf8');
        if (isContactMuted(jid)) continue; // atendimento manual: automação não interfere

        const s = getTenantSettings();
        const greeting = settingsStore.renderTemplate(s.openingMessage, templateVars({ cliente: item.pushName || '' }));
        await sendWhatsAppText(jid, greeting);

        if (!conversationStore.has(jid)) {
          conversationStore.set(jid, { pushName: item.pushName || '', clientInfo: {}, offeredSlots: [], messages: [] });
        }
        const conv = conversationStore.get(jid);
        conv.messages.push({ role: 'assistant', content: greeting });
        conv.disclosed = true;
        saveMemory();
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (e) {
      console.warn('[SchedulerAgent] Erro no verificador da fila de abertura:', e.message);
    } finally {
      openingDispatchRunning = false;
    }
  }, 25000);
  if (timer.unref) timer.unref();
}

startMorningQueueChecker();

// ==============================================================================
// Transparência (assistente virtual) e Transferência para Atendimento Humano
// ==============================================================================

/** Garante que a primeira mensagem enviada ao cliente se declare "assistente virtual" (uma única vez por conversa). */
function withDisclosure(conv, text) {
  if (!conv) return text;
  if (conv.disclosed || settingsStore.DISCLOSURE_RE.test(text)) {
    conv.disclosed = true;
    return text;
  }
  const s = getTenantSettings();
  const line = settingsStore.renderTemplate(s.disclosureLine, templateVars());
  conv.disclosed = true;
  return `${line}\n\n${text}`;
}

const GREETING_WORDS = new Set(['oi', 'oii', 'oiii', 'ola', 'opa', 'eai', 'e', 'ai', 'bom', 'boa', 'dia', 'tarde', 'noite',
  'tudo', 'bem', 'td', 'hey', 'hello', 'salve', 'blz', 'beleza', 'certo', 'ola', 'oie', 'alo', 'fala', 'boas', 'tranquilo', 'como', 'vai', 'voce', 'vc', 'ta']);

/** Mensagem só de cumprimento ("oi", "bom dia", "olá tudo bem?") => responder com a saudação oficial. */
function isGreetingOnly(text) {
  const tokens = String(text || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.length <= 6 && tokens.every(t => GREETING_WORDS.has(t));
}

function normalizeForIntent(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Cliente pediu para falar com uma pessoa / atendente humano. */
function wantsHuman(text) {
  const t = normalizeForIntent(text);
  if (/\b(atendente|atendimento humano|humano)\b/.test(t) && !/\b(voce|vc)\s+(e|eh)\b/.test(t)) return true;
  if (/(falar|conversar|chamar|passar|transferir|encaminhar|quero|preciso|prefiro|gostaria).{0,40}(com )?(uma |um )?(pessoa|gente de verdade|alguem|responsavel|dono|tecnico|warley)/.test(t)
      && !/(servico|orcamento|visita) (para|pra)/.test(t)) return true;
  if (/pessoa (de verdade|real)|gente de verdade/.test(t)) return true;
  return false;
}

/** Cliente perguntou se está falando com um robô / IA. */
function asksIfBot(text) {
  const t = normalizeForIntent(text);
  return /(voce|vc|isso|esse atendimento|ai)\s*(e|eh|esta|ta)?\s*(um |uma )?(robo|bot|ia\b|inteligencia artificial|automatic|maquina|chatbot)/.test(t)
      || /(to|estou|tou)\s+falando\s+com\s+(um |uma )?(robo|bot|maquina|pessoa|alguem|humano|ia\b)/.test(t)
      || /(e|eh)\s+(um |uma )?(robo|bot|humano|pessoa de verdade|gente de verdade)\s*\??$/.test(t)
      || /(voce|vc)\s+(e|eh)\s+(gente|pessoa|humano|real)/.test(t);
}

// ==============================================================================
// Filtro de Civilidade / Palavras Ofensivas
// ==============================================================================
function containsOffensiveWords(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const offensiveList = [
    'porra', 'caralho', 'vai se foder', 'foder', 'vsf', 'puta que pariu', 'pqp',
    'vai tomar no cu', 'vtnc', 'tomar no cu', 'filho da puta', 'fdp', 'arrombado',
    'otario', 'otário', 'babaca', 'merda', 'bosta', 'vagabundo', 'lixo', 'viado',
    'desgraçado', 'puta', 'corno', 'imbecil'
  ];
  return offensiveList.some(w => lower.includes(w));
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// Inicializar Google Calendar
calendarService.init(GOOGLE_CALENDAR_ID).catch(err => {
  console.error('[SchedulerAgent] Erro ao conectar Google Calendar:', err.message);
});

// Armazenamento em memória do histórico de conversas (com persistência simples)
const conversationStore = new Map();
const memoryFile = path.resolve(__dirname, '..', 'data', 'conversations_memory.json');

// Carregar memória se existir
try {
  const dataDir = path.dirname(memoryFile);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (fs.existsSync(memoryFile)) {
    const raw = fs.readFileSync(memoryFile, 'utf8');
    const parsed = JSON.parse(raw);
    for (const [k, v] of Object.entries(parsed)) {
      conversationStore.set(k, v);
    }
  }
} catch (e) {
  console.warn('[SchedulerAgent] Aviso ao carregar memória:', e.message);
}

function saveMemory() {
  try {
    const obj = {};
    for (const [k, v] of conversationStore.entries()) {
      // Salva apenas as últimas 20 mensagens por contato
      obj[k] = {
        ...v,
        messages: (v.messages || []).slice(-20)
      };
    }
    fs.writeFileSync(memoryFile, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.warn('[SchedulerAgent] Erro ao salvar memória:', e.message);
  }
}

// ==============================================================================
// Armazenamento de Contatos com Atendimento Manual Exclusivo (Automação Silenciada)
// ==============================================================================
const mutedContacts = new Map();
const mutedFile = path.resolve(__dirname, '..', 'data', 'muted_contacts.json');

try {
  const dataDir = path.dirname(mutedFile);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (fs.existsSync(mutedFile)) {
    const raw = fs.readFileSync(mutedFile, 'utf8');
    const parsed = JSON.parse(raw);
    for (const [k, v] of Object.entries(parsed)) {
      mutedContacts.set(k, v);
    }
  }
} catch (e) {
  console.warn('[SchedulerAgent] Aviso ao carregar contatos manuais:', e.message);
}

function saveMutedContacts() {
  try {
    const obj = {};
    for (const [k, v] of mutedContacts.entries()) {
      obj[k] = v;
    }
    fs.writeFileSync(mutedFile, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.warn('[SchedulerAgent] Erro ao salvar contatos manuais:', e.message);
  }
}

function normalizeJid(input) {
  if (!input) return '';
  let str = String(input).trim();
  if (str.includes('@s.whatsapp.net')) return str;
  if (str.includes('@lid')) return str;
  const digits = str.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('55') && digits.length >= 12) {
    return `${digits}@s.whatsapp.net`;
  }
  if (digits.length === 10 || digits.length === 11) {
    return `55${digits}@s.whatsapp.net`;
  }
  return `${digits}@s.whatsapp.net`;
}

function isContactMuted(remoteJid) {
  if (!remoteJid) return false;
  const norm = normalizeJid(remoteJid);
  const rawDigits = remoteJid.replace(/\D/g, '');

  for (const [key] of mutedContacts.entries()) {
    if (key === norm || key === remoteJid) return true;
    const keyDigits = key.replace(/\D/g, '');
    if (rawDigits && keyDigits && rawDigits === keyDigits) return true;
    if (rawDigits.length >= 10 && keyDigits.length >= 10) {
      if (rawDigits.endsWith(keyDigits.slice(-8)) && rawDigits.slice(0, 4) === keyDigits.slice(0, 4)) {
        return true;
      }
    }
  }
  return false;
}

function muteContact(rawJid, name) {
  const norm = normalizeJid(rawJid);
  const phone = norm.split('@')[0];
  const contactName = name || (conversationStore.get(norm)?.pushName) || phone;

  mutedContacts.set(norm, {
    jid: norm,
    phone,
    name: contactName,
    manual: true,
    updatedAt: new Date().toISOString()
  });

  // Se houver mensagem pendente na fila de 2 minutos, cancela na hora!
  if (pendingQueue.has(norm)) {
    const entry = pendingQueue.get(norm);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.typingTimer) clearTimeout(entry.typingTimer);
    pendingQueue.delete(norm);
    console.log(`[SchedulerAgent] Resposta pendente cancelada para ${norm} (atendimento manual ativado).`);
  }

  saveMutedContacts();
  console.log(`[SchedulerAgent] Contato ${contactName} (${norm}) marcado para ATENDIMENTO MANUAL EXCLUSIVO.`);
  return { success: true, jid: norm, manual: true, name: contactName };
}

function unmuteContact(rawJid) {
  const norm = normalizeJid(rawJid);
  let foundKey = null;
  const rawDigits = rawJid.replace(/\D/g, '');

  for (const [key] of mutedContacts.entries()) {
    if (key === norm || key === rawJid || (rawDigits && key.replace(/\D/g, '') === rawDigits)) {
      foundKey = key;
      break;
    }
  }

  if (foundKey) {
    mutedContacts.delete(foundKey);
  } else {
    mutedContacts.delete(norm);
  }

  saveMutedContacts();
  console.log(`[SchedulerAgent] Contato ${norm} reativado para AUTOMAÇÃO IA.`);
  return { success: true, jid: norm, manual: false };
}

function getMutedContacts() {
  const list = [];
  for (const v of mutedContacts.values()) {
    list.push(v);
  }
  return list;
}

async function getContactsList() {
  const contactMap = new Map();

  // 1. Inicia com contatos da memória de conversa
  for (const [jid, data] of conversationStore.entries()) {
    const phone = jid.split('@')[0];
    const lastMsg = (data.messages && data.messages.length > 0)
      ? data.messages[data.messages.length - 1].content
      : '';
    contactMap.set(phone, {
      jid,
      phone,
      name: data.pushName || phone,
      profilePicUrl: null,
      lastMessage: lastMsg,
      updatedAt: new Date().toISOString(),
      isManual: isContactMuted(jid)
    });
  }

  // 2. Mescla com contatos manuais salvos
  for (const [jid, data] of mutedContacts.entries()) {
    const phone = jid.split('@')[0];
    if (contactMap.has(phone)) {
      const existing = contactMap.get(phone);
      existing.isManual = true;
      if (data.name && data.name !== phone) existing.name = data.name;
    } else {
      contactMap.set(phone, {
        jid,
        phone,
        name: data.name || phone,
        profilePicUrl: null,
        lastMessage: 'Marcado para atendimento manual',
        updatedAt: data.updatedAt || new Date().toISOString(),
        isManual: true
      });
    }
  }

  // 3. Mescla com chats do WhatsApp via Evolution API (para listar clientes reais)
  try {
    const res = await fetch(`${EVOLUTION_URL}/chat/findChats/${INSTANCE_NAME}`, {
      method: 'POST',
      headers: {
        'apikey': EVOLUTION_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    });
    if (res.ok) {
      const chats = await res.json();
      if (Array.isArray(chats)) {
        for (const c of chats) {
          if (!c.remoteJid || c.remoteJid.includes('@g.us') || c.remoteJid === 'status@broadcast') continue;

          let targetJid = c.remoteJid;
          if (targetJid.includes('@lid') && c.lastMessage?.key?.remoteJidAlt) {
            targetJid = c.lastMessage.key.remoteJidAlt;
          }
          const phone = targetJid.split('@')[0];
          const name = c.pushName || c.lastMessage?.pushName || phone;
          const msgObj = c.lastMessage?.message;
          const lastMsg = msgObj?.conversation || msgObj?.extendedTextMessage?.text || (msgObj ? '[Áudio / Mídia]' : '');
          const updatedAt = c.updatedAt || (c.lastMessage?.messageTimestamp ? new Date(c.lastMessage.messageTimestamp * 1000).toISOString() : new Date().toISOString());

          if (contactMap.has(phone)) {
            const existing = contactMap.get(phone);
            if (c.profilePicUrl && !existing.profilePicUrl) existing.profilePicUrl = c.profilePicUrl;
            if (lastMsg && (!existing.lastMessage || existing.lastMessage.length < 5)) existing.lastMessage = lastMsg;
            if (name && (existing.name === phone || existing.name === 'Você')) existing.name = name;
            existing.updatedAt = updatedAt;
            existing.isManual = isContactMuted(targetJid);
          } else {
            contactMap.set(phone, {
              jid: targetJid,
              phone,
              name: (name === 'Você') ? phone : name,
              profilePicUrl: c.profilePicUrl || null,
              lastMessage: lastMsg,
              updatedAt,
              isManual: isContactMuted(targetJid)
            });
          }
        }
      }
    }
  } catch (e) {
    console.warn('[SchedulerAgent] Aviso ao buscar chats da Evolution API:', e.message);
  }

  const list = Array.from(contactMap.values());
  // Ordena por mais recente primeiro
  list.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  return list;
}

// ------------------------------------------------------------------------------
// Ferramentas da Agenda para o Modelo GPT-4o mini
// ------------------------------------------------------------------------------
const TOOLS_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'get_available_calendar_slots',
      description: 'Consulta a agenda do Google Calendar da WarNat Tech em tempo real e retorna EXATAMENTE 2 horários livres verificados. ATENÇÃO OBRIGATÓRIA: Use esta função SOMENTE DEPOIS que o cliente já tiver esclarecido se o serviço é para NOVA INSTALAÇÃO ou para MANUTENÇÃO. NUNCA chame esta função se o cliente apenas pediu "visita técnica", "orçamento" ou "valores" de forma genérica sem ter especificado se é nova instalação ou manutenção. Se o cliente pediu "outro dia", "outra data" ou recusou uma data anterior, NUNCA repita a mesma data: passe a data antiga em excludeDates!',
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
            description: 'Lista de horários ou datas específicas que o cliente já recusou anteriormente para não repetir (ex: ["08:00", "10:00"]).'
          },
          excludeDates: {
            type: 'array',
            items: { type: 'string' },
            description: 'Lista de DATAS inteiras (YYYY-MM-DD ou DD/MM) que devem ser TOTALMENTE IGNORADAS. Use SEMPRE que o cliente pedir "outro dia", "outra data", ou recusar um dia.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'check_specific_slot_availability',
      description: 'Verifica se uma data e horário específicos solicitados pelo cliente estão LIVRES na agenda do Google Calendar. Se estiver ocupado, retorna os horários livres alternativos.',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: 'Data no formato YYYY-MM-DD (ex: "2026-11-04")'
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
      description: 'Grava e bloqueia um agendamento no Google Calendar. ANALISE O CONTEXTO: use appointmentType: "VISITA_TECNICA" para diagnóstico e orçamento prévio, OU appointmentType: "INSTALACAO_CFTV" quando o cliente já aprovou o orçamento e está agendando a instalação definitiva das câmeras.',
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
      name: 'book_technical_visit',
      description: 'Atalho direto para agendar a Visita Técnica Gratuita de avaliação e orçamento no Google Calendar.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Data confirmada no formato YYYY-MM-DD' },
          time: { type: 'string', description: 'Horário confirmado no formato HH:mm' },
          clientName: { type: 'string', description: 'Nome do cliente' },
          address: { type: 'string', description: 'Endereço completo' },
          notes: { type: 'string', description: 'Observações' }
        },
        required: ['date', 'time', 'clientName']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'book_installation_service',
      description: 'Atalho direto para agendar a Instalação Definitiva das Câmeras de Segurança (quando o cliente já aprovou o orçamento).',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'Data confirmada no formato YYYY-MM-DD' },
          time: { type: 'string', description: 'Horário confirmado no formato HH:mm' },
          clientName: { type: 'string', description: 'Nome do cliente' },
          address: { type: 'string', description: 'Endereço completo' },
          notes: { type: 'string', description: 'Observações da instalação' }
        },
        required: ['date', 'time', 'clientName']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_client_details',
      description: 'Grava o ENDEREÇO (e nome/observações) informados pelo cliente no evento do Google Calendar e no CRM, depois que o agendamento já foi criado. Chame assim que o cliente informar o endereço do local da visita/instalação.',
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'Endereço completo informado pelo cliente (rua, número, bairro, referência)' },
          clientName: { type: 'string', description: 'Nome do cliente (se informado)' },
          notes: { type: 'string', description: 'Observações úteis (ponto de referência, quantidade de câmeras, etc.)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'cancel_appointment',
      description: 'Cancela e remove DEFINITIVAMENTE o agendamento da visita técnica ou instalação do Google Calendar. ATENÇÃO: DEVE ser chamada sempre que o cliente pedir para desmarcar, cancelar ou adiar um agendamento ("desmarcar", "cancelar", "não vou poder", "vou aguardar outro dia"). Esta função remove o evento do Google Calendar e retorna automaticamente os próximos 2 horários livres verificados para remarcação imediata.',
      parameters: {
        type: 'object',
        properties: {
          clientName: {
            type: 'string',
            description: 'Nome do cliente'
          },
          date: {
            type: 'string',
            description: 'Data do agendamento que está sendo cancelado no formato YYYY-MM-DD (se mencionada)'
          },
          reason: {
            type: 'string',
            description: 'Motivo do cancelamento (opcional)'
          }
        }
      }
    }
  }
];

/**
 * Detecta se o texto do cliente é uma escolha ou confirmação de data e horário para agendamento
 */
function detectBookingRequest(text, conv) {
  if (!text) return null;
  const lower = text.toLowerCase().trim();

  // Se for cancelamento explícito, não é agendamento
  if (lower.includes('desmarqu') || lower.includes('cancel') || lower.includes('outro dia') || lower.includes('não posso') || lower.includes('nao posso')) {
    return null;
  }

  // Palavras indicando concordância / escolha de horário
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

  // Extrai o horário (ex: 10h, 10:00, 10:30, às 08:00, às 10)
  const timeMatch = lower.match(/\b([01]?\d|2[0-3])(?::([0-5]\d)|h(?:oras?)?|\s*horas?)\b/) ||
                    lower.match(/às\s*([01]?\d|2[0-3])\b/);

  let targetTime = null;
  if (timeMatch) {
    const hour = String(timeMatch[1]).padStart(2, '0');
    const minute = timeMatch[2] ? String(timeMatch[2]).padStart(2, '0') : '00';
    targetTime = `${hour}:${minute}`;
  }

  // Se for pergunta de disponibilidade ("tem vaga?", "não tem na quarta?", "consegue?", etc.), NÃO é confirmação de agendamento!
  const isQuestioningAvailability = (
    lower.includes('tem vaga') ||
    lower.includes('teria vaga') ||
    lower.includes('não tem') ||
    lower.includes('nao tem') ||
    lower.includes('tem horário') ||
    lower.includes('tem horario') ||
    lower.includes('consegue') ||
    lower.includes('dá pra ser') ||
    lower.includes('da pra ser') ||
    lower.includes('será que') ||
    lower.includes('sera que') ||
    lower.includes('?')
  );

  if (isQuestioningAvailability) {
    return null; // Não força agendamento, deixa checar disponibilidade
  }

  // Se o cliente só disse "pode marcar", "pode ser", "esse horário" e temos apenas 1 slot oferecido
  if (!targetTime && hasBookingVerb && conv && conv.offeredSlots && conv.offeredSlots.length === 1) {
    targetTime = conv.offeredSlots[0].time;
  }

  if (!hasBookingVerb) return null;
  if (!targetTime) return null;

  // Localiza a data para esse horário
  let targetDate = null;

  // 1. Data explícita no texto do cliente (ex: 07/11 ou 2026-11-07)
  const dateMatch = text.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (dateMatch) {
    const now = new Date();
    const d = String(dateMatch[1]).padStart(2, '0');
    const m = String(dateMatch[2]).padStart(2, '0');
    targetDate = `${now.getFullYear()}-${m}-${d}`;
  }

  // 2. Nos offeredSlots registrados na conversa
  if (!targetDate && conv && conv.offeredSlots && conv.offeredSlots.length > 0) {
    const matching = conv.offeredSlots.find(s => s.time === targetTime);
    if (matching) {
      targetDate = matching.date;
    } else {
      targetDate = conv.offeredSlots[0].date;
    }
  }

  // 3. Nas mensagens do assistente oferecendo horários
  if (!targetDate && conv && conv.messages) {
    const assistantMsgs = conv.messages.filter(m => m.role === 'assistant').slice(-3);
    for (const am of assistantMsgs.reverse()) {
      const dm = am.content.match(/\b(\d{2})\/(\d{2})\b/);
      if (dm) {
        const now = new Date();
        targetDate = `${now.getFullYear()}-${dm[2]}-${dm[1]}`;
        break;
      }
    }
  }

  if (targetTime && targetDate) {
    return {
      date: targetDate,
      time: targetTime
    };
  }

  return null;
}

/**
 * Executa as ferramentas da agenda invocadas pelo modelo
 */
async function executeCalendarTool(toolName, toolArgs, remoteJid, clientInfo) {
  console.log(`[SchedulerAgent] Executando ferramenta: ${toolName}`, toolArgs);

  if (toolName === 'get_available_calendar_slots') {
    try {
      const conv = conversationStore.get(remoteJid);
      if (conv && conv.messages) {
        const allUserText = conv.messages.filter(m => m.role === 'user').map(m => m.content.toLowerCase()).join(' ');
        const isClearlyNew = allUserText.includes('nova instala') || allUserText.includes('instalar do zero') || allUserText.includes('câmeras novas') || allUserText.includes('não tenho câmera') || allUserText.includes('instalação nova') || allUserText.includes('projeto novo') || allUserText.includes('quero instalar');
        const isClearlyMaintenance = allUserText.includes('manuten') || allUserText.includes('consert') || allUserText.includes('repar') || allUserText.includes('parou de') || allUserText.includes('câmera queim') || allUserText.includes('arrumar') || allUserText.includes('já tenho câmera') || allUserText.includes('já tenho');

        if (!isClearlyNew && !isClearlyMaintenance) {
          console.log('[SchedulerAgent] Ferramenta recusou consulta: cliente ainda não identificou se é Nova Instalação ou Manutenção.');
          return {
            success: false,
            requiresQualification: true,
            instruction: 'O cliente ainda NÃO esclareceu se a visita técnica é para NOVA INSTALAÇÃO ou MANUTENÇÃO. NÃO passe horários e NÃO fale de gratuidade! Pergunte primeiro: "Opa! Com certeza, realizamos sim. Só para eu te orientar certinho: a visita técnica seria para uma *nova instalação* de câmeras ou para *manutenção / conserto* de câmeras que você já tem no local?"'
          };
        }
      }

      const fromDate = toolArgs.fromDate || null;
      const exclude = toolArgs.excludeSlots || [];
      const excludeDates = toolArgs.excludeDates || [];

      // Se o cliente pediu "outro dia" ou "outra data", auto-coleta datas anteriores oferecidas para não repetir a mesma data
      if (conv && conv.messages) {
        const lastUser = conv.messages.filter(m => m.role === 'user').slice(-1)[0]?.content.toLowerCase() || '';
        if (lastUser.includes('outro dia') || lastUser.includes('outra data') || lastUser.includes('não posso nesse') || lastUser.includes('nao posso nesse') || lastUser.includes('outro')) {
          for (const m of conv.messages) {
            if (m.role === 'assistant') {
              const dms = m.content.match(/\b(\d{2}\/\d{2})\b/g);
              if (dms) {
                for (const d of dms) {
                  if (!excludeDates.includes(d)) excludeDates.push(d);
                }
              }
            }
          }
        }
      }

      const slots = await calendarService.getNextAvailableSlots(2, fromDate, exclude, excludeDates);
      if (conv) {
        conv.offeredSlots = slots;
        saveMemory();
      }

      return {
        success: true,
        totalFound: slots.length,
        slots: slots.map(s => ({
          date: s.date,
          dayOfWeek: s.dayOfWeek,
          time: s.time,
          description: s.label
        }))
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  if (toolName === 'check_specific_slot_availability') {
    try {
      const { date, time } = toolArgs;
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
            message: `O horário das ${time} no dia ${date} está 100% LIVRE no Google Calendar para agendamento.`
          };
        }
      }

      const nextSlots = await calendarService.getNextAvailableSlots(2);
      return {
        available: false,
        conflict: true,
        date,
        time,
        message: `No momento nossa agenda para esse dia/horário já está preenchida. Só temos a data sugerida ou ${calendarService.getNextWindowPhrase()} (${nextSlots.map(s => s.label).join(' ou ')}). Caso abra uma vaga em outro dia ou horário, nós entramos em contato com você!`,
        suggestedAlternativeSlots: nextSlots.map(s => s.label),
        instruction: 'Avise que nossa agenda para esses dias já está preenchida, que no momento só temos a data sugerida ou a próxima data liberada nos horários livres informados, e que caso abra alguma vaga em outro dia ou horário entraremos em contato. NUNCA diga que os agendamentos só podem ser feitos em determinado dia da semana!'
      };
    } catch (e) {
      return { available: false, error: e.message };
    }
  }

  if (toolName === 'book_appointment' || toolName === 'book_technical_visit' || toolName === 'book_installation_service') {
    try {
      const phone = remoteJid.split('@')[0];
      const clientName = (toolArgs.clientName && toolArgs.clientName !== 'Cliente') ? toolArgs.clientName : (clientInfo.pushName || 'Cliente WhatsApp');
      const address = toolArgs.address || clientInfo.address || 'Endereço a confirmar';

      let appointmentType = toolArgs.appointmentType || 'VISITA_TECNICA';
      if (toolName === 'book_installation_service') appointmentType = 'INSTALACAO_CFTV';
      if (toolName === 'book_technical_visit') appointmentType = 'VISITA_TECNICA';

      const isInstallation = (appointmentType === 'INSTALACAO_CFTV') ||
        (toolArgs.serviceType && (toolArgs.serviceType.toLowerCase().includes('instalação') || toolArgs.serviceType.toLowerCase().includes('instalacao')));

      const serviceType = toolArgs.serviceType || (isInstallation ? 'Instalação de Câmeras de Segurança' : 'Visita Técnica Gratuita');

      const res = await calendarService.bookAppointment({
        date: toolArgs.date,
        time: toolArgs.time,
        clientName,
        phone,
        address,
        serviceType,
        appointmentType: isInstallation ? 'INSTALACAO_CFTV' : 'VISITA_TECNICA',
        notes: toolArgs.notes || ''
      });

      // Se agendado com sucesso, registra imediatamente no Leads CRM!
      if (res.success) {
        leadsCrm.recordAppointment({
          jid: remoteJid,
          clientName,
          phone,
          appointmentType: isInstallation ? 'INSTALACAO_CFTV' : 'VISITA_TECNICA',
          date: toolArgs.date,
          time: toolArgs.time,
          address,
          notes: toolArgs.notes || '',
          eventLink: res.eventLink,
          eventId: res.eventId,
          serviceType
        });
      }

      return res;
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  if (toolName === 'save_client_details') {
    try {
      const phone = remoteJid ? remoteJid.split('@')[0] : '';
      const lead = leadsCrm.getLead(remoteJid, phone);
      const appt = lead && lead.appointment;
      if (!appt || !appt.eventId) {
        return { success: false, error: 'Não há agendamento ativo para vincular o endereço. Agende primeiro.' };
      }
      const address = (toolArgs.address || '').trim();
      const clientName = (toolArgs.clientName || '').trim();
      const notes = (toolArgs.notes || '').trim();
      if (!address && !clientName && !notes) return { success: false, error: 'Nada para salvar.' };

      await calendarService.updateAppointmentDetails({ eventId: appt.eventId, address, clientName, notes });
      leadsCrm.recordAppointment({
        jid: remoteJid, clientName: clientName || lead.name, phone,
        appointmentType: appt.type, date: appt.date, time: appt.time,
        address: address || appt.address, notes: notes || appt.notes,
        eventLink: appt.eventLink, eventId: appt.eventId, serviceType: appt.serviceType
      });
      return { success: true, saved: { address: address || null, clientName: clientName || null, notes: notes || null }, instruction: 'Dados gravados na agenda e no CRM. Confirme ao cliente que está tudo anotado.' };
    } catch (e) {
      console.error('[SchedulerAgent] Erro ao salvar dados do cliente:', e.message);
      return { success: false, error: e.message };
    }
  }

  if (toolName === 'cancel_appointment') {
    try {
      const phone = remoteJid ? remoteJid.split('@')[0] : '';
      const lead = leadsCrm.getLead(remoteJid, phone);
      const eventId = lead?.appointment?.eventId || null;
      const appointmentDate = lead?.appointment?.date || toolArgs.date || null;
      const appointmentTime = lead?.appointment?.time || null;
      const clientName = (toolArgs.clientName && toolArgs.clientName !== 'Cliente') ? toolArgs.clientName : (lead?.name || clientInfo?.pushName || '');

      console.log(`[SchedulerAgent] Executando cancel_appointment para ${clientName} (${phone}), eventId=${eventId}`);

      // 1. Remove definitivamente do Google Calendar
      const calRes = await calendarService.cancelAppointment({
        eventId,
        phone,
        clientName,
        date: appointmentDate
      });

      // 2. Atualiza no Leads CRM
      const crmRes = leadsCrm.cancelAppointment(remoteJid, phone);

      // 3. Busca imediatamente 2 novos horários livres na agenda do Google Calendar para remarcação
      // REGRA DE OURO ABSOLUTA: JAMAIS sugerir a mesma data cancelada! Deve ser OBRIGATORIAMENTE em OUTRO DIA diferente!
      const excludeDates = [];
      let searchFromDate = null;

      if (appointmentDate) {
        excludeDates.push(appointmentDate);
        // Formato curto também para exclusão (ex: "07/11")
        const parts = appointmentDate.split('-');
        if (parts.length === 3) excludeDates.push(`${parts[2]}/${parts[1]}`);

        // Inicia a busca a partir do dia seguinte
        const [y, m, d] = appointmentDate.split('-').map(Number);
        const nextDay = new Date(y, m - 1, d + 1);
        const pad = (n) => String(n).padStart(2, '0');
        searchFromDate = `${nextDay.getFullYear()}-${pad(nextDay.getMonth() + 1)}-${pad(nextDay.getDate())}`;
      }

      // Adiciona também datas mencionadas no histórico de conversa que o cliente recusou
      const conv = conversationStore.get(remoteJid);
      if (conv && conv.messages) {
        for (const m of conv.messages) {
          if (m.role === 'assistant') {
            const dateMatches = m.content.match(/\b(\d{2}\/\d{2})\b/g);
            if (dateMatches) {
              for (const dm of dateMatches) {
                if (!excludeDates.includes(dm)) excludeDates.push(dm);
              }
            }
          }
        }
      }

      const slots = await calendarService.getNextAvailableSlots(2, searchFromDate, [], excludeDates);

      return {
        success: true,
        calendarCancelled: calRes.success,
        deletedEventId: calRes.deletedEventId || eventId,
        previousAppointment: {
          date: appointmentDate,
          time: appointmentTime
        },
        suggestedSlots: slots.map(s => ({
          date: s.date,
          dayOfWeek: s.dayOfWeek,
          time: s.time,
          description: s.label,
          formatted: s.formatted
        })),
        instruction: 'O agendamento anterior foi CANCELADO e REMOVIDO do Google Calendar com sucesso. Responda confirmando a desmarcação com simpatia e acolhimento humano (ex: "Tranquilo! Já cancelei e retirei aqui da nossa agenda."). E IMEDIATAMENTE ofereça os 2 novos horários livres em OUTRO DIA retornados em suggestedSlots para o cliente já deixar reagendado, dizendo que no momento só temos a data sugerida ou a próxima data liberada, e que caso abra uma vaga em outro dia ou horário entramos em contato. NUNCA diga que os agendamentos só podem ser feitos em determinado dia da semana!'
      };
    } catch (e) {
      console.error('[SchedulerAgent] Erro ao cancelar agendamento:', e.message);
      return { success: false, error: e.message };
    }
  }

  return { error: `Ferramenta desconhecida: ${toolName}` };
}

/**
 * Gera o Prompt do Sistema com data/hora em tempo real - Persona 100% Humana e Especialista
 */
function buildSystemPrompt() {
  const now = new Date();
  const options = { timeZone: 'America/Sao_Paulo', weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' };
  const currentDateTimeStr = now.toLocaleDateString('pt-BR', options);
  const ts = getTenantSettings();
  const scheduleDesc = calendarService.getAllowedScheduleDescription();
  const nextWindow = calendarService.getNextWindowPhrase();
  const hoursDesc = settingsStore.describeBusinessHours(ts);
  const baseAddrLine = ts.baseAddress ? `\nBASE DE PARTIDA DO TÉCNICO (referência de atendimento): ${ts.baseAddress}` : '';

  return `Você é a ${ts.assistantName}, assistente virtual da ${ts.companyName} - Especialistas em Sistemas de Câmeras de Segurança e CFTV em Belo Horizonte, Barreiro e Grande BH.
Você conversa no WhatsApp de forma natural, acolhedora, profissional, educada e ágil, em nome da equipe do responsável técnico e especialista Warley Santos.${baseAddrLine}

DATA E HORA ATUAL DO SISTEMA: ${currentDateTimeStr}

================================================================================
TRANSPARÊNCIA OBRIGATÓRIA (CDC/LGPD): VOCÊ É UMA ASSISTENTE VIRTUAL
================================================================================
- Você é a ${ts.assistantName}, uma ASSISTENTE VIRTUAL (sistema automatizado). NUNCA se passe por uma pessoa real, NUNCA diga que é humana e NUNCA invente um nome/cargo humano.
- Se o cliente perguntar se você é robô, IA ou pessoa: confirme com naturalidade que é a assistente virtual da ${ts.companyName} e ofereça o atendimento com uma pessoa da equipe.
- Se o cliente pedir para falar com uma pessoa/atendente/humano: diga que vai encaminhar para a equipe (o sistema faz a transferência).
- Dados pessoais (nome, endereço) são pedidos apenas para a visita/instalação; não peça CPF, documentos ou dados bancários.
- A apresentação como assistente virtual na primeira mensagem é inserida pelo sistema; NÃO repita a apresentação nas mensagens seguintes.

================================================================================
TOM NATURAL (SEM LINGUAGEM ROBÓTICA!)
================================================================================
Fale de forma humanizada e calorosa, como um bom atendimento brasileiro, mas sempre transparente quanto a ser assistente virtual.
É TERMINANTEMENTE PROIBIDO emitir frases robóticas, tais como:
❌ "Parece que você não mencionou nada específico."
❌ "Como posso ajudar você hoje?" ou "Como posso te auxiliar?"
❌ "Se precisar de informações sobre segurança eletrônica ou instalação de câmeras, estou à disposição!"
❌ "Vou verificar os horários disponíveis na agenda... Um momento, por favor!"
❌ "Aguarde um instante enquanto consulto."
❌ "Prezado(a) cliente", "Informamos por meio desta", "Agradecemos o contato."

COMO FALAR DE FORMA NATURAL NO WHATSAPP:
- Fale como um bom profissional brasileiro: use "Opa, tudo bem?", "Com certeza!", "Perfeito!", "Show de bola!", "Tranquilo!".
- Respostas diretas ao ponto, em parágrafos curtos e objetivos.
- Destaque dias e horários em *negrito* para facilitar a leitura no celular.
- NUNCA adie ou mande o cliente esperar com "vou verificar a agenda... um momento". Assim que o tipo de visita for identificado (nova instalação ou manutenção), chame a ferramenta "get_available_calendar_slots" NESTA MESMA REQUISIÇÃO e JÁ RESPONDA com os dois horários livres na ponta da língua!

================================================================================
ESCOPO DE ATUAÇÃO E TRATAMENTO DE SOLICITAÇÕES
================================================================================
A WarNat Tech atua ÚNICA E EXCLUSIVAMENTE com SISTEMAS DE CÂMERAS DE SEGURANÇA E CFTV (Residencial, Comercial e Condominial):
- Novas instalações de câmeras de vigilância (CFTV HD, Câmeras IP, Wi-Fi, DVR/NVR, visualização remota no celular)
- Manutenção, reparo, troca e reconfiguração de sistemas de câmeras já instalados

================================================================================
REGRA FUNDAMENTAL ABSOLUTA: IDENTIFICAÇÃO PRÉVIA ANTES DE QUALQUER OFERTA!
================================================================================
TODAS as suas respostas devem SEMPRE identificar primeiro o que o cliente quer, e SÓ DEPOIS fazer a oferta (seja de visita técnica, horários livres ou valores)!

A política comercial da WarNat Tech possui uma distinção crítica:
1. A VISITA TÉCNICA GRATUITA É EXCLUSIVA PARA NOVAS INSTALAÇÕES DE CÂMERAS!
2. MANUTENÇÃO / CONSERTO DE CÂMERAS EXISTENTES POSSUI TAXA DE R$ 140,00!
   * Regra da taxa de manutenção:
     - O valor de R$ 140,00 da taxa de visita é 100% aproveitado e abatido no conserto!
     - Se o valor do conserto for menor ou igual a R$ 140,00: o cliente NÃO paga nenhum valor adicional (a taxa de R$ 140 já cobre o serviço!).
     - Se o conserto for maior que R$ 140,00: é cobrado apenas o valor que ultrapassar os R$ 140,00.

PORTANTO, É TERMINANTEMENTE PROIBIDO:
- ❌ NUNCA diga que a visita técnica é 100% gratuita antes de ter certeza absoluta que se trata de uma NOVA INSTALAÇÃO!
- ❌ NUNCA ofereça horários da agenda antes de saber se o cliente quer NOVA INSTALAÇÃO ou MANUTENÇÃO!

FLUXO OBRIGATÓRIO DE ATENDIMENTO:

PASSO 1: O CLIENTE PEDE VISITA TÉCNICA, ORÇAMENTO OU PREÇO (SEM ESPECIFICAR SE É NOVA INSTALAÇÃO OU MANUTENÇÃO):
(Exemplos: "Visita técnica", "Quero agendar visita", "Vocês fazem visita técnica?", "Quanto custa?", "Qual o valor do orçamento?", "Preciso de um técnico")
- O cliente NÃO disse se tem câmeras antigas ou se quer instalar tudo novo!
- SUA OBRIGAÇÃO É PERGUNTAR PRIMEIRO PARA IDENTIFICAR O QUE ELE PRECISA:
  "Opa! Com certeza, realizamos sim. Só para eu te orientar certinho: a visita técnica seria para uma *nova instalação* de câmeras ou para *manutenção / conserto* de câmeras que você já tem no local?"
- NÃO chame ferramentas da agenda e NÃO faça nenhuma oferta de gratuidade ainda!

PASSO 2: O CLIENTE CONFIRMA QUE É NOVA INSTALAÇÃO (CÂMERAS NOVAS DO ZERO):
(Exemplos: "É nova instalação", "Quero colocar 4 câmeras", "Não tenho câmeras ainda", "Instalação do zero")
- AGORA SIM: Trata-se comprovadamente de Nova Instalação!
- A Visita Técnica é 100% GRATUITA e sem compromisso para avaliar pontos cegos e cabeamento ideal.
- Chame IMEDIATAMENTE a ferramenta "get_available_calendar_slots" e apresente DOIS horários livres reais da agenda:
  "Perfeito! Para *nova instalação*, a nossa visita técnica de avaliação é *100% gratuita e sem compromisso*. O técnico Warley vai até o seu imóvel para avaliar os pontos cegos e o cabeamento ideal.

No momento, temos disponibilidade na nossa agenda para *[Dia da Semana] ([Data])* às *[Horário 1]* ou às *[Horário 2]* (ou para ${nextWindow}). Caso abra uma vaga em outro dia ou horário, a gente entra em contato com você!

Algum desses horários fica bom para você?"

PASSO 3: O CLIENTE CONFIRMA QUE É MANUTENÇÃO / REPARO (CÂMERAS EXISTENTES):
(Exemplos: "É manutenção", "Minhas câmeras pararam de gravar", "Quero conserto de câmeras", "Trocar DVR/câmera queimada")
- AGORA SIM: Trata-se comprovadamente de Manutenção!
- Apresente OBRIGATORIAMENTE a regra dos R$ 140,00 na mensagem.
- Chame IMEDIATAMENTE a ferramenta "get_available_calendar_slots" e apresente DOIS horários livres reais da agenda:
  "Perfeito! Para *manutenção em câmeras que você já tem*, temos uma taxa de visita técnica de *R$ 140,00*. E o melhor: esse valor já é 100% aproveitado no serviço! Se o conserto ficar em até R$ 140,00, você *não paga nenhum valor adicional*. Se o conserto for maior que R$ 140,00, é cobrado *apenas o valor que ultrapassar os R$ 140,00*.

Consultei a agenda do técnico Warley e no momento só temos disponibilidade para o *[Dia da Semana] ([Data])* às *[Horário 1]* ou às *[Horário 2]* (ou para ${nextWindow}). Caso abra uma vaga em outro dia ou horário, a gente entra em contato com você!

Qual desses horários funciona melhor para você?"

PASSO 4: SE O CLIENTE SOLICITAR QUALQUER SERVIÇO FORA DO RAMO DE CÂMERAS DE SEGURANÇA:
(Exemplos: Decoração de festas, buffet, compras, alimentos, pintura, pedreiro, conserto de eletrodomésticos, etc.)
- Recuse com simpatia, naturalidade e firmeza, sem frases robóticas:
  "Opa! A gente não mexe com esse tipo de serviço não, amigo(a). Aqui na WarNat Tech somos focados exclusivamente em *Sistemas de Câmeras de Segurança e CFTV*. Se você precisar de monitoramento e proteção para seu imóvel ou comércio, estamos às ordens!"
- JAMAIS consulte a agenda ou ofereça horários para coisas fora do escopo de câmeras!

================================================================================
REGRA DE OURO CRÍTICA: DISTINÇÃO ABSOLUTA ENTRE "VISITA TÉCNICA" E "INSTALAÇÃO"
================================================================================
JAMAIS misture os assuntos com o cliente! Analise todo o histórico da conversa:

MOMENTO 1: VISITA TÉCNICA (AVALIAÇÃO / DIAGNÓSTICO / ORÇAMENTO NO LOCAL)
- Aplica-se a clientes que estão pedindo orçamento, novos projetos, ou manutenção de câmeras existentes.
- VOCABULÁRIO EXCLUSIVO: Fale sempre e apenas de "VISITA TÉCNICA".
  * Explique que o Warley vai ao imóvel para avaliar pontos cegos, altura e cabeamento antes de qualquer orçamento.
  * JAMAIS diga que ele já vai para "instalar" no primeiro contato.
  * Agende com a ferramenta: book_appointment (appointmentType: "VISITA_TECNICA") ou book_technical_visit.

MOMENTO 2: AGENDAMENTO DA INSTALAÇÃO (SERVIÇO FECHADO / ORÇAMENTO APROVADO)
- Aplica-se quando o cliente já teve a visita técnica, já aprovou o orçamento com o Warley e está agendando a montagem definitiva!
- VOCABULÁRIO EXCLUSIVO: Fale sempre e apenas de "INSTALAÇÃO DAS CÂMERAS".
  * Confirme com entusiasmo: "Excelente! Vamos agendar a *Instalação das suas Câmeras de Segurança*!"
  * JAMAIS chame de "visita técnica" se o cliente já fechou o serviço e quer a instalação!
  * Agende com a ferramenta: book_appointment (appointmentType: "INSTALACAO_CFTV") ou book_installation_service.

================================================================================
REGRAS RÍGIDAS DE OURO DA AGENDA DO GOOGLE (ZERO CONFLITO / ANTI-CHOQUE)
================================================================================
1. SUGESTÃO OBRIGATÓRIA DE DOIS HORÁRIOS LIVRES:
   - DIRETRIZ FUNDAMENTAL DE COMUNICAÇÃO: NUNCA diga ao cliente que "os agendamentos só podem ser feitos em tal dia da semana" ou "só atendemos em tal dia" (a janela liberada hoje é: ${scheduleDesc} - informação interna, não dizer assim ao cliente)!
   - Em vez disso, informe sempre com naturalidade que NO MOMENTO SÓ TEMOS A DATA SUGERIDA OU PARA ${nextWindow.toUpperCase()}, e que CASO ABRA UMA VAGA EM OUTRO HORÁRIO OU DIA ENTRAMOS EM CONTATO!
   - Chame sempre "get_available_calendar_slots" para obter DOIS horários livres reais do Google Calendar.
   - Apresente EXATAMENTE esses dois horários ao cliente.
   - PREMISSA ABSOLUTA DO GOOGLE CALENDAR: SÓ marque a data e horário se o dia e horário estiver comprovadamente LIVRE no calendário do Google! NUNCA marque uma data e horário que esteja ocupado na agenda.

2. SE O CLIENTE NÃO PUDER NOS DOIS HORÁRIOS SUGERIDOS:
   - Chame novamente "get_available_calendar_slots", incluindo em "excludeSlots" os horários recusados (o sistema buscará horários na próxima data liberada).
   - Apresente de forma acolhedora: "Tranquilo! Para ${nextWindow} temos esses horários livres... E caso abra alguma vaga antes em outro dia ou horário, a gente te avisa por aqui!".

3. SE O CLIENTE SUGERIR UM HORÁRIO OU OUTRO DIA ESPECÍFICO (Ex: "Pode ser na quarta às 10h?", "Tem vaga na semana?"):
   - Chame IMEDIATAMENTE "check_specific_slot_availability".
   - SE LIVRE (e estiver dentro da disponibilidade confirmada): Agende IMEDIATAMENTE chamando "book_appointment" e confirme com alegria:
     "Perfeito, [Nome]! Já deixei reservado aqui na agenda na [Data] às [Horário]. O Warley estará aí no local!"
   - SE O DIA/HORÁRIO ESTIVER OCUPADO OU INDISPONÍVEL: JAMAIS MARQUE! Avise com simpatia e acolhimento:
     "Poxa, para esses dias nossa agenda já está preenchida! No momento só temos a data sugerida ou para ${nextWindow} às [Horário 1] ou às [Horário 2]. Caso abra uma vaga em outro dia ou horário, a gente entra em contato com você! Algum desses horários fica bom para você?"

4. SE A MENSAGEM DO CLIENTE CONTIVER "[audio]":
   - Significa que o cliente enviou um áudio no WhatsApp que foi transcrito. Acolha com naturalidade (ex: "Ouvi seu áudio aqui! Perfeito...").

5. CANCELAMENTO E DESMARCAÇÃO DE AGENDAMENTO (REMOÇÃO NA AGENDA + 2 HORÁRIOS EM OUTRO DIA):
   - Quando o cliente solicitar desmarcar, cancelar, adiar ou pedir outro dia (Exemplos: "desmarque por favor", "cancela", "não vou poder no dia marcado", "vou aguardar outro dia", "quero desmarcar", "desmarca pra mim"):
   - Você DEVE OBRIGATORIAMENTE chamar a ferramenta "cancel_appointment" para remover o evento do Google Calendar e atualizar o sistema! NUNCA apenas responda em texto sem chamar a ferramenta.
   - REGRA DE OURO ABSOLUTA: JAMAIS sugira a mesma data ou os mesmos horários do agendamento cancelado! A nova sugestão de reagendamento DEVE SER OBRIGATORIAMENTE EM OUTRO DIA DISPONÍVEL (em uma data futura diferente)!
   - Na sua resposta ao cliente:
     a) Confirme a desmarcação com acolhimento e simpatia (ex: "Tranquilo! Já desmarquei e retirei aqui da nossa agenda.").
     b) IMEDIATAMENTE ofereça a nova data (OUTRO DIA) com os DOIS horários livres retornados em suggestedSlots pela ferramenta "cancel_appointment", seguindo exatamente o fluxo de agendamento:
        "Se você quiser já deixar reagendado para outro dia, no momento só temos disponibilidade na *[Dia da Semana] ([Data])* às *[Horário 1]* ou às *[Horário 2]* (ou para ${nextWindow}). Caso abra uma vaga em outro dia ou horário, a gente entra em contato com você!
        
        Algum desses horários fica melhor para você?"
   - Se o cliente preferir remarcar mais para a frente, ele é livre para isso, mas você DEVE SEMPRE oferecer as duas opções de horário livre de OUTRO DIA na mesma resposta!

6. REGRA ABSOLUTA DE AGENDAMENTO NO GOOGLE CALENDAR:
   - Toda vez que o cliente confirmar ou escolher um horário ("pode marcar às 10h", "10h fica bom", "pode ser esse", etc.), você DEVE chamar a ferramenta "book_appointment" para registrar no Google Calendar.
   - NUNCA diga que o horário está reservado ou agendado sem que a ferramenta tenha sido executada com sucesso!
   - Se o horário estiver ocupado na agenda, NUNCA marque! Avise com educação e ofereça os horários livres reais retornados pela ferramenta.

7. EDUCAÇÃO, CIVILIDADE E TRATAMENTO DE PALAVRAS OFENSIVAS:
   - Se um cliente usar palavras ofensivas, gírias grosseiras ou baixo calão, JAMAIS responda da mesma forma!
   - Todas as respostas devem ser extremamente educadas, calmas, profissionais e respeitosas, sem palavras chulas nem gírias agressivas.

8. HORÁRIO DE ATENDIMENTO (CONFIGURADO NO PAINEL: ${hoursDesc}):
   - O expediente oficial da ${ts.companyName} é: ${hoursDesc}.
   - Atendimentos já em andamento no final do expediente devem seguir até a marcação final da visita técnica ou instalação.

9. COLETA DE DADOS APÓS O AGENDAMENTO:
   - Logo depois de confirmar um agendamento (evento criado no Google Calendar), peça de forma simpática o ENDEREÇO COMPLETO do local (rua, número, bairro e ponto de referência) e, se ainda não souber, o nome.
   - Assim que o cliente informar o endereço, chame a ferramenta "save_client_details" para gravar na agenda e no CRM, e confirme que está tudo anotado.
   - Não peça CPF, documentos ou dados bancários.`;
}

// ------------------------------------------------------------------------------
// Disparador de Ações via Evolution API
// ------------------------------------------------------------------------------
async function sendWhatsAppText(number, text) {
  try {
    let cleanNumber = String(number);
    if (cleanNumber.includes('@s.whatsapp.net')) {
      cleanNumber = cleanNumber.split('@')[0];
    } else if (cleanNumber.includes('@lid')) {
      // Se for LID, procura se temos o telefone real nos contatos
      const chats = await getContactsList().catch(() => []);
      const found = chats.find(c => c.jid === cleanNumber || c.phone === cleanNumber.split('@')[0]);
      if (found && found.phone && !found.phone.includes('@lid')) {
        cleanNumber = found.phone;
      } else {
        cleanNumber = cleanNumber.split('@')[0];
      }
    } else if (cleanNumber.includes('@')) {
      cleanNumber = cleanNumber.split('@')[0];
    }

    console.log(`[SchedulerAgent] Enviando mensagem via Evolution API para ${cleanNumber}...`);
    const res = await fetch(`${EVOLUTION_URL}/message/sendText/${INSTANCE_NAME}`, {
      method: 'POST',
      headers: {
        'apikey': EVOLUTION_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        number: cleanNumber,
        text: text,
        delay: 1500
      })
    });
    const resData = await res.json().catch(() => ({}));
    if (res.ok) {
      console.log(`[SchedulerAgent] Mensagem enviada com sucesso para ${cleanNumber}!`);
      return true;
    } else {
      console.error(`[SchedulerAgent] Falha ao enviar mensagem para ${cleanNumber}:`, resData);
      return false;
    }
  } catch (e) {
    console.error('[SchedulerAgent] Erro ao enviar mensagem WhatsApp:', e.message);
    return false;
  }
}

async function sendTypingPresence(number) {
  try {
    let cleanNumber = String(number);
    if (cleanNumber.includes('@s.whatsapp.net') || cleanNumber.includes('@')) {
      cleanNumber = cleanNumber.split('@')[0];
    }
    await fetch(`${EVOLUTION_URL}/chat/sendPresence/${INSTANCE_NAME}`, {
      method: 'POST',
      headers: {
        'apikey': EVOLUTION_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        number: cleanNumber,
        presence: 'composing',
        delay: 1200
      })
    });
  } catch (e) {}
}

// Fila de mensagens pendentes com atraso humanizado
// Map<remoteJid, { pushName: string, texts: string[], timer: NodeJS.Timeout, typingTimer: NodeJS.Timeout, targetTime: number }>
const pendingQueue = new Map();
const activeProcessing = new Set();

/**
 * Dispara as mensagens acumuladas da fila após o tempo humanizado
 */
async function dispatchQueuedMessages(remoteJid) {
  const entry = pendingQueue.get(remoteJid);
  if (!entry) return;
  pendingQueue.delete(remoteJid);

  if (entry.timer) clearTimeout(entry.timer);
  if (entry.typingTimer) clearTimeout(entry.typingTimer);

  const combinedText = entry.texts.join('\n');
  const pushName = entry.pushName;

  console.log(`[SchedulerAgent] Tempo humanizado concluído! Processando resposta para ${pushName || remoteJid} (${entry.texts.length} msg(s) acumulada(s))...`);

  // Garante status digitando ativo antes e durante a resposta
  await sendTypingPresence(remoteJid);

  try {
    activeProcessing.add(remoteJid);
    await processIncomingMessage(remoteJid, pushName, combinedText);
  } finally {
    activeProcessing.delete(remoteJid);
  }
}

/**
 * Processador principal de mensagens recebidas pelo Webhook da Evolution API
 */
async function processIncomingMessage(remoteJid, pushName, incomingText) {
  if (!incomingText || !incomingText.trim()) return;

  console.log(`[SchedulerAgent] Processando mensagem de ${pushName} (${remoteJid}): "${incomingText.replace(/\n/g, ' ')}"`);

  // Recupera ou cria histórico de conversa
  if (!conversationStore.has(remoteJid)) {
    conversationStore.set(remoteJid, {
      pushName: pushName || '',
      clientInfo: {},
      offeredSlots: [],
      messages: []
    });
  }

  const conv = conversationStore.get(remoteJid);
  conv.pushName = pushName || conv.pushName;
  conv.clientInfo = conv.clientInfo || {};
  conv.clientInfo.pushName = conv.pushName;
  conv.messages.push({
    role: 'user',
    content: incomingText
  });

  const tenantSettings = getTenantSettings();
  const hadAssistantBefore = conv.messages.slice(0, -1).some(m => m.role === 'assistant');

  // 0a. Cliente pediu atendimento humano => transfere (silencia a automação para este contato)
  if (wantsHuman(incomingText)) {
    console.log(`[SchedulerAgent] ${pushName || remoteJid} pediu atendimento humano. Transferindo e silenciando automação para este contato.`);
    let handoff = settingsStore.renderTemplate(tenantSettings.humanHandoffMessage, templateVars({ cliente: pushName || '' }));
    handoff = withDisclosure(conv, handoff);
    conv.messages.push({ role: 'assistant', content: handoff });
    saveMemory();
    await sendWhatsAppText(remoteJid, handoff);
    muteContact(remoteJid, pushName);
    return { message: handoff, handoff: true };
  }

  // 0b. Cliente perguntou se está falando com robô/IA => resposta honesta e determinística
  if (asksIfBot(incomingText)) {
    const honest = `Sim, sou a *${tenantSettings.assistantName}*, assistente virtual da *${tenantSettings.companyName}*, ou seja, um sistema automatizado e não uma pessoa. Posso te ajudar com orçamento, visita técnica e agendamento. Se preferir falar com uma pessoa da nossa equipe, é só pedir que eu encaminho.`;
    conv.disclosed = true;
    conv.messages.push({ role: 'assistant', content: honest });
    saveMemory();
    await sendWhatsAppText(remoteJid, honest);
    return { message: honest, botQuery: true };
  }

  // 0c. Primeiro contato só com cumprimento => saudação oficial da assistente (configurada no painel)
  if (!hadAssistantBefore && isGreetingOnly(incomingText)) {
    const greeting = settingsStore.renderTemplate(tenantSettings.greetingMessage, templateVars({ cliente: pushName || '' }));
    conv.disclosed = true;
    conv.messages.push({ role: 'assistant', content: greeting });
    saveMemory();
    await sendWhatsAppText(remoteJid, greeting);
    return { message: greeting, greeting: true };
  }

  // 1. Verificação de Palavras Ofensivas / Baixo Calão (Tratar sempre com respeito e civilidade)
  if (containsOffensiveWords(incomingText)) {
    console.log(`[SchedulerAgent] Palavra ofensiva detectada de ${pushName || remoteJid}. Respondendo com civilidade e profissionalismo.`);
    let politeResponse = 'Compreendo sua mensagem. Estamos aqui para atendê-lo com total respeito e profissionalismo no que se refere a câmeras de segurança e CFTV. Se desejar dar andamento ao atendimento de forma tranquila, permanecemos à disposição.';
    politeResponse = withDisclosure(conv, politeResponse);
    conv.messages.push({ role: 'assistant', content: politeResponse });
    saveMemory();
    await sendWhatsAppText(remoteJid, politeResponse);
    return { message: politeResponse, offensive: true };
  }

  // Mostra "digitando..." no WhatsApp
  await sendTypingPresence(remoteJid);

  // Prepara as mensagens para a OpenAI
  const messagesToSend = [
    { role: 'system', content: buildSystemPrompt() },
    ...conv.messages.slice(-12)
  ];

  try {
    let assistantMessage = null;
    let toolCallCount = 0;

    // Verificação Proativa de Cancelamento / Desmarcação:
    const incomingLower = incomingText.toLowerCase();
    const isCancelIntent = (
      incomingLower.includes('desmarqu') ||
      incomingLower.includes('desmarca') ||
      incomingLower.includes('cancel') ||
      incomingLower.includes('não vou poder') ||
      incomingLower.includes('nao vou poder') ||
      incomingLower.includes('aguardar outro dia') ||
      incomingLower.includes('não posso mais') ||
      incomingLower.includes('nao posso mais')
    );

    let cancelToolResult = null;
    if (isCancelIntent) {
      console.log(`[SchedulerAgent] Intenção de cancelamento detectada para ${remoteJid}. Executando cancel_appointment proativamente...`);
      cancelToolResult = await executeCalendarTool('cancel_appointment', {}, remoteJid, conv.clientInfo);
      messagesToSend.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_proactive_cancel',
          type: 'function',
          function: {
            name: 'cancel_appointment',
            arguments: JSON.stringify({})
          }
        }]
      });
      messagesToSend.push({
        role: 'tool',
        tool_call_id: 'call_proactive_cancel',
        content: JSON.stringify(cancelToolResult)
      });
      toolCallCount++;
    }

    // 2. Verificação Proativa de Agendamento (quando o cliente confirma/escolhe um horário):
    const bookingReq = detectBookingRequest(incomingText, conv);
    let bookToolResult = null;

    if (bookingReq && !isCancelIntent) {
      console.log(`[SchedulerAgent] Intenção de agendamento detectada para ${remoteJid}: data=${bookingReq.date}, hora=${bookingReq.time}`);
      
      const allText = conv.messages.map(m => m.content.toLowerCase()).join(' ');
      const isInstallation = allText.includes('instalação das câmeras') || allText.includes('orçamento aprovado');
      const appointmentType = isInstallation ? 'INSTALACAO_CFTV' : 'VISITA_TECNICA';

      bookToolResult = await executeCalendarTool('book_appointment', {
        date: bookingReq.date,
        time: bookingReq.time,
        clientName: pushName || conv.pushName || 'Cliente WhatsApp',
        appointmentType,
        serviceType: isInstallation ? 'Instalação de Câmeras de Segurança' : 'Visita Técnica Gratuita'
      }, remoteJid, conv.clientInfo);

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
              clientName: pushName || conv.pushName || 'Cliente WhatsApp',
              appointmentType
            })
          }
        }]
      });
      messagesToSend.push({
        role: 'tool',
        tool_call_id: 'call_proactive_book',
        content: JSON.stringify(bookToolResult)
      });
      toolCallCount++;
    }

    // 3. Verificação Proativa de Consulta de Horários (evita qualquer alucinação de datas/horários pela IA):
    const allUserText = conv.messages.filter(m => m.role === 'user').map(m => m.content.toLowerCase()).join(' ');
    const isClearlyNew = allUserText.includes('nova instala') || allUserText.includes('instalar do zero') || allUserText.includes('câmeras novas') || allUserText.includes('não tenho câmera') || allUserText.includes('instalação nova') || allUserText.includes('projeto novo') || allUserText.includes('quero instalar');
    const isClearlyMaintenance = allUserText.includes('manuten') || allUserText.includes('consert') || allUserText.includes('repar') || allUserText.includes('parou de') || allUserText.includes('câmera queim') || allUserText.includes('arrumar') || allUserText.includes('já tenho câmera') || allUserText.includes('já tenho');

    const needsSlots = (isClearlyNew || isClearlyMaintenance) && !isCancelIntent && !bookingReq;
    const hasActiveOfferedSlots = conv.offeredSlots && conv.offeredSlots.length > 0;
    const asksOtherDayOrTimes = incomingLower.includes('outro dia') || incomingLower.includes('outra data') || incomingLower.includes('outros horários') || incomingLower.includes('outras opções') || incomingLower.includes('horários') || incomingLower.includes('quando pode') || incomingLower.includes('tem vaga');

    if (needsSlots && (!hasActiveOfferedSlots || asksOtherDayOrTimes)) {
      console.log(`[SchedulerAgent] Cliente qualificado precisando de horários reais. Consultando Google Calendar diretamente...`);
      const excludeDates = [];
      if (incomingLower.includes('outro dia') || incomingLower.includes('outra data')) {
        if (conv.offeredSlots) {
          for (const s of conv.offeredSlots) {
            if (!excludeDates.includes(s.date)) excludeDates.push(s.date);
          }
        }
      }
      const slots = await calendarService.getNextAvailableSlots(2, null, [], excludeDates);
      conv.offeredSlots = slots;
      saveMemory();

      messagesToSend.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_proactive_slots',
          type: 'function',
          function: {
            name: 'get_available_calendar_slots',
            arguments: JSON.stringify({ excludeDates })
          }
        }]
      });
      messagesToSend.push({
        role: 'tool',
        tool_call_id: 'call_proactive_slots',
        content: JSON.stringify({
          success: true,
          totalFound: slots.length,
          slots: slots.map(s => ({
            date: s.date,
            dayOfWeek: s.dayOfWeek,
            time: s.time,
            description: s.label
          }))
        })
      });
      toolCallCount++;
    }

    // Loop de chamada de ferramentas (até no máximo 4 iterações)
    while (toolCallCount < 4) {
      const response = await openai.chat.completions.create({
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
          } catch (e) {}

          const toolResult = await executeCalendarTool(fnName, fnArgs, remoteJid, conv.clientInfo);
          if (fnName === 'cancel_appointment') {
            cancelToolResult = toolResult;
          }

          messagesToSend.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult)
          });
        }
      } else {
        const contentLower = (responseMessage.content || '').toLowerCase();
        const isDeferral = (contentLower.includes('vou verificar') || contentLower.includes('um momento') || contentLower.includes('aguarde')) &&
                           (contentLower.includes('horário') || contentLower.includes('agenda') || contentLower.includes('visita'));

        if (isDeferral && toolCallCount === 0) {
          const allUserText = conv.messages.filter(m => m.role === 'user').map(m => m.content.toLowerCase()).join(' ');
          const isIdentified = allUserText.includes('nova instala') || allUserText.includes('instalar do zero') || allUserText.includes('câmeras novas') || allUserText.includes('não tenho câmera') || allUserText.includes('instalação nova') || allUserText.includes('manuten') || allUserText.includes('consert') || allUserText.includes('repar') || allUserText.includes('parou de');

          if (isIdentified) {
            console.log('[SchedulerAgent] O modelo tentou adiar a resposta. Forçando consulta de 2 horários na agenda para responder na hora!');
            const slots = await calendarService.getNextAvailableSlots(2);
            messagesToSend.push({
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_auto_slots',
                type: 'function',
                function: {
                  name: 'get_available_calendar_slots',
                  arguments: JSON.stringify({})
                }
              }]
            });
            messagesToSend.push({
              role: 'tool',
              tool_call_id: 'call_auto_slots',
              content: JSON.stringify({
                success: true,
                totalFound: slots.length,
                slots: slots.map(s => ({
                  date: s.date,
                  dayOfWeek: s.dayOfWeek,
                  time: s.time,
                  description: s.label
                }))
              })
            });
            toolCallCount++;
            continue;
          }
        }

        assistantMessage = responseMessage.content;
        break;
      }
    }

    if (assistantMessage) {
      // Guardrail Anti-Oferta Prematura:
      // TODAS as respostas devem sempre identificar primeiro o que o cliente quer (Nova Instalação vs Manutenção)
      // e SÓ DEPOIS fazer oferta de visita gratuita, horários da agenda ou taxa de serviço.
      // (Não se aplica a cancelamento de agendamento já existente)
      const allUserText = conv.messages.filter(m => m.role === 'user').map(m => m.content.toLowerCase()).join(' ');
      const isClearlyNew = allUserText.includes('nova instala') || allUserText.includes('instalar do zero') || allUserText.includes('câmeras novas') || allUserText.includes('não tenho câmera') || allUserText.includes('instalação nova') || allUserText.includes('projeto novo') || allUserText.includes('quero instalar');
      const isClearlyMaintenance = allUserText.includes('manuten') || allUserText.includes('consert') || allUserText.includes('repar') || allUserText.includes('parou de') || allUserText.includes('câmera queim') || allUserText.includes('arrumar') || allUserText.includes('já tenho câmera') || allUserText.includes('já tenho');

      if (!isCancelIntent && !cancelToolResult && !isClearlyNew && !isClearlyMaintenance) {
        const assistantLower = assistantMessage.toLowerCase();
        const hasPrematureOffer = assistantLower.includes('gratuita') ||
                                  assistantLower.includes('100%') ||
                                  assistantLower.includes('disponibilidade na') ||
                                  assistantLower.includes('temos horários') ||
                                  assistantLower.includes('horários livres') ||
                                  assistantLower.includes('algum desses horários') ||
                                  assistantLower.includes('qual desses horários') ||
                                  assistantLower.includes('140');

        if (hasPrematureOffer) {
          console.log('[SchedulerAgent] Interceptada oferta prematura sem identificação prévia. Corrigindo para pergunta de identificação.');
          assistantMessage = 'Opa! Com certeza, realizamos sim. Só para eu te orientar certinho: a visita técnica seria para uma *nova instalação* de câmeras ou para *manutenção / conserto* de câmeras que você já tem no local?';
        }
      }

      // Guardrail Anti-Alucinação de Agendamento (REGRA DE OURO DO GOOGLE CALENDAR):
      // NUNCA permita que a IA diga que marcou ou reservou na agenda se o evento NÃO foi criado no Google Calendar!
      const assistantLower = assistantMessage.toLowerCase();
      const claimsBooking = assistantLower.includes('já reservei') ||
                            assistantLower.includes('já deixei reservado') ||
                            assistantLower.includes('deixei reservado') ||
                            assistantLower.includes('está agendado') ||
                            assistantLower.includes('agendei aqui') ||
                            assistantLower.includes('marquei aqui');

      if (claimsBooking) {
        const lead = leadsCrm.getLead(remoteJid);
        const hasRealEvent = lead && lead.appointment && lead.appointment.eventId;

        if (!hasRealEvent) {
          console.log(`[SchedulerAgent] ALERTA CRÍTICO: O modelo disse que agendou, mas o evento NÃO constava no Google Calendar! Tentando agendar agora...`);
          const timeM = assistantMessage.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/) || assistantMessage.match(/às\s*([01]?\d|2[0-3])\b/);
          const dateM = assistantMessage.match(/\b(\d{1,2})\/(\d{1,2})\b/);

          let bookSuccess = false;
          if (timeM) {
            const hour = String(timeM[1]).padStart(2, '0');
            const minute = timeM[2] || '00';
            const timeStr = `${hour}:${minute}`;
            
            let dateStr = null;
            if (dateM) {
              const now = new Date();
              dateStr = `${now.getFullYear()}-${String(dateM[2]).padStart(2, '0')}-${String(dateM[1]).padStart(2, '0')}`;
            } else if (conv.offeredSlots && conv.offeredSlots.length > 0) {
              dateStr = conv.offeredSlots[0].date;
            }

            if (dateStr) {
              const allText = conv.messages.map(m => m.content.toLowerCase()).join(' ');
              const isInstallation = allText.includes('instalação das câmeras') || allText.includes('orçamento aprovado');
              const appointmentType = isInstallation ? 'INSTALACAO_CFTV' : 'VISITA_TECNICA';

              const res = await calendarService.bookAppointment({
                date: dateStr,
                time: timeStr,
                clientName: pushName || conv.pushName || 'Cliente WhatsApp',
                phone: remoteJid.split('@')[0],
                serviceType: isInstallation ? 'Instalação de Câmeras de Segurança' : 'Visita Técnica Gratuita',
                appointmentType
              });

              if (res.success) {
                bookSuccess = true;
                leadsCrm.recordAppointment({
                  jid: remoteJid,
                  clientName: pushName || conv.pushName || 'Cliente WhatsApp',
                  phone: remoteJid.split('@')[0],
                  appointmentType,
                  date: dateStr,
                  time: timeStr,
                  eventId: res.eventId,
                  eventLink: res.eventLink,
                  serviceType: isInstallation ? 'Instalação de Câmeras de Segurança' : 'Visita Técnica Gratuita'
                });
                console.log(`[SchedulerAgent] Evento criado com sucesso no Google Calendar (ID: ${res.eventId})!`);
              } else {
                console.warn(`[SchedulerAgent] Conflito na agenda do Google para ${dateStr} às ${timeStr}. Interceptando mensagem falsa e oferecendo horários reais.`);
                const slots = await calendarService.getNextAvailableSlots(2);
                conv.offeredSlots = slots;
                saveMemory();
                assistantMessage = `Poxa, consultei a agenda do Google e o horário das *${timeStr}* na data *${dateStr}* já está ocupado. No momento só temos a data sugerida ou ${calendarService.getNextWindowPhrase()} na *${slots[0].label}* ou na *${slots[1].label}*. Caso abra uma vaga em outro dia ou horário, a gente entra em contato com você! Qual desses horários fica bom para você?`;
              }
            }
          }

          if (!bookSuccess && !assistantMessage.includes('já está ocupado')) {
            const slots = await calendarService.getNextAvailableSlots(2);
            conv.offeredSlots = slots;
            saveMemory();
            assistantMessage = `Para garantir que não haja choque de horário, consultei a agenda do Google e no momento só temos a data sugerida ou ${calendarService.getNextWindowPhrase()} na *${slots[0].label}* ou na *${slots[1].label}*. Caso abra uma vaga em outro dia ou horário, a gente entra em contato com você! Qual desses horários fica melhor para você?`;
          }
        }
      }

      // Guardrail Obrigatório para Cancelamento / Desmarcação:
      // O cliente solicitou desmarcar -> deve confirmar cancelamento E oferecer 2 novos horários livres em OUTRO DIA diferente
      if (cancelToolResult && cancelToolResult.suggestedSlots && cancelToolResult.suggestedSlots.length >= 2) {
        const s1 = cancelToolResult.suggestedSlots[0].description;
        const s2 = cancelToolResult.suggestedSlots[1].description;
        const t1 = cancelToolResult.suggestedSlots[0].time;
        const t2 = cancelToolResult.suggestedSlots[1].time;
        const prevDate = cancelToolResult.previousAppointment?.date; // ex: 2026-11-07

        let prevShort = '';
        if (prevDate) {
          const parts = prevDate.split('-');
          if (parts.length === 3) prevShort = `${parts[2]}/${parts[1]}`; // ex: 07/11
        }

        const suggestedDateStr = cancelToolResult.suggestedSlots[0].date;
        const [sy, sm, sd] = suggestedDateStr.split('-');
        const newShort = `${sd}/${sm}`; // ex: 14/11

        // Se a resposta sugeriu a data antiga cancelada ou se não mencionou a nova data:
        if ((prevShort && assistantMessage.toLowerCase().includes(prevShort) && !assistantMessage.includes(newShort)) ||
            (!assistantMessage.includes(newShort) && !assistantMessage.includes(t1) && !assistantMessage.includes(t2))) {
          console.log(`[SchedulerAgent] Garantindo sugestão de reagendamento em OUTRO DIA (${newShort}).`);
          assistantMessage = `Tranquilo! Já cancelei e retirei aqui da nossa agenda.\n\nNo momento só temos para a *${s1}* ou *${s2}* (ou para ${calendarService.getNextWindowPhrase()}). Caso abra uma vaga em outro dia ou horário, a gente entra em contato com você!\n\nAlgum desses horários fica melhor para você?`;
        }
      }

      // Guardrail adicional: Se o cliente solicita MANUTENÇÃO e o assistente ainda não explicou a taxa de R$ 140
      const lastUserMsg = conv.messages.filter(m => m.role === 'user').slice(-1)[0]?.content.toLowerCase() || '';
      const isMaintenanceUser = (lastUserMsg.includes('manuten') || lastUserMsg.includes('consert') || lastUserMsg.includes('repar') || lastUserMsg.includes('parou de') || lastUserMsg.includes('queimad')) &&
                                !lastUserMsg.includes('nova instala') && !lastUserMsg.includes('instalar') && !lastUserMsg.includes('novas');
      const alreadyMentionedFee = conv.messages.some(m => m.role === 'assistant' && m.content.includes('140'));

      if (!isCancelIntent && !cancelToolResult && isMaintenanceUser && !alreadyMentionedFee && !assistantMessage.includes('140')) {
        console.log('[SchedulerAgent] Inserindo regra obrigatória da taxa de R$ 140 de manutenção na resposta.');
        assistantMessage = `Perfeito! Para *manutenção em câmeras que você já tem*, temos uma taxa de visita técnica de *R$ 140,00*. E o melhor: esse valor já é 100% aproveitado no serviço! Se o conserto ficar em até R$ 140,00, você *não paga nenhum valor adicional*. Se o conserto for maior que R$ 140,00, é cobrado *apenas o valor que ultrapassar os R$ 140,00*.\n\n${assistantMessage}`;
      }

      // Guardrail de Integridade de Contexto (Visita Técnica vs Instalação):
      // "Jamais misture conversas, ou assuntos. Se o cliente estiver falando sobre visita tecnica, fale somente sobre visita tecnica por exempo, se for sobre agendamento de instalação fale soment sobre instação por exemplo, jamais sai fora do contexto."
      const isInstallContext = allUserText.includes('fech') || allUserText.includes('orçamento aprovado') || allUserText.includes('instalação das 4') || allUserText.includes('fechei');
      if (!isInstallContext) {
        assistantMessage = assistantMessage.replace(/instalação das suas câmeras agendada/gi, 'visita técnica gratuita agendada');
        assistantMessage = assistantMessage.replace(/instalação das 4 câmeras agendada/gi, 'visita técnica gratuita agendada');
        assistantMessage = assistantMessage.replace(/instalação de câmeras agendada/gi, 'visita técnica gratuita agendada');
      }

      // Transparência: a primeira mensagem ao cliente sempre se declara assistente virtual
      assistantMessage = withDisclosure(conv, assistantMessage);

      console.log(`[SchedulerAgent] Resposta gerada: "${assistantMessage.substring(0, 100)}..."`);
      conv.messages.push({
        role: 'assistant',
        content: assistantMessage
      });
      saveMemory();

      // Envia a resposta de volta ao WhatsApp
      await sendWhatsAppText(remoteJid, assistantMessage);
      return { message: assistantMessage };
    }
  } catch (error) {
    console.error('[SchedulerAgent] Erro na OpenAI ou execução:', error.message);
    const fallback = withDisclosure(conv, 'Opa! Tive uma breve oscilação aqui na consulta, mas já anotei sua mensagem. O especialista Warley vai te responder em instantes por aqui!');
    saveMemory();
    await sendWhatsAppText(remoteJid, fallback);
    return { message: fallback, error: error.message };
  }
}

/**
 * Handler público para receber o Webhook da Evolution API
 */
function handleWebhookPayload(payload) {
  if (!payload || payload.event !== 'messages.upsert') return;
  const data = payload.data;
  if (!data || !data.key) return;

  const { remoteJid, fromMe, id } = data.key;
  const remoteJidAlt = data.key.remoteJidAlt;

  // Ignora mensagens enviadas pelo próprio bot ou de grupos / status
  if (fromMe) return;
  if (!remoteJid || remoteJid.includes('@g.us') || remoteJid === 'status@broadcast') return;

  // Resolve JID real do contato (converte LID para número de telefone real se disponível)
  let effectiveJid = remoteJid;
  if (remoteJid.includes('@lid') && remoteJidAlt && remoteJidAlt.includes('@s.whatsapp.net')) {
    console.log(`[SchedulerAgent] Convertendo JID LID ${remoteJid} para número real ${remoteJidAlt}`);
    effectiveJid = remoteJidAlt;
  }

  const pushName = data.pushName || '';

  // ==============================================================================
  // VERIFICAÇÃO DE ATENDIMENTO MANUAL EXCLUSIVO (SILENCIAR AUTOMAÇÃO)
  // ==============================================================================
  if (isContactMuted(effectiveJid) || (remoteJidAlt && isContactMuted(remoteJidAlt))) {
    console.log(`[SchedulerAgent] Contato ${pushName || effectiveJid} está em ATENDIMENTO MANUAL EXCLUSIVO. Automação silenciada (apenas humano responde).`);
    return;
  }

  // Extrai o texto da mensagem (ou texto transcrito pelo Whisper!)
  let text = '';
  if (data.message?.speechToText) {
    const rawSpeech = typeof data.message.speechToText === 'string'
      ? data.message.speechToText
      : (data.message.speechToText?.text || '');
    text = rawSpeech.startsWith('[audio]') ? rawSpeech : `[audio] ${rawSpeech}`;
  } else if (data.message?.conversation) {
    text = data.message.conversation;
  } else if (data.message?.extendedTextMessage?.text) {
    text = data.message.extendedTextMessage.text;
  }

  if (!text || !text.trim()) return;

  // Registra a interação do cliente no Funil do CRM
  try {
    leadsCrm.recordClientInteraction({
      jid: effectiveJid,
      phone: effectiveJid.split('@')[0],
      name: pushName,
      incomingText: text
    });
  } catch (e) {}

  // ==============================================================================
  // VERIFICAÇÃO DE HORÁRIO DE ATENDIMENTO (08:00 ÀS 20:00)
  // ==============================================================================
  const withinHours = isWithinBusinessHours();
  const ongoing = isOngoingConversation(effectiveJid);

  if (!withinHours && !ongoing) {
    console.log(`[SchedulerAgent] Mensagem de ${pushName || effectiveJid} recebida FORA do horário de atendimento configurado.`);
    
    // Adiciona à fila de abertura (dispara quando o expediente abrir, conforme o painel)
    queueForMorningService(effectiveJid, pushName, text);

    if (!conversationStore.has(effectiveJid)) {
      conversationStore.set(effectiveJid, { pushName: pushName || '', clientInfo: {}, offeredSlots: [], messages: [] });
    }
    const c = conversationStore.get(effectiveJid);
    c.messages.push({ role: 'user', content: text });

    // Aviso de fora do expediente (evita spam: no máximo 1 aviso a cada 4 horas por cliente)
    const FOUR_HOURS = 4 * 60 * 60 * 1000;
    const alreadyNotified = c.outOfHoursNoticeAt && (Date.now() - c.outOfHoursNoticeAt) < FOUR_HOURS;

    if (!alreadyNotified) {
      const s = getTenantSettings();
      let outOfHoursMsg = settingsStore.renderTemplate(s.outOfHoursMessage, templateVars({ cliente: pushName || '' }));
      outOfHoursMsg = withDisclosure(c, outOfHoursMsg);
      c.outOfHoursNoticeAt = Date.now();
      c.messages.push({ role: 'assistant', content: outOfHoursMsg });
      saveMemory();
      sendWhatsAppText(effectiveJid, outOfHoursMsg);
    } else {
      saveMemory();
    }
    return;
  }

  // Se o delay configurado for 0 (modo imediato), processa na hora
  if (RESPONSE_DELAY_SECONDS <= 0) {
    processIncomingMessage(effectiveJid, pushName, text);
    return;
  }

  const delayMs = RESPONSE_DELAY_SECONDS * 1000;

  // Se já há uma fila pendente para este contato:
  if (pendingQueue.has(effectiveJid)) {
    const entry = pendingQueue.get(effectiveJid);
    entry.texts.push(text);
    if (pushName) entry.pushName = pushName;

    const remainingMs = entry.targetTime - Date.now();
    console.log(`[SchedulerAgent] Mensagem acumulada de ${pushName || effectiveJid}: "${text}". Faltam ${(remainingMs / 1000).toFixed(0)}s para responder.`);

    // Se faltarem menos de 20 segundos para responder, adiciona 20s de margem
    // para que a pessoa termine de mandar pensamentos picados
    if (remainingMs < 20000) {
      clearTimeout(entry.timer);
      if (entry.typingTimer) clearTimeout(entry.typingTimer);

      const extraMs = 20000;
      entry.targetTime = Date.now() + extraMs;

      // Digitando... nos últimos 12 segundos
      entry.typingTimer = setTimeout(() => {
        console.log(`[SchedulerAgent] Exibindo "digitando..." para ${pushName || effectiveJid}...`);
        sendTypingPresence(effectiveJid);
      }, Math.max(0, extraMs - 12000));

      entry.timer = setTimeout(() => {
        dispatchQueuedMessages(effectiveJid);
      }, extraMs);
    }
  } else {
    // Nova mensagem recebida: inicia o timer humanizado
    console.log(`[SchedulerAgent] Nova mensagem de ${pushName || effectiveJid}: "${text}". Resposta programada para daqui a ${RESPONSE_DELAY_SECONDS}s (${(RESPONSE_DELAY_SECONDS / 60).toFixed(1)} min) para simular leitura humana.`);

    const targetTime = Date.now() + delayMs;

    // Dispara "digitando..." 15 segundos antes do envio para parecer 100% natural
    const typingLeadTime = Math.min(15000, delayMs / 2);
    const typingDelay = Math.max(0, delayMs - typingLeadTime);

    const typingTimer = setTimeout(() => {
      console.log(`[SchedulerAgent] Exibindo status "digitando..." para ${pushName || effectiveJid}...`);
      sendTypingPresence(effectiveJid);
    }, typingDelay);

    const timer = setTimeout(() => {
      dispatchQueuedMessages(effectiveJid);
    }, delayMs);

    pendingQueue.set(effectiveJid, {
      pushName,
      texts: [text],
      targetTime,
      timer,
      typingTimer
    });
  }
}

/**
 * Zera o estado de UMA conversa (memória da IA, fila de resposta pendente e fila de abertura).
 * Usado pela homologação para não deixar rastro do número de teste.
 */
function resetConversation(jid) {
  const norm = normalizeJid(jid);
  conversationStore.delete(norm);
  saveMemory();
  if (pendingQueue.has(norm)) {
    const entry = pendingQueue.get(norm);
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.typingTimer) clearTimeout(entry.typingTimer);
    pendingQueue.delete(norm);
  }
  try {
    if (fs.existsSync(morningQueueFile)) {
      const q = JSON.parse(fs.readFileSync(morningQueueFile, 'utf8'));
      if (q[norm]) { delete q[norm]; fs.writeFileSync(morningQueueFile, JSON.stringify(q, null, 2), 'utf8'); }
    }
  } catch (e) {}
  return { success: true, jid: norm };
}

/** Cópia das mensagens de uma conversa (para homologação/diagnóstico). */
function getConversation(jid) {
  const conv = conversationStore.get(normalizeJid(jid));
  return conv ? { messages: conv.messages.map(m => ({ ...m })), disclosed: !!conv.disclosed } : { messages: [], disclosed: false };
}

module.exports = {
  getConversation,
  isWithinBusinessHours,
  resetConversation,
  handleWebhookPayload,
  processIncomingMessage,
  executeCalendarTool,
  getResponseDelay,
  setResponseDelay,
  dispatchQueuedMessages,
  muteContact,
  unmuteContact,
  isContactMuted,
  getMutedContacts,
  getContactsList
};
