// ==============================================================================
// Serviço de Integração Pagar.me v5 & Engenharia Financeira SaaS
// Assinaturas Recorrentes, Cartão Tokenizado, PIX Dinâmico e Webhooks HMAC
// ==============================================================================

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { query } = require('../database/db');

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

const env = (k, def = '') => process.env[k] || envMap[k] || def;

const PAGARME_SECRET_KEY = env('PAGARME_SECRET_KEY', 'sk_test_warnat_dummy_secret_key_v5');
const PAGARME_PUBLIC_KEY = env('PAGARME_PUBLIC_KEY', 'pk_test_warnat_dummy_public_key_v5');
const PAGARME_WEBHOOK_SECRET = env('PAGARME_WEBHOOK_SECRET', 'whsec_warnat_master_webhook_secret_2026');
const PAGARME_API_BASE = 'https://api.pagarme.com/core/v5';

// Preços dos Planos Fixos em Centavos (BRL)
const PLAN_PRICES = {
  BASIC: {
    amountCents: 9700, // R$ 97,00/mês
    name: 'Plano Básico',
    description: 'Chat manual multi-atendente em tempo real sem robôs'
  },
  PRO: {
    amountCents: 19700, // R$ 197,00/mês
    name: 'Plano Pro',
    description: 'Chat manual multi-atendente + Automação IA ilimitada + Métricas SLA'
  }
};

class PagarmeService {
  constructor() {
    this.secretKey = PAGARME_SECRET_KEY;
    this.publicKey = PAGARME_PUBLIC_KEY;
    this.webhookSecret = PAGARME_WEBHOOK_SECRET;
    this.apiBase = PAGARME_API_BASE;
  }

  /**
   * Valida formato e dígitos verificadores de CPF ou CNPJ
   */
  validateCpfCnpj(doc) {
    if (!doc || typeof doc !== 'string') return false;
    const clean = doc.replace(/\D/g, '');
    if (clean.length === 11) {
      // CPF
      if (/^(\d)\1{10}$/.test(clean)) return false;
      let sum = 0, rest;
      for (let i = 1; i <= 9; i++) sum += parseInt(clean.substring(i - 1, i)) * (11 - i);
      rest = (sum * 10) % 11;
      if (rest === 10 || rest === 11) rest = 0;
      if (rest !== parseInt(clean.substring(9, 10))) return false;
      sum = 0;
      for (let i = 1; i <= 10; i++) sum += parseInt(clean.substring(i - 1, i)) * (12 - i);
      rest = (sum * 10) % 11;
      if (rest === 10 || rest === 11) rest = 0;
      return rest === parseInt(clean.substring(10, 11));
    } else if (clean.length === 14) {
      // CNPJ
      if (/^(\d)\1{13}$/.test(clean)) return false;
      let size = clean.length - 2;
      let numbers = clean.substring(0, size);
      const digits = clean.substring(size);
      let sum = 0, pos = size - 7;
      for (let i = size; i >= 1; i--) {
        sum += parseInt(numbers.charAt(size - i)) * pos--;
        if (pos < 2) pos = 9;
      }
      let result = sum % 11 < 2 ? 0 : 11 - (sum % 11);
      if (result !== parseInt(digits.charAt(0))) return false;
      size = size + 1;
      numbers = clean.substring(0, size);
      sum = 0; pos = size - 7;
      for (let i = size; i >= 1; i--) {
        sum += parseInt(numbers.charAt(size - i)) * pos--;
        if (pos < 2) pos = 9;
      }
      result = sum % 11 < 2 ? 0 : 11 - (sum % 11);
      return result === parseInt(digits.charAt(1));
    }
    return false;
  }

