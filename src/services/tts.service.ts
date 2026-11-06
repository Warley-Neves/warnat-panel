// ==============================================================================
// SAAS MULTI-TENANT ENGINE - TEXT-TO-SPEECH (TTS) SERVICE (TYPESCRIPT)
// Síntese de voz com OpenAI TTS para respostas de voz da assistente virtual (Nat)
// ==============================================================================

import { OpenAI } from 'openai';
import path from 'path';
import fs from 'fs';

// Carregar variáveis de ambiente
const envPath = path.resolve(__dirname, '..', '..', '.env');
const envMap: Record<string, string> = {};
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

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || envMap['OPENAI_API_KEY'];

export interface SpeechResponse {
  buffer: Buffer;
  base64: string;
  mimetype: string;
  voice: string;
  size: number;
}

export class TextToSpeechService {
  private openai: OpenAI;

  constructor(apiKey?: string) {
    this.openai = new OpenAI({
      apiKey: apiKey || OPENAI_API_KEY
    });
  }

  /**
   * Converte texto humanizado em áudio para notas de voz no WhatsApp
   */
  public async generateSpeech(
    text: string,
    options: {
      voice?: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer' | string;
      model?: string;
      format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav';
      speed?: number;
    } = {}
  ): Promise<SpeechResponse> {
    if (!text || !text.trim()) {
      throw new Error('Texto para síntese de voz é obrigatório.');
    }

    const cleanText = text
      .replace(/\*+/g, '')
      .replace(/_{1,2}/g, '')
      .replace(/`{1,3}[^`]*`{1,3}/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .trim();

    const voice = (options.voice || 'nova') as any;
    const model = options.model || 'tts-1';
    const responseFormat = options.format || 'mp3';

    try {
      const response = await this.openai.audio.speech.create({
        model,
        voice,
        input: cleanText,
        response_format: responseFormat,
        speed: options.speed || 1.05
      });

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      const base64 = buffer.toString('base64');

      return {
        buffer,
        base64,
        mimetype: `audio/${responseFormat}`,
        voice,
        size: buffer.length
      };
    } catch (err: any) {
      console.error('[TextToSpeechService] Erro ao gerar áudio com OpenAI TTS:', err.message);
      throw err;
    }
  }
}

export const ttsService = new TextToSpeechService();
