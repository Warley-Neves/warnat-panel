// ==============================================================================
// Serviço de Autenticação Multi-Tenant & Segurança - WarNat SaaS
// Hashing com Bcrypt e Tokens JWT com Isolamento por tenant_id
// ==============================================================================

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const { query, getClient } = require('./db');
const evolutionService = require('../services/evolution.service');

// Carregar variáveis de ambiente
const envPath = path.resolve(__dirname, '..', '.env');
const envMap = {};
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      envMap[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
    }
  });
}

const JWT_SECRET = process.env.PANEL_JWT_SECRET || envMap['PANEL_JWT_SECRET'] || 'warnat-saas-jwt-secret-key-2026';
const JWT_EXPIRES_IN = '7d';
const SALT_ROUNDS = 10;

class AuthService {
  /**
   * Gera hash seguro para senha do usuário
   */
  async hashPassword(password) {
    if (!password || typeof password !== 'string') {
      throw new Error('Senha inválida para hash.');
    }
    return await bcrypt.hash(password, SALT_ROUNDS);
  }

  /**
   * Compara senha informada com o hash salvo no banco
   */
  async comparePassword(password, hash) {
    if (!password || !hash) return false;
    return await bcrypt.compare(password, hash);
  }

  /**
   * Gera token JWT assinado com contexto multi-tenant
   */
  generateToken(user) {
    const isSuper = !!(user.is_super_admin || user.isSuperAdmin || (user.email && user.email.toLowerCase() === 'admin@warnattech.com.br'));
    const payload = {
      userId: user.id || user.userId,
      tenantId: user.tenant_id || user.tenantId,
      email: user.email,
      role: user.role,
      nome: user.nome,
      isSuperAdmin: isSuper,
      impersonated: !!user.impersonated,
      originalTenantId: user.originalTenantId || null
    };
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  }

  /**
   * Valida e decodifica o token JWT
   */
  verifyToken(token) {
    try {
      if (!token || typeof token !== 'string') return null;
      const cleanToken = token.replace(/^Bearer\s+/i, '').trim();
      return jwt.verify(cleanToken, JWT_SECRET);
    } catch (err) {
      return null;
    }
  }

  /**
   * Cadastra novo usuário vinculado a um tenant
   */
  async registerUser({ tenantId, email, password, role = 'operador', nome, departmentId = null }) {
    if (!tenantId || !email || !password || !nome) {
      throw new Error('Todos os campos são obrigatórios: tenantId, email, password, nome.');
    }

    const cleanEmail = email.toLowerCase().trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      throw new Error('Formato de e-mail inválido.');
    }

    if (password.length < 6) {
      throw new Error('A senha deve conter no mínimo 6 caracteres.');
    }

    const validRoles = ['admin', 'supervisor', 'atendente'];
    const safeRole = validRoles.includes(role) ? role : 'atendente';

    const existing = await query('SELECT id FROM users WHERE email = $1', [cleanEmail]);
    if (existing.rowCount > 0) {
      throw new Error('E-mail já cadastrado na plataforma.');
    }

    const passwordHash = await this.hashPassword(password);
    const result = await query(
      `INSERT INTO users (tenant_id, email, password_hash, role, nome, department_id, ativo)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       RETURNING id, tenant_id, email, role, nome, department_id, ativo, created_at`,
      [tenantId, cleanEmail, passwordHash, safeRole, nome.trim(), departmentId || null]
    );

