// ==============================================================================
// CRM & Gestão do Funil de Clientes Atendidos - WarNat Tech
// Métricas: Total Atendidos, Visitas Técnicas Marcadas, Instalações Fechadas
// ==============================================================================

const fs = require('fs');
const path = require('path');

const leadsFile = path.resolve(__dirname, '..', 'data', 'leads_crm.json');
const memoryFile = path.resolve(__dirname, '..', 'data', 'conversations_memory.json');

// Mapa em memória dos leads
const leadsStore = new Map();

// Status possíveis do funil
const LEAD_STATUS = {
  EM_ATENDIMENTO: 'EM_ATENDIMENTO',       // Em sondagem / tirando dúvidas
  VISITA_MARCADA: 'VISITA_MARCADA',       // Visita técnica agendada
  INSTALACAO_FECHADA: 'INSTALACAO_FECHADA', // Fechou para instalação de câmeras
  RECUSADO: 'RECUSADO'                   // Fora de escopo / desistência
};

function formatPhone(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('55')) {
    const ddd = digits.substring(2, 4);
    const num = digits.substring(4);
    return `+55 (${ddd}) ${num.length === 9 ? num.substring(0, 5) + '-' + num.substring(5) : num.substring(0, 4) + '-' + num.substring(4)}`;
  }
  if (digits.length === 12 && digits.startsWith('55')) {
    const ddd = digits.substring(2, 4);
    const num = digits.substring(4);
    return `+55 (${ddd}) ${num.substring(0, 4)}-${num.substring(4)}`;
  }
  return phone;
}

function initCrm() {
  try {
    const dataDir = path.dirname(leadsFile);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    if (fs.existsSync(leadsFile)) {
      const raw = fs.readFileSync(leadsFile, 'utf8');
      const parsed = JSON.parse(raw);
      for (const [k, v] of Object.entries(parsed)) {
        leadsStore.set(k, v);
      }
    }

    // Se estiver vazio ou inicializando pela primeira vez, sincroniza do conversations_memory
    if (leadsStore.size === 0 && fs.existsSync(memoryFile)) {
      const rawMem = fs.readFileSync(memoryFile, 'utf8');
      const memObj = JSON.parse(rawMem);
      for (const [jid, data] of Object.entries(memObj)) {
        if (!jid || jid.includes('@g.us')) continue;
        const phone = jid.split('@')[0];
        const pushName = data.pushName || data.clientInfo?.pushName || phone;
        const messages = data.messages || [];
        const lastMsg = messages.length > 0 ? messages[messages.length - 1].content : '';

        // Detecta se houve agendamento concluído nas mensagens
        let status = LEAD_STATUS.EM_ATENDIMENTO;
        let appointment = null;

        const bookingMsg = messages.find(m => m.role === 'assistant' && (m.content.includes('Já reservei') || m.content.includes('Google Calendar') || m.content.includes('visita') || m.content.includes('agendado')));
        if (bookingMsg) {
          if (bookingMsg.content.includes('instalação das 4 câmeras') || bookingMsg.content.includes('Instalação')) {
            status = LEAD_STATUS.INSTALACAO_FECHADA;
          } else {
            status = LEAD_STATUS.VISITA_MARCADA;
          }
        }

        leadsStore.set(jid, {
          jid,
          phone,
          formattedPhone: formatPhone(phone),
          name: pushName,
          status,
          statusLabel: getStatusLabel(status),
          lastMessage: lastMsg,
          appointment: appointment,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          notes: ''
        });
      }
      saveLeads();
    }
  } catch (e) {
    console.warn('[LeadsCRM] Aviso ao inicializar CRM:', e.message);
  }
}

