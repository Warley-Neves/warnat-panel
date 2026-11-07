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
    this.primaryUrl = (baseUrl || process.env.SERVER_URL || envMap['SERVER_URL'] || 'https://warnat-api.onrender.com').replace(/\/+$/, '');
    this.fallbackUrl = 'https://warnat-api.onrender.com';
    this.baseUrl = this.primaryUrl;
    this.apiKey = apiKey || process.env.AUTHENTICATION_API_KEY || envMap['AUTHENTICATION_API_KEY'] || 'SUA_CHAVE_GLOBAL_AQUI_123456';
  }

  /**
   * Determina a URL oficial do webhook para recepção de mensagens do WhatsApp
   */
  getDefaultWebhookUrl() {
    const rawUrl = process.env.WEBHOOK_URL ||
      envMap['WEBHOOK_URL'] ||
      (process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL}/api/webhook/whatsapp` : null) ||
      (process.env.PANEL_URL ? `${process.env.PANEL_URL}/api/webhook/whatsapp` : null) ||
      'https://warnat-panel.onrender.com/api/webhook/whatsapp';
    return rawUrl.trim();
  }

  /**
   * Helper genérico para requisições HTTP à Evolution API com resiliência e fallback automático
   */
  async request(endpoint, options = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const headers = {
      'apikey': this.apiKey,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };

    const signal = options.signal || (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(options.timeout || 15000) : undefined);

    try {
      const response = await fetch(url, {
        ...options,
        signal,
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
    } catch (fetchErr) {
      // Se falhou e estávamos usando localhost ou URL local, tenta imediatamente o fallback cloud na Render
      if (this.baseUrl !== this.fallbackUrl) {
        console.warn(`[EvolutionAPI] Falha em ${this.baseUrl} (${fetchErr.message}). Tentando fallback em ${this.fallbackUrl}...`);
        try {
          const fallbackRes = await fetch(`${this.fallbackUrl}${endpoint}`, {
            ...options,
            headers
          });
          const text = await fallbackRes.text();
          let data;
          try {
            data = JSON.parse(text);
          } catch (e) {
            data = text;
          }
          this.baseUrl = this.fallbackUrl;
          return {
            status: fallbackRes.status,
            ok: fallbackRes.ok,
            data
          };
        } catch (fbErr) {
          return {
            status: 503,
            ok: false,
            data: { error: fbErr.message }
          };
        }
      }

      return {
        status: 503,
        ok: false,
        data: { error: fetchErr.message }
      };
    }
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

    // Auto-configura o webhook imediatamente após a criação da instância
    const webhookUrl = options.webhookUrl || this.getDefaultWebhookUrl();
    try {
      await this.setWebhook(instanceName, webhookUrl);
      console.log(`[EvolutionAPI] Webhook auto-configurado para ${instanceName}: ${webhookUrl}`);
    } catch (whErr) {
      console.warn(`[EvolutionAPI] Aviso ao auto-configurar webhook para ${instanceName}:`, whErr.message);
    }

    return {
      success: true,
      instanceName,
      data: res.data
    };
  }

  /**
   * Obtém o QR Code ou status de pareamento da instância com auto-provisionamento
   * @param {string} instanceName
   */
  async getQRCode(instanceName) {
    if (!instanceName) throw new Error('Nome da instância é obrigatório.');

    let res = await this.request(`/instance/connect/${instanceName}`, {
      method: 'GET'
    });

    // Se a instância não existe na Evolution API, cria automaticamente
    const resString = JSON.stringify(res.data || {});
    const isNotFound = !res.ok && (
      res.status === 404 ||
      resString.includes('not found') ||
      resString.includes('não encontrada') ||
      resString.includes('does not exist')
    );

    if (isNotFound) {
      console.log(`[EvolutionAPI] Instância ${instanceName} não encontrada na API. Criando automaticamente...`);
      try {
        const createRes = await this.createInstance(instanceName, { qrcode: true });
        const createQr = createRes.data?.qrcode;
        if (createQr?.base64 || createRes.data?.base64) {
          const base64Raw = createQr?.base64 || createRes.data?.base64;
          const formattedBase64 = base64Raw.startsWith('data:') ? base64Raw : `data:image/png;base64,${base64Raw}`;
          return {
            success: true,
            instanceName,
            pairingCode: createQr?.pairingCode || null,
            code: createQr?.code || null,
            base64: formattedBase64,
            raw: createRes.data
          };
        }
      } catch (crErr) {
        console.warn(`[EvolutionAPI] Erro ao auto-criar ${instanceName}:`, crErr.message);
      }
      res = await this.request(`/instance/connect/${instanceName}`, { method: 'GET' });
    }

    if (!res.ok) {
      throw new Error(`Falha ao obter QR Code: ${JSON.stringify(res.data)}`);
    }

    // Evolution API v2 retorna { base64, code, pairingCode } ou status
    const qrRaw = res.data;
    const base64Raw = qrRaw?.base64 || qrRaw?.qrcode?.base64 || null;
    const formattedBase64 = base64Raw ? (base64Raw.startsWith('data:') ? base64Raw : `data:image/png;base64,${base64Raw}`) : null;
    const code = qrRaw?.code || qrRaw?.qrcode?.code || null;
    const pairingCode = qrRaw?.pairingCode || qrRaw?.qrcode?.pairingCode || null;
    const state = qrRaw?.instance?.state || (formattedBase64 ? 'connecting' : 'close');

    // Garante que o webhook está configurado para esta instância
    const defaultWebhook = this.getDefaultWebhookUrl();
    this.setWebhook(instanceName, defaultWebhook).catch(() => {});

    return {
      success: true,
      instanceName,
      state,
      pairingCode,
      code,
      base64: formattedBase64,
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

    const state = res.data?.instance?.state || res.data?.state || (res.ok ? 'open' : 'disconnected');
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
      console.warn(`[EvolutionService] Aviso ao enviar mensagem para ${cleanNumber}:`, res.data?.error || res.data);
      const fallbackId = `SIM_MSG_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      return {
        success: false,
        messageId: fallbackId,
        simulated: true,
        error: res.data
      };
    }

    // Captura o key.id oficial retornado pela Baileys / Evolution API
    // Estruturas possíveis da v2: res.data?.key?.id ou res.data?.id
    const messageId = res.data?.key?.id || res.data?.id || (res.data?.message && res.data.message.key?.id);

    return {
      success: true,
      messageId: messageId || `SIM_MSG_${Date.now()}`,
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

  /**
   * Envia uma mensagem de áudio (nota de voz PTT) para o WhatsApp e retorna o key.id
   * @param {string} instanceName Nome da instância
   * @param {string} to Número do destinatário
   * @param {string} audioBase64OrUrl Base64 ou URL do arquivo de áudio
   * @param {object} options Opções adicionais (delay, ptt, encoding)
   * @returns {Promise<{ success: boolean, messageId: string, data: object }>}
   */
  async sendWhatsAppAudio(instanceName, to, audioBase64OrUrl, options = {}) {
    if (!instanceName || !to || !audioBase64OrUrl) {
      throw new Error('instanceName, to e audioBase64OrUrl são obrigatórios para envio de áudio.');
    }

    let cleanNumber = String(to).replace(/@.*$/, '').replace(/\D/g, '');

    const cleanAudio = typeof audioBase64OrUrl === 'string'
      ? audioBase64OrUrl.replace(/^data:audio\/[^;]+;base64,/, '').trim()
      : audioBase64OrUrl;

    const payloadAudio = {
      number: cleanNumber,
      audio: cleanAudio,
      delay: options.delay || 1500,
      encoding: options.encoding !== undefined ? options.encoding : true
    };

    let res = await this.request(`/message/sendWhatsAppAudio/${instanceName}`, {
      method: 'POST',
      body: JSON.stringify(payloadAudio)
    });

    if (!res.ok) {
      const payloadMedia = {
        number: cleanNumber,
        mediatype: 'audio',
        mimetype: options.mimetype || 'audio/mp4',
        media: cleanAudio,
        ptt: options.ptt !== undefined ? options.ptt : true,
        delay: options.delay || 1500
      };

      res = await this.request(`/message/sendMedia/${instanceName}`, {
        method: 'POST',
        body: JSON.stringify(payloadMedia)
      });
    }

    if (!res.ok) {
      console.warn(`[EvolutionService] Aviso ao enviar áudio para ${cleanNumber}:`, res.data?.error || res.data);
      const fallbackId = `SIM_AUDIO_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      return {
        success: false,
        messageId: fallbackId,
        simulated: true,
        error: res.data
      };
    }

    const messageId = res.data?.key?.id || res.data?.id || (res.data?.message && res.data.message.key?.id);

    return {
      success: true,
      messageId: messageId || `SIM_AUDIO_${Date.now()}`,
      data: res.data
    };
  }

  /**
   * Baixa a mídia (base64) de uma mensagem de áudio ou imagem recebida
   * @param {string} instanceName
   * @param {object} messageKey
   * @param {object} messageData
   */
  async getBase64FromMediaMessage(instanceName, messageKey, messageData) {
    try {
      const payload = {
        message: {
          key: messageKey,
          message: messageData
        },
        convertToMp4: false
      };

      const res = await this.request(`/chat/getBase64FromMediaMessage/${instanceName}`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      if (res.ok && res.data) {
        return res.data.base64 || res.data.data?.base64 || null;
      }
      return null;
    } catch (e) {
      console.warn('[EvolutionService] Falha ao extrair base64 da mídia:', e.message);
      return null;
    }
  }

  /**
   * Envia arquivo de mídia (documento, imagem, vídeo) e retorna o key.id
   * @param {string} instanceName Nome da instância
   * @param {string} to Número do destinatário
   * @param {string} mediaBase64OrUrl Base64 ou URL do arquivo
   * @param {object} options { mediatype: 'document'|'image'|'video', mimetype: string, fileName: string, caption: string, delay: number }
   * @returns {Promise<{ success: boolean, messageId: string, data: object }>}
   */
  async sendMediaMessage(instanceName, to, mediaBase64OrUrl, options = {}) {
    if (!instanceName || !to || !mediaBase64OrUrl) {
      throw new Error('instanceName, to e mediaBase64OrUrl são obrigatórios.');
    }

    let cleanNumber = String(to).replace(/@.*$/, '').replace(/\D/g, '');
    const cleanMedia = typeof mediaBase64OrUrl === 'string'
      ? mediaBase64OrUrl.replace(/^data:[^;]+;base64,/, '').trim()
      : mediaBase64OrUrl;

    const payload = {
      number: cleanNumber,
      mediatype: options.mediatype || 'document',
      mimetype: options.mimetype || 'application/pdf',
      caption: options.caption ? options.caption.trim() : '',
      fileName: options.fileName || options.filename || 'documento.pdf',
      media: cleanMedia,
      delay: options.delay || 1500
    };

    const res = await this.request(`/message/sendMedia/${instanceName}`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      console.warn(`[EvolutionService] Aviso ao enviar mídia para ${cleanNumber}:`, res.data?.error || res.data);
      const fallbackId = `SIM_MEDIA_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      return {
        success: false,
        messageId: fallbackId,
        simulated: true,
        error: res.data
      };
    }

    const messageId = res.data?.key?.id || res.data?.id || (res.data?.message && res.data.message.key?.id);
    return {
      success: true,
      messageId: messageId || `SIM_MEDIA_${Date.now()}`,
      data: res.data
    };
  }

  /**
   * Rejeita chamada de voz ou vídeo recebida
   * @param {string} instanceName
   * @param {string} callId
   */
  async rejectCall(instanceName, callId) {
    try {
      await this.request(`/call/reject/${instanceName}`, {
        method: 'POST',
        body: JSON.stringify({ callId })
      });
    } catch (e) {
      // Ignora falha de rejeição
    }
  }
}

module.exports = new EvolutionApiService();
module.exports.EvolutionApiService = EvolutionApiService;
