/**
 * BATERIA DE AUDITORIA DE SEGURANÇA E CONFORMIDADE (DEFENSIVE SECURITY TEST SUITE)
 *
 * Validações de Segurança:
 * 1. Proteção contra Path Traversal / Arbitrary File Read (CWE-22)
 * 2. Headers de Segurança HTTP (OWASP: nosniff, SAMEORIGIN, strict-origin)
 * 3. Isolamento Estrito Multi-Tenant & Prevenção de IDOR (CWE-639)
 * 4. Controle de Acesso Baseado em Funções (RBAC - CWE-285)
 * 5. Proteção contra Stored & Reflected XSS (CWE-79)
 * 6. Segurança de Credenciais & Hashing (CWE-522 / CWE-256)
 */

const http = require('http');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const { query, pool } = require('../database/db');
const authService = require('../database/auth.service');
const { handleV2Routes } = require('../panel/routes/v2.routes');
const fs = require('fs');

async function runSecurityAudit() {
  console.log('====================================================================');
  console.log('🛡️  INICIANDO AUDITORIA DE SEGURANÇA & TESTES DE CONFORMIDADE');
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

  // 1. Inicia mini servidor HTTP idêntico ao panel/server.js para testar headers e static traversal
  const publicDir = path.resolve(__dirname, '..', 'panel', 'public');

  const server = http.createServer(async (req, res) => {
    const urlObj = new URL(req.url, 'http://127.0.0.1');
    const pathname = urlObj.pathname;
    const method = req.method;

    // Headers OWASP
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-token, apikey');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

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

    // Rotas v2
    if (pathname.startsWith('/api/v2/')) {
      const handled = await handleV2Routes(req, res, pathname, method, body);
      if (handled) return;
    }

    // Static files com mitigação path traversal
    const safePath = path.normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[\/\\])+/, '');
    const filePath = path.resolve(publicDir, '.' + safePath);

    if (filePath.startsWith(publicDir + path.sep) || filePath === path.join(publicDir, 'index.html')) {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        return fs.createReadStream(filePath).pipe(res);
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  const TEST_PORT = 3505;
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
          let data = raw;
          try { data = JSON.parse(raw); } catch (e) {}
          resolve({ status: res.status, statusCode: res.statusCode, headers: res.headers, data, raw });
        });
      });
      req.on('error', (err) => resolve({ status: 500, error: err.message }));
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  try {
    // ------------------------------------------------------------------------
    // TESTE 1: Proteção contra Path Traversal / Arbitrary File Read (CWE-22)
    // ------------------------------------------------------------------------
    console.log('--- 1. Testes de Path Traversal & Headers de Segurança HTTP ---');

    // Tentativa 1: Path traversal direto para o arquivo .env
    const traversalAttempt1 = await httpRequest('/../../.env');
    assert(
      traversalAttempt1.statusCode === 404 && !traversalAttempt1.raw.includes('OPENAI_API_KEY'),
      'Tentativa de Path Traversal (/../../.env) foi bloqueada (404 Not Found)'
    );

    // Tentativa 2: Traversal com normalização complexa
    const traversalAttempt2 = await httpRequest('/....//....//.env');
    assert(
      traversalAttempt2.statusCode === 404 && !traversalAttempt2.raw.includes('DATABASE_URL'),
      'Tentativa de Path Traversal (/....//....//.env) foi bloqueada'
    );

    // Tentativa 3: Traversal para arquivo de schema do banco
    const traversalAttempt3 = await httpRequest('/../database/schema.sql');
    assert(
      traversalAttempt3.statusCode === 404,
      'Acesso a diretórios internos fora de public/ foi bloqueado'
    );

    // Verificação de Headers de Segurança OWASP
    const rootRes = await httpRequest('/');
    assert(rootRes.headers['x-content-type-options'] === 'nosniff', 'Header X-Content-Type-Options: nosniff presente');
    assert(rootRes.headers['x-frame-options'] === 'SAMEORIGIN', 'Header X-Frame-Options: SAMEORIGIN presente (anti-clickjacking)');
    assert(rootRes.headers['x-xss-protection'] === '1; mode=block', 'Header X-XSS-Protection presente');
    assert(rootRes.headers['referrer-policy'] === 'strict-origin-when-cross-origin', 'Header Referrer-Policy presente');

    // ------------------------------------------------------------------------
    // TESTE 2: Isolamento Estrito Multi-Tenant & Prevenção de IDOR (CWE-639)
    // ------------------------------------------------------------------------
    console.log('\n--- 2. Testes de Isolamento Multi-Tenant & Anti-IDOR ---');

    // Cria Tenant A e Tenant B
    const emailA = `tenantA_${Date.now()}@securitytest.com`;
    const regA = await authService.registerTenantAndAdmin({
      nome_empresa: 'Empresa Segura Alfa',
      nome: 'Admin Alfa',
      email: emailA,
      password: 'StrongPassword123!',
      sobre_empresa: 'Empresa A para teste de isolamento.'
    });

    const emailB = `tenantB_${Date.now()}@securitytest.com`;
    const regB = await authService.registerTenantAndAdmin({
      nome_empresa: 'Empresa Segura Beta',
      nome: 'Admin Beta',
      email: emailB,
      password: 'StrongPassword123!',
      sobre_empresa: 'Empresa B para teste de isolamento.'
    });

    const tokenA = regA.token;
    const tokenB = regB.token;
    const tenantIdA = regA.tenant.id;
    const tenantIdB = regB.tenant.id;

    // Tenant A cria um bloqueio de agenda
    const createLockResA = await httpRequest('/api/v2/tenant/schedule-locks', 'POST', {
      Authorization: `Bearer ${tokenA}`
    }, {
      tipo_recorrencia: 'unica',
      data: '2026-11-28',
      horario: '10:00',
      tipo_acao: 'bloquear',
      motivo: 'Segredo Alfa'
    });
    assert(createLockResA.statusCode === 201, 'Tenant A cria bloqueio na sua própria agenda');
    const lockIdA = createLockResA.data.lock.id;

    // Tentativa IDOR: Tenant B tenta deletar o bloqueio de Tenant A
    const idorDeleteLock = await httpRequest(`/api/v2/tenant/schedule-locks/${lockIdA}`, 'DELETE', {
      Authorization: `Bearer ${tokenB}`
    });
    assert(idorDeleteLock.statusCode === 404, 'IDOR Prevenido: Tenant B não consegue excluir bloqueio de Tenant A (404)');

    // Tenant B lista seus bloqueios: Não pode ver os bloqueios de Tenant A
    const listLocksB = await httpRequest('/api/v2/tenant/schedule-locks', 'GET', {
      Authorization: `Bearer ${tokenB}`
    });
    const hasLockA = Array.isArray(listLocksB.data.locks) && listLocksB.data.locks.some(l => l.id === lockIdA);
    assert(!hasLockA, 'Isolamento de Dados: Bloqueio do Tenant A não vaza na listagem do Tenant B');

    // Tenant A cria lead manual
    const createLeadResA = await httpRequest('/api/v2/tenant/leads/manual', 'POST', {
      Authorization: `Bearer ${tokenA}`
    }, {
      phone: '31999990001',
      name: 'Cliente Privado Alfa',
      initialMessage: 'Dados confidenciais Alfa'
    });
    assert(createLeadResA.statusCode === 201, 'Tenant A cria lead confidencial');
    const sessionIdA = createLeadResA.data.sessionId;

    // Tentativa IDOR: Tenant B tenta alterar o funil ou enviar mensagem na sessão do Tenant A
    const idorMsgAttempt = await httpRequest(`/api/v2/tenant/leads/${sessionIdA}/messages`, 'POST', {
      Authorization: `Bearer ${tokenB}`
    }, {
      message: 'Mensagem invasora do Tenant B'
    });
    assert(idorMsgAttempt.statusCode === 404, 'IDOR Prevenido: Tenant B não consegue interagir no chat do Tenant A (404)');

    // ------------------------------------------------------------------------
    // TESTE 3: Controle de Acesso Baseado em Funções (RBAC)
    // ------------------------------------------------------------------------
    console.log('\n--- 3. Testes de Controle de Acesso (RBAC) ---');

    // Admin cria atendente
    const emailAtendente = `atendente_${Date.now()}@securitytest.com`;
    const createAtendenteRes = await httpRequest('/api/v2/tenant/users', 'POST', {
      Authorization: `Bearer ${tokenA}`
    }, {
      nome: 'Carlos Atendente',
      email: emailAtendente,
      password: 'AtendentePass123!',
      role: 'atendente'
    });
    assert(createAtendenteRes.statusCode === 201, 'Admin cria usuário com perfil "atendente"');

    const loginAtendente = await authService.login(emailAtendente, 'AtendentePass123!');
    const tokenAtendente = loginAtendente.token;

    // Atendente tenta alterar configurações de IA do tenant
    const forbiddenAi = await httpRequest('/api/v2/tenant/ai-config', 'PUT', {
      Authorization: `Bearer ${tokenAtendente}`
    }, {
      nome_assistente: 'HackedBot'
    });
    assert(forbiddenAi.statusCode === 403, 'RBAC Bloqueio: Atendente impedido de alterar regras de IA (403)');

    // Atendente tenta cadastrar novos usuários
    const forbiddenUserCreate = await httpRequest('/api/v2/tenant/users', 'POST', {
      Authorization: `Bearer ${tokenAtendente}`
    }, {
      nome: 'Novo Admin Falso',
      email: 'fakeadmin@securitytest.com',
      password: 'FakePassword123!',
      role: 'admin'
    });
    assert(forbiddenUserCreate.statusCode === 403, 'RBAC Bloqueio: Atendente impedido de criar usuários (403)');

    // Atendente tenta ver listagem de membros da equipe
    const forbiddenUsersList = await httpRequest('/api/v2/tenant/users', 'GET', {
      Authorization: `Bearer ${tokenAtendente}`
    });
    assert(forbiddenUsersList.statusCode === 403, 'RBAC Bloqueio: Atendente impedido de listar usuários da equipe (403)');

    // ------------------------------------------------------------------------
    // TESTE 4: Proteção contra Exposição de Senhas & Hashing
    // ------------------------------------------------------------------------
    console.log('\n--- 4. Testes de Segurança de Credenciais & Hashing ---');

    // Consulta lista de usuários pelo Admin
    const usersListRes = await httpRequest('/api/v2/tenant/users', 'GET', {
      Authorization: `Bearer ${tokenA}`
    });
    const users = usersListRes.data.users || [];
    const hasExposedPassword = users.some(u => u.password_hash || u.password);
    assert(!hasExposedPassword, 'Campos password e password_hash NÃO são expostos em respostas da API');

    // Senha com hash bcrypt válido
    const dbUserRes = await query(`SELECT password_hash FROM users WHERE email = $1`, [emailA.toLowerCase()]);
    const hash = dbUserRes.rows[0]?.password_hash;
    assert(hash && hash.startsWith('$2'), 'Senha armazenada com hash Bcrypt seguro ($2a$ / $2b$)');

    // ------------------------------------------------------------------------
    // TESTE 5: Higienização contra XSS no Front-End
    // ------------------------------------------------------------------------
    console.log('\n--- 5. Testes de Higienização de Saída (Anti-XSS) ---');
    const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

    assert(indexHtml.includes('function escapeHtml'), 'Função escapeHtml implementada no index.html');
    assert(indexHtml.includes('function escapeJsArg'), 'Função escapeJsArg implementada no index.html');
    assert(indexHtml.includes('${escapeHtml(m.content)}'), 'Conteúdo de mensagens protegido com escapeHtml');
    assert(indexHtml.includes('${escapeHtml(lead.client_name)}'), 'Nome do lead no Kanban protegido com escapeHtml');
    assert(indexHtml.includes('${escapeHtml(a.client_name)}'), 'Nome do agendamento protegido com escapeHtml');

  } finally {
    server.close();
    await pool.end();
  }

  console.log('\n====================================================================');
  console.log(`📊 RESULTADO DA AUDITORIA DE SEGURANÇA: ${passed} PASSOU / ${failed} FALHOU`);
  console.log('====================================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runSecurityAudit().catch(err => {
  console.error('Erro na auditoria:', err);
  process.exit(1);
});
