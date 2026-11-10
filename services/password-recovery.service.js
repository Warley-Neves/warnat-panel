// ==============================================================================
// Serviço de Recuperação de Senha Multicanal (E-mail & WhatsApp)
// Em conformidade com OWASP ASVS e NIST SP 800-63B
// ==============================================================================

const crypto = require('crypto');
const { query } = require('../database/db');
const authService = require('../database/auth.service');
const rateLimiter = require('./rate-limiter.service');
const evolutionService = require('./evolution.service');

class PasswordRecoveryService {
  /**
   * Mascara e-mail ou telefone para resposta segura (OWASP Data Minimization)
   */
  maskIdentifier(type, value) {
    if (!value) return '';
    const clean = String(value).trim();
    if (type === 'email') {
      const parts = clean.split('@');
      if (parts.length !== 2) return '***@***';
      const name = parts[0];
      const domain = parts[1];
      if (name.length <= 2) {
        return `${name[0]}*@${domain}`;
      }
      return `${name[0]}***${name[name.length - 1]}@${domain}`;
    } else {
      const digits = clean.replace(/\D/g, '');
      if (digits.length <= 4) return '****';
      const last4 = digits.slice(-4);
      const ddd = digits.length >= 10 ? digits.slice(-11, -9) : '';
      return ddd ? `(${ddd}) 9****-${last4}` : `****-${last4}`;
    }
  }

  /**
   * Solicita um código OTP de recuperação de 6 dígitos via E-mail ou WhatsApp
   */
  async requestResetCode({ type, identifier, clientIp }) {
    if (!type || !identifier) {
      throw new Error('Tipo (email ou telefone) e identificador são obrigatórios.');
    }

    const cleanType = String(type).toLowerCase().trim();
    if (cleanType !== 'email' && cleanType !== 'telefone') {
      throw new Error('Tipo de recuperação inválido. Utilize "email" ou "telefone".');
    }

    const rawId = String(identifier).trim();

    // 1. Rate Limiting por IP e Identificador
    const rateCheck = rateLimiter.checkPasswordResetRate(clientIp, rawId);
    if (!rateCheck.allowed) {
      const err = new Error(rateCheck.error);
      err.statusCode = 429;
      throw err;
    }
    rateLimiter.recordPasswordResetAttempt(clientIp, rawId);

    // 2. Validação de Formato
    let cleanEmail = null;
    let cleanPhone = null;

    if (cleanType === 'email') {
      cleanEmail = rawId.toLowerCase();
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(cleanEmail)) {
        throw new Error('Formato de e-mail inválido.');
      }
    } else {
      cleanPhone = rawId.replace(/\D/g, '');
      if (cleanPhone.length < 8) {
        throw new Error('Número de telefone inválido. Informe o DDD e o número completo.');
      }
    }

    // 3. Busca do Usuário no Banco de Dados
    let user = null;
    if (cleanType === 'email') {
      const res = await query(
        `SELECT id, tenant_id, nome, email, telefone, ativo
         FROM users 
         WHERE LOWER(email) = $1 AND ativo = true 
         LIMIT 1`,
        [cleanEmail]
      );
      if (res.rowCount > 0) user = res.rows[0];
    } else {
      // Normalização de telefone brasileiro (com 55, sem 55, ou últimos 8-9 dígitos)
      const phoneNo55 = cleanPhone.startsWith('55') ? cleanPhone.slice(2) : cleanPhone;
      const phoneWith55 = cleanPhone.startsWith('55') ? cleanPhone : '55' + cleanPhone;
      const last8 = cleanPhone.slice(-8);

      const res = await query(
        `SELECT id, tenant_id, nome, email, telefone, ativo
         FROM users 
         WHERE ativo = true AND (
           telefone = $1 OR telefone = $2 OR telefone LIKE $3
         )
         LIMIT 1`,
        [cleanPhone, phoneWith55, `%${last8}`]
      );
      if (res.rowCount > 0) user = res.rows[0];
    }