    return result.rows[0];
  }

  /**
   * Helper alternativo para criar usuário pelo Tenant
   */
  async createUser(tenantId, { nome, email, password, role = 'atendente', departmentId = null }) {
    return this.registerUser({ tenantId, email, password, role, nome, departmentId });
  }

  /**
   * Lista todos os usuários de um tenant específico com suas equipes/departamentos
   */
  async listUsers(tenantId) {
    const res = await query(
      `SELECT u.id, u.tenant_id, u.nome, u.email, u.role, COALESCE(u.ativo, true) as ativo,
              u.department_id, d.nome as department_name, d.cor as department_cor,
              u.created_at, u.updated_at
       FROM users u
       LEFT JOIN departments d ON u.department_id = d.id
       WHERE u.tenant_id = $1
       ORDER BY u.created_at ASC`,
      [tenantId]
    );
    return res.rows;
  }

  /**
   * Atualiza dados de um usuário do tenant
   */
  async updateUser(tenantId, userId, { nome, role, ativo, password, departmentId, department_id }) {
    const updates = [];
    const values = [userId, tenantId];
    let idx = 3;

    if (nome) {
      updates.push(`nome = $${idx++}`);
      values.push(nome.trim());
    }
    if (role) {
      const validRoles = ['admin', 'supervisor', 'atendente'];
      if (!validRoles.includes(role)) {
        throw new Error('Cargo de usuário inválido.');
      }
      updates.push(`role = $${idx++}`);
      values.push(role);
    }
    if (typeof ativo === 'boolean') {
      updates.push(`ativo = $${idx++}`);
      values.push(ativo);
    }
    const resolvedDeptId = departmentId !== undefined ? departmentId : department_id;
    if (resolvedDeptId !== undefined) {
      updates.push(`department_id = $${idx++}`);
      values.push(resolvedDeptId || null);
    }
    if (password !== undefined) {
      if (typeof password !== 'string' || password.trim().length < 6) {
        throw new Error('A nova senha deve conter no mínimo 6 caracteres.');
      }
      const hash = await this.hashPassword(password.trim());
      updates.push(`password_hash = $${idx++}`);
      values.push(hash);
    }

    if (updates.length === 0) return null;

    updates.push(`updated_at = NOW()`);

    const res = await query(
      `UPDATE users
       SET ${updates.join(', ')}
       WHERE id = $1 AND tenant_id = $2
       RETURNING id, tenant_id, nome, email, role, COALESCE(ativo, true) as ativo, created_at, updated_at`,
      values
    );

    return res.rows[0] || null;
  }

  /**
   * Remove um usuário do tenant com proteção para o último administrador
   */
  async deleteUser(tenantId, userId) {
    // Impede a remoção se este for o único administrador ativo do tenant
    const adminCheck = await query(
      `SELECT id FROM users WHERE tenant_id = $1 AND role = 'admin' AND COALESCE(ativo, true) = true`,
      [tenantId]
    );
    if (adminCheck.rowCount <= 1 && adminCheck.rows[0]?.id === userId) {
      throw new Error('Não é permitido remover o único administrador ativo da empresa.');
    }

    const res = await query(
      `DELETE FROM users WHERE id = $1 AND tenant_id = $2 RETURNING id`,
      [userId, tenantId]
    );
    return res.rowCount > 0;
  }

  /**
   * Autentica usuário e retorna token JWT + dados do tenant
   */
  async login(email, password) {
    if (!email || !password) {
      throw new Error('E-mail e senha são obrigatórios.');
    }

    const cleanEmail = email.toLowerCase().trim();
    const res = await query(
      `SELECT u.id, u.tenant_id, u.email, u.password_hash, u.role, u.nome, COALESCE(u.ativo, true) as user_ativo,
              COALESCE(u.is_super_admin, false) as is_super_admin,
              u.privacy_policy_accepted_at, u.privacy_policy_version,
              t.nome_empresa, t.plano, COALESCE(t.status, 'TRIALING') as tenant_status,
              t.trial_ends_at, COALESCE(t.is_manually_blocked, false) as is_manually_blocked,
              t.ativo as tenant_ativo
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       WHERE u.email = $1`,
      [cleanEmail]
    );

    if (res.rowCount === 0) {
      throw new Error('Credenciais inválidas: e-mail ou senha incorretos.');
    }

    const user = res.rows[0];

    if (!user.tenant_ativo) {
      throw new Error('Empresa/Tenant desativado. Contate o suporte.');
    }

    if (!user.user_ativo) {
      throw new Error('Acesso bloqueado: Este usuário foi desativado pelo administrador.');
    }

    const isValid = await this.comparePassword(password, user.password_hash);
    if (!isValid) {
      throw new Error('Credenciais inválidas.');
    }

    const isSuper = !!(user.is_super_admin || cleanEmail === 'admin@warnattech.com.br');
    if (isSuper && !user.is_super_admin) {
      user.is_super_admin = true;
      await query(`UPDATE users SET is_super_admin = true WHERE id = $1`, [user.id]).catch(() => {});
    }

    const token = this.generateToken({ ...user, is_super_admin: isSuper });

    return {
      token,
      user: {
        id: user.id,
        tenantId: user.tenant_id,
        email: user.email,
        role: user.role,
        nome: user.nome,
        empresa: user.nome_empresa,
        plano: user.plano,
        status: user.tenant_status,
        trialEndsAt: user.trial_ends_at,
        isManuallyBlocked: user.is_manually_blocked,
        isSuperAdmin: isSuper,
        privacyPolicyAcceptedAt: user.privacy_policy_accepted_at,
        privacyPolicyVersion: user.privacy_policy_version,
        privacyPolicyAccepted: Boolean(user.privacy_policy_accepted_at && user.privacy_policy_version === 'v1.0')
      }
    };
  }

  /**
   * Registra consentimento do usuário à Política de Privacidade (LGPD)
   */
  async recordConsent(userId, tenantId, policyVersion = 'v1.0', ipAddress = null, userAgent = null) {
    const client = await getClient();
    try {
      await client.query('BEGIN');
      const updatedUser = await client.query(
        `UPDATE users
         SET privacy_policy_accepted_at = NOW(),
             privacy_policy_version = $2,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, nome, email, privacy_policy_accepted_at, privacy_policy_version`,
        [userId, policyVersion]
      );

      await client.query(
        `INSERT INTO user_consents (user_id, tenant_id, policy_version, accepted_at, ip_address, user_agent)
         VALUES ($1, $2, $3, NOW(), $4, $5)`,
        [userId, tenantId, policyVersion, ipAddress, userAgent]
      );

      await client.query('COMMIT');
      return {
        success: true,
        accepted_at: updatedUser.rows[0]?.privacy_policy_accepted_at,
        version: policyVersion
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Auto-cadastro de nova Empresa Assinante (Tenant) + Usuário Administrador
   */
  async registerTenantAndAdmin({
    nome_empresa,
    documento,
    plano = 'start',
    nome,
    email,
    password,
    sobre_empresa = 'Empresa inovadora atendendo via WhatsApp.',
    privacy_policy_accepted = true,
    ipAddress = null,
    userAgent = null
  }) {
    if (!nome_empresa || !nome || !email || !password) {
      throw new Error('Campos obrigatórios: nome_empresa, nome, email e password.');
    }

    const cleanEmail = email.toLowerCase().trim();
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(cleanEmail)) {
      throw new Error('Formato de e-mail inválido.');
    }

    if (typeof password !== 'string' || password.length < 6) {
      throw new Error('A senha deve conter no mínimo 6 caracteres.');
    }

    const existing = await query('SELECT id FROM users WHERE email = $1;', [cleanEmail]);
    if (existing.rowCount > 0) {
      throw new Error(`O e-mail '${cleanEmail}' já está cadastrado.`);
    }

    // 1. Cria Tenant com Free Trial de 7 dias
    const tenantRes = await query(
      `INSERT INTO tenants (nome_empresa, documento, plano, limite_conversas_mes, ativo, status, trial_ends_at, is_manually_blocked)
       VALUES ($1, $2, $3, 300, true, 'TRIALING', NOW() + INTERVAL '7 days', false)
       RETURNING id, nome_empresa, documento, plano, limite_conversas_mes, ativo, status, trial_ends_at, created_at;`,
      [nome_empresa.trim(), documento || null, plano || 'pro']
    );
    const tenant = tenantRes.rows[0];

    // 2. Hash da senha e insere Usuário Administrador
    const isSuper = cleanEmail.includes('admin@warnattech') || cleanEmail.includes('superadmin');
    const passwordHash = await this.hashPassword(password);
    const policyAcceptedAt = privacy_policy_accepted ? new Date() : null;
    const policyVersion = privacy_policy_accepted ? 'v1.0' : null;

    const userRes = await query(
      `INSERT INTO users (tenant_id, nome, email, password_hash, role, is_super_admin, privacy_policy_accepted_at, privacy_policy_version)
       VALUES ($1, $2, $3, $4, 'admin', $5, $6, $7)
       RETURNING id, tenant_id, nome, email, role, is_super_admin, privacy_policy_accepted_at, privacy_policy_version, created_at;`,
      [tenant.id, nome.trim(), cleanEmail, passwordHash, isSuper, policyAcceptedAt, policyVersion]
    );
    const user = userRes.rows[0];

    if (privacy_policy_accepted) {
      await query(
        `INSERT INTO user_consents (user_id, tenant_id, policy_version, accepted_at, ip_address, user_agent)
         VALUES ($1, $2, 'v1.0', NOW(), $3, $4);`,
        [user.id, tenant.id, ipAddress || null, userAgent || null]
      ).catch(e => console.warn('[AuthService] Erro ao gravar user_consents no cadastro:', e.message));
    }

    // 3. Cria configuração de IA inicial padrão para o Tenant com nicho personalizado
    const nomeLower = nome_empresa.toLowerCase();
    const isVelas = nomeLower.includes('vela') || nomeLower.includes('aroma');
    const isCftv = nomeLower.includes('cftv') || nomeLower.includes('camera') || nomeLower.includes('câmera') || nomeLower.includes('segurança');
    
    const initialNicho = isVelas ? 'Velas Artesanais & Aromatizadores' : (isCftv ? 'Segurança Eletrônica & CFTV' : 'Comércio e Atendimento');
    const initialTipo = isVelas ? 'produtos' : 'servicos';
    const initialObjetivo = isVelas ? 'venda_produtos' : 'agendamento';
    const initialTaxa = isCftv ? 140.00 : null;

    await query(
      `INSERT INTO tenant_ai_configs (
         tenant_id, nome_assistente, responsavel_tecnico, regiao_atendimento, taxa_manutencao_reais,
         tom_de_voz, sobre_empresa, servicos_oferecidos, servicos_recusados, regras_agendamento, pausa_automatica_minutos,
         nicho_atuacao, tipo_negocio, objetivo_funil, tempo_resposta_segundos
       ) VALUES ($1, 'Nat', $2, 'Atendimento em toda a região', $3, 'profissional_humanizado', $4, '[]'::jsonb, null,
         '{"dias":["segunda","terca","quarta","quinta","sexta","sabado"],"horario_inicio":"08:00","horario_fim":"18:00","slots_agendamento":["08:00","10:00","14:00","16:00"]}'::jsonb,
         45, $5, $6, $7, 3)
       ON CONFLICT (tenant_id) DO NOTHING;`,
      [tenant.id, nome.trim(), initialTaxa, sobre_empresa, initialNicho, initialTipo, initialObjetivo]
    );

    // 4. Cria Instância do WhatsApp no banco de dados para a nova Empresa
    const cleanCompanySlug = nome_empresa.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'empresa';
    const instanceSlug = `${cleanCompanySlug}-${String(tenant.id).slice(0, 6)}`;

    await query(
      `INSERT INTO tenant_whatsapp_instances (tenant_id, instance_name, instance_token, status)
       VALUES ($1, $2, $3, 'connecting')
       ON CONFLICT (tenant_id) DO UPDATE SET instance_name = EXCLUDED.instance_name, updated_at = now()`,
      [tenant.id, instanceSlug, `token-${instanceSlug}`]
    );

    // 5. Auto-cria instância na Evolution API para gerar QR Code de imediato e vincula o webhook
    try {
      await evolutionService.createInstance(instanceSlug, { qrcode: true });
      const webhookUrl = evolutionService.getDefaultWebhookUrl ? evolutionService.getDefaultWebhookUrl() : 'https://warnat-panel.onrender.com/api/webhook/whatsapp';
      await evolutionService.setWebhook(instanceSlug, webhookUrl).catch(() => {});
      console.log(`[AuthService] Instância WhatsApp ${instanceSlug} auto-provisionada e webhook configurado para a empresa ${nome_empresa}`);
    } catch (evErr) {
      console.warn(`[AuthService] Aviso ao provisionar instância ${instanceSlug} na Evolution API:`, evErr.message);
    }

    const token = this.generateToken(user);

    return {
      token,
      user: {
        id: user.id,
        tenantId: tenant.id,
        email: user.email,
        role: user.role,
        nome: user.nome,
        empresa: tenant.nome_empresa,
        plano: tenant.plano,
        status: tenant.status,
        trialEndsAt: tenant.trial_ends_at,
        isSuperAdmin: !!user.is_super_admin,
        privacyPolicyAcceptedAt: user.privacy_policy_accepted_at,
        privacyPolicyVersion: user.privacy_policy_version,
        privacyPolicyAccepted: Boolean(user.privacy_policy_accepted_at && user.privacy_policy_version === 'v1.0')
      },
      tenant
    };
  }

  /**
   * Middleware para extrair e validar autenticação em requisições HTTP
   */
  authenticateRequest(req) {
    const authHeader = req.headers['authorization'] || '';
    const customHeader = req.headers['x-admin-token'] || '';
    const token = authHeader || customHeader;

    if (!token) return null;
    return this.verifyToken(token);
  }
}

module.exports = new AuthService();
