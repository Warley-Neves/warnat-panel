// ==============================================================================
// Evolution API Service - Multi-Tenant SaaS
// Gerenciamento de Instâncias WhatsApp, Conexão e Disparo de Mensagens com key.id
// ==============================================================================

const path = require('path');
const fs = require('fs');

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

class EvolutionApiService {
  constructor(baseUrl = null, apiKey = null) {
    this.baseUrl = (baseUrl || process.env.SERVER_URL || envMap['SERVER_URL'] || 'http://localhost:8085').replace(/\/+$/, '');
    this.apiKey = apiKey || process.env.AUTHENTICATION_API_KEY || envMap['AUTHENTICATION_API_KEY'] || 'SUA_CHAVE_GLOBAL_AQUI_123456';
  }

  /**
   * Helper genérico para requisições HTTP à Evolution API
   */
  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'apikey': this.apiKey,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };

    const response = await fetch(url, {
      ...options,
      headers
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      data = text;
    }

    return {
      status: response.status,
      ok: response.ok,
      data
    };
  }

  /**
   * Cria uma nova instância na Evolution API para um tenant
   * @param {string} instanceName Nome único da instância
   * @param {object} options Opções adicionais (qrcode, webhook, etc.)
   */
  async createInstance(instanceName, options = {}) {
    if (!instanceName) throw new Error('Nome da instância é obrigatório.');

    const payload = {
      instanceName,
      token: options.token || `token-${instanceName}-${Date.now()}`,
      qrcode: options.qrcode !== undefined ? options.qrcode : true,
      integration: options.integration || 'WHATSAPP-BAILEYS',
      reject_calls: options.rejectCalls || false,
      groupsIgnore: options.groupsIgnore !== undefined ? options.groupsIgnore : true,
      alwaysOnline: options.alwaysOnline !== undefined ? options.alwaysOnline : false,
      readMessages: options.readMessages || false,
      readStatus: options.readStatus || false
    };

    const res = await this.request('/instance/create', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      throw new Error(`Falha ao criar instância: ${JSON.stringify(res.data)}`);
    }

    return {
      success: true,
      instanceName,
      data: res.data
    };
  }

  /**
   * Obtém o QR Code ou status de pareamento da instância
   * @param {string} instanceName
   */
  async getQRCode(instanceName) {
    if (!instanceName) throw new Error('Nome da instância é obrigatório.');

    const res = await this.request(`/instance/connect/${instanceName}`, {
      method: 'GET'
    });

    if (!res.ok) {
      throw new Error(`Falha ao obter QR Code: ${JSON.stringify(res.data)}`);
    }

    // Evolution API v2 retorna { base64, code, pairingCode } ou status
    return {
      success: true,
      instanceName,
      pairingCode: res.data?.pairingCode || null,
      code: res.data?.code || null,
      base64: res.data?.base64 || null,
      raw: res.data
    };
  }

  /**
   * Consulta o estado atual da conexão WhatsApp (open, connecting, close)
   * @param {string} instanceName
   */
  async getInstanceStatus(instanceName) {
    if (!instanceName) throw new Error('Nome da instância é obrigatório.');

    const res = await this.request(`/instance/connectionState/${instanceName}`, {
      method: 'GET'
    });

    const state = res.data?.instance?.state || res.data?.state || 'disconnected';
    return {
      success: res.ok,
      instanceName,
      state, // 'open', 'connecting', 'close', 'disconnected'
      data: res.data
    };
  }

  /**
   * Configura o webhook oficial da instância para receber mensagens
   * @param {string} instanceName
   * @param {string} webhookUrl
   * @param {Array<string>} events
   */
  async setWebhook(instanceName, webhookUrl, events = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE']) {
    if (!instanceName || !webhookUrl) throw new Error('instanceName e webhookUrl são obrigatórios.');

    const res = await this.request(`/webhook/set/${instanceName}`, {
      method: 'POST',
      body: JSON.stringify({
        webhook: {
          enabled: true,
          url: webhookUrl,
          byEvents: false,
          base64: false,
          events
        }
      })
    });

    return {
      success: res.ok,
      data: res.data
    };
  }

  /**
   * Envia mensagem de texto e CAPTURA E RETORNA o key.id retornado pela Evolution API
   * @param {string} instanceName Nome da instância do WhatsApp
   * @param {string} to Número do destinatário (ex: 5531983579692 ou JID)
   * @param {string} text Conteúdo da mensagem de texto
   * @param {object} options Opções adicionais (delay, quoted, etc.)
   * @returns {Promise<{ success: boolean, messageId: string, data: object }>}
   */
  async sendTextMessage(instanceName, to, text, options = {}) {
    if (!instanceName || !to || !text) {
      throw new Error('instanceName, to e text são obrigatórios para envio de mensagem.');
    }

    // Normaliza número de telefone (remove sufixos WhatsApp se presentes para a Evolution)
    let cleanNumber = String(to).replace(/@.*$/, '').replace(/\D/g, '');

    const payload = {
      number: cleanNumber,
      text: text.trim(),
      delay: options.delay || 1200,
      linkPreview: options.linkPreview !== undefined ? options.linkPreview : false
    };

    if (options.quoted) {
      payload.quoted = options.quoted;
    }

    const res = await this.request(`/message/sendText/${instanceName}`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      console.error(`[EvolutionService] Erro ao enviar mensagem para ${cleanNumber}:`, res.data);
      return {
        success: false,
        messageId: null,
        error: res.data
      };
    }

    // Captura o key.id oficial retornado pela Baileys / Evolution API
    // Estruturas possíveis da v2: res.data?.key?.id ou res.data?.id
    const messageId = res.data?.key?.id || res.data?.id || (res.data?.message && res.data.message.key?.id);

    return {
      success: true,
      messageId: messageId || null,
      data: res.data
    };
  }

  /**
   * Simula digitação ('composing') ou gravação de áudio ('recording')
   */
  async sendPresence(instanceName, to, presence = 'composing') {
    try {
      let cleanNumber = String(to).replace(/@.*$/, '').replace(/\D/g, '');
      await this.request(`/chat/sendPresence/${instanceName}`, {
        method: 'POST',
        body: JSON.stringify({
          number: cleanNumber,
          presence,
          delay: 1500
        })
      });
    } catch (e) {
      // Falha de presença não é impeditiva
    }
  }
}

module.exports = new EvolutionApiService();
module.exports.EvolutionApiService = EvolutionApiService;
