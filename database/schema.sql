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
    role VARCHAR(20) DEFAULT 'admin', -- 'admin', 'supervisor', 'atendente'
    ativo BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
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
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_tenant_whatsapp_instances_tenant'
  ) THEN
    ALTER TABLE tenant_whatsapp_instances ADD CONSTRAINT uq_tenant_whatsapp_instances_tenant UNIQUE (tenant_id);
  END IF;
END $$;

-- ------------------------------------------------------------------------------
-- 4. Configurações Comerciais e Regras da IA por Tenant
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenant_ai_configs (
    tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    modo_atendimento VARCHAR(30) DEFAULT 'automacao', -- 'automacao' (IA ativa) ou 'manual' (atendimento humano para todo o tenant)
    nome_assistente VARCHAR(60) DEFAULT 'Natália',
    responsavel_tecnico VARCHAR(100) DEFAULT 'Warley Santos',
    regiao_atendimento VARCHAR(150) DEFAULT 'Belo Horizonte, Barreiro e Grande BH',
    taxa_manutencao_reais NUMERIC(10,2) DEFAULT 140.00,
    tom_de_voz VARCHAR(50) DEFAULT 'profissional_amigavel',
    sobre_empresa TEXT NOT NULL,
    servicos_oferecidos JSONB NOT NULL DEFAULT '[]', -- [{ "nome": "...", "faixa_preco": "...", "detalhes": "..." }]
    servicos_recusados TEXT,
    regras_agendamento JSONB DEFAULT '{}',
    instrucoes_personalizadas TEXT,
    whatsapp_notificacao_humana VARCHAR(25),
    pausa_automatica_minutos INT DEFAULT 45,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Migrações seguras idempotentes para tenant_ai_configs
ALTER TABLE tenant_ai_configs ADD COLUMN IF NOT EXISTS modo_atendimento VARCHAR(30) DEFAULT 'automacao';
ALTER TABLE tenant_ai_configs ADD COLUMN IF NOT EXISTS nome_assistente VARCHAR(60) DEFAULT 'Natália';
ALTER TABLE tenant_ai_configs ADD COLUMN IF NOT EXISTS responsavel_tecnico VARCHAR(100) DEFAULT 'Warley Santos';
ALTER TABLE tenant_ai_configs ADD COLUMN IF NOT EXISTS regiao_atendimento VARCHAR(150) DEFAULT 'Belo Horizonte, Barreiro e Grande BH';
ALTER TABLE tenant_ai_configs ADD COLUMN IF NOT EXISTS taxa_manutencao_reais NUMERIC(10,2) DEFAULT 140.00;
ALTER TABLE tenant_ai_configs ADD COLUMN IF NOT EXISTS instrucoes_personalizadas TEXT;
ALTER TABLE tenant_ai_configs ADD COLUMN IF NOT EXISTS atender_chamadas BOOLEAN DEFAULT true;
ALTER TABLE tenant_ai_configs ADD COLUMN IF NOT EXISTS mensagem_chamada TEXT DEFAULT 'Olá! Vi que você tentou me ligar por chamada. Como sou a assistente virtual Nat e nossos técnicos estão em visitas técnicas em campo, nosso atendimento aqui pelo WhatsApp é realizado com total agilidade por mensagens de áudio e texto! Como posso te ajudar agora? Pode me mandar um áudio ou escrever aqui o que precisa!';
ALTER TABLE tenant_ai_configs ADD COLUMN IF NOT EXISTS responder_com_audio VARCHAR(30) DEFAULT 'texto';
ALTER TABLE tenant_ai_configs ALTER COLUMN responder_com_audio SET DEFAULT 'texto';
ALTER TABLE tenant_ai_configs ADD COLUMN IF NOT EXISTS voz_ia VARCHAR(20) DEFAULT 'nova';
ALTER TABLE tenant_ai_configs ADD COLUMN IF NOT EXISTS nicho_atuacao VARCHAR(150);
ALTER TABLE tenant_ai_configs ADD COLUMN IF NOT EXISTS tipo_negocio VARCHAR(50) DEFAULT 'servicos';
ALTER TABLE tenant_ai_configs ADD COLUMN IF NOT EXISTS objetivo_funil VARCHAR(100) DEFAULT 'agendamento';
ALTER TABLE tenant_ai_configs ADD COLUMN IF NOT EXISTS pergunta_inicial_qualificacao TEXT;
ALTER TABLE tenant_ai_configs ADD COLUMN IF NOT EXISTS diretrizes_funil TEXT;
ALTER TABLE tenant_ai_configs ADD COLUMN IF NOT EXISTS politicas_comerciais TEXT;

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
    tipo_agendamento VARCHAR(50) DEFAULT 'VISITA_TECNICA',
    endereco TEXT,
    google_event_id VARCHAR(255),
    google_event_link TEXT,
    valor_estimado NUMERIC(10, 2),
    observacoes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_appointments_lookup ON appointments(tenant_id, remote_jid, data_agendada DESC);

-- Migrações seguras idempotentes para appointments
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS client_name VARCHAR(150);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS tipo_agendamento VARCHAR(50) DEFAULT 'VISITA_TECNICA';
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS endereco TEXT;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS google_event_id VARCHAR(255);
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS google_event_link TEXT;

-- ------------------------------------------------------------------------------
-- 7. Sessões de Atendimento e Human-in-the-Loop
-- ------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    remote_jid VARCHAR(60) NOT NULL,
    client_name VARCHAR(150),
    status_atendimento VARCHAR(30) DEFAULT 'ia_ativa' CHECK (status_atendimento IN ('ia_ativa', 'pausa_humana', 'transbordado', 'manual')),
    etapa_funil VARCHAR(30) DEFAULT 'novo', -- 'novo', 'qualificacao', 'manual', 'agendado', 'concluido', 'perdido'
    atendente_id UUID REFERENCES users(id) ON DELETE SET NULL,
    paused_until TIMESTAMPTZ,
    dados_lead JSONB DEFAULT '{}',
    last_interaction TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
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
    media_type VARCHAR(30) DEFAULT 'text', -- 'text', 'audio', 'call_voice', 'call_video', 'image', 'document'
    media_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_flow ON chat_messages(session_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_tenant ON chat_messages(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_msg_id ON chat_messages(message_id);

-- Migrações seguras idempotentes para chat_messages
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS media_type VARCHAR(30) DEFAULT 'text';
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS media_url TEXT;

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

    -- Garante colunas client_name e created_at em chat_sessions
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'chat_sessions' AND column_name = 'client_name'
    ) THEN
        ALTER TABLE chat_sessions ADD COLUMN client_name VARCHAR(150);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'chat_sessions' AND column_name = 'created_at'
    ) THEN
        ALTER TABLE chat_sessions ADD COLUMN created_at TIMESTAMPTZ DEFAULT NOW();
    END IF;

    -- Garante colunas ativo e updated_at em users
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'users' AND column_name = 'ativo'
    ) THEN
        ALTER TABLE users ADD COLUMN ativo BOOLEAN DEFAULT TRUE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'users' AND column_name = 'updated_at'
    ) THEN
        ALTER TABLE users ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();
    END IF;

    -- Garante colunas etapa_funil e atendente_id em chat_sessions
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'chat_sessions' AND column_name = 'etapa_funil'
    ) THEN
        ALTER TABLE chat_sessions ADD COLUMN etapa_funil VARCHAR(30) DEFAULT 'novo';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'chat_sessions' AND column_name = 'atendente_id'
    ) THEN
        ALTER TABLE chat_sessions ADD COLUMN atendente_id UUID REFERENCES users(id) ON DELETE SET NULL;
    END IF;

    -- Atualiza constraint users_role_check para suportar admin, supervisor, atendente, operador
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'supervisor', 'atendente', 'operador'));

    -- Índices adicionais para tabelas adaptadas
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_etapa_funil ON chat_sessions(etapa_funil);
END $$;
