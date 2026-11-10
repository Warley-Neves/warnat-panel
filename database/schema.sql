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
ALTER TABLE tenant_ai_configs ADD COLUMN IF NOT EXISTS tempo_resposta_segundos INT DEFAULT 3;

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

    -- Tabela de bloqueios e regras de disponibilidade da agenda (dias, horários e recorrência)
    CREATE TABLE IF NOT EXISTS agenda_bloqueios (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        data DATE,
        horario VARCHAR(10),
        tipo_recorrencia VARCHAR(30) DEFAULT 'unica', -- 'unica' (data específica), 'semanal' (toda semana), 'intervalo' (período de recesso/férias)
        dia_semana VARCHAR(20), -- 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado', 'domingo'
        dias_semana JSONB DEFAULT '[]', -- múltiplos dias para recorrência semanal
        data_fim DATE, -- para intervalos de datas (ex: recesso de fim de ano)
        tipo_acao VARCHAR(20) DEFAULT 'bloquear', -- 'bloquear' (trava) ou 'liberar' (exceção aberta para agendar)
        motivo VARCHAR(255) DEFAULT 'Bloqueado manualmente no painel',
        created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE agenda_bloqueios ALTER COLUMN data DROP NOT NULL;
    ALTER TABLE agenda_bloqueios ADD COLUMN IF NOT EXISTS tipo_recorrencia VARCHAR(30) DEFAULT 'unica';
    ALTER TABLE agenda_bloqueios ADD COLUMN IF NOT EXISTS dia_semana VARCHAR(20);
    ALTER TABLE agenda_bloqueios ADD COLUMN IF NOT EXISTS dias_semana JSONB DEFAULT '[]';
    ALTER TABLE agenda_bloqueios ADD COLUMN IF NOT EXISTS data_fim DATE;
    ALTER TABLE agenda_bloqueios ADD COLUMN IF NOT EXISTS tipo_acao VARCHAR(20) DEFAULT 'bloquear';
    CREATE INDEX IF NOT EXISTS idx_agenda_bloqueios_tenant_data ON agenda_bloqueios(tenant_id, data);
    CREATE INDEX IF NOT EXISTS idx_agenda_bloqueios_recorrencia ON agenda_bloqueios(tenant_id, tipo_recorrencia, dia_semana);
    CREATE INDEX IF NOT EXISTS idx_agenda_bloqueios_intervalo ON agenda_bloqueios(tenant_id, data, data_fim);

    -- --------------------------------------------------------------------------
    -- 9. GESTÃO DE DEPARTAMENTOS / SETORES OMNICHANNEL
    -- --------------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS departments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        nome VARCHAR(100) NOT NULL,
        descricao TEXT,
        cor VARCHAR(30) DEFAULT '#3b82f6',
        ativo BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_departments_tenant ON departments(tenant_id);

    -- Vínculo de Membros da Equipe com Departamentos / Equipes
    ALTER TABLE users ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_users_department_id ON users(department_id);

    -- --------------------------------------------------------------------------
    -- 9.1 GESTÃO DE CONSENTIMENTO & POLÍTICA DE PRIVACIDADE (LGPD LEI 13.709/18)
    -- --------------------------------------------------------------------------
    ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_policy_accepted_at TIMESTAMPTZ DEFAULT NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_policy_version VARCHAR(20) DEFAULT NULL;

    CREATE TABLE IF NOT EXISTS user_consents (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        policy_version VARCHAR(20) NOT NULL,
        accepted_at TIMESTAMPTZ DEFAULT NOW(),
        ip_address VARCHAR(50),
        user_agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_user_consents_user ON user_consents(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_consents_tenant ON user_consents(tenant_id);

    -- --------------------------------------------------------------------------
    -- 10. RESPOSTAS RÁPIDAS (CANNED RESPONSES)
    -- --------------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS canned_responses (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        atalho VARCHAR(50) NOT NULL,
        titulo VARCHAR(120) NOT NULL,
        conteudo TEXT NOT NULL,
        categoria VARCHAR(60) DEFAULT 'Geral',
        criado_por UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CONSTRAINT uk_tenant_canned_shortcut UNIQUE(tenant_id, atalho)
    );
    CREATE INDEX IF NOT EXISTS idx_canned_lookup ON canned_responses(tenant_id, atalho);

    -- --------------------------------------------------------------------------
    -- 11. NOTAS INTERNAS PRIVADAS DA EQUIPE
    -- --------------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS chat_internal_notes (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        author_name VARCHAR(100) NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_internal_notes_session ON chat_internal_notes(session_id, created_at ASC);

    -- --------------------------------------------------------------------------
    -- 12. TRILHA DE AUDITORIA E HISTÓRICO DE EVENTOS DO TICKET
    -- --------------------------------------------------------------------------
    CREATE TABLE IF NOT EXISTS ticket_audit_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        tipo_evento VARCHAR(50) NOT NULL,
        descricao TEXT NOT NULL,
        metadados JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ticket_audit_session ON ticket_audit_events(session_id, created_at ASC);

    -- --------------------------------------------------------------------------
    -- COLUNAS ADITIVAS EM CHAT_SESSIONS (FILA, CONCORRÊNCIA E SLA)
    -- --------------------------------------------------------------------------
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id) ON DELETE SET NULL;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS priority INT DEFAULT 3;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS locked_by UUID REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS first_human_reply_at TIMESTAMPTZ;
    ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_chat_sessions_dept ON chat_sessions(tenant_id, department_id);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_locked ON chat_sessions(locked_by, locked_at);
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_queue ON chat_sessions(tenant_id, queued_at, priority DESC);

    -- --------------------------------------------------------------------------
    -- 13. SAAS BILLING (PAGAR.ME V5), ASSINATURAS, FATURAS E SUPERADMIN
    -- --------------------------------------------------------------------------
    -- Extensão de usuários para SuperAdmin
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN DEFAULT FALSE;
    CREATE INDEX IF NOT EXISTS idx_users_is_super_admin ON users(is_super_admin);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS telefone VARCHAR(30);
    CREATE INDEX IF NOT EXISTS idx_users_telefone ON users(telefone);

    -- Extensão de tenants com ciclo de vida, trial de 7 dias e travas administrativas
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'TRIALING';
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days');
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_manually_blocked BOOLEAN DEFAULT FALSE;
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS admin_notes TEXT;
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS courtesy_plan VARCHAR(20) DEFAULT NULL;
    ALTER TABLE tenants ADD COLUMN IF NOT EXISTS past_due_since TIMESTAMPTZ DEFAULT NULL;
    CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);

    -- Tabela de assinaturas (subscriptions)
    CREATE TABLE IF NOT EXISTS subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        plan_id VARCHAR(50) NOT NULL,
        pagarme_subscription_id VARCHAR(100),
        pagarme_customer_id VARCHAR(100),
        status VARCHAR(50) DEFAULT 'active',
        payment_method VARCHAR(30) DEFAULT 'credit_card',
        current_period_start TIMESTAMPTZ DEFAULT NOW(),
        current_period_end TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days'),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON subscriptions(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_subscriptions_pagarme ON subscriptions(pagarme_subscription_id);

    -- Tabela de faturas (invoices)
    CREATE TABLE IF NOT EXISTS invoices (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        pagarme_invoice_id VARCHAR(100),
        amount_cents INT NOT NULL,
        status VARCHAR(30) DEFAULT 'PENDING',
        pix_qr_code TEXT,
        pix_copy_paste TEXT,
        paid_at TIMESTAMPTZ,
        due_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_invoices_tenant ON invoices(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_invoices_pagarme ON invoices(pagarme_invoice_id);

    -- Tabela de idempotência de webhooks
    CREATE TABLE IF NOT EXISTS processed_webhooks (
        event_id VARCHAR(150) PRIMARY KEY,
        event_type VARCHAR(100),
        processed_at TIMESTAMPTZ DEFAULT NOW(),
        payload JSONB DEFAULT '{}'
    );

    -- Tabela de logs de auditoria do SuperAdmin
    CREATE TABLE IF NOT EXISTS admin_audit_logs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        admin_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        target_tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
        action VARCHAR(60) NOT NULL,
        details JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_admin_audit_target ON admin_audit_logs(target_tenant_id);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_logs(created_at DESC);

    -- 14. RECUPERAÇÃO DE SENHA MULTICANAL (EMAIL & WHATSAPP) - OWASP / NIST SP 800-63B
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash VARCHAR(64) NOT NULL,
        target_type VARCHAR(20) NOT NULL, -- 'email' ou 'telefone'
        target_value VARCHAR(150) NOT NULL,
        attempts INT DEFAULT 0,
        used BOOLEAN DEFAULT FALSE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_reset_user ON password_reset_tokens(user_id);
    CREATE INDEX IF NOT EXISTS idx_reset_token_hash ON password_reset_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_reset_expires ON password_reset_tokens(expires_at);
END $$;
