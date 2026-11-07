const http = require('http');
const { query } = require('../database/db');
const authService = require('../database/auth.service');
const { handleV2Routes } = require('../panel/routes/v2.routes');

function request(port, path, method, data = null, token = null) {
  return new Promise((resolve, reject) => {
    const payload = data ? JSON.stringify(data) : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(raw);
          resolve({ status: res.statusCode, data: json });
        } catch (e) {
          resolve({ status: res.statusCode, data: raw });
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runTest() {
  console.log('====================================================================');
  console.log('📅 TESTE: CALENDÁRIO INTERATIVO & AGENDAMENTOS MULTI-TENANT');
  console.log('====================================================================\n');

  let passed = 0;
  let total = 0;

  function assert(cond, name) {
    total++;
    if (cond) {
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${name}`);
      throw new Error(`Falha no teste: ${name}`);
    }
  }

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

  await new Promise(r => server.listen(3497, '127.0.0.1', r));
  console.log('📡 Servidor de testes escutando na porta 3497.\n');

  try {
    // 1. Cadastra um novo tenant para o teste do calendário
    const timestamp = Date.now();
    const testEmail = `admin_cal_${timestamp}@empresa.com`;
    const regRes = await authService.registerTenantAndAdmin({
      nome_empresa: 'Empresa Calendário Teste',
      nome: 'Administrador Agenda',
      email: testEmail,
      password: 'SenhaCalendario123!',
      sobre_empresa: 'Empresa para teste do calendário visual de visitas.'
    });

    const tenantId = regRes.tenant.id;
    const token = regRes.token;
    assert(!!token, 'Tenant criado com sucesso');

    // 2. Insere 3 agendamentos em datas e status diferentes no PostgreSQL
    const remoteJid = '5531987654321@s.whatsapp.net';
    
    // Agendamento 1: Ativo para 2026-11-07 10:00:00 (Brasília)
    const appt1Res = await query(`
      INSERT INTO appointments (
        tenant_id, remote_jid, servico, tipo_agendamento, data_agendada, status, valor_estimado, endereco
      ) VALUES ($1, $2, 'Instalação de 4 Câmeras', 'VISITA_TECNICA', '2026-11-07 13:00:00+00', 'agendado', 0, 'Rua das Flores, 120, BH')
      RETURNING id;
    `, [tenantId, remoteJid]);
    const appt1Id = appt1Res.rows[0].id;

    // Agendamento 2: Concluído para 2026-11-14 14:00:00 (Brasília)
    const appt2Res = await query(`
      INSERT INTO appointments (
        tenant_id, remote_jid, servico, tipo_agendamento, data_agendada, status, valor_estimado, endereco
      ) VALUES ($1, $2, 'Manutenção DVR 8 Canais', 'MANUTENCAO', '2026-11-14 17:00:00+00', 'concluido', 140.00, 'Av. Amazonas, 500, Centro')
      RETURNING id;
    `, [tenantId, remoteJid]);
    const appt2Id = appt2Res.rows[0].id;

    // Agendamento 3: Cancelado para 2026-11-21 08:00:00 (Brasília)
    const appt3Res = await query(`
      INSERT INTO appointments (
        tenant_id, remote_jid, servico, tipo_agendamento, data_agendada, status, valor_estimado, endereco
      ) VALUES ($1, $2, 'Avaliação de Cabeamento', 'VISITA_TECNICA', '2026-11-21 11:00:00+00', 'cancelado', 0, 'Rua São Paulo, 30, Barreiro')
      RETURNING id;
    `, [tenantId, remoteJid]);
    const appt3Id = appt3Res.rows[0].id;

    // 3. Testa a rota GET /api/v2/tenant/appointments
    const getRes = await request(3497, '/api/v2/tenant/appointments', 'GET', null, token);
    assert(getRes.status === 200 && getRes.data.success, 'GET /api/v2/tenant/appointments retornou 200');
    
    const appts = getRes.data.appointments;
    assert(Array.isArray(appts) && appts.length === 3, 'Retornou exatamente os 3 agendamentos do tenant');

    // 4. Valida campos específicos necessários para o Calendário
    const appt1 = appts.find(a => a.id === appt1Id);
    assert(appt1 !== undefined, 'Agendamento 1 localizado no retorno');
    assert(appt1.data_iso === '2026-11-07', 'Campo data_iso formatado exatamente como "2026-11-07"');
    assert(appt1.horario_br === '10:00', 'Campo horario_br retornado exatamente como "10:00" em horário de Brasília');
    assert(appt1.status === 'agendado', 'Status agendado correto');

    const appt2 = appts.find(a => a.id === appt2Id);
    assert(appt2.data_iso === '2026-11-14', 'Campo data_iso do agendamento 2 é "2026-11-14"');
    assert(appt2.horario_br === '14:00', 'Campo horario_br do agendamento 2 é "14:00"');
    assert(appt2.status === 'concluido', 'Status concluído correto');

    const appt3 = appts.find(a => a.id === appt3Id);
    assert(appt3.data_iso === '2026-11-21', 'Campo data_iso do agendamento 3 é "2026-11-21"');
    assert(appt3.status === 'cancelado', 'Status cancelado correto');

    // 5. Atualiza status de agendamento (PUT /api/v2/tenant/appointments/:id/status)
    const updateRes = await request(3497, `/api/v2/tenant/appointments/${appt1Id}/status`, 'PUT', {
      status: 'concluido'
    }, token);
    assert(updateRes.status === 200 && updateRes.data.success, 'Status do agendamento 1 atualizado para "concluido" via API');

    // Reconsulta para confirmar
    const reGetRes = await request(3497, '/api/v2/tenant/appointments', 'GET', null, token);
    const updatedAppt1 = reGetRes.data.appointments.find(a => a.id === appt1Id);
    assert(updatedAppt1.status === 'concluido', 'Status refletido no banco como "concluido"');

    // 6. Limpeza via cascade
    await query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    console.log('\n🧹 Dados de teste limpos via Cascade.');

    console.log('\n====================================================================');
    console.log(`🎉 TODOS OS ${total} TESTES DO CALENDÁRIO PASSARAM COM SUCESSO! (${passed}/${total})`);
    console.log('====================================================================\n');
  } catch (err) {
    console.error('❌ Erro no teste:', err);
    process.exit(1);
  } finally {
    server.close();
    process.exit(0);
  }
}

runTest();