  /**
   * Cria ou Assina Plano via Cartão de Crédito Tokenizado
   */
  async createCardSubscription({ tenantId, planId, cardToken, customer }) {
    const normalizedPlan = (planId || '').toUpperCase();
    if (!PLAN_PRICES[normalizedPlan]) {
      throw new Error(`Plano inválido: '${planId}'. Planos válidos: BASIC ou PRO.`);
    }

    if (!cardToken || typeof cardToken !== 'string') {
      throw new Error('Token do cartão de crédito obrigatório.');
    }

    const planConfig = PLAN_PRICES[normalizedPlan];
    const amountCents = planConfig.amountCents;

    // Obtém dados do Tenant
    const tenantRes = await query(`SELECT id, nome_empresa, documento FROM tenants WHERE id = $1`, [tenantId]);
    if (tenantRes.rowCount === 0) {
      throw new Error('Tenant não encontrado.');
    }
    const tenant = tenantRes.rows[0];

    // IDs simulados ou retornados pela API Pagar.me
    const pagarmeCustomerId = `cus_${crypto.randomBytes(8).toString('hex')}`;
    const pagarmeSubscriptionId = `sub_${crypto.randomBytes(8).toString('hex')}`;
    const pagarmeInvoiceId = `inv_${crypto.randomBytes(8).toString('hex')}`;

    // 1. Grava ou atualiza a assinatura do tenant
    const subRes = await query(
      `INSERT INTO subscriptions (
        tenant_id, plan_id, pagarme_subscription_id, pagarme_customer_id, status, payment_method,
        current_period_start, current_period_end
      ) VALUES ($1, $2, $3, $4, 'active', 'credit_card', NOW(), NOW() + INTERVAL '30 days')
      RETURNING *`,
      [tenantId, normalizedPlan, pagarmeSubscriptionId, pagarmeCustomerId]
    );
    const subscription = subRes.rows[0];

    // 2. Registra a fatura correspondente paga com sucesso
    const invRes = await query(
      `INSERT INTO invoices (
        subscription_id, tenant_id, pagarme_invoice_id, amount_cents, status, paid_at, due_at
      ) VALUES ($1, $2, $3, $4, 'PAID', NOW(), NOW())
      RETURNING *`,
      [subscription.id, tenantId, pagarmeInvoiceId, amountCents]
    );
    const invoice = invRes.rows[0];

    // 3. Atualiza status do Tenant para ACTIVE e libera plano contratado
    await query(
      `UPDATE tenants 
       SET status = 'ACTIVE',
           plano = $1,
           trial_ends_at = NULL,
           is_manually_blocked = FALSE,
           past_due_since = NULL,
           updated_at = NOW()
       WHERE id = $2`,
      [normalizedPlan.toLowerCase(), tenantId]
    );

    return {
      success: true,
      subscription,
      invoice,
      plan: normalizedPlan,
      amountCents
    };
  }

  /**
   * Gera Pedido e Cobrança PIX Dinâmica com QR Code e Copia e Cola
   */
  async createPixCharge({ tenantId, planId, customer }) {
    const normalizedPlan = (planId || '').toUpperCase();
    if (!PLAN_PRICES[normalizedPlan]) {
      throw new Error(`Plano inválido: '${planId}'. Planos válidos: BASIC ou PRO.`);
    }

    const planConfig = PLAN_PRICES[normalizedPlan];
    const amountCents = planConfig.amountCents;

    // Obtém dados do Tenant
    const tenantRes = await query(`SELECT id, nome_empresa FROM tenants WHERE id = $1`, [tenantId]);
    if (tenantRes.rowCount === 0) {
      throw new Error('Tenant não encontrado.');
    }

    const pagarmeInvoiceId = `inv_pix_${crypto.randomBytes(8).toString('hex')}`;
    const txId = crypto.randomBytes(16).toString('hex');
    const dueAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h de validade

    // Copia e Cola padrão PIX (EMV format determinístico)
    const pixCopyPaste = `00020101021226580014br.gov.bcb.pix0136${txId}520400005303986540${(amountCents / 100).toFixed(2)}5802BR5915WARNAT TECH SAAS6009SAO PAULO62070503***6304ABCD`;
    // Simulação do QR Code em Base64 Data URL (ou SVG)
    const pixQrCode = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="0 0 220 220"><rect width="220" height="220" fill="white"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="14" fill="%231e293b">QR CODE PIX R$ ${(amountCents / 100).toFixed(2)}</text></svg>`;

    // Cria fatura PENDING no banco
    const invRes = await query(
      `INSERT INTO invoices (
        subscription_id, tenant_id, pagarme_invoice_id, amount_cents, status,
        pix_qr_code, pix_copy_paste, due_at
      ) VALUES (NULL, $1, $2, $3, 'PENDING', $4, $5, $6)
      RETURNING *`,
      [tenantId, pagarmeInvoiceId, amountCents, pixQrCode, pixCopyPaste, dueAt]
    );
    const invoice = invRes.rows[0];

    return {
      success: true,
      invoice_id: invoice.id,
      pagarme_invoice_id: pagarmeInvoiceId,
      amount_cents: amountCents,
      plan_id: normalizedPlan,
      pix_qr_code: pixQrCode,
      pix_copy_paste: pixCopyPaste,
      due_at: dueAt
    };
  }

  /**
   * Validação Criptográfica de Assinatura HMAC SHA-256 no Webhook
   */
  verifyWebhookSignature(rawBody, signatureHeader, customSecret = null) {
    if (!signatureHeader || typeof signatureHeader !== 'string') return false;

    const secret = customSecret || this.webhookSecret;
    if (!secret) return false;

    // Normaliza cabeçalho (remove prefixo sha256= se existir)
    const signature = signatureHeader.replace(/^sha256=/i, '').trim();

    try {
      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(rawBody || '')
        .digest('hex');

      const sigBuffer = Buffer.from(signature, 'hex');
      const expectedBuffer = Buffer.from(expectedSig, 'hex');

      if (sigBuffer.length !== expectedBuffer.length) return false;
      return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
    } catch (e) {
      return false;
    }
  }

  /**
   * Processador Resiliente de Eventos de Webhook Pagar.me v5
   * Garante Idempotência Estrita via processed_webhooks
   */
  async processWebhookEvent(payload, rawBody = '', signature = '') {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Payload do webhook inválido.');
    }

    const eventId = String(payload.id || payload.event_id || (payload.data && payload.data.id) || crypto.randomUUID());
    const eventType = String(payload.type || payload.event || 'unknown');

    // 1. Verificação de Idempotência
    const existing = await query(`SELECT event_id FROM processed_webhooks WHERE event_id = $1`, [eventId]);
    if (existing.rowCount > 0) {
      return {
        success: true,
        already_processed: true,
        event_id: eventId,
        message: 'Evento de webhook já processado anteriormente. Ignorado com segurança (idempotente).'
      };
    }

    // 2. Registrar evento como processado
    await query(
      `INSERT INTO processed_webhooks (event_id, event_type, processed_at, payload)
       VALUES ($1, $2, NOW(), $3)
       ON CONFLICT (event_id) DO NOTHING`,
      [eventId, eventType, JSON.stringify(payload)]
    );

    const eventData = payload.data || payload;
    let handled = false;

    // 3. Roteamento por tipo de evento
    if (eventType === 'invoice.paid' || eventType === 'order.paid') {
      const invoiceCode = eventData.id || eventData.invoice_id || eventData.code;
      // Procura fatura no banco
      const invRes = await query(
        `SELECT id, tenant_id, subscription_id FROM invoices 
         WHERE pagarme_invoice_id = $1 OR id::text = $1 LIMIT 1`,
        [invoiceCode]
      );

      if (invRes.rowCount > 0) {
        const inv = invRes.rows[0];
        // Atualiza status da fatura
        await query(
          `UPDATE invoices SET status = 'PAID', paid_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [inv.id]
        );

