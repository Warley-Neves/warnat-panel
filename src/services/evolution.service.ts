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
  private baseUrl: string;
  private apiKey: string;

  constructor(baseUrl?: string, apiKey?: string) {
    this.baseUrl = (baseUrl || process.env.SERVER_URL || 'http://localhost:8085').replace(/\/+$/, '');
    this.apiKey = apiKey || process.env.AUTHENTICATION_API_KEY || 'SUA_CHAVE_GLOBAL_AQUI_123456';
  }

  /**
   * Helper genérico para requisições HTTP à Evolution API
   */
  private async request(endpoint: string, options: RequestInit = {}): Promise<{ status: number; ok: boolean; data: any }> {
    const url = `${this.baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      'apikey': this.apiKey,
      'Content-Type': 'application/json',
      ...((options.headers as Record<string, string>) || {})
    };

    try {
      const response = await fetch(url, {
        ...options,
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
    }

    return {
      success: res.ok,
      instanceName,
      data: res.data
    };
  }

  /**
   * Obtém o QR Code ou status de pareamento da instância
   */
  public async getQRCode(instanceName: string): Promise<QRCodeResponse> {
    if (!instanceName) {
      throw new Error('Nome da instância é obrigatório.');
    }

    const res = await this.request(`/instance/connect/${instanceName}`, {
      method: 'GET'
    });

    return {
      success: res.ok,
      instanceName,
      pairingCode: res.data?.pairingCode || null,
      code: res.data?.code || null,
      base64: res.data?.base64 || null,
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
}

export const evolutionService = new EvolutionApiService();
