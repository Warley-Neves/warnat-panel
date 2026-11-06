// ==============================================================================
// Serviço de Autenticação Multi-Tenant & Segurança - WarNat SaaS
// Hashing com Bcrypt e Tokens JWT com Isolamento por tenant_id
// ==============================================================================

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const { query } = require('./db');
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
    const payload = {
      userId: user.id,
      tenantId: user.tenant_id,
      email: user.email,
      role: user.role,
      nome: user.nome
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
  async registerUser({ tenantId, email, password, role = 'operador', nome }) {
    if (!tenantId || !email || !password || !nome) {
      throw new Error('Todos os campos são obrigatórios: tenantId, email, password, nome.');
    }

    const cleanEmail = email.toLowerCase().trim();
    const existing = await query('SELECT id FROM users WHERE email = $1', [cleanEmail]);
    if (existing.rowCount > 0) {
      throw new Error('E-mail já cadastrado na plataforma.');
    }

    const passwordHash = await this.hashPassword(password);
    const result = await query(
      `INSERT INTO users (tenant_id, email, password_hash, role, nome, ativo)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id, tenant_id, email, role, nome, ativo, created_at`,
      [tenantId, cleanEmail, passwordHash, role, nome.trim()]
    );

    return result.rows[0];
  }

  /**
   * Helper alternativo para criar usuário pelo Tenant
   */
  async createUser(tenantId, { nome, email, password, role = 'atendente' }) {
    return this.registerUser({ tenantId, email, password, role, nome });
  }

  /**
   * Lista todos os usuários de um tenant específico
   */
  async listUsers(tenantId) {
    const res = await query(
      `SELECT id, tenant_id, nome, email, role, COALESCE(ativo, true) as ativo, created_at, updated_at
       FROM users
       WHERE tenant_id = $1
       ORDER BY created_at ASC`,
      [tenantId]
    );
    return res.rows;
  }

  /**
   * Atualiza dados de um usuário do tenant
   */
  async updateUser(tenantId, userId, { nome, role, ativo, password }) {
    const updates = [];
    const values = [userId, tenantId];
    let idx = 3;

    if (nome) {
      updates.push(`nome = $${idx++}`);
      values.push(nome.trim());
    }
    if (role) {
      updates.push(`role = $${idx++}`);
      values.push(role);
    }
    if (typeof ativo === 'boolean') {
      updates.push(`ativo = $${idx++}`);
      values.push(ativo);
    }
    if (password && password.trim().length >= 6) {
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
   * Remove um usuário do tenant
   */
  async deleteUser(tenantId, userId) {
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
              t.nome_empresa, t.plano, t.ativo as tenant_ativo
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

    const token = this.generateToken(user);

    return {
      token,
      user: {
        id: user.id,
        tenantId: user.tenant_id,
        email: user.email,
        role: user.role,
        nome: user.nome,
        empresa: user.nome_empresa,
        plano: user.plano
      }
    };
  }

  /**
   * Auto-cadastro de nova Empresa Assinante (Tenant) + Usuário Administrador
   */
  async registerTenantAndAdmin({ nome_empresa, documento, plano = 'start', nome, email, password, sobre_empresa = 'Empresa inovadora atendendo via WhatsApp.' }) {
    if (!nome_empresa || !nome || !email || !password) {
      throw new Error('Campos obrigatórios: nome_empresa, nome, email e password.');
    }

    const cleanEmail = email.toLowerCase().trim();
    const existing = await query('SELECT id FROM users WHERE email = $1;', [cleanEmail]);
    if (existing.rowCount > 0) {
      throw new Error(`O e-mail '${cleanEmail}' já está cadastrado.`);
    }

    // 1. Cria Tenant
    const tenantRes = await query(
      `INSERT INTO tenants (nome_empresa, documento, plano, limite_conversas_mes, ativo)
       VALUES ($1, $2, $3, 300, true)
       RETURNING id, nome_empresa, documento, plano, limite_conversas_mes, ativo, created_at;`,
      [nome_empresa.trim(), documento || null, plano]
    );
    const tenant = tenantRes.rows[0];

    // 2. Hash da senha e insere Usuário Administrador
    const passwordHash = await this.hashPassword(password);
    const userRes = await query(
      `INSERT INTO users (tenant_id, nome, email, password_hash, role)
       VALUES ($1, $2, $3, $4, 'admin')
       RETURNING id, tenant_id, nome, email, role, created_at;`,
      [tenant.id, nome.trim(), cleanEmail, passwordHash]
    );
    const user = userRes.rows[0];

    // 3. Cria configuração de IA inicial padrão para o Tenant
    await query(
      `INSERT INTO tenant_ai_configs (
         tenant_id, tom_de_voz, sobre_empresa, servicos_oferecidos, servicos_recusados, regras_agendamento, pausa_automatica_minutos
       ) VALUES ($1, 'profissional_amigavel', $2, '[]'::jsonb, null, '{"dias":["segunda","terca","quarta","quinta","sexta"],"horario_inicio":"08:00","horario_fim":"18:00"}'::jsonb, 45)
       ON CONFLICT (tenant_id) DO NOTHING;`,
      [tenant.id, sobre_empresa]
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

    // 5. Auto-cria instância na Evolution API para gerar QR Code de imediato
    try {
      await evolutionService.createInstance(instanceSlug, { qrcode: true });
      console.log(`[AuthService] Instância WhatsApp ${instanceSlug} auto-provisionada na Evolution API para a empresa ${nome_empresa}`);
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
        plano: tenant.plano
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
