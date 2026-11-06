// ==============================================================================
// SAAS MULTI-TENANT ENGINE - AUTHENTICATION SERVICE (TYPESCRIPT)
// Multi-tenant registration, password hashing (bcrypt) and JWT issuance
// ==============================================================================

import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query, withTransaction } from '../database/db';
import { evolutionService } from './evolution.service';
import {
  Tenant,
  User,
  SafeUser,
  RegisterTenantAdminInput,
  LoginInput,
  AuthResult,
  TokenPayload
} from '../types/database.types';

const BCRYPT_ROUNDS = 10;
const JWT_SECRET = process.env.PANEL_JWT_SECRET || 'warnat_saas_multi_tenant_secret_key_2026';
const JWT_EXPIRES_IN = '7d';

export class AuthService {
  /**
   * Gera hash seguro para senha usando bcrypt
   */
  public static async hashPassword(password: string): Promise<string> {
    return await bcrypt.hash(password, BCRYPT_ROUNDS);
  }

  /**
   * Compara uma senha em texto com o hash armazenado
   */
  public static async comparePassword(password: string, hash: string): Promise<boolean> {
    return await bcrypt.compare(password, hash);
  }

  /**
   * Emite token JWT assinado contendo o contexto do tenant
   */
  public static generateToken(payload: TokenPayload): string {
    return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  }

  /**
   * Valida e decodifica o token JWT
   */
  public static verifyToken(token: string): TokenPayload | null {
    try {
      const decoded = jwt.verify(token, JWT_SECRET) as TokenPayload;
      return decoded;
    } catch {
      return null;
    }
  }

