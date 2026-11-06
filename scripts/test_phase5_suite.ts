// ==============================================================================
// SAAS MULTI-TENANT ENGINE - PHASE 5 TEST SUITE (TYPESCRIPT)
// Comprehensive automated test verifying:
// 1. Auto-registration (POST /api/v2/auth/register)
// 2. Multi-tenant login & JWT protection (POST /api/v2/auth/login, GET /api/v2/auth/me)
// 3. WhatsApp connection status & QR Code routes (GET /api/v2/whatsapp/status)
// 4. AI Rules configuration read & update (GET/PUT /api/v2/tenant/ai-config)
// 5. CRM Leads table and interactive AI Pause/Resume switch (POST /api/v2/tenant/leads/toggle-ai)
// 6. Cumulative customer memory & appointments (GET /api/v2/tenant/customers)
// ==============================================================================

import http from 'http';
import { query, shutdownPool } from '../src/database/db';
import { handleV2Routes } from '../panel/routes/v2.routes';
import { CustomerService } from '../src/services/customer.service';

const TEST_PORT = 3299;

async function runPhase5Tests() {
  console.log('================================================================');
  console.log('🧪 INICIANDO BATERIA DE TESTES DE INTEGRAÇÃO - FASE 5 (TYPESCRIPT)');
  console.log('================================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function assert(condition: boolean, testName: string, details?: string) {
    totalTests++;
    if (condition) {
      console.log(`  ✅ [PASS] ${testName}`);
      passedTests++;
    } else {
      console.error(`  ❌ [FAIL] ${testName}${details ? `: ${details}` : ''}`);
      throw new Error(`Test failed: ${testName}`);
    }
  }

  // 1. Inicia servidor HTTP de teste para rotas da API v2
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${TEST_PORT}`);
    const pathname = url.pathname;
    const method = req.method || 'GET';

    let body: any = {};
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        body = {};
      }
    }

    try {
      const handled = await handleV2Routes(req, res, pathname, method, body);
      if (handled === false) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
      }
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  console.log(`📡 Servidor de teste da API v2 ouvindo na porta ${TEST_PORT}\n`);

  // Helper para requisições HTTP locais
  async function requestApi(endpoint: string, options: { method?: string; body?: any; token?: string } = {}) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };
    if (options.token) {
      headers['Authorization'] = `Bearer ${options.token}`;
    }

    const res = await fetch(`http://localhost:${TEST_PORT}${endpoint}`, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    const data: any = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, data };
  }

  let createdTenantId: string | null = null;

  try {
    // --------------------------------------------------------------------------
    // Teste 1: Auto-cadastro de Nova Empresa (POST /api/v2/auth/register)
    // --------------------------------------------------------------------------
    console.log('📋 Teste 1: Auto-cadastro de Empresa (POST /api/v2/auth/register)');
    const regEmail = `omega.${Date.now()}@telecom.com`;
    const regRes = await requestApi('/api/v2/auth/register', {
      method: 'POST',
      body: {
        nome_empresa: 'Omega Telecom & Segurança',
        documento: '44.555.666/0001-77',
        plano: 'start',
        nome: 'Marcos Diretor',
        email: regEmail,
        password: 'SenhaForteOmega123!',
        sobre_empresa: 'Especialistas em CFTV e cabeamento estruturado.'
      }
    });

    assert(regRes.status === 201, 'Endpoint de cadastro retorna status 201 (Created)');
    assert(Boolean(regRes.data?.token), 'Token JWT retornado no auto-cadastro');
    assert(regRes.data?.user?.email === regEmail, 'Dados do usuário administrador retornados');
    assert(regRes.data?.tenant?.nome_empresa === 'Omega Telecom & Segurança', 'Dados da empresa retornados');

    const authToken = regRes.data.token;
    createdTenantId = regRes.data.tenant.id;

    // --------------------------------------------------------------------------
    // Teste 2: Login com Credenciais (POST /api/v2/auth/login)
    // --------------------------------------------------------------------------
    console.log('\n📋 Teste 2: Autenticação Multi-Tenant (POST /api/v2/auth/login)');
    const loginRes = await requestApi('/api/v2/auth/login', {
      method: 'POST',
      body: {
        email: regEmail,
        password: 'SenhaForteOmega123!'
      }
    });

    assert(loginRes.status === 200, 'Login autenticado com status 200');
    assert(Boolean(loginRes.data?.token), 'Novo token JWT gerado');
    assert(loginRes.data?.user?.empresa === 'Omega Telecom & Segurança', 'Empresa do usuário retornada no login');

    // --------------------------------------------------------------------------
    // Teste 3: Contexto do Usuário Logado (GET /api/v2/auth/me)
    // --------------------------------------------------------------------------
    console.log('\n📋 Teste 3: Contexto do Usuário Logado (GET /api/v2/auth/me)');
    const meRes = await requestApi('/api/v2/auth/me', { token: authToken });
    assert(meRes.status === 200, 'Rota /api/v2/auth/me retorna 200');
    assert(meRes.data?.tenant?.nome_empresa === 'Omega Telecom & Segurança', 'Nome da empresa validado via token');
    assert(meRes.data?.user?.email === regEmail, 'E-mail do usuário validado via token');

    // --------------------------------------------------------------------------
    // Teste 4: Status do WhatsApp e Polling (GET /api/v2/whatsapp/status)
    // --------------------------------------------------------------------------
    console.log('\n📋 Teste 4: Conexão WhatsApp & Polling (GET /api/v2/whatsapp/status)');
    const wsStatusBefore = await requestApi('/api/v2/whatsapp/status', { token: authToken });
    assert(wsStatusBefore.status === 200, 'Status do WhatsApp retornado com sucesso');

    // Cadastra instância para o tenant
    const testInstName = `inst-omega-${Date.now()}`;
    await query(
      `INSERT INTO tenant_whatsapp_instances (tenant_id, instance_name, numero_telefone, status)
       VALUES ($1, $2, '5531988884321', 'connecting');`,
      [createdTenantId, testInstName]
    );

    const wsStatusAfter = await requestApi('/api/v2/whatsapp/status', { token: authToken });
    assert(wsStatusAfter.data?.configured === true, 'Instância detectada como configurada');
    assert(wsStatusAfter.data?.instanceName === testInstName, 'Nome da instância retornado');

    // --------------------------------------------------------------------------
    // Teste 5: Formulário de Regras de IA (GET / PUT /api/v2/tenant/ai-config)
    // --------------------------------------------------------------------------
    console.log('\n📋 Teste 5: Gestão das Regras da IA (GET & PUT /api/v2/tenant/ai-config)');
    const getAiRes = await requestApi('/api/v2/tenant/ai-config', { token: authToken });
    assert(getAiRes.status === 200, 'Configurações de IA recuperadas com sucesso');

    const updateAiRes = await requestApi('/api/v2/tenant/ai-config', {
      method: 'PUT',
      token: authToken,
      body: {
        tom_de_voz: 'consultivo_especialista',
        sobre_empresa: 'Líderes em tecnologia de segurança eletrônica residencial e corporativa.',
        servicos_oferecidos: ['CFTV IP 4K', 'Controle de Acesso Biométrico', 'Alarme Monitorado'],
        servicos_recusados: 'Conserto de eletrodomésticos e celulares.',
        regras_agendamento: { descricao: 'Atendimento de segunda a sábado das 08h às 18h.' },
        whatsapp_notificacao_humana: '5531999990000',
        pausa_automatica_minutos: 60
      }
    });

    assert(updateAiRes.status === 200, 'Configurações de IA salvas com status 200');

    // Valida persistência no banco
    const updatedAi = await requestApi('/api/v2/tenant/ai-config', { token: authToken });
    assert(updatedAi.data?.config?.tom_de_voz === 'consultivo_especialista', 'Tom de voz atualizado');
    assert(updatedAi.data?.config?.pausa_automatica_minutos === 60, 'Pausa automática atualizada para 60 min');
    assert(updatedAi.data?.config?.whatsapp_notificacao_humana === '5531999990000', 'WhatsApp de notificação atualizado');

    // --------------------------------------------------------------------------
    // Teste 6: CRM Leads com Switch de Pausa da IA (POST /api/v2/tenant/leads/toggle-ai)
    // --------------------------------------------------------------------------
    console.log('\n📋 Teste 6: CRM de Leads & Switch de Pausa/Reativação da IA');
    const testRemoteJid = '5531997778888@s.whatsapp.net';

    // Cria sessão inicial com lead qualificado
    const sessRes = await query<{ id: string }>(
      `INSERT INTO chat_sessions (tenant_id, remote_jid, status_atendimento, dados_lead)
       VALUES ($1, $2, 'ia_ativa', $3::jsonb)
       RETURNING id;`,
      [
        createdTenantId,
        testRemoteJid,
        JSON.stringify({ nome: 'Cliente CRM', servico: 'CFTV IP 4K', bairro_cidade: 'Lourdes / BH' })
      ]
    );
    const sessionId = sessRes.rows[0].id;

    // Consulta leads
    const leadsRes1 = await requestApi('/api/v2/tenant/leads', { token: authToken });
    assert(leadsRes1.data?.leads?.length === 1, 'Sessão listada na tabela do CRM');
    assert(leadsRes1.data?.leads[0].is_paused === false, 'Status inicial da IA é Ativa');

    // Executa Switch: PAUSAR IA
    const pauseRes = await requestApi('/api/v2/tenant/leads/toggle-ai', {
      method: 'POST',
      token: authToken,
      body: { sessionId, action: 'pause' }
    });
    assert(pauseRes.data?.status === 'pausa_humana', 'Switch para pausa_humana executado com sucesso');

    const leadsRes2 = await requestApi('/api/v2/tenant/leads', { token: authToken });
    assert(leadsRes2.data?.leads[0].is_paused === true, 'Tabela reflete status pausado (Pausa Humana)');

    // Executa Switch: REATIVAR IA (zera paused_until)
    const resumeRes = await requestApi('/api/v2/tenant/leads/toggle-ai', {
      method: 'POST',
      token: authToken,
      body: { sessionId, action: 'resume' }
    });
    assert(resumeRes.data?.status === 'ia_ativa', 'Switch para ia_ativa executado com sucesso');

    const leadsRes3 = await requestApi('/api/v2/tenant/leads', { token: authToken });
    assert(leadsRes3.data?.leads[0].is_paused === false, 'Tabela reflete IA reativada');
    assert(leadsRes3.data?.leads[0].paused_until === null, 'paused_until zerado imediatamente');

    // --------------------------------------------------------------------------
    // Teste 7: Dossiê de Clientes (GET /api/v2/tenant/customers)
    // --------------------------------------------------------------------------
    console.log('\n📋 Teste 7: Dossiê Permanente do Cliente (GET /api/v2/tenant/customers)');
    await CustomerService.findOrCreateProfile(createdTenantId, testRemoteJid, {
      nome: 'Cliente CRM',
      endereco_completo: 'Rua Rio de Janeiro, 1200 - Lourdes',
      perfil_resumo: 'Cliente solicitou orçamento de 6 câmeras IP Intelbras.'
    });

    await CustomerService.createAppointment(createdTenantId, {
      remote_jid: testRemoteJid,
      servico: 'Instalação CFTV IP 4K',
      data_agendada: new Date(Date.now() + 86400000),
      status: 'agendado'
    });

    const custRes = await requestApi('/api/v2/tenant/customers', { token: authToken });
    assert(custRes.status === 200, 'Dossiês de clientes recuperados com status 200');
    assert(custRes.data?.customers?.length === 1, 'Cliente cadastrado encontrado');
    assert(custRes.data?.customers[0].perfil_resumo.includes('6 câmeras IP'), 'Resumo do dossiê presente');
    assert(custRes.data?.customers[0].agendamentos?.length === 1, 'Agendamento associado retornado');

    // --------------------------------------------------------------------------
    // Limpeza final do tenant de teste
    // --------------------------------------------------------------------------
    await query('DELETE FROM tenants WHERE id = $1;', [createdTenantId]);

    console.log('\n================================================================');
    console.log(`🎉 TODAS AS VALIDAÇÕES DA FASE 5 FORAM CONCLUÍDAS COM SUCESSO!`);
    console.log(`Total de Testes: ${totalTests} | Aprovados: ${passedTests} | Falhas: 0`);
    console.log('================================================================\n');

  } catch (err) {
    console.error('❌ Falha na bateria de testes da Fase 5:', err);
    throw err;
  } finally {
    server.close();
    await shutdownPool();
  }
}

runPhase5Tests()
  .then(() => {
    setTimeout(() => process.exit(0), 100);
  })
  .catch((err) => {
    console.error(err);
    setTimeout(() => process.exit(1), 100);
  });
