// ==============================================================================
// Bateria Completa de Testes: Faturamento Pagar.me v5, Entitlements & SuperAdmin
// ==============================================================================

const http = require('http');
const crypto = require('crypto');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const { query, pool } = require('../database/db');
const authService = require('../database/auth.service');
const { handleV2Routes } = require('../panel/routes/v2.routes');
const webhookController = require('../controllers/webhook.controller');
const pagarmeService = require('../services/pagarme.service');
const entitlementsService = require('../services/entitlements.service');

async function runTestSuite() {
  console.log('====================================================================');
  console.log('🚀 INICIANDO TESTES DO SISTEMA DE BILLING, ENTITLEMENTS & SUPERADMIN');
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

  // 1. Inicia mini servidor HTTP de teste em porta aleatória
  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url, 'http://127.0.0.1');
    const pathname = urlObj.pathname;
    const method = req.method;

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-hub-signature, x-pagarme-signature');

    if (method === 'OPTIONS') {
      res.writeHead(200);
      return res.end();
    }

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
      if (handled === false) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Rota não encontrada' }));
      }
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  await new Promise(resolve => server.listen(0, resolve));
  const testPort = server.address().port;
  const baseUrl = `http://127.0.0.1:${testPort}`;

  function request(path, options = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const reqOptions = {
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {})
        }
      };

      const req = http.request(url, reqOptions, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve({ status: res.statusCode, headers: res.headers, data: json });
          } catch (e) {
            resolve({ status: res.statusCode, headers: res.headers, data });
          }
        });
      });

      req.on('error', reject);
      if (options.body) {
        req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
      }
      req.end();
    });
  }

  try {
    const timestamp = Date.now();

    // --------------------------------------------------------------------------
    // 1. PREPARAÇÃO: SUPERADMIN & USUÁRIOS DE TESTE
    // --------------------------------------------------------------------------
    console.log('--- 1. Preparação: SuperAdmin e Tenants de Teste ---');
    
    // Cria SuperAdmin de Teste
    const saEmail = `superadmin_${timestamp}@warnattech.com.br`;
    const saReg = await authService.registerTenantAndAdmin({
      nome_empresa: `SaaS Host ${timestamp}`,
      nome: 'Warley SuperAdmin',
      email: saEmail,
      password: 'SuperPassword123!',
      sobre_empresa: 'Gestão da Plataforma SaaS'
    });
    await query(`UPDATE users SET is_super_admin = TRUE WHERE id = $1`, [saReg.user.id]);
    saReg.user.is_super_admin = true;
    const saToken = authService.generateToken({ ...saReg.user, is_super_admin: true });

    // Cria Tenant A (Plano Básico)
    const tBasicEmail = `tenant_basic_${timestamp}@teste.com`;
    const tBasicReg = await authService.registerTenantAndAdmin({
      nome_empresa: `Empresa Básico ${timestamp}`,
      nome: 'Carlos Básico',
      email: tBasicEmail,
      password: 'Password123!',
      plano: 'basic'
    });
    await query(`UPDATE tenants SET plano = 'basic', status = 'ACTIVE' WHERE id = $1`, [tBasicReg.tenant.id]);
    const basicToken = tBasicReg.token;

    // Cria Tenant B (Plano Pro)
    const tProEmail = `tenant_pro_${timestamp}@teste.com`;
    const tProReg = await authService.registerTenantAndAdmin({
      nome_empresa: `Empresa Pro ${timestamp}`,
      nome: 'Beatriz Pro',
      email: tProEmail,
      password: 'Password123!',
      plano: 'pro'
    });
    const proToken = tProReg.token;

    assert(saToken && basicToken && proToken, 'SuperAdmin, Tenant Básico e Tenant Pro criados e autenticados');

    // --------------------------------------------------------------------------
    // 2. SUPERADMIN BACKOFFICE: CONTROLE DE ACESSO & KPIS
    // --------------------------------------------------------------------------
    console.log('\n--- 2. SuperAdmin Backoffice: RBAC, KPIs & Listagem ---');

    // Tentativa de acesso de usuário comum a /api/v2/superadmin/kpis deve retornar 403
    const forbiddenKpi = await request('/api/v2/superadmin/kpis', {
      headers: { 'Authorization': `Bearer ${basicToken}` }
    });
    assert(forbiddenKpi.status === 403, 'Acesso negado (403) a rota de SuperAdmin para usuário comum');
    assert(forbiddenKpi.data?.error === 'FORBIDDEN_SUPERADMIN_ONLY', 'Código de erro FORBIDDEN_SUPERADMIN_ONLY retornado corretamente');

    // Acesso permitido com token de SuperAdmin
    const saKpi = await request('/api/v2/superadmin/kpis', {
      headers: { 'Authorization': `Bearer ${saToken}` }
    });
    assert(saKpi.status === 200, 'SuperAdmin acessa /api/v2/superadmin/kpis com sucesso (200)');
    assert(saKpi.data?.kpis && typeof saKpi.data.kpis.totalTenants === 'number', 'KPIs consolidados calculados e retornados');
    assert(saKpi.data?.kpis.mrrReais !== undefined, 'Métrica MRR presente no relatório financeiro');

    // Listagem consolidada de tenants
    const saTenants = await request('/api/v2/superadmin/tenants', {
      headers: { 'Authorization': `Bearer ${saToken}` }
    });
    assert(saTenants.status === 200, 'SuperAdmin lista tenants com sucesso');
    assert(Array.isArray(saTenants.data?.tenants) && saTenants.data.tenants.length >= 3, 'Todos os tenants retornados na visão global');

    // --------------------------------------------------------------------------
    // 3. AÇÕES DO SUPERADMIN: EXTENSÃO DE TESTE, BLOQUEIO E CORTESIA
    // --------------------------------------------------------------------------
    console.log('\n--- 3. Ações do SuperAdmin: Extensão de Testes, Bloqueio Imediato & Cortesia ---');

    // Força expiração do trial do Tenant Básico
    await query(
      `UPDATE tenants SET status = 'TRIAL_EXPIRED', trial_ends_at = NOW() - INTERVAL '2 days' WHERE id = $1`,
      [tBasicReg.tenant.id]
    );

    // SuperAdmin estende o período de testes (+15 dias)
    const extendRes = await request(`/api/v2/superadmin/tenants/${tBasicReg.tenant.id}/extend-trial`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${saToken}` },
      body: { additional_days: 15, reason: 'Extensão solicitada para testes' }
    });
    assert(extendRes.status === 200, 'SuperAdmin estende trial com sucesso (+15 dias)');
    assert(extendRes.data?.tenant?.status === 'TRIALING', 'Status do tenant restaurado para TRIALING');

    // Valida trilha de auditoria para EXTEND_TRIAL
    const auditExtend = await query(
      `SELECT action, details FROM admin_audit_logs WHERE target_tenant_id = $1 AND action = 'EXTEND_TRIAL'`,
      [tBasicReg.tenant.id]
    );
    assert(auditExtend.rowCount > 0, 'Ação EXTEND_TRIAL registrada na tabela admin_audit_logs');

    // SuperAdmin bloqueia administrativamente o tenant
    const blockRes = await request(`/api/v2/superadmin/tenants/${tBasicReg.tenant.id}/block`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${saToken}` },
      body: { blocked: true, reason: 'Inadimplência grave confirmada' }
    });
    assert(blockRes.status === 200, 'SuperAdmin bloqueia tenant com sucesso');
    assert(blockRes.data?.tenant?.status === 'SUSPENDED_BY_ADMIN', 'Status atualizado para SUSPENDED_BY_ADMIN');

    // Tenant bloqueado tenta fazer qualquer operação de escrita (deve receber 403 ACCOUNT_SUSPENDED_BY_ADMIN)
    const blockedOp = await request('/api/v2/tenant/departments', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${basicToken}` },
      body: { nome: 'Setor Bloqueado' }
    });
    assert(blockedOp.status === 403, 'Operação do tenant bloqueado rejeitada com HTTP 403');
    assert(blockedOp.data?.error === 'ACCOUNT_SUSPENDED_BY_ADMIN', 'Código de erro ACCOUNT_SUSPENDED_BY_ADMIN retornado');

    // SuperAdmin desbloqueia o tenant
    const unblockRes = await request(`/api/v2/superadmin/tenants/${tBasicReg.tenant.id}/block`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${saToken}` },
      body: { blocked: false, reason: 'Comprovante apresentado' }
    });
    assert(unblockRes.status === 200, 'SuperAdmin desbloqueia tenant com sucesso');

    // SuperAdmin concede Cortesia Pro
    const courtesyRes = await request(`/api/v2/superadmin/tenants/${tBasicReg.tenant.id}/courtesy-plan`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${saToken}` },
      body: { courtesy_plan: 'pro', reason: 'Cortesia concedida para parceiro' }
    });
    assert(courtesyRes.status === 200, 'SuperAdmin concede Cortesia Pro com sucesso');
    assert(courtesyRes.data?.courtesy_plan === 'pro', 'Cortesia Pro registrada no tenant');

    // --------------------------------------------------------------------------
    // 4. INTEGRAÇÃO PAGAR.ME V5: CARTÃO, PIX & WEBHOOKS RESILIENTES
    // --------------------------------------------------------------------------
    console.log('\n--- 4. Faturamento Pagar.me v5: Cartão, PIX Dinâmico & Webhooks HMAC ---');

    // Checkout com Cartão de Crédito Tokenizado
    const cardCheckout = await request('/api/v2/tenant/billing/checkout/card', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${proToken}` },
      body: {
        plan_id: 'PRO',
        card_token: `tok_test_${timestamp}`,
        customer: {
          name: 'Beatriz Pro',
          document: '12345678909',
          email: tProEmail
        }
      }
    });
    assert(cardCheckout.status === 200, 'Checkout via cartão de crédito responde HTTP 200');
    assert(cardCheckout.data?.subscription && cardCheckout.data?.invoice, 'Assinatura e fatura criadas no banco de dados');
    assert(cardCheckout.data?.amountCents === 19700, 'Valor da assinatura do Plano Pro correto (R$ 197,00 = 19700 centavos)');

    // Checkout com PIX Dinâmico
    const pixCheckout = await request('/api/v2/tenant/billing/checkout/pix', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${proToken}` },
      body: { plan_id: 'PRO' }
    });
    assert(pixCheckout.status === 200, 'Checkout via PIX dinâmico responde HTTP 200');
    assert(pixCheckout.data?.pix_qr_code && pixCheckout.data?.pix_copy_paste, 'QR Code e Copia e Cola gerados no payload PIX');

    // Webhook Pagar.me v5: invoice.paid
    const testInvoiceCode = `inv_test_${timestamp}`;
    await query(
      `INSERT INTO invoices (tenant_id, pagarme_invoice_id, amount_cents, status)
       VALUES ($1, $2, 19700, 'PENDING')`,
      [tProReg.tenant.id, testInvoiceCode]
    );

    const webhookSecret = 'whsec_warnat_master_webhook_secret_2026';
    const webhookPayload = {
      id: `evt_${timestamp}_paid`,
      type: 'invoice.paid',
      data: {
        id: testInvoiceCode,
        amount: 19700,
        status: 'paid'
      }
    };
    const rawBody = JSON.stringify(webhookPayload);
    const validHmac = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');

    // Envio do Webhook com assinatura HMAC válida
    const whRes = await request('/api/webhooks/pagarme', {
      method: 'POST',
      headers: {
        'x-hub-signature': `sha256=${validHmac}`
      },
      body: webhookPayload
    });
    assert(whRes.status === 200, 'Webhook Pagar.me aceita requisição com assinatura HMAC válida (HTTP 200)');
    assert(whRes.data?.handled === true, 'Evento invoice.paid processado e fatura atualizada para PAID');

    // Teste de Idempotência Estrita no Webhook: Reenvio do mesmo evento
    const duplicateWhRes = await request('/api/webhooks/pagarme', {
      method: 'POST',
      headers: {
        'x-hub-signature': `sha256=${validHmac}`
      },
      body: webhookPayload
    });
    assert(duplicateWhRes.status === 200, 'Reenvio de webhook duplicado retorna HTTP 200');
    assert(duplicateWhRes.data?.already_processed === true, 'Idempotência Estrita: evento duplicado não reprocessado');

    // Webhook com assinatura inválida deve ser rejeitado (401)
    const invalidWhRes = await request('/api/webhooks/pagarme', {
      method: 'POST',
      headers: {
        'x-hub-signature': 'sha256=invalid_signature_hex_value_1234567890'
      },
      body: webhookPayload
    });
    assert(invalidWhRes.status === 401, 'Webhook com assinatura HMAC inválida rejeitado com HTTP 401');

    // --------------------------------------------------------------------------
    // 5. FEATURE GATING & REGRESSÃO ZERO (REGRAS 0 A 4)
    // --------------------------------------------------------------------------
    console.log('\n--- 5. Feature Gating & Garantia de Não-Regressão ---');

    // Cria um Tenant estritamente no Plano BÁSICO (sem cortesia e sem trial)
    const tBasicStrictEmail = `strict_basic_${timestamp}@teste.com`;
    const tBasicStrict = await authService.registerTenantAndAdmin({
      nome_empresa: `Strict Básico ${timestamp}`,
      nome: 'Operador Básico',
      email: tBasicStrictEmail,
      password: 'Password123!',
      plano: 'basic'
    });
    await query(
      `UPDATE tenants 
       SET plano = 'basic', status = 'ACTIVE', trial_ends_at = NULL, courtesy_plan = NULL 
       WHERE id = $1`,
      [tBasicStrict.tenant.id]
    );
    const strictBasicToken = tBasicStrict.token;

    // A) Chat Manual multi-atendente DEVE funcionar 100% no Plano Básico (Não-Regressão)
    const manualChatRes = await request('/api/v2/tenant/leads', {
      headers: { 'Authorization': `Bearer ${strictBasicToken}` }
    });
    assert(manualChatRes.status === 200, 'Não-Regressão: Tenant no Plano BÁSICO acessa chat manual normalmente');

    // B) Alteração de regras de IA no Plano Básico DEVE ser bloqueada (Feature Gate)
    const aiConfigBlocked = await request('/api/v2/tenant/ai-config', {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${strictBasicToken}` },
      body: { modo_atendimento: 'automacao' }
    });
    assert(aiConfigBlocked.status === 403, 'Feature Gate: Tenant no Plano BÁSICO bloqueado de configurar IA (HTTP 403)');
    assert(aiConfigBlocked.data?.error === 'FEATURE_NOT_AVAILABLE_IN_PLAN', 'Código FEATURE_NOT_AVAILABLE_IN_PLAN retornado');
    assert(aiConfigBlocked.data?.required_plan === 'PRO', 'Informa que o plano exigido é o PRO');

    // C) No Webhook receptor: Mensagem enviada para o Tenant Básico NÃO deve disparar robô
    const fakeIncomingMsg = {
      event: 'messages.upsert',
      instance: `strict-basic-${String(tBasicStrict.tenant.id).slice(0, 6)}`,
      data: {
        key: {
          remoteJid: `553199999${timestamp.toString().slice(-4)}@s.whatsapp.net`,
          fromMe: false,
          id: `msg_test_${timestamp}`
        },
        pushName: 'Cliente Teste',
        message: {
          conversation: 'Olá, gostaria de saber se vocês atendem amanhã'
        }
      }
    };
    const incomingResult = await webhookController.handleWebhook(fakeIncomingMsg);
    assert(incomingResult.handled === true, 'Webhook processou mensagem recebida');
    assert(incomingResult.action === 'message_saved_human_queue_only', 'Robô silenciado no Plano Básico: mensagem salva para atendimento humano exclusivo');

    // D) Tenant Pro (ou em Trial) tem automação liberada
    const canProBots = await entitlementsService.canUseFeature(tProReg.tenant.id, 'automation_bots');
    assert(canProBots === true, 'Tenant no Plano PRO possui a feature automation_bots liberada');

    // --------------------------------------------------------------------------
    // RESULTADO FINAL
    // --------------------------------------------------------------------------
    console.log('\n====================================================================');
    console.log(`📊 RESULTADO FINAL DA BATERIA: ${passedTests} PASSOU | ${failedTests} FALHOU`);
    console.log('====================================================================\n');

    server.close();
    process.exit(failedTests === 0 ? 0 : 1);
  } catch (err) {
    console.error('❌ Erro fatal durante a execução dos testes:', err);
    server.close();
    process.exit(1);
  }
}

if (require.main === module) {
  runTestSuite();
}

module.exports = { runTestSuite };