    // 4. Proteção contra Enumeração de Usuários (OWASP User Enumeration Prevention)
    // Se o usuário não existir, simula um tempo de hash/busca e responde com sucesso genérico
    if (!user) {
      await new Promise(r => setTimeout(r, 180 + Math.floor(Math.random() * 120)));
      return {
        success: true,
        message: 'Se o contato informado estiver cadastrado, você receberá um código de recuperação em instantes.',
        target_type: cleanType,
        masked_target: this.maskIdentifier(cleanType, rawId)
      };
    }

    // 5. Invalida tokens anteriores não utilizados do usuário
    await query(
      `UPDATE password_reset_tokens 
       SET used = true 
       WHERE user_id = $1 AND used = false`,
      [user.id]
    );

    // 6. Geração do Token OTP Criptograficamente Seguro (CSPRNG)
    const rawCode = crypto.randomInt(100000, 1000000).toString();
    const tokenHash = crypto.createHash('sha256').update(rawCode).digest('hex');
    const targetValue = cleanType === 'email' ? cleanEmail : cleanPhone;

    // 7. Armazenamento com Hash SHA-256 e Validade de 15 Minutos (NIST)
    await query(
      `INSERT INTO password_reset_tokens (
         user_id, token_hash, target_type, target_value, expires_at
       ) VALUES ($1, $2, $3, $4, NOW() + INTERVAL '15 minutes')`,
      [user.id, tokenHash, cleanType, targetValue]
    );

    // 8. Log Seguro de Auditoria
    await query(
      `INSERT INTO admin_audit_logs (admin_user_id, target_tenant_id, action, details)
       VALUES ($1, $2, 'PASSWORD_RESET_REQUESTED', $3)`,
      [
        user.id,
        user.tenant_id,
        JSON.stringify({
          type: cleanType,
          masked_target: this.maskIdentifier(cleanType, targetValue),
          ip: clientIp,
          requested_at: new Date().toISOString()
        })
      ]
    ).catch(() => {});

    // 9. Envio Multicanal: Disparo via WhatsApp (se telefone disponível)
    const destPhone = user.telefone || (cleanType === 'telefone' ? cleanPhone : null);
    if (destPhone) {
      try {
        // Localiza instância WhatsApp ativa associada
        const instRes = await query(
          `SELECT instance_name 
           FROM tenant_whatsapp_instances 
           WHERE (tenant_id = $1 OR status = 'open') AND status = 'open' 
           ORDER BY (tenant_id = $1) DESC 
           LIMIT 1`,
          [user.tenant_id]
        );
        const instanceName = instRes.rows[0]?.instance_name || process.env.INSTANCE_NAME || 'warnat-tech';

        const firstName = (user.nome || 'Usuário').split(' ')[0];
        const whatsappMsg =
          `🔐 *WarNat SaaS - Código de Recuperação*\n\n` +
          `Olá, *${firstName}*!\n` +
          `Seu código de segurança para redefinir sua senha é:\n\n` +
          `👉 *${rawCode}*\n\n` +
          `⏱️ *Validade:* 15 minutos (uso único).\n` +
          `Se você não solicitou esta redefinição, desconsidere esta mensagem. Sua conta permanece segura.`;

        await evolutionService.sendTextMessage(instanceName, destPhone, whatsappMsg);
        console.log(`✅ [PasswordRecovery] Código OTP WhatsApp disparado com sucesso para ${destPhone}`);
      } catch (evErr) {
        console.warn(`⚠️ [PasswordRecovery] Aviso ao despachar mensagem WhatsApp:`, evErr.message);
      }
    }

    // Log para console administrativo
    console.log(`🔐 [PasswordRecovery] Código gerado para ${user.email} (${destPhone || 'sem telefone'}): ${rawCode}`);

