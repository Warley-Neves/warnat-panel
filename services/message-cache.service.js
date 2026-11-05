// ==============================================================================
// Cache de Mensagens e Anti-Loop - WarNat SaaS
// Suporte a Redis e Fallback de Alta Performance em Memória (TTL 60s)
// ==============================================================================

class MessageCacheService {
  constructor() {
    this.memoryCache = new Map(); // key -> expiresAt (timestamp)
    this.redisClient = null;
    this.isRedisReady = false;

    // Varredura periódica para limpeza de chaves expiradas em memória (a cada 30s)
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, expiresAt] of this.memoryCache.entries()) {
        if (now > expiresAt) {
          this.memoryCache.delete(key);
        }
      }
    }, 30000);

    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /**
   * Conecta ao Redis opcionalmente
   */
  async initRedis(redisUrl) {
    if (!redisUrl) return;
    try {
      // Carregamento dinâmico para não quebrar se redis não estiver instalado
      const Redis = require('ioredis');
      this.redisClient = new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 3000
      });

      this.redisClient.on('connect', () => {
        this.isRedisReady = true;
        console.log('[MessageCache] Conectado ao Redis com sucesso.');
      });

      this.redisClient.on('error', (err) => {
        this.isRedisReady = false;
        console.warn('[MessageCache] Redis indisponível, utilizando MemoryCache fallback:', err.message);
      });

      await this.redisClient.connect();
    } catch (e) {
      this.isRedisReady = false;
      console.log('[MessageCache] Operando em modo MemoryCache nativo (TTL automático).');
    }
  }

  /**
   * Registra que uma mensagem foi enviada pelo bot da IA (Anti-Loop)
   * @param {string} messageId ID da mensagem da Evolution API (ex: key.id)
   * @param {number} ttlSeconds Tempo de vida em segundos (padrão: 60s)
   */
  async setBotSent(messageId, ttlSeconds = 60) {
    if (!messageId) return;
    const key = `bot_sent:${messageId}`;

    // 1. Grava no MemoryCache
    const expiresAt = Date.now() + (ttlSeconds * 1000);
    this.memoryCache.set(key, expiresAt);

    // 2. Se Redis estiver ativo, grava com EX
    if (this.isRedisReady && this.redisClient) {
      try {
        await this.redisClient.set(key, 'true', 'EX', ttlSeconds);
      } catch (err) {
        // Fallback silencioso para memória
      }
    }
  }

  /**
   * Verifica se a mensagem foi originada pelo bot
   * @param {string} messageId ID da mensagem
   * @returns {Promise<boolean>}
   */
  async isBotSent(messageId) {
    if (!messageId) return false;
    const key = `bot_sent:${messageId}`;

    // 1. Checa Redis primeiro se disponível
    if (this.isRedisReady && this.redisClient) {
      try {
        const val = await this.redisClient.get(key);
        if (val) return true;
      } catch (err) {
        // Fallback para memória
      }
    }

    // 2. Checa MemoryCache
    const expiresAt = this.memoryCache.get(key);
    if (expiresAt) {
      if (Date.now() <= expiresAt) {
        return true;
      }
      this.memoryCache.delete(key);
    }

    return false;
  }

  /**
   * Remove uma chave do cache
   */
  async delete(messageId) {
    if (!messageId) return;
    const key = `bot_sent:${messageId}`;
    this.memoryCache.delete(key);
    if (this.isRedisReady && this.redisClient) {
      try {
        await this.redisClient.del(key);
      } catch (e) {}
    }
  }
}

// Singleton
module.exports = new MessageCacheService();
