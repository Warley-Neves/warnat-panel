// ==============================================================================
// SAAS MULTI-TENANT ENGINE - EVOLUTION API & MESSAGING TYPES
// ==============================================================================

export interface CreateInstanceOptions {
  token?: string;
  qrcode?: boolean;
  integration?: string;
  rejectCalls?: boolean;
  groupsIgnore?: boolean;
  alwaysOnline?: boolean;
  readMessages?: boolean;
  readStatus?: boolean;
  webhookUrl?: string;
}

export interface CreateInstanceResponse {
  success: boolean;
  instanceName: string;
  data: any;
}

export interface QRCodeResponse {
  success: boolean;
  instanceName: string;
  pairingCode: string | null;
  code: string | null;
  base64: string | null;
  raw: any;
}

export interface InstanceStatusResponse {
  success: boolean;
  instanceName: string;
  state: 'open' | 'connecting' | 'disconnected' | 'close';
  data: any;
}

export interface SetWebhookResponse {
  success: boolean;
  data: any;
}

export interface SendMessageOptions {
  delay?: number;
  linkPreview?: boolean;
  quoted?: any;
}

export interface SendMessageResponse {
  success: boolean;
  messageId: string; // key.id retornado pela Evolution API (crucial para anti-loop)
  simulated?: boolean;
  data?: any;
  error?: any;
}

/**
 * Estrutura do payload recebido via Webhook da Evolution API v2
 */
export interface EvolutionWebhookPayload {
  event: 'messages.upsert' | 'messages.update' | 'connection.update' | 'call' | string;
  instance: string;
  data?: {
    id?: string;
    from?: string;
    isVideo?: boolean;
    isGroup?: boolean;
    status?: string;
    key?: {
      remoteJid?: string;
      fromMe?: boolean;
      id?: string;
      remoteJidAlt?: string;
      participant?: string;
    };
    pushName?: string;
    base64?: string;
    message?: {
      conversation?: string;
      extendedTextMessage?: {
        text?: string;
      };
      speechToText?: string | { text?: string };
      base64?: string;
      audioMessage?: {
        mimetype?: string;
        seconds?: number;
        base64?: string;
      };
      imageMessage?: {
        mimetype?: string;
        caption?: string;
        base64?: string;
      };
      videoMessage?: {
        mimetype?: string;
        caption?: string;
        base64?: string;
      };
      documentMessage?: {
        mimetype?: string;
        fileName?: string;
        caption?: string;
      };
      [key: string]: any;
    };
    state?: string;
    instance?: string;
  };
}

export interface DebounceBufferItem {
  tenantId: string;
  instanceName: string;
  sessionId: string;
  remoteJid: string;
  pushName: string;
  messages: string[];
  isAudio?: boolean;
  timer: NodeJS.Timeout | null;
}

export interface AITurnInput {
  tenantId: string;
  instanceName: string;
  sessionId: string;
  remoteJid: string;
  pushName: string;
  userMessage: string;
  isAudio?: boolean;
}