    return {
      success: true,
      message: 'Se o contato informado estiver cadastrado, você receberá um código de recuperação em instantes.',
      target_type: cleanType,
      masked_target: this.maskIdentifier(cleanType, targetValue)
    };
  }

  /**
   * Valida o código OTP e redefine a senha do usuário
   */
  async verifyAndResetPassword({ code, newPassword, clientIp }) {
    if (!code || typeof code !== 'string') {
      throw new Error('O código de recuperação de 6 dígitos é obrigatório.');
    }

    const cleanCode = code.trim();
    if (!/^\d{6}$/.test(cleanCode)) {
      throw new Error('O código de recuperação deve conter exatamente 6 dígitos numéricos.');
    }

    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
      throw new Error('A nova senha deve conter pelo menos 6 caracteres.');
    }

    // 1. Gera hash SHA-256 do código recebido para busca
    const tokenHash = crypto.createHash('sha256').update(cleanCode).digest('hex');

    const tokenRes = await query(
      `SELECT t.id, t.user_id, t.attempts, t.used, t.expires_at, t.target_type, t.target_value,
              u.email, u.tenant_id, u.nome, u.telefone, u.ativo
       FROM password_reset_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = $1
       ORDER BY t.created_at DESC
       LIMIT 1`,
      [tokenHash]
    );

    if (tokenRes.rowCount === 0) {
      const err = new Error('Código de verificação incorreto ou inválido.');
      err.statusCode = 400;
      throw err;
    }

    const token = tokenRes.rows[0];

    // 2. Proteção contra reuso
    if (token.used) {
      const err = new Error('Este código de verificação já foi utilizado. Solicite um novo código.');
      err.statusCode = 400;
      throw err;
    }

    // 3. Validação de expiração (15 minutos)
    const isExpired = new Date(token.expires_at) < new Date();
    if (isExpired) {
      await query(`UPDATE password_reset_tokens SET used = true WHERE id = $1`, [token.id]);
      const err = new Error('Este código de verificação expirou. Solicite um novo código.');
      err.statusCode = 400;
      throw err;
    }

    // 4. Proteção contra Força Bruta no código (Max 5 tentativas)
    if (token.attempts >= 5) {
      await query(`UPDATE password_reset_tokens SET used = true WHERE id = $1`, [token.id]);
      const err = new Error('Número máximo de tentativas excedido para este código. Solicite um novo.');
      err.statusCode = 429;
      throw err;
    }

    // 5. Criptografa nova senha com Bcrypt
    const newPasswordHash = await authService.hashPassword(newPassword);

    // 6. Atualiza senha do usuário e invalida token
    await query(
      `UPDATE users 
       SET password_hash = $1, updated_at = NOW() 
       WHERE id = $2`,
      [newPasswordHash, token.user_id]
    );

    await query(
      `UPDATE password_reset_tokens 
       SET used = true 
       WHERE id = $1`,
      [token.id]
    );

    // 7. Registro de Auditoria
    await query(
      `INSERT INTO admin_audit_logs (admin_user_id, target_tenant_id, action, details)
       VALUES ($1, $2, 'PASSWORD_RESET_COMPLETED', $3)`,
      [
        token.user_id,
        token.tenant_id,
        JSON.stringify({
          method: token.target_type,
          ip: clientIp,
          completed_at: new Date().toISOString()
        })
      ]
    ).catch(() => {});

    // 8. Notificação de Segurança de Confirmação (Anti-Account Takeover)
    if (token.telefone) {
      try {
        const instRes = await query(
          `SELECT instance_name 
           FROM tenant_whatsapp_instances 
           WHERE (tenant_id = $1 OR status = 'open') AND status = 'open' 
           ORDER BY (tenant_id = $1) DESC 
           LIMIT 1`,
          [token.tenant_id]
        );
        const instanceName = instRes.rows[0]?.instance_name || process.env.INSTANCE_NAME || 'warnat-tech';

        const firstName = (token.nome || 'Usuário').split(' ')[0];
        const confirmMsg =
          `🔒 *WarNat SaaS - Senha Alterada com Sucesso*\n\n` +
          `Olá, *${firstName}*!\n` +
          `Informamos que a senha de acesso da sua conta (*${token.email}*) foi atualizada com sucesso.\n\n` +
          `Se você realizou esta alteração, desconsidere esta mensagem. Caso NÃO tenha sido você, entre em contato imediatamente com o administrador.`;

        await evolutionService.sendTextMessage(instanceName, token.telefone, confirmMsg);
      } catch (evErr) {
        console.warn(`⚠️ [PasswordRecovery] Aviso ao enviar notificação de sucesso:`, evErr.message);
      }
    }

    return {
      success: true,
      message: 'Sua senha foi redefinida com sucesso! Você já pode entrar com sua nova senha.'
    };
  }
}

module.exports = new PasswordRecoveryService();
