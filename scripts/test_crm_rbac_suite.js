// ==============================================================================
// TEST SUITE: CRM AVANÇADO, DASHBOARD, ATENDIMENTO MANUAL & RBAC
// ==============================================================================

const http = require('http');
const { query } = require('../database/db');
const authService = require('../database/auth.service');
const { handleV2Routes } = require('../panel/routes/v2.routes');

function request(port, path, method = 'GET', body = null, token = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
      }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runCrmRbacSuite() {
  console.log('================================================================');
  console.log('🚀 INICIANDO TESTES DO CRM, DASHBOARD, CHAT MANUAL & RBAC');
  console.log('================================================================\n');

  let passed = 0;
  let total = 0;
  function assert(cond, name, details) {
    total++;
    if (cond) {
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${name}${details ? ': ' + details : ''}`);
      throw new Error(`Falha no teste: ${name}`);
    }
  }

  // 1. Inicia servidor temporário para testar rotas v2
  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url, 'http://127.0.0.1');
    let body = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      try { body = JSON.parse(raw); } catch (e) {}
    }
    const handled = await handleV2Routes(req, res, urlObj.pathname, req.method, body);
    if (!res.writableEnded && !handled) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  await new Promise(r => server.listen(3499, '127.0.0.1', r));
  console.log('📡 Servidor de testes rodando na porta 3499.\n');

  try {
    // 2. Cria Tenant e Usuário Admin de teste
    const testAdminEmail = `admin_crm_${Date.now()}@testcrm.com`;
    const regRes = await authService.registerTenantAndAdmin({
      nome_empresa: 'Empresa Teste CRM & RBAC',
      nome: 'Administrador CRM',
      email: testAdminEmail,
      password: 'AdminPassword123!',
      sobre_empresa: 'Empresa com CRM avançado e atendimento manual.'
    });

    const tenantId = regRes.tenant.id;
    const adminToken = regRes.token;
    assert(!!adminToken, 'Tenant e Administrador criados com sucesso');

    // 3. Testa Configuração de Horários Comerciais e Agendamento (PUT /api/v2/tenant/ai-config)
    const aiConfigRes = await request(3499, '/api/v2/tenant/ai-config', 'PUT', {
      tom_de_voz: 'consultivo_especialista',
      pausa_automatica_minutos: 60,
      whatsapp_notificacao_humana: '5531983525816',
      sobre_empresa: 'Especialistas em CFTV com agenda organizada.',
      servicos_oferecidos: ['CFTV Full HD', 'Manutenção DVR'],
      regras_agendamento: {
        horario_inicio: '08:30',
        horario_fim: '18:30',
        dias_atendimento: ['segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'],
        slots_agendamento: ['08:30', '10:30', '13:30', '15:30', '17:30'],
        politica_agendamento: 'Visita técnica gratuita para instalações novas.'
      }
    }, adminToken);

    assert(aiConfigRes.status === 200 && aiConfigRes.data.success, 'Regras de IA e Horários salvos com sucesso via API');

    // 4. Criação de Atendimento Manual (POST /api/v2/tenant/leads/manual)
    const manualLeadRes = await request(3499, '/api/v2/tenant/leads/manual', 'POST', {
      phone: '31987654321',
      name: 'Cliente Manual Teste',
      servico: 'Instalação de 4 Câmeras',
      urgencia: 'alta',
      initialMessage: 'Olá! Sou o atendente humano da empresa. Como posso te ajudar?',
      etapa_funil: 'manual'
    }, adminToken);

    assert(manualLeadRes.status === 201 && manualLeadRes.data.success, 'Atendimento manual criado com sucesso');
    const sessionId = manualLeadRes.data.sessionId;

    // 5. Consulta Dashboard & Leads (GET /api/v2/tenant/leads)
    const leadsRes = await request(3499, '/api/v2/tenant/leads', 'GET', null, adminToken);
    assert(leadsRes.status === 200 && Array.isArray(leadsRes.data.leads), 'Listagem de leads do CRM retornou com sucesso');
    assert(leadsRes.data.leads.length >= 1, 'Atendimento manual listado no CRM');
    assert(leadsRes.data.stats && leadsRes.data.stats.total >= 1, 'Dashboard KPIs calculados com sucesso');
    assert(leadsRes.data.leads[0].etapa_funil === 'manual', 'Lead está na etapa "manual" do funil');

    // 6. Envio de Mensagem Manual pelo Chat do Painel (POST /api/v2/tenant/leads/:id/messages)
    const sendMsgRes = await request(3499, `/api/v2/tenant/leads/${sessionId}/messages`, 'POST', {
      message: 'Verifiquei aqui e temos vaga no sábado às 10:30. Fica bom para você?'
    }, adminToken);

    assert(sendMsgRes.status === 200 && sendMsgRes.data.success, 'Mensagem manual enviada pelo operador registrada no histórico');

    // 7. Atualização da Etapa do Funil (PUT /api/v2/tenant/leads/:id/stage)
    const stageRes = await request(3499, `/api/v2/tenant/leads/${sessionId}/stage`, 'PUT', {
      etapa_funil: 'agendado'
    }, adminToken);

    assert(stageRes.status === 200 && stageRes.data.success, 'Lead movido com sucesso para a etapa "agendado"');

    // 8. Gestão de Equipe & RBAC: Cadastro de Atendente pelo Admin (POST /api/v2/tenant/users)
    const atendenteEmail = `atendente_${Date.now()}@testcrm.com`;
    const createAtendenteRes = await request(3499, '/api/v2/tenant/users', 'POST', {
      nome: 'Mariana Atendente',
      email: atendenteEmail,
      password: 'AtendentePass123!',
      role: 'atendente'
    }, adminToken);

    if (createAtendenteRes.status !== 201) {
      console.log('DEBUG createAtendenteRes:', createAtendenteRes.status, createAtendenteRes.data);
    }

    assert(createAtendenteRes.status === 201 && createAtendenteRes.data.success, 'Atendente cadastrado com sucesso pelo Administrador');
    const atendenteId = createAtendenteRes.data.user.id;

    // 9. Login como Atendente
    const loginAtendente = await authService.login(atendenteEmail, 'AtendentePass123!');
    const atendenteToken = loginAtendente.token;
    assert(loginAtendente.user.role === 'atendente', 'Login autenticado com cargo "atendente"');

    // 10. Teste de RBAC: Atendente NÃO pode criar usuários
    const forbiddenUserCreate = await request(3499, '/api/v2/tenant/users', 'POST', {
      nome: 'Tentativa Invalida',
      email: 'hacker@teste.com',
      password: '123456Password!',
      role: 'admin'
    }, atendenteToken);

    assert(forbiddenUserCreate.status === 403, 'RBAC Bloqueio: Atendente impedido de criar novos usuários (403 Forbidden)');

    // 11. Teste de RBAC: Atendente NÃO pode alterar regras de IA
    const forbiddenAiChange = await request(3499, '/api/v2/tenant/ai-config', 'PUT', {
      tom_de_voz: 'amigavel_e_caloroso'
    }, atendenteToken);

    assert(forbiddenAiChange.status === 403, 'RBAC Bloqueio: Atendente impedido de alterar regras da IA (403 Forbidden)');

    // 12. Teste de RBAC: Atendente PODE acessar o CRM e responder mensagens
    const atendenteLeads = await request(3499, '/api/v2/tenant/leads', 'GET', null, atendenteToken);
    assert(atendenteLeads.status === 200 && atendenteLeads.data.leads.length >= 1, 'RBAC Permissão: Atendente tem acesso operacional ao CRM');

    // 13. Admin atualiza status do Atendente (Desativar) (PUT /api/v2/tenant/users/:id)
    const updateUserRes = await request(3499, `/api/v2/tenant/users/${atendenteId}`, 'PUT', {
      ativo: false
    }, adminToken);

    assert(updateUserRes.status === 200 && updateUserRes.data.user.ativo === false, 'Administrador desativou membro da equipe com sucesso');

    // 14. Confirma que usuário desativado tem login bloqueado
    let blockedLogin = false;
    try {
      await authService.login(atendenteEmail, 'AtendentePass123!');
    } catch (e) {
      blockedLogin = true;
    }
    assert(blockedLogin, 'Login de usuário desativado bloqueado pelo sistema');

    // 15. Admin exclui o atendente (DELETE /api/v2/tenant/users/:id)
    const deleteUserRes = await request(3499, `/api/v2/tenant/users/${atendenteId}`, 'DELETE', null, adminToken);
    assert(deleteUserRes.status === 200 && deleteUserRes.data.success, 'Usuário removido da equipe com sucesso');

    // 16. Limpeza via cascade
    await query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    console.log('🧹 Dados de teste limpos via Cascade.\n');

    console.log('================================================================');
    console.log(`🎉 TODOS OS ${total} TESTES DE CRM & RBAC PASSARAM COM SUCESSO! (${passed}/${total})`);
    console.log('================================================================\n');

  } catch (err) {
    console.error('❌ Erro no teste:', err);
    throw err;
  } finally {
    server.close();
  }
}

if (require.main === module) {
  runCrmRbacSuite()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

module.exports = { runCrmRbacSuite };
