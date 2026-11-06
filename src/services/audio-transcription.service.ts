// ==============================================================================
// SAAS MULTI-TENANT ENGINE - AUDIO TRANSCRIPTION SERVICE (TYPESCRIPT)
// Transcrição de áudios e mensagens de voz do WhatsApp via OpenAI Whisper
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

export class AudioTranscriptionService {
  private openai: OpenAI;

  constructor(apiKey?: string) {
    this.openai = new OpenAI({
      apiKey: apiKey || OPENAI_API_KEY
    });
  }

  /**
   * Transcreve um áudio (Buffer ou Base64) usando o modelo Whisper-1 da OpenAI
   */
  public async transcribeAudio(
    audioData: Buffer | string,
    options: { filename?: string; mimetype?: string; language?: string } = {}
  ): Promise<string | null> {
    if (!audioData) return null;

    try {
      let buffer: Buffer;
      if (Buffer.isBuffer(audioData)) {
        buffer = audioData;
      } else if (typeof audioData === 'string') {
        const cleanBase64 = audioData.replace(/^data:audio\/[^;]+;base64,/, '').trim();
        buffer = Buffer.from(cleanBase64, 'base64');
      } else {
        return null;
      }

      if (!buffer || buffer.length === 0) {
        return null;
      }

      const filename = options.filename || 'whatsapp_audio.ogg';
      const fileType = options.mimetype || 'audio/ogg';

      const file = await OpenAI.toFile(buffer, filename, { type: fileType });

      const transcription = await this.openai.audio.transcriptions.create({
        file,
        model: 'whisper-1',
        language: options.language || 'pt',
        temperature: 0.2
      });

      return transcription?.text ? transcription.text.trim() : null;
    } catch (err: any) {
      console.error('[AudioTranscriptionService] Erro ao transcrever áudio com Whisper:', err.message);
      return null;
    }
  }
}

export const audioTranscriptionService = new AudioTranscriptionService();
