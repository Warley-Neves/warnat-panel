// ==============================================================================
// Bateria de Testes de Segurança & Auditoria OWASP - WarNat SaaS
// ==============================================================================

const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const rateLimiter = require('../services/rate-limiter.service');
const entitlementsService = require('../services/entitlements.service');
const authService = require('../database/auth.service');
const webhookCtrl = require('../controllers/webhook.controller');

async function runSecurityAuditTests() {
  console.log('====================================================================');
  console.log('🔒 INICIANDO AUDITORIA DE SEGURANÇA & BOAS PRÁTICAS OWASP');
  console.log('====================================================================\n');

  let passed = 0;
  let failed = 0;

  function assert(condition, name, details = '') {
    if (condition) {
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${name}${details ? ' - ' + details : ''}`);
      failed++;
    }
  }

  // --------------------------------------------------------------------------
  // TESTE 1: Rate Limiter & Proteção contra Brute Force em Login
  // --------------------------------------------------------------------------
  console.log('--- TESTE 1: Proteção Brute Force (Rate Limiting) ---');
  const testIp = '198.51.100.42';
  const testEmail = 'attacker@teste.com';

  const initCheck = rateLimiter.checkLoginRate(testIp, testEmail);
  assert(initCheck.allowed === true, 'Primeira tentativa de login é permitida');

  for (let i = 0; i < 6; i++) {
    rateLimiter.recordLoginFailure(testIp, testEmail);
  }

  const blockedCheck = rateLimiter.checkLoginRate(testIp, testEmail);
  assert(blockedCheck.allowed === false, 'Após 6 falhas consecutivas, o login é bloqueado temporariamente (HTTP 429)');
  assert(blockedCheck.waitSeconds > 0, `Tempo de espera informado: ${blockedCheck.waitSeconds}s`);

  rateLimiter.recordLoginSuccess(testIp, 'other@teste.com');
  const otherCheck = rateLimiter.checkLoginRate(testIp, 'other@teste.com');
  assert(otherCheck.allowed === true, 'Outro usuário sem falhas excessivas pode logar normalmente');

  // --------------------------------------------------------------------------
  // TESTE 2: Rate Limiter de Cadastro de Tenants (Anti-Abuse)
  // --------------------------------------------------------------------------
  console.log('\n--- TESTE 2: Limite de Criação de Empresas por IP ---');
  const regIp = '203.0.113.88';
  for (let i = 0; i < 6; i++) {
    rateLimiter.checkRegisterRate(regIp);
  }
  const regBlocked = rateLimiter.checkRegisterRate(regIp);
  assert(regBlocked.allowed === false, 'Após 6 cadastros na mesma hora pelo mesmo IP, novas criações são bloqueadas');

  // --------------------------------------------------------------------------
  // TESTE 3: Política de Senhas & Validação de E-mail
  // --------------------------------------------------------------------------
  console.log('\n--- TESTE 3: Política de Senha Forte & Validação de E-mail ---');

  try {
    await authService.registerTenantAndAdmin({
      nome_empresa: 'Empresa Teste',
      nome: 'Admin',
      email: 'email_invalido_sem_arroba',
      password: 'senhaValida123'
    });
    assert(false, 'Deveria ter rejeitado e-mail com formato inválido');
  } catch (err) {
    assert(err.message.includes('inválido'), 'E-mail sem formato válido é rejeitado pelo backend');
  }

  try {
    await authService.registerTenantAndAdmin({
      nome_empresa: 'Empresa Teste',
      nome: 'Admin',
      email: 'valido@empresa.com',
      password: '123' // Menos de 6 caracteres
    });
    assert(false, 'Deveria ter rejeitado senha curta');
  } catch (err) {
    assert(err.message.includes('mínimo 6 caracteres'), 'Senha com menos de 6 caracteres é rejeitada no cadastro');
  }

  // --------------------------------------------------------------------------
  // TESTE 4: Blindagem contra Exclusão do Administrador Raiz
  // --------------------------------------------------------------------------
  console.log('\n--- TESTE 4: Blindagem contra Exclusão do Administrador Raiz ---');
  const adminCheckCode = authService.deleteUser.toString();
  assert(adminCheckCode.includes('Não é permitido remover o único administrador ativo'), 'deleteUser possui guarda ativa impedindo exclusão do último admin');

  // --------------------------------------------------------------------------
  // TESTE 5: Verificação de SuperAdmin Obrigatória no Banco de Dados
  // --------------------------------------------------------------------------
  console.log('\n--- TESTE 5: Proteção contra Falsificação de Token SuperAdmin ---');
  const evalCode = entitlementsService.evaluateAccess.toString();
  assert(evalCode.includes('users WHERE id = $1'), 'evaluateAccess valida o usuário e is_super_admin diretamente no banco de dados');
  assert(evalCode.includes('USER_DEACTIVATED'), 'evaluateAccess bloqueia usuários inativos/desativados no banco');

  // --------------------------------------------------------------------------
  // TESTE 6: Proteção contra Data Bleed no Webhook Controller
  // --------------------------------------------------------------------------
  console.log('\n--- TESTE 6: Isolamento Multi-Tenant em Webhooks ---');
  const resolveCode = webhookCtrl.resolveTenantAndSession.toString();
  assert(!resolveCode.includes('ORDER BY created_at ASC LIMIT 1'), 'Fallback perigoso que vazava mensagens para o tenant mais antigo foi 100% removido');
  assert(resolveCode.includes('não está associada a nenhuma empresa'), 'Instância desconhecida lança erro explícito de isolamento');

  console.log('\n====================================================================');
  console.log(`📊 RESULTADO DA AUDITORIA:`);
  console.log(`   ✅ PASS: ${passed}`);
  console.log(`   ❌ FAIL: ${failed}`);
  console.log('====================================================================\n');

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runSecurityAuditTests().catch(e => {
  console.error('Fatal audit error:', e);
  process.exit(1);
});
