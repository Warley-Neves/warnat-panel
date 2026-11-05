-- ==============================================================================
-- SAAS MULTI-TENANT ARCHITECTURE - DATABASE SCHEMA
-- Isolamento estrito por tenant_id, autenticação e mensageria
-- ==============================================================================

-- Habilita extensão para UUID se necessário
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------------------------
-- 1. TABELA DE TENANTS (EMPRESAS CLIENTES DA PLATAFORMA SAAS)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome_empresa VARCHAR(255) NOT NULL,
    documento VARCHAR(30), -- CNPJ / CPF
    plano VARCHAR(50) NOT NULL DEFAULT 'pro', -- 'starter', 'pro', 'enterprise'
    limite_conversas_mes INTEGER NOT NULL DEFAULT 1000,
    ativo BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------------------
-- 2. TABELA DE USUÁRIOS (ADMIN / OPERADORES POR TENANT)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'operador' CHECK (role IN ('admin', 'operador')),
    nome VARCHAR(255) NOT NULL,
    ativo BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------------------
-- 3. INSTÂNCIAS DO WHATSAPP DA EVOLUTION API POR TENANT
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_whatsapp_instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    instance_name VARCHAR(100) NOT NULL UNIQUE,
    instance_token VARCHAR(255),
    numero_telefone VARCHAR(30),
    status VARCHAR(30) NOT NULL DEFAULT 'disconnected' CHECK (status IN ('open', 'connecting', 'disconnected')),
    webhook_url VARCHAR(500),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------------------
-- 4. CONFIGURAÇÕES DE IA POR TENANT (PROMPT COMPILER DINÂMICO)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_ai_configs (
    tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    tom_de_voz VARCHAR(100) NOT NULL DEFAULT 'profissional_humanizado',
    sobre_empresa TEXT NOT NULL,
    servicos_oferecidos JSONB NOT NULL DEFAULT '[]'::jsonb,
    servicos_recusados TEXT,
    regras_agendamento JSONB NOT NULL DEFAULT '{}'::jsonb,
    whatsapp_notificacao_humana VARCHAR(30),
    pausa_automatica_minutos INTEGER NOT NULL DEFAULT 45,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------------------
-- 5. SESSÕES DE CHAT / CONTATOS (ISOLAMENTO POR TENANT + REMOTE_JID)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    remote_jid VARCHAR(100) NOT NULL,
    client_name VARCHAR(255),
    status_atendimento VARCHAR(30) NOT NULL DEFAULT 'ia_ativa' CHECK (status_atendimento IN ('ia_ativa', 'pausa_humana', 'transbordado')),
    paused_until TIMESTAMPTZ,
    dados_lead JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_interaction TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_tenant_remote_jid UNIQUE (tenant_id, remote_jid)
);

-- ------------------------------------------------------------------------------
-- 6. HISTÓRICO DE MENSAGENS DO CHAT
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content TEXT NOT NULL,
    message_id VARCHAR(150), -- ID único retornado pela Evolution API para rastreamento e anti-loop
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------------------
-- ÍNDICES DE PERFORMANCE E ISOLAMENTO MULTI-TENANT
-- ------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_instances_tenant_id ON tenant_whatsapp_instances(tenant_id);
CREATE INDEX IF NOT EXISTS idx_instances_name ON tenant_whatsapp_instances(instance_name);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_tenant_jid ON chat_sessions(tenant_id, remote_jid);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_paused_until ON chat_sessions(paused_until);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_tenant ON chat_messages(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_msg_id ON chat_messages(message_id);
