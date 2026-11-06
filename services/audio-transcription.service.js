// ==============================================================================
// Audio Transcription Service (OpenAI Whisper) - Multi-Tenant SaaS
// Transcrição de áudio e notas de voz do WhatsApp em texto
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

class AudioTranscriptionService {
  constructor(apiKey = null) {
    this.openai = new OpenAI({
      apiKey: apiKey || OPENAI_API_KEY
    });
  }

  /**
   * Transcreve um áudio (Buffer ou Base64) usando o modelo Whisper-1 da OpenAI
   * @param {Buffer|string} audioData Buffer ou string base64 do arquivo de áudio
   * @param {object} options Opções adicionais (mimetype, filename, language)
   * @returns {Promise<string|null>} Texto transcrito ou null se falhar
   */
  async transcribeAudio(audioData, options = {}) {
    if (!audioData) return null;

    try {
      let buffer;
      if (Buffer.isBuffer(audioData)) {
        buffer = audioData;
      } else if (typeof audioData === 'string') {
        // Remove prefixo data:audio/...;base64, se houver
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

      const text = transcription?.text ? transcription.text.trim() : null;
      return text;
    } catch (err) {
      console.error('[AudioTranscriptionService] Erro ao transcrever áudio com Whisper:', err.message);
      return null;
    }
  }
}

module.exports = new AudioTranscriptionService();
module.exports.AudioTranscriptionService = AudioTranscriptionService;
