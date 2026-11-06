-- ==============================================================================
-- SAAS MULTI-TENANT ENGINE - PRODUCTION DATABASE SCHEMA (8 TABLES)
-- Strict tenant_id isolation, cumulative customer memory & authentication
-- ==============================================================================

-- Habilita extensão para UUID se necessário
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ------------------------------------------------------------------------------
-- 1. Empresas Assinantes (Tenants)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nome_empresa VARCHAR(150) NOT NULL,
    documento VARCHAR(20),
    plano VARCHAR(50) DEFAULT 'start',
    limite_conversas_mes INT DEFAULT 300,
    ativo BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------------------------------------------------------------
-- 2. Usuários Administrativos do Tenant
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    nome VARCHAR(100) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) DEFAULT 'admin',
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_tenant_email ON users(tenant_id, email);
CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users(tenant_id);

-- ------------------------------------------------------------------------------
-- 3. Instâncias de Conexão WhatsApp (Evolution API)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_whatsapp_instances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    instance_name VARCHAR(100) UNIQUE NOT NULL,
    instance_token VARCHAR(255),
    numero_telefone VARCHAR(25),
    status VARCHAR(30) DEFAULT 'disconnected', -- 'connecting', 'open', 'disconnected'
    webhook_url VARCHAR(500),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_instances_tenant_id ON tenant_whatsapp_instances(tenant_id);

-- ------------------------------------------------------------------------------
-- 4. Configurações Comerciais e Regras da IA por Tenant
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_ai_configs (
    tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    tom_de_voz VARCHAR(50) DEFAULT 'profissional_amigavel',
    sobre_empresa TEXT NOT NULL,
    servicos_oferecidos JSONB NOT NULL DEFAULT '[]', -- [{ "nome": "...", "faixa_preco": "...", "detalhes": "..." }]
    servicos_recusados TEXT,
    regras_agendamento JSONB DEFAULT '{}',
    whatsapp_notificacao_humana VARCHAR(25),
    pausa_automatica_minutos INT DEFAULT 45,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------------------------------------------------------------
-- 5. Dossiê Permanente do Cliente Final (Memória de Longo Prazo)
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customer_profiles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    remote_jid VARCHAR(60) NOT NULL,
    nome VARCHAR(100),
    telefone VARCHAR(25),
    endereco_completo TEXT,
    perfil_resumo TEXT, -- Resumo cumulativo de interações anteriores e preferências
    metadados JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uk_tenant_customer UNIQUE(tenant_id, remote_jid)
);
CREATE INDEX IF NOT EXISTS idx_customer_lookup ON customer_profiles(tenant_id, remote_jid);

-- ------------------------------------------------------------------------------
-- 6. Histórico de Agendamentos e Ordens de Serviço
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS appointments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    customer_id UUID REFERENCES customer_profiles(id) ON DELETE SET NULL,
    remote_jid VARCHAR(60) NOT NULL,
    servico VARCHAR(150) NOT NULL,
    data_agendada TIMESTAMPTZ NOT NULL,
    status VARCHAR(30) DEFAULT 'agendado', -- 'agendado', 'concluido', 'cancelado'
    valor_estimado NUMERIC(10, 2),
    observacoes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_appointments_lookup ON appointments(tenant_id, remote_jid, data_agendada DESC);

-- ------------------------------------------------------------------------------
-- 7. Sessões de Atendimento e Human-in-the-Loop
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    remote_jid VARCHAR(60) NOT NULL,
    status_atendimento VARCHAR(30) DEFAULT 'ia_ativa', -- 'ia_ativa', 'pausa_humana', 'transbordado'
    paused_until TIMESTAMPTZ,
    dados_lead JSONB DEFAULT '{}',
    last_interaction TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uk_tenant_session UNIQUE(tenant_id, remote_jid)
);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_tenant_jid ON chat_sessions(tenant_id, remote_jid);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_paused_until ON chat_sessions(paused_until);

-- ------------------------------------------------------------------------------
-- 8. Mensagens da Sessão
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    role VARCHAR(20) NOT NULL, -- 'user', 'assistant', 'system'
    content TEXT NOT NULL,
    message_id VARCHAR(150), -- Rastreamento único Evolution API (anti-loop)
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_flow ON chat_messages(session_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_tenant ON chat_messages(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_msg_id ON chat_messages(message_id);

-- ------------------------------------------------------------------------------
-- ADAPTAÇÃO IDEMPOTENTE PARA TABELAS PRÉ-EXISTENTES
-- ------------------------------------------------------------------------------
DO $$
BEGIN
    -- Garante constraint uk_tenant_session caso já existisse sob outro nome
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'uk_tenant_session'
    ) THEN
        IF EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'uq_tenant_remote_jid'
        ) THEN
            ALTER TABLE chat_sessions RENAME CONSTRAINT uq_tenant_remote_jid TO uk_tenant_session;
        ELSE
            ALTER TABLE chat_sessions ADD CONSTRAINT uk_tenant_session UNIQUE(tenant_id, remote_jid);
        END IF;
    END IF;

    -- Garante coluna message_id em chat_messages
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'chat_messages' AND column_name = 'message_id'
    ) THEN
        ALTER TABLE chat_messages ADD COLUMN message_id VARCHAR(150);
    END IF;
END $$;
