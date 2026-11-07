// ==============================================================================
// Motor de Entitlements & Feature Gating - WarNat SaaS
// Regras 0-4 de Acesso Multi-Tenant & Controle de Recursos por Plano
// ==============================================================================

const { query } = require('../database/db');

class EntitlementsService {
  /**
   * Obtém o estado de assinatura, ciclo de vida e plano efetivo do Tenant
   */
  async getTenantLifecycle(tenantId) {
    const res = await query(
      `SELECT id, nome_empresa, plano, status, trial_ends_at, is_manually_blocked,
              courtesy_plan, past_due_since, admin_notes
       FROM tenants
       WHERE id = $1`,
      [tenantId]
    );

    if (res.rowCount === 0) {
      return null;
    }

    const tenant = res.rows[0];
    let currentStatus = tenant.status || 'TRIALING';
    const now = new Date();

    // Transição automática para TRIAL_EXPIRED se o período de 7 dias tiver vencido
    if (currentStatus === 'TRIALING' && tenant.trial_ends_at && new Date(tenant.trial_ends_at) < now) {
      currentStatus = 'TRIAL_EXPIRED';
      await query(`UPDATE tenants SET status = 'TRIAL_EXPIRED', updated_at = NOW() WHERE id = $1`, [tenantId]);
      tenant.status = 'TRIAL_EXPIRED';
    }

    // Determina o Plano Efetivo
    let effectivePlan = 'BASIC';
    const courtesy = (tenant.courtesy_plan || '').toUpperCase();
    const storedPlan = (tenant.plano || '').toUpperCase();

    if (courtesy === 'PRO') {
      effectivePlan = 'PRO';
    } else if (currentStatus === 'TRIALING') {
      // 7 Dias de Free Trial com acesso Pro liberado sem cartão
      effectivePlan = 'PRO';
    } else if (currentStatus === 'ACTIVE' || currentStatus === 'PAST_DUE') {
      // Checa se possui assinatura PRO ativa no banco
      const subRes = await query(
        `SELECT plan_id FROM subscriptions 
         WHERE tenant_id = $1 AND status = 'active'
         ORDER BY current_period_end DESC LIMIT 1`,
        [tenantId]
      );
      if (subRes.rowCount > 0 && subRes.rows[0].plan_id.toUpperCase() === 'PRO') {
        effectivePlan = 'PRO';
      } else if (storedPlan === 'PRO') {
        effectivePlan = 'PRO';
      } else {
        effectivePlan = 'BASIC';
      }
    } else {
      effectivePlan = storedPlan === 'PRO' ? 'PRO' : 'BASIC';
    }

    // Cálculo do Grace Period de 3 dias para PAST_DUE
    let isPastDueGraceExceeded = false;
    let graceDaysRemaining = 3;
    if (currentStatus === 'PAST_DUE' && tenant.past_due_since) {
      const pastDueDate = new Date(tenant.past_due_since);
      const diffMs = now.getTime() - pastDueDate.getTime();
      const diffDays = diffMs / (1000 * 60 * 60 * 24);
      if (diffDays >= 3) {
        isPastDueGraceExceeded = true;
        graceDaysRemaining = 0;
      } else {
        graceDaysRemaining = Math.max(0, Math.ceil(3 - diffDays));
      }
    }

    return {
      tenantId: tenant.id,
      nomeEmpresa: tenant.nome_empresa,
      status: currentStatus,
      rawStatus: tenant.status,
      plano: tenant.plano,
      effectivePlan,
      isTrialing: currentStatus === 'TRIALING',
      trialEndsAt: tenant.trial_ends_at,
      isManuallyBlocked: Boolean(tenant.is_manually_blocked),
      courtesyPlan: tenant.courtesy_plan,
      pastDueSince: tenant.past_due_since,
      isPastDueGraceExceeded,
      graceDaysRemaining,
      adminNotes: tenant.admin_notes
    };
  }

