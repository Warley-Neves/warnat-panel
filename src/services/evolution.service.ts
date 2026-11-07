// ==============================================================================
// SAAS MULTI-TENANT ENGINE - EVOLUTION API SERVICE (TYPESCRIPT)
// WhatsApp instance management, QR code polling, messaging & key.id capture
// ==============================================================================

import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import {
  CreateInstanceOptions,
  CreateInstanceResponse,
  QRCodeResponse,
  InstanceStatusResponse,
  SetWebhookResponse,
  SendMessageOptions,
  SendMessageResponse
} from '../types/evolution.types';

const envPath = path.resolve(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  dotenv.config({ path: envPath });
} else {
  dotenv.config();
}

export class EvolutionApiService {
  private primaryUrl: string;
  private fallbackUrl: string = 'https://warnat-api.onrender.com';
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl?: string, apiKey?: string) {
    this.primaryUrl = (baseUrl || process.env.SERVER_URL || 'https://warnat-api.onrender.com').replace(/\/+$/, '');
    this.baseUrl = this.primaryUrl;
    this.apiKey = apiKey || process.env.AUTHENTICATION_API_KEY || 'SUA_CHAVE_GLOBAL_AQUI_123456';
  }

  /**
   * Determina a URL oficial do webhook para recepção de mensagens do WhatsApp
   */
  public getDefaultWebhookUrl(): string {
    const rawUrl = process.env.WEBHOOK_URL ||
      (process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL}/api/webhook/whatsapp` : null) ||
      (process.env.PANEL_URL ? `${process.env.PANEL_URL}/api/webhook/whatsapp` : null) ||
      'https://warnat-panel.onrender.com/api/webhook/whatsapp';
    return rawUrl.trim();
  }

  /**
   * Helper genérico para requisições HTTP à Evolution API com fallback automático
   */
  private async request(endpoint: string, options: RequestInit = {}): Promise<{ status: number; ok: boolean; data: any }> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      'apikey': this.apiKey,
      'Content-Type': 'application/json',
      ...((options.headers as Record<string, string>) || {})
    };

    const signal = options.signal || (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined);

    try {
      const response = await fetch(url, {
        ...options,
        signal,
        headers
      });

      const text = await response.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }

      return {
        status: response.status,
        ok: response.ok,
        data
      };
    } catch (fetchErr: any) {
      if (this.baseUrl !== this.fallbackUrl) {
        console.warn(`[EvolutionAPI] Falha em ${this.baseUrl} (${fetchErr.message}). Tentando fallback em ${this.fallbackUrl}...`);
        try {
          const fallbackRes = await fetch(`${this.fallbackUrl}${endpoint}`, {
            ...options,
            headers
          });
          const text = await fallbackRes.text();
          let data: any;
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
          this.baseUrl = this.fallbackUrl;
          return {
            status: fallbackRes.status,
            ok: fallbackRes.ok,
            data
          };
        } catch (fbErr: any) {
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
   */
  public async createInstance(
    instanceName: string,
    options: CreateInstanceOptions = {}
  ): Promise<CreateInstanceResponse> {
    if (!instanceName) {
      throw new Error('Nome da instância é obrigatório.');
    }

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
      console.warn(`[EvolutionApiService] Falha ao criar instância na API:`, res.data);
    } else {
      // Auto-configura o webhook imediatamente após a criação da instância
      const webhookUrl = options.webhookUrl || this.getDefaultWebhookUrl();
      try {
        await this.setWebhook(instanceName, webhookUrl);
        console.log(`[EvolutionApiService] Webhook auto-configurado para ${instanceName}: ${webhookUrl}`);
      } catch (whErr: any) {
        console.warn(`[EvolutionApiService] Aviso ao auto-configurar webhook para ${instanceName}:`, whErr.message);
      }
    }

    return {
      success: res.ok,
      instanceName,
      data: res.data
    };
  }

  /**
   * Obtém o QR Code ou status de pareamento da instância com auto-criação
   */
  public async getQRCode(instanceName: string): Promise<QRCodeResponse> {
    if (!instanceName) {
      throw new Error('Nome da instância é obrigatório.');
    }

    let res = await this.request(`/instance/connect/${instanceName}`, {
      method: 'GET'
    });

    const resString = JSON.stringify(res.data || {});
    const isNotFound = !res.ok && (
      res.status === 404 ||
      resString.includes('not found') ||
      resString.includes('não encontrada') ||
      resString.includes('does not exist')
    );

    if (isNotFound) {
      console.log(`[EvolutionApiService] Instância ${instanceName} não encontrada. Criando automaticamente...`);
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
      } catch (crErr: any) {
        console.warn(`[EvolutionApiService] Erro ao auto-criar ${instanceName}:`, crErr.message);
      }
      res = await this.request(`/instance/connect/${instanceName}`, { method: 'GET' });
    }

    const qrRaw = res.data;
    const base64Raw = qrRaw?.base64 || qrRaw?.qrcode?.base64 || null;
    const formattedBase64 = base64Raw ? (base64Raw.startsWith('data:') ? base64Raw : `data:image/png;base64,${base64Raw}`) : null;

    // Garante que o webhook está configurado para esta instância
    const defaultWebhook = this.getDefaultWebhookUrl();
    this.setWebhook(instanceName, defaultWebhook).catch(() => {});

    return {
      success: res.ok,
      instanceName,
      pairingCode: qrRaw?.pairingCode || qrRaw?.qrcode?.pairingCode || null,
      code: qrRaw?.code || qrRaw?.qrcode?.code || null,
      base64: formattedBase64,
      raw: res.data
    };
  }

  /**
   * Consulta o estado atual da conexão WhatsApp (open, connecting, disconnected)
   */
  public async getInstanceStatus(instanceName: string): Promise<InstanceStatusResponse> {
    if (!instanceName) {
      throw new Error('Nome da instância é obrigatório.');
    }

    const res = await this.request(`/instance/connectionState/${instanceName}`, {
      method: 'GET'
    });

    const state = (res.data?.instance?.state || res.data?.state || 'disconnected') as 'open' | 'connecting' | 'disconnected' | 'close';
    return {
      success: res.ok,
      instanceName,
      state,
      data: res.data
    };
  }

  /**
   * Configura o webhook oficial da instância para receber mensagens
   */
  public async setWebhook(
    instanceName: string,
    webhookUrl: string,
    events: string[] = ['MESSAGES_UPSERT', 'MESSAGES_UPDATE', 'CONNECTION_UPDATE']
  ): Promise<SetWebhookResponse> {
    if (!instanceName || !webhookUrl) {
      throw new Error('instanceName e webhookUrl são obrigatórios.');
    }

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
   */
  public async sendTextMessage(
    instanceName: string,
    to: string,
    text: string,
    options: SendMessageOptions = {}
  ): Promise<SendMessageResponse> {
    if (!instanceName || !to || !text) {
      throw new Error('instanceName, to e text são obrigatórios para envio de mensagem.');
    }

    const cleanNumber = String(to).replace(/@.*$/, '').replace(/\D/g, '');

    const payload: any = {
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
      // Se a Evolution API local estiver desconectada ou em homologação, gera ID rastreável
      const fallbackId = `SIM_MSG_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      return {
        success: false,
        messageId: fallbackId,
        simulated: true,
        error: res.data
      };
    }

    // Captura o key.id oficial retornado pela Baileys / Evolution API
    const messageId =
      res.data?.key?.id ||
      res.data?.id ||
      (res.data?.message && res.data.message.key?.id) ||
      `SIM_MSG_${Date.now()}`;

    return {
      success: true,
      messageId,
      data: res.data
    };
  }

  /**
   * Simula presença de digitação no WhatsApp ('composing' ou 'recording')
   */
  public async sendPresence(
    instanceName: string,
    to: string,
    presence: 'composing' | 'recording' = 'composing'
  ): Promise<void> {
    try {
      const cleanNumber = String(to).replace(/@.*$/, '').replace(/\D/g, '');
      await this.request(`/chat/sendPresence/${instanceName}`, {
        method: 'POST',
        body: JSON.stringify({
          number: cleanNumber,
          presence,
          delay: 1500
        })
      });
    } catch {
      // Falha de presença não é impeditiva para o fluxo
    }
  }

  /**
   * Envia uma mensagem de áudio (nota de voz PTT) para o WhatsApp e retorna o key.id
   */
  public async sendWhatsAppAudio(
    instanceName: string,
    to: string,
    audioBase64OrUrl: string,
    options: { delay?: number; ptt?: boolean; encoding?: boolean; mimetype?: string } = {}
  ): Promise<SendMessageResponse> {
    if (!instanceName || !to || !audioBase64OrUrl) {
      throw new Error('instanceName, to e audioBase64OrUrl são obrigatórios para envio de áudio.');
    }

    const cleanNumber = String(to).replace(/@.*$/, '').replace(/\D/g, '');
    const cleanAudio = audioBase64OrUrl.replace(/^data:audio\/[^;]+;base64,/, '').trim();

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

    const messageId =
      res.data?.key?.id ||
      res.data?.id ||
      (res.data?.message && res.data.message.key?.id) ||
      `SIM_AUDIO_${Date.now()}`;

    return {
      success: true,
      messageId,
      data: res.data
    };
  }

  /**
   * Baixa a mídia (base64) de uma mensagem recebida
   */
  public async getBase64FromMediaMessage(
    instanceName: string,
    messageKey: any,
    messageData: any
  ): Promise<string | null> {
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
    } catch (e: any) {
      console.warn('[EvolutionService] Falha ao extrair base64 da mídia:', e.message);
      return null;
    }
  }

  /**
   * Rejeita chamada de voz ou vídeo
   */
  public async rejectCall(instanceName: string, callId: string): Promise<void> {
    try {
      await this.request(`/call/reject/${instanceName}`, {
        method: 'POST',
        body: JSON.stringify({ callId })
      });
    } catch {
      // Ignora falha de rejeição
    }
  }
}

export const evolutionService = new EvolutionApiService();
