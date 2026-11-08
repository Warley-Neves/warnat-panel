// ==============================================================================
// Bateria de Testes: Política de Privacidade e Consentimento LGPD (Lei 13.709/2018)
// ==============================================================================

const http = require('http');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const { query, pool } = require('../database/db');
const authService = require('../database/auth.service');
const { handleV2Routes } = require('../panel/routes/v2.routes');

async function runPrivacySuite() {
  console.log('====================================================================');
  console.log('🛡️  INICIANDO BATERIA DE TESTES: POLÍTICA DE PRIVACIDADE & LGPD');
  console.log('====================================================================\n');

  let passedTests = 0;
  let failedTests = 0;

  function assert(condition, testName, details = '') {
    if (condition) {
      console.log(`  ✅ PASS: ${testName}`);
      passedTests++;
    } else {
      console.error(`  ❌ FAIL: ${testName}${details ? ': ' + details : ''}`);
      failedTests++;
    }
  }

  // 1. Inicia mini servidor HTTP de teste
  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url, 'http://127.0.0.1');
    const pathname = urlObj.pathname;
    const method = req.method;

    let body = {};
    let raw = '';
    if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
      for await (const chunk of req) raw += chunk;
      req.rawBody = raw;
      if (raw) {
        try { body = JSON.parse(raw); } catch (e) { body = {}; }
      }
    }

    try {
      const handled = await handleV2Routes(req, res, pathname, method, body);
      if (!handled && !res.writableEnded) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'NOT_FOUND' }));
      }
    } catch (err) {
      if (!res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  });

  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  console.log(`📡 Servidor de teste rodando em ${baseUrl}\n`);

  async function api(path, options = {}) {
    const fetchRes = await fetch(`${baseUrl}${path}`, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'PrivacyTestSuite/1.0',
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const data = await fetchRes.json().catch(() => ({}));
    return { status: fetchRes.status, ok: fetchRes.ok, data };
  }

  try {
    // --------------------------------------------------------------------------
    // TESTE 1: Rota pública GET /api/v2/privacy-policy
    // --------------------------------------------------------------------------
    console.log('--- TESTE 1: Consulta Pública dos Termos de Privacidade ---');
    const polRes = await api('/api/v2/privacy-policy');
    assert(polRes.status === 200, 'GET /api/v2/privacy-policy responde status 200');
    assert(polRes.data?.version === 'v1.0', 'Versão da política retornada é v1.0', polRes.data?.version);
    assert(polRes.data?.dpo_email === 'privacidade@warnattech.com.br', 'Canal do DPO configurado corretamente', polRes.data?.dpo_email);
    assert(polRes.data?.title?.includes('LGPD'), 'Título faz menção expressa à LGPD', polRes.data?.title);

    // --------------------------------------------------------------------------
    // TESTE 2: Cadastro sem consentimento da LGPD deve ser rejeitado (400)
    // --------------------------------------------------------------------------
    console.log('\n--- TESTE 2: Auto-cadastro sem Aceite da LGPD ---');
    const testEmailNoConsent = `noconsent_${Date.now()}@teste.com`;
    const regFailRes = await api('/api/v2/auth/register', {
      method: 'POST',
      body: {
        nome_empresa: 'Empresa Sem Consentimento',
        nome: 'Usuario Teste',
        email: testEmailNoConsent,
        password: 'senhaSegura123!',
        privacy_policy_accepted: false
      }
    });
    assert(regFailRes.status === 400, 'Cadastro sem consentimento retorna status 400');
    assert(regFailRes.data?.error?.includes('LGPD') || regFailRes.data?.error?.includes('Privacidade'), 'Retorna mensagem de exigência de consentimento', regFailRes.data?.error);

    // --------------------------------------------------------------------------
    // TESTE 3: Cadastro com consentimento da LGPD aceito
    // --------------------------------------------------------------------------
    console.log('\n--- TESTE 3: Auto-cadastro com Consentimento LGPD ---');
    const testEmailWithConsent = `consent_${Date.now()}@teste.com`;
    const regSuccessRes = await api('/api/v2/auth/register', {
      method: 'POST',
      body: {
        nome_empresa: 'Empresa LGPD Compliant',
        nome: 'Gestor Titular',
        email: testEmailWithConsent,
        password: 'senhaSegura123!',
        privacy_policy_accepted: true
      }
    });
    assert(regSuccessRes.status === 201, 'Cadastro com consentimento retorna status 201', JSON.stringify(regSuccessRes.data));
    assert(regSuccessRes.data?.token, 'Token JWT retornado com sucesso');
    const newUserId = regSuccessRes.data?.user?.id;
    const newTenantId = regSuccessRes.data?.user?.tenantId;
    const userToken = regSuccessRes.data?.token;

    // Verifica no banco de dados se os campos foram gravados
    const dbUserCheck = await query(
      `SELECT privacy_policy_accepted_at, privacy_policy_version FROM users WHERE id = $1`,
      [newUserId]
    );
    assert(dbUserCheck.rows[0]?.privacy_policy_version === 'v1.0', 'Versão gravada na tabela users é v1.0');
    assert(dbUserCheck.rows[0]?.privacy_policy_accepted_at !== null, 'Data do consentimento gravada na tabela users');

    // Verifica se gravou na tabela user_consents
    const dbConsentCheck = await query(
      `SELECT * FROM user_consents WHERE user_id = $1`,
      [newUserId]
    );
    assert(dbConsentCheck.rowCount >= 1, 'Registro de auditoria inserido na tabela user_consents');
    assert(dbConsentCheck.rows[0]?.policy_version === 'v1.0', 'Versão gravada na tabela user_consents é v1.0');

    // --------------------------------------------------------------------------
    // TESTE 4: Login do usuário recém-criado reflete consentimento aceito
    // --------------------------------------------------------------------------
    console.log('\n--- TESTE 4: Verificação de Consentimento no Perfil (/api/v2/auth/me) ---');
    const meRes = await api('/api/v2/auth/me', {
      headers: { Authorization: `Bearer ${userToken}` }
    });
    assert(meRes.status === 200, 'GET /api/v2/auth/me responde 200');
    assert(meRes.data?.user?.privacyPolicyAccepted === true, 'privacyPolicyAccepted é true para usuário que consentiu');
    assert(meRes.data?.user?.privacy_policy_version === 'v1.0', 'privacy_policy_version é v1.0');

    // --------------------------------------------------------------------------
    // TESTE 5: Simulação de Usuário Legado sem Consentimento e Acionamento do Gate
    // --------------------------------------------------------------------------
    console.log('\n--- TESTE 5: Usuário Legado Sem Consentimento & Registro Posterior ---');
    // Força limpeza do consentimento do usuário para simular conta legada
    await query(
      `UPDATE users SET privacy_policy_accepted_at = NULL, privacy_policy_version = NULL WHERE id = $1`,
      [newUserId]
    );

    const meBeforeConsent = await api('/api/v2/auth/me', {
      headers: { Authorization: `Bearer ${userToken}` }
    });
    assert(meBeforeConsent.data?.user?.privacyPolicyAccepted === false, 'Usuário com dados resetados tem privacyPolicyAccepted === false (ACIONA GATE BLOQUEANTE)');

    // Registra consentimento pelo endpoint do gate: POST /api/v2/auth/consent
    const postConsentRes = await api('/api/v2/auth/consent', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userToken}` },
      body: { version: 'v1.0' }
    });
    assert(postConsentRes.status === 200, 'POST /api/v2/auth/consent responde 200', JSON.stringify(postConsentRes.data));
    assert(postConsentRes.data?.success === true, 'Consentimento aceito e processado com sucesso');

    // Verifica novamente o perfil do usuário
    const meAfterConsent = await api('/api/v2/auth/me', {
      headers: { Authorization: `Bearer ${userToken}` }
    });
    assert(meAfterConsent.data?.user?.privacyPolicyAccepted === true, 'Após confirmação do gate, privacyPolicyAccepted é true e libera o painel');

    // --------------------------------------------------------------------------
    // Limpeza dos dados de teste
    // --------------------------------------------------------------------------
    await query(`DELETE FROM user_consents WHERE tenant_id = $1`, [newTenantId]).catch(() => {});
    await query(`DELETE FROM users WHERE tenant_id = $1`, [newTenantId]).catch(() => {});
    await query(`DELETE FROM tenant_whatsapp_instances WHERE tenant_id = $1`, [newTenantId]).catch(() => {});
    await query(`DELETE FROM tenant_ai_configs WHERE tenant_id = $1`, [newTenantId]).catch(() => {});
    await query(`DELETE FROM tenants WHERE id = $1`, [newTenantId]).catch(() => {});

  } catch (err) {
    console.error('💥 Erro fatal durante a execução dos testes:', err);
    failedTests++;
  } finally {
    server.close();
    await pool.end();
  }

  console.log('\n====================================================================');
  console.log(`📊 RESULTADO FINAL DOS TESTES LGPD:`);
  console.log(`   ✅ PASS: ${passedTests}`);
  console.log(`   ❌ FAIL: ${failedTests}`);
  console.log('====================================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runPrivacySuite();
