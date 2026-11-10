// ==============================================================================
// Teste Automatizado de Recuperação de Senha Multicanal (OWASP / NIST SP 800-63B)
// ==============================================================================

const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const { query } = require('../database/db');
const passwordRecovery = require('../services/password-recovery.service');
const authService = require('../database/auth.service');
const rateLimiter = require('../services/rate-limiter.service');
const crypto = require('crypto');

async function runRecoveryTests() {
  console.log('====================================================================');
  console.log('🔑 TESTES DE RECUPERAÇÃO DE SENHA MULTICANAL (E-MAIL & WHATSAPP)');
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

  // 1. Mascaramento LGPD / OWASP
  console.log('--- 1. Mascaramento de Identificadores (Data Minimization) ---');
  const maskedEmail = passwordRecovery.maskIdentifier('email', 'warley.santos@warnattech.com.br');
  assert(maskedEmail.startsWith('w') && maskedEmail.includes('***') && maskedEmail.endsWith('@warnattech.com.br'), `Email mascarado: ${maskedEmail}`);

  const maskedPhone = passwordRecovery.maskIdentifier('telefone', '5531983525816');
  assert(maskedPhone.includes('(31)') && maskedPhone.includes('5816') && maskedPhone.includes('****'), `Telefone mascarado: ${maskedPhone}`);

  // 2. Proteção contra Enumeração de Usuários (Anti-User Enumeration)
  console.log('\n--- 2. Proteção contra Enumeração de Contas ---');
  const fakeRes = await passwordRecovery.requestResetCode({
    type: 'email',
    identifier: 'usuario_totalmente_inexistente_999@warnattech.com.br',
    clientIp: '189.10.20.30'
  });
  assert(fakeRes.success === true, 'Conta inexistente retorna sucesso genérico');
  assert(fakeRes.message.includes('estiver cadastrado'), 'Mensagem neutra não revela ausência do usuário');

  // 3. Solicitação Válida por E-mail
  console.log('\n--- 3. Solicitação Válida por E-mail ---');
  const emailRes = await passwordRecovery.requestResetCode({
    type: 'email',
    identifier: 'admin@warnattech.com.br',
    clientIp: '189.10.20.31'
  });
  assert(emailRes.success === true, 'Solicitação por e-mail aceita');
  assert(emailRes.masked_target.includes('@warnattech.com.br'), 'Identificador de destino mascarado');

  // Verifica armazenamento seguro no banco (Token Hashed com SHA-256)
  const tokenDb = await query(
    `SELECT t.id, t.token_hash, t.target_type, t.expires_at, t.used, u.email
     FROM password_reset_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE u.email = 'admin@warnattech.com.br' AND t.used = false
     ORDER BY t.created_at DESC LIMIT 1`
  );
  assert(tokenDb.rowCount === 1, 'Registro de token criado no banco de dados');
  assert(tokenDb.rows[0].token_hash.length === 64, 'Token armazenado como hash SHA-256 (64 hex chars)');
  assert(new Date(tokenDb.rows[0].expires_at) > new Date(), 'Validade configurada no futuro (15 minutos)');

  // 4. Solicitação Válida por Telefone (WhatsApp)
  console.log('\n--- 4. Solicitação Válida por Telefone / WhatsApp ---');
  const phoneRes = await passwordRecovery.requestResetCode({
    type: 'telefone',
    identifier: '(31) 98352-5816',
    clientIp: '189.10.20.32'
  });
  assert(phoneRes.success === true, 'Solicitação por telefone aceita');
  assert(phoneRes.target_type === 'telefone', 'Canal identificado como telefone');

  // 5. Invalidação de Tokens Anteriores
  console.log('\n--- 5. Invalidação de Códigos Anteriores (Uso Único) ---');
  const oldTokens = await query(
    `SELECT COUNT(*) as count 
     FROM password_reset_tokens t
     JOIN users u ON u.id = t.user_id
     WHERE u.email = 'admin@warnattech.com.br' AND t.used = false`
  );
  assert(Number(oldTokens.rows[0].count) === 1, 'Apenas o token mais recente permanece ativo para o usuário');

  // 6. Teste de Redefinição com Código
  console.log('\n--- 6. Validação de Código & Redefinição de Senha ---');
  
  // Gera código conhecido diretamente no banco para teste controlado
  const testCode = '654321';
  const testHash = crypto.createHash('sha256').update(testCode).digest('hex');
  const userAdmin = await query(`SELECT id FROM users WHERE email = 'admin@warnattech.com.br'`);
  const adminId = userAdmin.rows[0].id;

  await query(`UPDATE password_reset_tokens SET used = true WHERE user_id = $1`, [adminId]);
  await query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, target_type, target_value, expires_at)
     VALUES ($1, $2, 'email', 'admin@warnattech.com.br', NOW() + INTERVAL '15 minutes')`,
    [adminId, testHash]
  );

  // Teste com código incorreto
  try {
    await passwordRecovery.verifyAndResetPassword({
      code: '000000',
      newPassword: 'NovaSenhaSegura2026!',
      clientIp: '189.10.20.33'
    });
    assert(false, 'Deveria ter rejeitado código incorreto');
  } catch (err) {
    assert(err.message.includes('incorreto') || err.message.includes('inválido'), 'Código incorreto rejeitado');
  }

  // Teste com senha curta (< 6 caracteres)
  try {
    await passwordRecovery.verifyAndResetPassword({
      code: testCode,
      newPassword: '123',
      clientIp: '189.10.20.33'
    });
    assert(false, 'Deveria ter rejeitado senha curta');
  } catch (err) {
    assert(err.message.includes('6 caracteres'), 'Senha menor que 6 caracteres rejeitada');
  }

  // Teste com código correto e senha válida
  const resetSuccess = await passwordRecovery.verifyAndResetPassword({
    code: testCode,
    newPassword: 'WarnatAdmin2026!', // Restaura a senha padrão após o teste
    clientIp: '189.10.20.33'
  });
  assert(resetSuccess.success === true, 'Senha redefinida com sucesso com código válido');

  // Teste de reuso do mesmo código (Deve falhar)
  try {
    await passwordRecovery.verifyAndResetPassword({
      code: testCode,
      newPassword: 'OutraSenhaQualquer123!',
      clientIp: '189.10.20.33'
    });
    assert(false, 'Deveria ter impedido reuso do código já utilizado');
  } catch (err) {
    assert(err.message.includes('já foi utilizado'), 'Reuso de código de uso único bloqueado com sucesso');
  }

  // 7. Auditoria do Evento
  console.log('\n--- 7. Registro em Logs de Auditoria ---');
  const auditRes = await query(
    `SELECT action, details FROM admin_audit_logs 
     WHERE admin_user_id = $1 AND action = 'PASSWORD_RESET_COMPLETED' 
     ORDER BY created_at DESC LIMIT 1`,
    [adminId]
  );
  assert(auditRes.rowCount === 1, 'Evento PASSWORD_RESET_COMPLETED registrado em admin_audit_logs');

  console.log('\n====================================================================');
  console.log(`📊 RESULTADO DOS TESTES DE RECUPERAÇÃO DE SENHA:`);
  console.log(`   ✅ PASS: ${passed}`);
  console.log(`   ❌ FAIL: ${failed}`);
  console.log('====================================================================\n');

  if (failed > 0) process.exit(1);
  else process.exit(0);
}

runRecoveryTests().catch(e => {
  console.error('Fatal test error:', e);
  process.exit(1);
});
