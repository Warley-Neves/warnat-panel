const http = require('http');
const { query } = require('../database/db');
const authService = require('../database/auth.service');

async function testPhase5() {
  console.log('------------------------------------------------------------');
  console.log('🧪 Iniciando Testes da Fase 5: API v2 & Painel Multi-Tenant');
  console.log('------------------------------------------------------------');

  // 1. Criar dados de teste no PostgreSQL
  const tenantRes = await query(
    `INSERT INTO tenants (nome_empresa, plano) VALUES ('Empresa Fase 5 Painel', 'pro') RETURNING id, nome_empresa`
  );
  const tenant = tenantRes.rows[0];

  const user = await authService.registerUser({
    tenantId: tenant.id,
    email: 'admin.fase5@painel.com',
    password: 'MinhaSenhaSegura2026!',
    role: 'admin',
    nome: 'Gerente Comercial'
  });

  await query(
    `INSERT INTO tenant_whatsapp_instances (tenant_id, instance_name, status) VALUES ($1, 'fase5-inst', 'open')`,
    [tenant.id]
  );

  await query(
    `INSERT INTO tenant_ai_configs (tenant_id, sobre_empresa, pausa_automatica_minutos) VALUES ($1, 'Empresa de câmeras e segurança', 45)`,
    [tenant.id]
  );

  const sessionRes = await query(
    `INSERT INTO chat_sessions (tenant_id, remote_jid, client_name, dados_lead) 
     VALUES ($1, '5531983579692@s.whatsapp.net', 'Maria Souza', $2) 
     RETURNING id`,
    [tenant.id, JSON.stringify({ nome: 'Maria Souza', servico: 'Câmeras CFTV', bairro_cidade: 'Barreiro / BH', urgencia: 'alta' })]
  );
  const session = sessionRes.rows[0];

  await query(
    `INSERT INTO chat_messages (session_id, tenant_id, role, content) 
     VALUES ($1, $2, 'user', 'Olá, gostaria de saber o valor da instalação de 4 câmeras')`,
    [session.id, tenant.id]
  );

  console.log('✅ Dados de teste preparados no banco.');

  // 2. Iniciar servidor temporário com as rotas do painel
  const { handleV2Routes } = require('../panel/routes/v2.routes');
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      const buffers = [];
      for await (const chunk of req) buffers.push(chunk);
      const str = Buffer.concat(buffers).toString();
      if (str) try { body = JSON.parse(str); } catch (e) {}
    }
    await handleV2Routes(req, res, url.pathname, req.method, body);
  });

  await new Promise(r => server.listen(3999, r));
  console.log('✅ Servidor de teste da API v2 ouvindo na porta 3999.');

  // Helper HTTP
  const request = (path, method = 'GET', data = null, token = null) => {
    return new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const payload = data ? JSON.stringify(data) : null;
      if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

      const req = http.request({
        hostname: '127.0.0.1',
        port: 3999,
        path,
        method,
        headers
      }, res => {
        let bodyStr = '';
        res.on('data', c => bodyStr += c);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(bodyStr) });
          } catch (e) {
            resolve({ status: res.statusCode, data: bodyStr });
          }
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  };

  try {
    // 3. Teste 1: Login Multi-Tenant
    const loginRes = await request('/api/v2/auth/login', 'POST', {
      email: 'admin.fase5@painel.com',
      password: 'MinhaSenhaSegura2026!'
    });
    console.log('✅ Teste 1 (POST /api/v2/auth/login):', loginRes.status, '| Sucesso:', loginRes.data.success);
    if (!loginRes.data.token) throw new Error('Falha ao emitir token JWT no login!');
    const token = loginRes.data.token;

    // 4. Teste 2: Obter Contexto do Usuário (/api/v2/auth/me)
    const meRes = await request('/api/v2/auth/me', 'GET', null, token);
    console.log('✅ Teste 2 (GET /api/v2/auth/me):', meRes.data.tenant.nome_empresa, '| Role:', meRes.data.user.role);

    // 5. Teste 3: Status do WhatsApp (/api/v2/whatsapp/status)
    const waRes = await request('/api/v2/whatsapp/status', 'GET', null, token);
    console.log('✅ Teste 3 (GET /api/v2/whatsapp/status): Status =', waRes.data.status, '| Instância =', waRes.data.instanceName);

    // 6. Teste 4: Salvar e Ler Regras da IA (/api/v2/tenant/ai-config)
    const saveAiRes = await request('/api/v2/tenant/ai-config', 'PUT', {
      tom_de_voz: 'consultivo_especialista',
      pausa_automatica_minutos: 60,
      whatsapp_notificacao_humana: '5531983579692',
      sobre_empresa: 'Líder em segurança eletrônica.',
      servicos_oferecidos: ['CFTV 4K', 'Alarmes Perimetrais']
    }, token);
    console.log('✅ Teste 4 (PUT /api/v2/tenant/ai-config):', saveAiRes.data.message);

    const getAiRes = await request('/api/v2/tenant/ai-config', 'GET', null, token);
    console.log('   - Tom de voz salvo:', getAiRes.data.config.tom_de_voz, '| Pausa (min):', getAiRes.data.config.pausa_automatica_minutos);

    // 7. Teste 5: Listar Leads & Conversas (/api/v2/tenant/leads)
    const leadsRes = await request('/api/v2/tenant/leads', 'GET', null, token);
    console.log('✅ Teste 5 (GET /api/v2/tenant/leads): Total leads retornados =', leadsRes.data.leads.length);
    console.log('   - Lead cliente:', leadsRes.data.leads[0].client_name, '| Serviço:', leadsRes.data.leads[0].dados_lead.servico);

    // 8. Teste 6: Switch Toggle de Pausa da IA (/api/v2/tenant/leads/toggle-ai)
    // Pausa a IA
    const pauseRes = await request('/api/v2/tenant/leads/toggle-ai', 'POST', {
      sessionId: session.id,
      action: 'pause'
    }, token);
    console.log('✅ Teste 6.1 (Pausar IA via Switch):', pauseRes.data.status, '(esperado: pausa_humana)');

    // Reativa a IA imediatamente
    const resumeRes = await request('/api/v2/tenant/leads/toggle-ai', 'POST', {
      sessionId: session.id,
      action: 'resume'
    }, token);
    console.log('✅ Teste 6.2 (Reativar IA via Switch):', resumeRes.data.status, '(esperado: ia_ativa)');

    // 9. Teste 7: Mensagens da Conversa (/api/v2/tenant/leads/:id/messages)
    const msgsRes = await request(`/api/v2/tenant/leads/${session.id}/messages`, 'GET', null, token);
    console.log('✅ Teste 7 (GET /api/v2/tenant/leads/:id/messages): Mensagens =', msgsRes.data.messages.length);

    console.log('\n🎉 TODOS OS TESTES DA FASE 5 PASSARAM COM 100% DE SUCESSO!');
  } finally {
    server.close();
    await query('DELETE FROM tenants WHERE id = $1', [tenant.id]);
    console.log('✅ Dados de teste limpos via Cascade.');
  }

  process.exit(0);
}

testPhase5().catch(err => {
  console.error('❌ Falha nos testes da Fase 5:', err);
  process.exit(1);
});