function saveLeads() {
  try {
    const obj = {};
    for (const [k, v] of leadsStore.entries()) {
      obj[k] = v;
    }
    fs.writeFileSync(leadsFile, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) {
    console.warn('[LeadsCRM] Erro ao salvar leads:', e.message);
  }
}

function getStatusLabel(status) {
  switch (status) {
    case LEAD_STATUS.VISITA_MARCADA:
      return 'Visita Técnica Agendada';
    case LEAD_STATUS.INSTALACAO_FECHADA:
      return 'Fechado para Instalação';
    case LEAD_STATUS.RECUSADO:
      return 'Fora de Escopo / Cancelado';
    case LEAD_STATUS.EM_ATENDIMENTO:
    default:
      return 'Em Atendimento / Sondagem';
  }
}

/**
 * Registra ou atualiza a interação de um cliente
 */
function recordClientInteraction({ jid, phone, name, incomingText }) {
  if (!jid) return;
  const cleanPhone = phone || jid.split('@')[0];

  if (!leadsStore.has(jid)) {
    leadsStore.set(jid, {
      jid,
      phone: cleanPhone,
      formattedPhone: formatPhone(cleanPhone),
      name: name || cleanPhone,
      status: LEAD_STATUS.EM_ATENDIMENTO,
      statusLabel: getStatusLabel(LEAD_STATUS.EM_ATENDIMENTO),
      lastMessage: incomingText || '',
      appointment: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      notes: ''
    });
  } else {
    const lead = leadsStore.get(jid);
    if (name && name !== cleanPhone && (!lead.name || lead.name === cleanPhone)) {
      lead.name = name;
    }
    if (incomingText) {
      lead.lastMessage = incomingText;
    }
    lead.updatedAt = new Date().toISOString();
  }

  saveLeads();
}

/**
 * Registra a confirmação de agendamento (Visita Técnica ou Instalação Fechada)
 */
function recordAppointment({ jid, clientName, phone, appointmentType, date, time, address, notes, eventLink, eventId, serviceType }) {
  const targetJid = jid || (phone ? `${phone}@s.whatsapp.net` : '');
  if (!targetJid) return;
  const cleanPhone = phone || targetJid.split('@')[0];

  const isInstallation = (appointmentType === 'INSTALACAO_CFTV') ||
    (serviceType && (serviceType.toLowerCase().includes('instalação') || serviceType.toLowerCase().includes('instalacao')));

  const status = isInstallation ? LEAD_STATUS.INSTALACAO_FECHADA : LEAD_STATUS.VISITA_MARCADA;

  if (!leadsStore.has(targetJid)) {
    leadsStore.set(targetJid, {
      jid: targetJid,
      phone: cleanPhone,
      formattedPhone: formatPhone(cleanPhone),
      name: clientName || cleanPhone,
      status,
      statusLabel: getStatusLabel(status),
      lastMessage: isInstallation ? 'Instalação de Câmeras Agendada' : 'Visita Técnica Agendada',
      appointment: {
        type: isInstallation ? 'INSTALACAO_CFTV' : 'VISITA_TECNICA',
        date,
        time,
        address: address || 'Endereço a confirmar',
        notes: notes || '',
        eventLink: eventLink || '',
        eventId: eventId || '',
        serviceType: serviceType || (isInstallation ? 'Instalação de Câmeras' : 'Visita Técnica Gratuita'),
        bookedAt: new Date().toISOString()
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      notes: notes || ''
    });
  } else {
    const lead = leadsStore.get(targetJid);
    lead.status = status;
    lead.statusLabel = getStatusLabel(status);
    if (clientName && clientName !== cleanPhone) lead.name = clientName;
    lead.appointment = {
      type: isInstallation ? 'INSTALACAO_CFTV' : 'VISITA_TECNICA',
      date,
      time,
      address: address || lead.appointment?.address || 'Endereço a confirmar',
      notes: notes || lead.appointment?.notes || '',
      eventLink: eventLink || lead.appointment?.eventLink || '',
      eventId: eventId || lead.appointment?.eventId || '',
      serviceType: serviceType || (isInstallation ? 'Instalação de Câmeras' : 'Visita Técnica Gratuita'),
      bookedAt: new Date().toISOString()
    };
    lead.updatedAt = new Date().toISOString();
  }

  saveLeads();
  console.log(`[LeadsCRM] Lead ${clientName} (${cleanPhone}) atualizado para: ${getStatusLabel(status)} [${date} às ${time}]`);
}

/**
 * Atualiza status e observações de um lead manualmente pelo painel
 */
function updateLeadStatus(jid, newStatus, notes = null, clientName = null) {
  if (!leadsStore.has(jid)) {
    const phone = jid.split('@')[0];
    leadsStore.set(jid, {
      jid,
      phone,
      formattedPhone: formatPhone(phone),
      name: clientName || phone,
      status: newStatus || LEAD_STATUS.EM_ATENDIMENTO,
      statusLabel: getStatusLabel(newStatus || LEAD_STATUS.EM_ATENDIMENTO),
      lastMessage: '',
      appointment: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      notes: notes || ''
    });
  }

  const lead = leadsStore.get(jid);
  if (newStatus && LEAD_STATUS[newStatus]) {
    lead.status = newStatus;
    lead.statusLabel = getStatusLabel(newStatus);
  }
  if (notes !== null && notes !== undefined) {
    lead.notes = notes;
  }
  if (clientName) {
    lead.name = clientName;
  }
  lead.updatedAt = new Date().toISOString();

  saveLeads();
  return { success: true, lead };
}

/**
 * Retorna todos os dados consolidados do painel de clientes atendidos e métricas
 */
function getDashboardMetrics() {
  const leads = Array.from(leadsStore.values());

  const totalClients = leads.length;
  const visitasMarcadas = leads.filter(l => l.status === LEAD_STATUS.VISITA_MARCADA).length;
  const instalacoesFechadas = leads.filter(l => l.status === LEAD_STATUS.INSTALACAO_FECHADA).length;
  const emAtendimento = leads.filter(l => l.status === LEAD_STATUS.EM_ATENDIMENTO).length;
  const recusados = leads.filter(l => l.status === LEAD_STATUS.RECUSADO).length;

  const convVisitas = totalClients > 0 ? ((visitasMarcadas / totalClients) * 100).toFixed(1) : '0.0';
  const convInstalacoes = totalClients > 0 ? ((instalacoesFechadas / totalClients) * 100).toFixed(1) : '0.0';

  // Ordena os leads por data de atualização decrescente
  leads.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

  return {
    metrics: {
      totalClients,
      visitasMarcadas,
      instalacoesFechadas,
      emAtendimento,
      recusados,
      convVisitas,
      convInstalacoes
    },
    leads
  };
}

/**
 * Obtém os dados de um lead pelo jid ou telefone
 */
function getLead(jid, phone) {
  const targetJid = jid || (phone ? `${phone}@s.whatsapp.net` : '');
  if (targetJid && leadsStore.has(targetJid)) {
    return leadsStore.get(targetJid);
  }
  if (phone) {
    const clean = phone.replace(/\D/g, '');
    for (const lead of leadsStore.values()) {
      if (lead.phone && lead.phone.replace(/\D/g, '').endsWith(clean.slice(-8))) {
        return lead;
      }
    }
  }
  return null;
}

/**
 * Cancela e desmarca o agendamento de um lead no CRM
 */
function cancelAppointment(jid, phone) {
  const targetJid = jid || (phone ? `${phone}@s.whatsapp.net` : '');
  let foundLead = null;

  if (targetJid && leadsStore.has(targetJid)) {
    foundLead = leadsStore.get(targetJid);
  } else if (phone) {
    const cleanPhone = phone.replace(/\D/g, '');
    for (const lead of leadsStore.values()) {
      if (lead.phone && lead.phone.replace(/\D/g, '').endsWith(cleanPhone.slice(-8))) {
        foundLead = lead;
        break;
      }
    }
  }

  let oldAppointment = null;
  if (foundLead) {
    oldAppointment = foundLead.appointment ? { ...foundLead.appointment } : null;
    foundLead.status = LEAD_STATUS.EM_ATENDIMENTO;
    foundLead.statusLabel = getStatusLabel(LEAD_STATUS.EM_ATENDIMENTO);
    foundLead.appointment = null;
    foundLead.lastMessage = 'Agendamento desmarcado pelo cliente';
    foundLead.updatedAt = new Date().toISOString();
    saveLeads();
    console.log(`[LeadsCRM] Agendamento do lead ${foundLead.name} (${foundLead.phone}) cancelado no CRM.`);
  }

  return { success: true, lead: foundLead, oldAppointment };
}

// Inicializa ao carregar módulo
initCrm();

/**
 * Remove um lead do CRM (usado na limpeza de dados de teste/homologação).
 */
function removeLead(jid) {
  const existed = leadsStore.delete(jid);
  if (existed) saveLeads();
  return existed;
}

module.exports = {
  removeLead,
  LEAD_STATUS,
  initCrm,
  recordClientInteraction,
  recordAppointment,
  cancelAppointment,
  getLead,
  updateLeadStatus,
  getDashboardMetrics,
  formatPhone
};