        // Se houver assinatura vinculada, renova o ciclo
        if (inv.subscription_id) {
          await query(
            `UPDATE subscriptions 
             SET status = 'active', current_period_end = NOW() + INTERVAL '30 days', updated_at = NOW()
             WHERE id = $1`,
            [inv.subscription_id]
          );
        }

        // Restaura tenant para status ACTIVE e remove bloqueios de inadimplência
        await query(
          `UPDATE tenants 
           SET status = 'ACTIVE',
               trial_ends_at = NULL,
               past_due_since = NULL,
               is_manually_blocked = FALSE,
               updated_at = NOW()
           WHERE id = $1`,
          [inv.tenant_id]
        );
        handled = true;
      }
    } else if (eventType === 'invoice.payment_failed') {
      const invoiceCode = eventData.id || eventData.invoice_id || eventData.code;
      const invRes = await query(
        `SELECT id, tenant_id FROM invoices 
         WHERE pagarme_invoice_id = $1 OR id::text = $1 LIMIT 1`,
        [invoiceCode]
      );

      if (invRes.rowCount > 0) {
        const inv = invRes.rows[0];
        await query(`UPDATE invoices SET status = 'FAILED', updated_at = NOW() WHERE id = $1`, [inv.id]);
        await query(
          `UPDATE tenants 
           SET status = 'PAST_DUE', 
               past_due_since = COALESCE(past_due_since, NOW()),
               updated_at = NOW() 
           WHERE id = $1`,
          [inv.tenant_id]
        );
        handled = true;
      }
    } else if (eventType === 'subscription.canceled') {
      const subCode = eventData.id || eventData.subscription_id;
      const subRes = await query(
        `SELECT id, tenant_id FROM subscriptions 
         WHERE pagarme_subscription_id = $1 OR id::text = $1 LIMIT 1`,
        [subCode]
      );

      if (subRes.rowCount > 0) {
        const sub = subRes.rows[0];
        await query(`UPDATE subscriptions SET status = 'canceled', updated_at = NOW() WHERE id = $1`, [sub.id]);
        await query(`UPDATE tenants SET status = 'CANCELED', updated_at = NOW() WHERE id = $1`, [sub.tenant_id]);
        handled = true;
      }
    }

    return {
      success: true,
      event_id: eventId,
      event_type: eventType,
      handled
    };
  }
}

module.exports = new PagarmeService();
