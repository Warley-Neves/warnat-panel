// ==============================================================================
// Serviço de Rate Limiting & Proteção contra Brute Force (OWASP) - WarNat SaaS
// ==============================================================================

class RateLimiterService {
  constructor() {
    // Mapa em memória para rastreamento de tentativas por chave
    // Key: string -> { count: number, firstAttempt: number, blockedUntil: number }
    this.hits = new Map();

    // Limpeza periódica de chaves expiradas a cada 5 minutos
    this.cleanupInterval = setInterval(() => this.cleanup(), 5 * 60 * 1000);
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /**
   * Limpa entradas cuja janela de retenção já expirou
   */
  cleanup() {
    const now = Date.now();
    for (const [key, data] of this.hits.entries()) {
      if (now > data.blockedUntil && (now - data.firstAttempt) > 60 * 60 * 1000) {
        this.hits.delete(key);
      }
    }
  }

  /**
   * Extrai o IP real do cliente tratando cabeçalhos de proxy reverso (Render/Cloudflare)
   */
  getClientIp(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      return String(forwarded).split(',')[0].trim();
    }
    return req.socket?.remoteAddress || '127.0.0.1';
  }

  /**
   * Verifica se uma tentativa de login é permitida
   * Limite: máximo 7 tentativas falhas a cada 10 minutos por IP + E-mail
   */
  checkLoginRate(ip, email) {
    const now = Date.now();
    const cleanEmail = (email || '').toLowerCase().trim();
    const key = `login:${ip}:${cleanEmail}`;
    const ipKey = `login_ip:${ip}`;

    const entry = this.hits.get(key);
    if (entry && now < entry.blockedUntil) {
      const waitSeconds = Math.ceil((entry.blockedUntil - now) / 1000);
      return {
        allowed: false,
        waitSeconds,
        error: `Muitas tentativas de login incorretas. Por segurança, tente novamente em ${waitSeconds} segundos.`
      };
    }

    const ipEntry = this.hits.get(ipKey);
    if (ipEntry && now < ipEntry.blockedUntil) {
      const waitSeconds = Math.ceil((ipEntry.blockedUntil - now) / 1000);
      return {
        allowed: false,
        waitSeconds,
        error: `Muitas tentativas a partir deste IP. Aguarde ${waitSeconds} segundos para tentar novamente.`
      };
    }

    return { allowed: true };
  }

  /**
   * Registra uma falha de autenticação (credenciais inválidas)
   */
  recordLoginFailure(ip, email) {
    const now = Date.now();
    const cleanEmail = (email || '').toLowerCase().trim();
    const key = `login:${ip}:${cleanEmail}`;
    const ipKey = `login_ip:${ip}`;

    // Falhas específicas do e-mail neste IP (Bloqueia após 6 falhas)
    let entry = this.hits.get(key) || { count: 0, firstAttempt: now, blockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= 6) {
      // Bloqueio progressivo: 15 minutos
      entry.blockedUntil = now + 15 * 60 * 1000;
    }
    this.hits.set(key, entry);

    // Falhas gerais a partir do mesmo IP (Bloqueia após 20 falhas)
    let ipEntry = this.hits.get(ipKey) || { count: 0, firstAttempt: now, blockedUntil: 0 };
    ipEntry.count += 1;
    if (ipEntry.count >= 20) {
      ipEntry.blockedUntil = now + 30 * 60 * 1000;
    }
    this.hits.set(ipKey, ipEntry);
  }

  /**
   * Reseta o contador de falhas em caso de sucesso
   */
  recordLoginSuccess(ip, email) {
    const cleanEmail = (email || '').toLowerCase().trim();
    this.hits.delete(`login:${ip}:${cleanEmail}`);
  }

  /**
   * Limita criação de novas contas/empresas por IP
   * Limite: máximo 6 cadastros por hora por IP
   */
  checkRegisterRate(ip) {
    const now = Date.now();
    const key = `reg:${ip}`;
    let entry = this.hits.get(key);

    if (!entry || (now - entry.firstAttempt) > 60 * 60 * 1000) {
      this.hits.set(key, { count: 1, firstAttempt: now, blockedUntil: 0 });
      return { allowed: true };
    }

    if (entry.count >= 6) {
      const waitSeconds = Math.ceil((entry.firstAttempt + 60 * 60 * 1000 - now) / 1000);
      return {
        allowed: false,
        waitSeconds,
        error: `Limite de cadastros excedido para este endereço IP. Tente novamente em ${Math.ceil(waitSeconds / 60)} minutos.`
      };
    }

    entry.count += 1;
    this.hits.set(key, entry);
    return { allowed: true };
  }

  /**
   * Limita solicitações de recuperação de senha por IP e por identificador
   * Limite: máximo 5 solicitações a cada 15 minutos por IP ou por identificador
   */
  checkPasswordResetRate(ip, identifier) {
    const now = Date.now();
    const cleanId = String(identifier || '').toLowerCase().trim();
    const key = `pw_reset:${ip}:${cleanId}`;
    const ipKey = `pw_reset_ip:${ip}`;

    const entry = this.hits.get(key);
    if (entry && now < entry.blockedUntil) {
      const waitSeconds = Math.ceil((entry.blockedUntil - now) / 1000);
      return {
        allowed: false,
        waitSeconds,
        error: `Muitas solicitações de recuperação para este contato. Aguarde ${Math.ceil(waitSeconds / 60)} minutos.`
      };
    }

    const ipEntry = this.hits.get(ipKey);
    if (ipEntry && now < ipEntry.blockedUntil) {
      const waitSeconds = Math.ceil((ipEntry.blockedUntil - now) / 1000);
      return {
        allowed: false,
        waitSeconds,
        error: `Muitas solicitações a partir deste IP. Aguarde ${Math.ceil(waitSeconds / 60)} minutos.`
      };
    }

    return { allowed: true };
  }

  recordPasswordResetAttempt(ip, identifier) {
    const now = Date.now();
    const cleanId = String(identifier || '').toLowerCase().trim();
    const key = `pw_reset:${ip}:${cleanId}`;
    const ipKey = `pw_reset_ip:${ip}`;

    let entry = this.hits.get(key) || { count: 0, firstAttempt: now, blockedUntil: 0 };
    if ((now - entry.firstAttempt) > 15 * 60 * 1000) {
      entry = { count: 0, firstAttempt: now, blockedUntil: 0 };
    }
    entry.count += 1;
    if (entry.count >= 5) {
      entry.blockedUntil = now + 15 * 60 * 1000;
    }
    this.hits.set(key, entry);

    let ipEntry = this.hits.get(ipKey) || { count: 0, firstAttempt: now, blockedUntil: 0 };
    if ((now - ipEntry.firstAttempt) > 15 * 60 * 1000) {
      ipEntry = { count: 0, firstAttempt: now, blockedUntil: 0 };
    }
    ipEntry.count += 1;
    if (ipEntry.count >= 10) {
      ipEntry.blockedUntil = now + 15 * 60 * 1000;
    }
    this.hits.set(ipKey, ipEntry);
  }
}

module.exports = new RateLimiterService();
