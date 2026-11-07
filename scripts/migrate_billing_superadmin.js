// ==============================================================================
// Migração Não-Destrutiva: Faturamento Pagar.me v5, Entitlements & SuperAdmin
// ==============================================================================

const { query } = require('../database/db');

async function runMigration() {
  console.log('--- Iniciando Migração Não-Destrutiva: Billing & SuperAdmin Backoffice ---');

  try {
    // 1. Extensão de Usuários (SuperAdmin Flag)
    console.log('[1/6] Adicionando coluna is_super_admin na tabela users...');
    await query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN DEFAULT FALSE;
      CREATE INDEX IF NOT EXISTS idx_users_is_super_admin ON users(is_super_admin);
    `);

    // Define administradores existentes padrão como SuperAdmin se for admin@warnattech
    await query(`
      UPDATE users 
      SET is_super_admin = TRUE 
      WHERE email ILIKE '%admin@warnattech%' OR email ILIKE '%superadmin%';
    `);

    // 2. Extensão da Tabela de Tenants
    console.log('[2/6] Adicionando campos de ciclo de vida e trial na tabela tenants...');
    await query(`
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS status VARCHAR(30) DEFAULT 'TRIALING';
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days');
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_manually_blocked BOOLEAN DEFAULT FALSE;
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS admin_notes TEXT;
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS courtesy_plan VARCHAR(20) DEFAULT NULL;
      ALTER TABLE tenants ADD COLUMN IF NOT EXISTS past_due_since TIMESTAMPTZ DEFAULT NULL;
      CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
    `);

    // Garante que tenants antigos sem trial_ends_at tenham uma data de 7 dias após o cadastro ou agora
    await query(`
      UPDATE tenants 
      SET trial_ends_at = COALESCE(trial_ends_at, created_at + INTERVAL '7 days', NOW() + INTERVAL '7 days'),
          status = COALESCE(status, 'TRIALING')
      WHERE trial_ends_at IS NULL OR status IS NULL;
    `);

    // 3. Tabela de Assinaturas (Subscriptions)
    console.log('[3/6] Criando tabela subscriptions com integridade referencial...');
    await query(`
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
    `);

    // 4. Tabela de Faturas (Invoices)
    console.log('[4/6] Criando tabela invoices...');
    await query(`
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
    `);

    // 5. Tabela de Idempotência de Webhooks (processed_webhooks)
    console.log('[5/6] Criando tabela processed_webhooks...');
    await query(`
      CREATE TABLE IF NOT EXISTS processed_webhooks (
        event_id VARCHAR(150) PRIMARY KEY,
        event_type VARCHAR(100),
        processed_at TIMESTAMPTZ DEFAULT NOW(),
        payload JSONB DEFAULT '{}'
      );
    `);

    // 6. Tabela de Logs de Auditoria Administrativa (admin_audit_logs)
    console.log('[6/6] Criando tabela admin_audit_logs...');
    await query(`
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
    `);

    console.log('✅ Migração de Billing & SuperAdmin concluída com sucesso!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Falha na execução da migração:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  runMigration();
}

module.exports = { runMigration };
