// ==============================================================================
// SAAS MULTI-TENANT ENGINE - MESSAGE CACHE & ANTI-LOOP SERVICE (TYPESCRIPT)
// Dual-layer cache (Redis + in-memory fallback) with 60s TTL for bot_sent keys
// ==============================================================================

export class MessageCacheService {
  private memoryCache: Map<string, number>; // key -> expiresAt (timestamp)
  private cleanupTimer: NodeJS.Timeout;
  private redisClient: any = null;
  private isRedisReady: boolean = false;

  constructor() {
    this.memoryCache = new Map<string, number>();

    // Varredura periódica para limpeza de chaves expiradas na memória (a cada 30s)
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

    // Tenta conectar ao Redis se REDIS_URL estiver definida
    const redisUrl = process.env.REDIS_URL || process.env.CHATWOOT_REDIS_URL;
    if (redisUrl) {
      this.initRedis(redisUrl).catch(() => {
        // Silencioso: opera em modo MemoryCache
      });
    }
  }

  /**
   * Conecta ao Redis opcionalmente
   */
  public async initRedis(redisUrl: string): Promise<void> {
    try {
      // Import dinâmico tolerante a ausência da lib ioredis
      const ioredisModule = 'ioredis';
      const Redis = require(ioredisModule);
      this.redisClient = new Redis(redisUrl, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 3000
      });

      this.redisClient.on('connect', () => {
        this.isRedisReady = true;
        console.log('⚡ [MessageCache] Conectado ao Redis com sucesso.');
      });

      this.redisClient.on('error', (err: Error) => {
        this.isRedisReady = false;
        console.warn('⚠️ [MessageCache] Redis indisponível, utilizando MemoryCache fallback:', err.message);
      });

      await this.redisClient.connect();
    } catch {
      this.isRedisReady = false;
    }
  }

  /**
   * Registra que uma mensagem foi enviada pelo bot da IA (Anti-Loop)
   * Salva: SET bot_sent:{messageId} = true EX 60
   */
  public async setBotSent(messageId: string, ttlSeconds: number = 60): Promise<void> {
    if (!messageId) return;
    const key = `bot_sent:${messageId}`;

    // 1. Grava no MemoryCache
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.memoryCache.set(key, expiresAt);

    // 2. Se Redis estiver ativo, grava com EX
    if (this.isRedisReady && this.redisClient) {
      try {
        await this.redisClient.set(key, 'true', 'EX', ttlSeconds);
      } catch {
        // Fallback para memória em caso de falha transitória do Redis
      }
    }
  }

  /**
   * Verifica se a mensagem foi originada pelo bot
   */
  public async isBotSent(messageId: string): Promise<boolean> {
    if (!messageId) return false;
    const key = `bot_sent:${messageId}`;

    // 1. Checa Redis primeiro se disponível
    if (this.isRedisReady && this.redisClient) {
      try {
        const val = await this.redisClient.get(key);
        if (val) return true;
      } catch {
        // Fallback para verificação em memória
      }
    }

    // 2. Checa MemoryCache
    const expiresAt = this.memoryCache.get(key);
    if (!expiresAt) return false;

    if (Date.now() > expiresAt) {
      this.memoryCache.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Limpa o cache (usado principalmente em testes)
   */
  public clear(): void {
    this.memoryCache.clear();
  }
}

export const messageCache = new MessageCacheService();