  /**
   * Auto-cadastro atômico de uma nova Empresa Assinante (Tenant) + Usuário Administrador
   */
  public static async registerTenantAndAdmin(
    input: RegisterTenantAdminInput
  ): Promise<AuthResult> {
    const {
      nome_empresa,
      documento,
      plano = 'start',
      nome,
      email,
      password,
      sobre_empresa = 'Empresa inovadora atendendo via WhatsApp.'
    } = input;

    if (!nome_empresa || !nome || !email || !password) {
      throw new Error('Campos obrigatórios: nome_empresa, nome, email e password.');
    }

    const normalizedEmail = email.toLowerCase().trim();

    return await withTransaction<AuthResult>(async (client) => {
      // 1. Verifica se e-mail já existe
      const existingUser = await client.query('SELECT id FROM users WHERE email = $1;', [normalizedEmail]);
      if (existingUser.rows.length > 0) {
        throw new Error(`O e-mail '${normalizedEmail}' já está cadastrado no sistema.`);
      }

      // 2. Insere Tenant
      const tenantRes = await client.query<Tenant>(
        `INSERT INTO tenants (nome_empresa, documento, plano, limite_conversas_mes, ativo)
         VALUES ($1, $2, $3, $4, true)
         RETURNING id, nome_empresa, documento, plano, limite_conversas_mes, ativo, created_at, updated_at;`,
        [nome_empresa.trim(), documento || null, plano, 300]
      );
      const tenant = tenantRes.rows[0];

      // 3. Hash da senha e insere Usuário Administrador
      const passwordHash = await this.hashPassword(password);
      const userRes = await client.query<User>(
        `INSERT INTO users (tenant_id, nome, email, password_hash, role)
         VALUES ($1, $2, $3, $4, 'admin')
         RETURNING id, tenant_id, nome, email, password_hash, role, created_at;`,
        [tenant.id, nome.trim(), normalizedEmail, passwordHash]
      );
      const rawUser = userRes.rows[0];

      // 4. Cria configuração de IA inicial padrão para o Tenant
      await client.query(
        `INSERT INTO tenant_ai_configs (
           tenant_id, tom_de_voz, sobre_empresa, servicos_oferecidos, servicos_recusados, regras_agendamento, pausa_automatica_minutos
         ) VALUES ($1, $2, $3, $4::jsonb, $5, $6::jsonb, 45)
         ON CONFLICT (tenant_id) DO NOTHING;`,
        [
          tenant.id,
          'profissional_amigavel',
          sobre_empresa,
          JSON.stringify([]),
          null,
          JSON.stringify({ dias: ['segunda', 'terca', 'quarta', 'quinta', 'sexta'], horario_inicio: '08:00', horario_fim: '18:00' })
        ]
      );

      // 5. Cria Instância do WhatsApp no banco de dados para a nova Empresa
      const cleanCompanySlug = nome_empresa.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '') || 'empresa';
      const instanceSlug = `${cleanCompanySlug}-${String(tenant.id).slice(0, 6)}`;

      await client.query(
        `INSERT INTO tenant_whatsapp_instances (tenant_id, instance_name, instance_token, status)
         VALUES ($1, $2, $3, 'connecting')
         ON CONFLICT (tenant_id) DO UPDATE SET instance_name = EXCLUDED.instance_name, updated_at = now();`,
        [tenant.id, instanceSlug, `token-${instanceSlug}`]
      );

      try {
        await evolutionService.createInstance(instanceSlug, { qrcode: true });
      } catch (evErr: any) {
        console.warn(`[AuthService] Aviso ao auto-provisionar instância ${instanceSlug}:`, evErr.message);
      }

      const safeUser: SafeUser = {
        id: rawUser.id,
        tenant_id: rawUser.tenant_id,
        nome: rawUser.nome,
        email: rawUser.email,
        role: rawUser.role,
        created_at: rawUser.created_at
      };

      const token = this.generateToken({
        userId: safeUser.id,
        tenantId: tenant.id,
        email: safeUser.email,
        role: safeUser.role,
        nome: safeUser.nome
      });

      return {
        token,
        user: safeUser,
        tenant
      };
    });
  }

  /**
   * Login autenticado de usuário com validação de senha e tenant ativo
   */
  public static async login(input: LoginInput): Promise<AuthResult> {
    const { email, password } = input;
    if (!email || !password) {
      throw new Error('E-mail e senha são obrigatórios.');
    }

    const normalizedEmail = email.toLowerCase().trim();

    // 1. Busca usuário
    const userRes = await query<User>(
      `SELECT id, tenant_id, nome, email, password_hash, role, created_at
       FROM users 
       WHERE email = $1;`,
      [normalizedEmail]
    );

    if (userRes.rows.length === 0) {
      throw new Error('Credenciais inválidas: e-mail ou senha incorretos.');
    }

    const user = userRes.rows[0];

    // 2. Valida hash da senha
    const isValidPassword = await this.comparePassword(password, user.password_hash);
    if (!isValidPassword) {
      throw new Error('Credenciais inválidas: e-mail ou senha incorretos.');
    }

    // 3. Valida se o Tenant está ativo
    const tenantRes = await query<Tenant>(
      `SELECT id, nome_empresa, documento, plano, limite_conversas_mes, ativo, created_at, updated_at
       FROM tenants
       WHERE id = $1;`,
      [user.tenant_id]
    );

    if (tenantRes.rows.length === 0 || !tenantRes.rows[0].ativo) {
      throw new Error('Acesso negado: a conta da sua empresa está inativa ou suspensa.');
    }

    const tenant = tenantRes.rows[0];

    const safeUser: SafeUser = {
      id: user.id,
      tenant_id: user.tenant_id,
      nome: user.nome,
      email: user.email,
      role: user.role,
      created_at: user.created_at
    };

    const token = this.generateToken({
      userId: safeUser.id,
      tenantId: tenant.id,
      email: safeUser.email,
      role: safeUser.role,
      nome: safeUser.nome
    });

    return {
      token,
      user: safeUser,
      tenant
    };
  }

  /**
   * Busca tenant por ID
   */
  public static async getTenantById(tenantId: string): Promise<Tenant | null> {
    const res = await query<Tenant>(
      `SELECT id, nome_empresa, documento, plano, limite_conversas_mes, ativo, created_at, updated_at
       FROM tenants
       WHERE id = $1;`,
      [tenantId]
    );
    return res.rows[0] || null;
  }

  /**
   * Busca usuário por ID (sem hash da senha)
   */
  public static async getUserById(userId: string): Promise<SafeUser | null> {
    const res = await query<SafeUser>(
      `SELECT id, tenant_id, nome, email, role, created_at
       FROM users
       WHERE id = $1;`,
      [userId]
    );
    return res.rows[0] || null;
  }
}
