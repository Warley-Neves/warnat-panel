// ==============================================================================
// SAAS MULTI-TENANT ENGINE - AI ENGINE & TOOL CALLING TYPES
// ==============================================================================

export type LeadUrgency = 'baixa' | 'media' | 'alta' | 'imediata';

export interface LeadQualificationArgs {
  nome: string;
  servico: string;
  bairro_cidade: string;
  urgencia?: LeadUrgency;
  detalhes?: string;
}

export interface StructuredLeadData {
  nome: string;
  servico: string;
  bairro_cidade: string;
  urgencia: LeadUrgency;
  detalhes: string;
  qualificado_em: string;
}

export interface LeadQualificationResult {
  success: boolean;
  message: string;
  notifSent: boolean;
  lead: StructuredLeadData;
  error?: string;
}

export interface TurnProcessingOptions {
  model?: string;
  temperature?: number;
  maxToolIterations?: number;
}

export interface TurnProcessingResult {
  success: boolean;
  messageId?: string;
  replyText?: string;
  mediaType?: string;
  toolCallsExecuted: string[];
  error?: string;
}
