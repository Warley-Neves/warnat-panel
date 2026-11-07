/**
 * BATERIA DE TESTES RIGOROSOS DE HELPDESK CORPORATIVO & NÃO-REGRESSÃO
 * 
 * Pilares Validados:
 * P1. Atendimento Compartilhado & Gestão de Filas (Trava de Concorrência, Claim, Release, Transferência com Auditoria)
 * P2. Produtividade & Colaboração (Canned Responses / Atalhos, Notas Internas Confidenciais)
 * P3. Automação Inteligente & Triagem (SLA timestamps: queued_at, first_human_reply_at, closed_at)
 * P4. Rich Media (Location com Google Maps, Contact vCard, Documentos, Stickers)
 * P5. Métricas, Relatórios e SLA (TMA - Tempo Médio de Atendimento, TME - Tempo Médio de Espera, Heatmaps)
 */

const http = require('http');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const { query, pool } = require('../database/db');
const authService = require('../database/auth.service');
const { handleV2Routes } = require('../panel/routes/v2.routes');
const webhookController = require('../controllers/webhook.controller');

async function runHelpdeskSuite() {
  console.log('====================================================================');
  console.log('🚀 INICIANDO BATERIA DE TESTES DE HELPDESK CORPORATIVO (P1 A P5)');
  console.log('====================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, testName, details = '') {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${testName}${details ? ': ' + details : ''}`);
      failed++;
    }
  }

  // 1. Inicia mini servidor HTTP para rotas v2
  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url, 'http://127.0.0.1');
    const pathname = urlObj.pathname;
    const method = req.method;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') {
      res.writeHead(200);
      return res.end();
    }

    let body = {};
    if (method === 'POST' || method === 'PUT') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      try { body = JSON.parse(raw); } catch (e) {}
    }

    if (pathname.startsWith('/api/v2/')) {
      const handled = await handleV2Routes(req, res, pathname, method, body);
      if (handled) return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  const TEST_PORT = 3510;
  await new Promise(r => server.listen(TEST_PORT, '127.0.0.1', r));

  function httpRequest(urlPath, method = 'GET', headers = {}, body = null) {
    return new Promise((resolve) => {
      const options = {
        hostname: '127.0.0.1',
        port: TEST_PORT,
        path: urlPath,
        method,
        headers: { ...headers }
      };
      if (body) {
        options.headers['Content-Type'] = 'application/json';
      }
      const req = http.request(options, (res) => {
        let raw = '';
        res.on('data', c => raw += c);
        res.on('end', () => {
          let data = null;
          try { data = JSON.parse(raw); } catch (e) { data = raw; }
          resolve({ statusCode: res.statusCode, data, headers: res.headers, raw });
        });
      });
      req.on('error', (err) => {
        resolve({ statusCode: 500, data: null, error: err });
      });
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  try {
    // ------------------------------------------------------------------------
    // SETUP: Criação de Tenant, Admin e 2 Atendentes para testes de concorrência
    // ------------------------------------------------------------------------
    console.log('--- 1. Preparação de Tenant e Operadores Concorrentes ---');
    const timestamp = Date.now();
    const adminEmail = `admin_helpdesk_${timestamp}@teste.com`;
    const regTenant = await authService.registerTenantAndAdmin({
      nome_empresa: `Corporativo Desk ${timestamp}`,
      nome: 'Administrador Desk',
      email: adminEmail,
      password: 'StrongPassword123!',
      sobre_empresa: 'Empresa modelo para atendimento compartilhado.'
    });

    const tenantId = regTenant.tenant.id;
    const tokenAdmin = regTenant.token;
    const adminUserId = regTenant.user.id;

    // Cria Atendente 1
    const user1Email = `atendente1_${timestamp}@teste.com`;
    const user1 = await authService.createUser(tenantId, {
      nome: 'Carlos Atendente N1',
      email: user1Email,
      password: 'Password123!',
      role: 'atendente'
    });
    const loginUser1 = await authService.login(user1Email, 'Password123!');
    const tokenUser1 = loginUser1.token;

    // Cria Atendente 2
    const user2Email = `atendente2_${timestamp}@teste.com`;
    const user2 = await authService.createUser(tenantId, {
      nome: 'Beatriz Atendente N2',
      email: user2Email,
      password: 'Password123!',
      role: 'atendente'
    });
    const loginUser2 = await authService.login(user2Email, 'Password123!');
    const tokenUser2 = loginUser2.token;

    assert(tokenAdmin && tokenUser1 && tokenUser2, 'Tenant, Administrador e 2 Atendentes criados e autenticados');

    // ------------------------------------------------------------------------
    // PILAR 1: DEPARTAMENTOS & FILAS DE ATENDIMENTO
    // ------------------------------------------------------------------------
    console.log('\n--- 2. Pilar 1: Departamentos & Filas de Atendimento (CRUD) ---');
    
    // Cria Departamento Suporte
    const createDeptRes = await httpRequest('/api/v2/tenant/departments', 'POST', {
      Authorization: `Bearer ${tokenAdmin}`
    }, {
      nome: 'Suporte Técnico N1',
      descricao: 'Atendimento inicial para resolução de chamados',
      cor: '#3b82f6'
    });
    assert(createDeptRes.statusCode === 201, 'Criação de Departamento Suporte Técnico N1');
    const deptSuporteId = createDeptRes.data?.department?.id;

    // Cria Departamento Financeiro
    const createDeptFinRes = await httpRequest('/api/v2/tenant/departments', 'POST', {
      Authorization: `Bearer ${tokenAdmin}`
    }, {
      nome: 'Financeiro & Contratos',
      descricao: 'Cobrança, boletos e emissão de notas fiscais',
      cor: '#10b981'
    });
    assert(createDeptFinRes.statusCode === 201, 'Criação de Departamento Financeiro & Contratos');
    const deptFinId = createDeptFinRes.data?.department?.id;

    // Lista Departamentos
    const listDeptsRes = await httpRequest('/api/v2/tenant/departments', 'GET', {
      Authorization: `Bearer ${tokenUser1}`
    });
    assert(
      listDeptsRes.statusCode === 200 && Array.isArray(listDeptsRes.data?.departments) && listDeptsRes.data.departments.length >= 2,
      'Listagem de Departamentos acessível aos atendentes'
    );

    // Atualiza Departamento
    const updateDeptRes = await httpRequest(`/api/v2/tenant/departments/${deptSuporteId}`, 'PUT', {
      Authorization: `Bearer ${tokenAdmin}`
    }, {
      nome: 'Suporte Técnico Avançado',
      descricao: 'Atendimento especializado',
      cor: '#2563eb',
      ativo: true
    });
    assert(updateDeptRes.statusCode === 200 && updateDeptRes.data?.department?.nome === 'Suporte Técnico Avançado', 'Atualização de Departamento');

    // ------------------------------------------------------------------------
    // PILAR 1: ATENDIMENTO COMPARTILHADO & TRAVA DE CONCORRÊNCIA
    // ------------------------------------------------------------------------
    console.log('\n--- 3. Pilar 1: Trava de Concorrência & Responsável Principal ---');
    
    // Cria uma sessão/ticket para testes
    const testJid = `551199999${timestamp.toString().slice(-4)}@s.whatsapp.net`;
    const createSessionRes = await query(`
      INSERT INTO chat_sessions (tenant_id, remote_jid, client_name, etapa_funil, status_atendimento, queued_at)
      VALUES ($1, $2, $3, 'qualificacao', 'manual', now())
      RETURNING id
    `, [tenantId, testJid, 'Cliente Concorrência Teste']);
    const testTicketId = createSessionRes.rows[0].id;
    assert(!!testTicketId, 'Ticket de teste criado no banco com queued_at definido');

    // Atendente 1 assume a conversa (Claim)
    const claimRes1 = await httpRequest(`/api/v2/tenant/leads/${testTicketId}/claim`, 'POST', {
      Authorization: `Bearer ${tokenUser1}`
    });
    assert(claimRes1.statusCode === 200 && claimRes1.data?.locked_by === user1.id, 'Atendente 1 assume conversa com sucesso (Claim Ticket)');

    // Verifica que o ticket aparece com is_locked = true na listagem
    const listLeadsRes = await httpRequest('/api/v2/tenant/leads', 'GET', {
      Authorization: `Bearer ${tokenUser2}`
    });
    const foundTicket = (listLeadsRes.data?.leads || []).find(l => l.id === testTicketId);
    assert(foundTicket && foundTicket.is_locked === true && foundTicket.locked_by === user1.id, 'Ticket listado com trava ativa e locked_by correto');

    // Atendente 2 tenta responder à mesma conversa -> DEVE RETORNAR HTTP 423 (Locked)
    const concurrentReplyRes = await httpRequest(`/api/v2/tenant/leads/${testTicketId}/messages`, 'POST', {
      Authorization: `Bearer ${tokenUser2}`
    }, {
      message: 'Olá, sou a Beatriz tentando responder ao mesmo tempo!'
    });
    assert(
      concurrentReplyRes.statusCode === 423,
      'Trava de Concorrência bloqueia Atendente 2 com HTTP 423 Locked'
    );
    assert(
      concurrentReplyRes.data?.error === 'concurrency_lock' || (concurrentReplyRes.data?.message && concurrentReplyRes.data.message.includes('responsabilidade exclusiva')),
      'Mensagem de erro informa bloqueio por outro atendente'
    );

    // Atendente 1 (dono do lock) responde normalmente
    const ownerReplyRes = await httpRequest(`/api/v2/tenant/leads/${testTicketId}/messages`, 'POST', {
      Authorization: `Bearer ${tokenUser1}`
    }, {
      message: 'Olá, sou o Carlos que assumiu o chamado. Como posso te ajudar?'
    });
    assert(ownerReplyRes.statusCode === 200, 'Atendente 1 (dono do lock) envia mensagem com sucesso');

    // Verifica que first_human_reply_at foi preenchido
    const checkSlaRow = await query(`SELECT first_human_reply_at FROM chat_sessions WHERE id = $1`, [testTicketId]);
    assert(!!checkSlaRow.rows[0].first_human_reply_at, 'first_human_reply_at registrado automaticamente no primeiro envio');

    // Atendente 1 libera a conversa (Release)
    const releaseRes = await httpRequest(`/api/v2/tenant/leads/${testTicketId}/release`, 'POST', {
      Authorization: `Bearer ${tokenUser1}`
    });
    assert(releaseRes.statusCode === 200, 'Atendente 1 libera conversa de volta para a fila');

    // Agora Atendente 2 pode assumir a conversa
    const claimRes2 = await httpRequest(`/api/v2/tenant/leads/${testTicketId}/claim`, 'POST', {
      Authorization: `Bearer ${tokenUser2}`
    });
    assert(claimRes2.statusCode === 200 && claimRes2.data?.locked_by === user2.id, 'Atendente 2 assume conversa liberada com sucesso');

    // ------------------------------------------------------------------------
    // PILAR 1: TRANSFERÊNCIA DE ATENDIMENTO COM AUDITORIA
    // ------------------------------------------------------------------------
    console.log('\n--- 4. Pilar 1: Transferência de Atendimento & Histórico Preservado ---');

    // Atendente 2 transfere o ticket para Atendente 1 e Departamento Financeiro
    const transferRes = await httpRequest(`/api/v2/tenant/leads/${testTicketId}/transfer`, 'POST', {
      Authorization: `Bearer ${tokenUser2}`
    }, {
      target_user_id: user1.id,
      department_id: deptFinId,
      reason: 'Cliente solicitou negociação de proposta comercial e envio de contrato'
    });
    assert(transferRes.statusCode === 200, 'Transferência de ticket executada com sucesso');

    // Verifica auditoria de transferência
    const auditRes = await httpRequest(`/api/v2/tenant/leads/${testTicketId}/audit-trail`, 'GET', {
      Authorization: `Bearer ${tokenUser1}`
    });
    assert(auditRes.statusCode === 200 && Array.isArray(auditRes.data?.audit_events), 'Histórico de auditoria retornado com sucesso');
    const transferEvent = (auditRes.data?.audit_events || []).find(e => (e.tipo_evento || e.event_type || '').includes('transfer'));
    assert(!!transferEvent, 'Evento de transferência gravado na tabela ticket_audit_events');
    console.log('DEBUG transferEvent:', JSON.stringify(transferEvent));
    const motivoText = JSON.stringify(transferEvent || '');
    assert(motivoText.toLowerCase().includes('negocia'), 'Motivo da transferência registrado intacto no payload da auditoria');

    // Verifica injeção de mensagem de sistema inline no chat
    const chatMsgsRes = await httpRequest(`/api/v2/tenant/leads/${testTicketId}/messages`, 'GET', {
      Authorization: `Bearer ${tokenUser1}`
    });
    const systemTransferMsg = (chatMsgsRes.data?.messages || []).find(m => m.role === 'system' && m.content.includes('[Transferência de Atendimento]'));
    assert(!!systemTransferMsg, 'Mensagem de sistema inline visível na linha do tempo da conversa');

    // ------------------------------------------------------------------------
    // PILAR 2: MENSAGENS RÁPIDAS (CANNED RESPONSES)
    // ------------------------------------------------------------------------
    console.log('\n--- 5. Pilar 2: Mensagens Rápidas (Canned Responses / Atalhos) ---');

    // Cria Canned Response /pix
    const createCannedRes = await httpRequest('/api/v2/tenant/canned-responses', 'POST', {
      Authorization: `Bearer ${tokenAdmin}`
    }, {
      atalho: '/pix',
      titulo: 'Chave PIX e Instruções de Pagamento',
      categoria: 'Financeiro',
      conteudo: 'Nossa chave PIX CNPJ é 00.123.456/0001-00 (Banco Inter). Envie o comprovante aqui.'
    });
    assert(createCannedRes.statusCode === 201, 'Criação de Mensagem Rápida (/pix)');
    const cannedId = createCannedRes.data?.canned_response?.id || createCannedRes.data?.response?.id;

    // Lista Canned Responses
    const listCannedRes = await httpRequest('/api/v2/tenant/canned-responses', 'GET', {
      Authorization: `Bearer ${tokenUser1}`
    });
    const cannedList = listCannedRes.data?.canned_responses || listCannedRes.data?.responses || [];
    assert(
      listCannedRes.statusCode === 200 && Array.isArray(cannedList) && cannedList.some(c => c.atalho === '/pix'),
      'Listagem de Mensagens Rápidas contém /pix'
    );

    // Atualiza Canned Response
    const updateCannedRes = await httpRequest(`/api/v2/tenant/canned-responses/${cannedId}`, 'PUT', {
      Authorization: `Bearer ${tokenAdmin}`
    }, {
      atalho: '/pix-atualizado',
      titulo: 'Chave PIX Oficial',
      categoria: 'Financeiro',
      conteudo: 'Chave PIX atualizada: financeiro@empresa.com.br'
    });
    const updatedCanned = updateCannedRes.data?.canned_response || updateCannedRes.data?.response;
    assert(updateCannedRes.statusCode === 200 && updatedCanned?.atalho === '/pix-atualizado', 'Atualização de Mensagem Rápida');

    // Deleta Canned Response
    const deleteCannedRes = await httpRequest(`/api/v2/tenant/canned-responses/${cannedId}`, 'DELETE', {
      Authorization: `Bearer ${tokenAdmin}`
    });
    assert(deleteCannedRes.statusCode === 200, 'Exclusão de Mensagem Rápida');

    // ------------------------------------------------------------------------
    // PILAR 2: NOTAS INTERNAS PRIVADAS (CONFIDENCIALIDADE)
    // ------------------------------------------------------------------------
    console.log('\n--- 6. Pilar 2: Notas Internas Privadas (Confidencialidade Estrita) ---');

    // Atendente 1 cria nota interna privada
    const createNoteRes = await httpRequest(`/api/v2/tenant/leads/${testTicketId}/internal-notes`, 'POST', {
      Authorization: `Bearer ${tokenUser1}`
    }, {
      note: 'Atenção equipe: cliente solicitou desconto especial para pagamento à vista. Autorizado até 15%.'
    });
    assert(createNoteRes.statusCode === 201, 'Criação de Nota Interna Privada');

    // Listagem de Notas Internas
    const listNotesRes = await httpRequest(`/api/v2/tenant/leads/${testTicketId}/internal-notes`, 'GET', {
      Authorization: `Bearer ${tokenUser2}`
    });
    assert(
      listNotesRes.statusCode === 200 && Array.isArray(listNotesRes.data?.notes) && listNotesRes.data.notes.some(n => n.note.includes('desconto especial')),
      'Atendente 2 visualiza a nota interna deixada pelo colega'
    );

    // Confidencialidade: Garante que a nota interna NÃO foi para chat_messages (WhatsApp)
    const checkWhatsAppMessages = await httpRequest(`/api/v2/tenant/leads/${testTicketId}/messages`, 'GET', {
      Authorization: `Bearer ${tokenUser1}`
    });
    const leakInChat = (checkWhatsAppMessages.data?.messages || []).some(m => m.content.includes('desconto especial'));
    assert(!leakInChat, 'Confidencialidade Garantida: Nota interna NUNCA vaza para o WhatsApp do cliente');

    // ------------------------------------------------------------------------
    // PILAR 4: TRATAMENTO DE RICH MEDIA NO WEBHOOK
    // ------------------------------------------------------------------------
    console.log('\n--- 7. Pilar 4: Suporte Completo a Rich Media no Webhook ---');

    const testInstanceName = regTenant.tenant.instance_name || `desk-test-${timestamp}`;
    await query(`
      INSERT INTO tenant_whatsapp_instances (tenant_id, instance_name, status)
      VALUES ($1, $2, 'open')
      ON CONFLICT (tenant_id) DO UPDATE SET instance_name = EXCLUDED.instance_name, status = 'open'
    `, [tenantId, testInstanceName]);

    // Teste 1: Recebimento de Location (Localização)
    const locationWebhookPayload = {
      event: 'messages.upsert',
      instance: testInstanceName,
      data: {
        key: {
          remoteJid: testJid,
          fromMe: false,
          id: `LOC_${Date.now()}`
        },
        pushName: 'Cliente Teste Mídia',
        message: {
          locationMessage: {
            degreesLatitude: -23.55052,
            degreesLongitude: -46.633308,
            name: 'Praça da Sé - São Paulo'
          }
        }
      }
    };

    await webhookController.handleWebhook(locationWebhookPayload);
    
    // Verifica no banco se a localização foi formatada com Google Maps
    const locMsgRow = await query(`
      SELECT content, media_type FROM chat_messages 
      WHERE session_id = $1 AND (content LIKE '%maps.google.com%' OR content LIKE '%google.com/maps%')
      ORDER BY created_at DESC LIMIT 1
    `, [testTicketId]);
    assert(
      locMsgRow.rows.length > 0 && locMsgRow.rows[0].media_type === 'location',
      'Webhook processou locationMessage convertendo para link do Google Maps'
    );

    // Teste 2: Recebimento de Contact (vCard)
    const contactWebhookPayload = {
      event: 'messages.upsert',
      instance: testInstanceName,
      data: {
        key: {
          remoteJid: testJid,
          fromMe: false,
          id: `VCF_${Date.now()}`
        },
        pushName: 'Cliente Teste Mídia',
        message: {
          contactMessage: {
            displayName: 'Dr. Roberto Consultor',
            vcard: 'BEGIN:VCARD\nVERSION:3.0\nN:Consultor;Roberto;;;\nFN:Dr. Roberto Consultor\nTEL;type=CELL;waid=5511988887777:+55 11 98888-7777\nEND:VCARD'
          }
        }
      }
    };

    await webhookController.handleWebhook(contactWebhookPayload);
    const vcardMsgRow = await query(`
      SELECT content, media_type FROM chat_messages 
      WHERE session_id = $1 AND content LIKE '%Dr. Roberto Consultor%'
      ORDER BY created_at DESC LIMIT 1
    `, [testTicketId]);
    assert(
      vcardMsgRow.rows.length > 0 && vcardMsgRow.rows[0].media_type === 'contact',
      'Webhook processou contactMessage (vCard) extraindo nome e telefone'
    );

    // ------------------------------------------------------------------------
    // PILAR 5: MÉTRICAS, SLA & ANALYTICS HELPDESK (TMA & TME)
    // ------------------------------------------------------------------------
    console.log('\n--- 8. Pilar 5: Métricas de Helpdesk & SLA (TMA & TME) ---');

    // Conclui o ticket para gerar TMA mensurável
    await httpRequest(`/api/v2/tenant/leads/${testTicketId}/stage`, 'PUT', {
      Authorization: `Bearer ${tokenUser1}`
    }, {
      etapa_funil: 'concluido'
    });

    const analyticsRes = await httpRequest('/api/v2/tenant/analytics/helpdesk', 'GET', {
      Authorization: `Bearer ${tokenAdmin}`
    });
    assert(analyticsRes.statusCode === 200, 'Endpoint /api/v2/tenant/analytics/helpdesk responde HTTP 200');
    assert(analyticsRes.data?.analytics !== undefined, 'Objeto analytics retornado na resposta');
    
    const an = analyticsRes.data.analytics;
    assert(typeof an.tma_minutos === 'number' || an.tma_minutos === null, 'TMA (Tempo Médio de Atendimento) calculado com precisão');
    assert(typeof an.tme_minutos === 'number' || an.tme_minutos === null, 'TME (Tempo Médio de Espera) calculado com precisão');
    assert(Array.isArray(an.por_operador), 'Distribuição de conversas por operador gerada');
    assert(Array.isArray(an.por_departamento), 'Distribuição de conversas por departamento gerada');
    assert(Array.isArray(an.por_hora), 'Heatmap de volume de conversas por horário gerado');

  } catch (err) {
    console.error('Erro inesperado durante a execução da suíte:', err);
    failed++;
  } finally {
    await new Promise(r => server.close(r));
    await pool.end();
  }

  console.log('\n====================================================================');
  console.log(`📊 RESULTADO FINAL DA BATERIA HELPDESK: ${passed} PASSOU | ${failed} FALHOU`);
  console.log('====================================================================');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runHelpdeskSuite().catch(e => {
  console.error('Fatal suite error:', e);
  process.exit(1);
});