  /**
   * Avalia as Regras 0 a 3 de acesso operacional do Tenant
   */
  async evaluateAccess(decodedUser, { isWrite = false } = {}) {
    // Regra 0: SuperAdmin Override (Acesso total irrestrito / bypass)
    if (decodedUser?.isSuperAdmin) {
      return { allowed: true, superAdmin: true };
    }

    // Dupla verificação no banco para evitar falsificação
    if (decodedUser?.userId) {
      const uRes = await query(`SELECT is_super_admin FROM users WHERE id = $1`, [decodedUser.userId]);
      if (uRes.rows[0]?.is_super_admin) {
        return { allowed: true, superAdmin: true };
      }
    }

    const tenantId = decodedUser?.tenantId;
    if (!tenantId) {
      return {
        allowed: false,
        statusCode: 401,
        error: 'UNAUTHORIZED_TENANT',
        message: 'Contexto de tenant ausente na requisição.'
      };
    }

    const lifecycle = await this.getTenantLifecycle(tenantId);
    if (!lifecycle) {
      return {
        allowed: false,
        statusCode: 404,
        error: 'TENANT_NOT_FOUND',
        message: 'Organização não encontrada no sistema.'
      };
    }

    // Regra 1: Bloqueio Administrativo Imediato
    if (lifecycle.isManuallyBlocked || lifecycle.status === 'SUSPENDED_BY_ADMIN') {
      return {
        allowed: false,
        statusCode: 403,
        error: 'ACCOUNT_SUSPENDED_BY_ADMIN',
        message: 'Sua conta foi suspensa pela administração. Entre em contato com o suporte: suporte@warnattech.com.br'
      };
    }

    // Regra 2: Período de Teste Expirado ou Cancelado (Bloqueia escrita operacional)
    if (lifecycle.status === 'TRIAL_EXPIRED' || lifecycle.status === 'CANCELED') {
      if (isWrite) {
        return {
          allowed: false,
          statusCode: 402,
          error: 'TRIAL_EXPIRED_UPGRADE_REQUIRED',
          message: 'Seu período de teste de 7 dias encerrou ou sua assinatura está inativa. Faça o upgrade para continuar utilizando os serviços operacionais.',
          required_action: 'BILLING_CHECKOUT',
          status: lifecycle.status
        };
      }
    }

    // Regra 3: Inadimplência (PAST_DUE)
    // Permite uso com aviso durante grace period de 3 dias. Se excedido, alerta persistente.
    return {
      allowed: true,
      lifecycle,
      effectivePlan: lifecycle.effectivePlan,
      pastDueWarning: lifecycle.status === 'PAST_DUE'
    };
  }

  /**
   * Avalia a Regra 4: Feature Gate por Recurso (ex: 'automation_bots')
   */
  async canUseFeature(tenantId, featureName) {
    const lifecycle = await this.getTenantLifecycle(tenantId);
    if (!lifecycle) return false;

    // Se bloqueado administrativamente ou expirado
    if (lifecycle.isManuallyBlocked || lifecycle.status === 'SUSPENDED_BY_ADMIN') {
      return false;
    }
    if (lifecycle.status === 'TRIAL_EXPIRED' || lifecycle.status === 'CANCELED') {
      return false;
    }

    // Se inadimplente com carência estourada (> 3 dias)
    if (lifecycle.status === 'PAST_DUE' && lifecycle.isPastDueGraceExceeded) {
      return false;
    }

    // Avaliação de Recursos
    if (featureName === 'automation_bots') {
      return lifecycle.effectivePlan === 'PRO';
    }

    if (featureName === 'sla_analytics') {
      return lifecycle.effectivePlan === 'PRO';
    }

    // Chat manual é liberado em todos os planos válidos (BASIC e PRO)
    if (featureName === 'manual_chat') {
      return true;
    }

    return true;
  }
}

module.exports = new EntitlementsService();
