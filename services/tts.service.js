// ==============================================================================
// Text-to-Speech (TTS) Service - Multi-Tenant SaaS
// Síntese de voz com OpenAI TTS para respostas em áudio da assistente virtual (Nat)
// ==============================================================================

const { OpenAI } = require('openai');
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

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || envMap['OPENAI_API_KEY'];

class TextToSpeechService {
  constructor(apiKey = null) {
    this.openai = new OpenAI({
      apiKey: apiKey || OPENAI_API_KEY
    });
  }

  /**
   * Converte texto humanizado em áudio MP3/Opus para notas de voz do WhatsApp
   * @param {string} text Texto a ser falado pela IA
   * @param {object} options Opções de voz (voice: 'nova' | 'shimmer' | 'alloy', model: 'tts-1')
   * @returns {Promise<{ buffer: Buffer, base64: string, mimetype: string }>}
   */
  async generateSpeech(text, options = {}) {
    if (!text || !text.trim()) {
      throw new Error('Texto para síntese de voz é obrigatório.');
    }

    // Limpa marcações de markdown e emojis exagerados que possam atrapalhar a dicção
    const cleanText = text
      .replace(/\*+/g, '') // Remove asteriscos de negrito
      .replace(/_{1,2}/g, '') // Remove itálicos
      .replace(/`{1,3}[^`]*`{1,3}/g, '') // Remove blocos de código
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Converte links markdown em texto puro
      .trim();

    const voice = options.voice || 'nova'; // 'nova' é a voz feminina padrão calorosa e natural da Nat
    const model = options.model || 'tts-1';
    const responseFormat = options.format || 'mp3';

    try {
      const response = await this.openai.audio.speech.create({
        model,
        voice,
        input: cleanText,
        response_format: responseFormat,
        speed: options.speed || 1.05 // Levemente acelerado para fluidez natural no WhatsApp
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
    } catch (err) {
      console.error('[TextToSpeechService] Erro ao gerar áudio com OpenAI TTS:', err.message);
      throw err;
    }
  }
}

module.exports = new TextToSpeechService();
module.exports.TextToSpeechService = TextToSpeechService;
