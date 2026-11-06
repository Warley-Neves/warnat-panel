// ==============================================================================
// SAAS MULTI-TENANT TYPES - DATABASE SCHEMAS & DTOS
// Fully typed definitions for all 8 entities, DTOs and Authentication
// ==============================================================================

/**
 * 1. Empresa Assinante (Tenant)
 */
export interface Tenant {
  id: string; // UUID
  nome_empresa: string;
  documento?: string | null;
  plano: string; // 'start', 'pro', 'enterprise'
  limite_conversas_mes: number;
  ativo: boolean;
  created_at: Date;
  updated_at: Date;
}

/**
 * 2. Usuário Administrativo do Tenant
 */
export type UserRole = 'admin' | 'operador';

export interface User {
  id: string; // UUID
  tenant_id: string; // FK -> tenants.id
  nome: string;
  email: string;
  password_hash: string;
  role: UserRole;
  created_at: Date;
}

export type SafeUser = Omit<User, 'password_hash'>;

/**
 * 3. Instância WhatsApp Evolution API vinculada ao Tenant
 */
export type WhatsappInstanceStatus = 'connecting' | 'open' | 'disconnected';

export interface TenantWhatsappInstance {
  id: string; // UUID
  tenant_id: string; // FK -> tenants.id
  instance_name: string; // UNIQUE
  instance_token?: string | null;
  numero_telefone?: string | null;
  status: WhatsappInstanceStatus;
  webhook_url?: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * 4. Configuração de Inteligência Artificial por Tenant
 */
export interface ServiceOffering {
  nome: string;
  faixa_preco?: string;
  detalhes?: string;
}

export interface TenantAiConfig {
  tenant_id: string; // PK/FK -> tenants.id
  tom_de_voz: string; // default 'profissional_amigavel'
  sobre_empresa: string;
  servicos_oferecidos: ServiceOffering[];
  servicos_recusados?: string | null;
  regras_agendamento: Record<string, unknown>;
  whatsapp_notificacao_humana?: string | null;
  pausa_automatica_minutos: number; // default 45
  updated_at: Date;
}

/**
 * 5. Dossiê Permanente do Cliente Final (Memória de Longo Prazo)
 */
export interface CustomerProfile {
  id: string; // UUID
  tenant_id: string; // FK -> tenants.id
  remote_jid: string;
  nome?: string | null;
  telefone?: string | null;
  endereco_completo?: string | null;
  perfil_resumo?: string | null; // Dossiê cumulativo
  metadados: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

/**
 * 6. Histórico de Agendamentos e Ordens de Serviço
 */
export type AppointmentStatus = 'agendado' | 'concluido' | 'cancelado';

export interface Appointment {
  id: string; // UUID
  tenant_id: string; // FK -> tenants.id
  customer_id?: string | null; // FK -> customer_profiles.id
  remote_jid: string;
  servico: string;
  data_agendada: Date;
  status: AppointmentStatus;
  valor_estimado?: number | null;
  observacoes?: string | null;
  created_at: Date;
}

/**
 * 7. Sessão de Atendimento Human-in-the-Loop
 */
export type SessionStatus = 'ia_ativa' | 'pausa_humana' | 'transbordado';

export interface ChatSession {
  id: string; // UUID
  tenant_id: string; // FK -> tenants.id
  remote_jid: string;
  client_name?: string | null;
  status_atendimento: SessionStatus;
  paused_until?: Date | null;
  dados_lead: Record<string, unknown>;
  last_interaction: Date;
  created_at?: Date;
}

/**
 * 8. Mensagem de Sessão
 */
export type MessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string; // UUID
  session_id: string; // FK -> chat_sessions.id
  tenant_id: string; // FK -> tenants.id
  role: MessageRole;
  content: string;
  message_id?: string | null;
  created_at: Date;
}

// ------------------------------------------------------------------------------
// DTOS PARA REGISTRO, AUTENTICAÇÃO E CADASTRO
// ------------------------------------------------------------------------------

export interface RegisterTenantAdminInput {
  nome_empresa: string;
  documento?: string;
  plano?: string;
  nome: string;
  email: string;
  password: string;
  sobre_empresa?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface TokenPayload {
  userId: string;
  tenantId: string;
  email: string;
  role: UserRole;
  nome: string;
}

export interface AuthResult {
  token: string;
  user: SafeUser;
  tenant: Tenant;
}
