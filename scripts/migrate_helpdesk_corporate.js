const path = require('path');
const dotenv = require('dotenv');
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const { query, pool } = require('../database/db');

async function migrate() {
  console.log('Applying additive schema extensions for corporate helpdesk...');

  // 1. Departamentos
  await query(`
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
  `);

  // 2. Respostas Rápidas
  await query(`
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
  `);

  // 3. Notas Internas
  await query(`
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
  `);

  // 4. Trilha de Auditoria
  await query(`
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
  `);

  // 5. Colunas Aditivas em chat_sessions
  await query(`
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
  `);

  console.log('✅ Additive schema migration applied successfully to PostgreSQL!');
  await pool.end();
}

migrate().catch(e => {
  console.error('Migration error:', e);
  process.exit(1);
});
