const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const OpenAI = require('openai');

// Default voices per provider (hardcoded for v1 — picker can come later)
const DEFAULT_OPENAI_VOICE = 'nova';   // clear, neutral
const DEFAULT_ELEVENLABS_VOICE_ID = 'TxGEqnHWrfWFTfGW9XjX'; // Josh

class VoiceService {
  constructor() {
    this.apiKey = process.env.ELEVENLABS_API_KEY;
    this.apiUrl = 'https://api.elevenlabs.io/v1';
    this.outputDir = process.env.OUTPUT_DIR || '/app/outputs';
    this.tempDir = process.env.TEMP_DIR || '/app/temp';

    // OpenAI client (lazy init — only created when actually needed)
    this._openai = null;
  }

  /**
   * Get or create the OpenAI client
   */
  getOpenAIClient() {
    if (!this._openai) {
      if (!process.env.OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY not configured');
      }
      this._openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    }
    return this._openai;
  }

  /**
   * Generate a single voiceover using OpenAI TTS
   * Returns: Buffer (mp3 audio)
   */
  async generateOpenAIVoice(text, voice = DEFAULT_OPENAI_VOICE) {
    if (!text || !text.trim()) {
      throw new Error('Text is required for voice generation');
    }
    if (text.length > 4096) {
      throw new Error('Text exceeds OpenAI TTS limit of 4096 characters');
    }

    console.log(`[VoiceService] OpenAI TTS: voice=${voice}, chars=${text.length}`);

    const openai = this.getOpenAIClient();

    const mp3Response = await openai.audio.speech.create({
      model: 'tts-1',
      voice: voice,
      input: text,
      response_format: 'mp3'
    });

    // The OpenAI SDK returns a Response object — we need the buffer
    const arrayBuffer = await mp3Response.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    console.log(`[VoiceService] ✓ OpenAI voice generated: ${audioBuffer.length} bytes`);
    return audioBuffer;
  }

  /**
   * UNIFIED voice generation — dispatches to OpenAI or 11Labs
   * Returns: Buffer (mp3 audio)
   *
   * @param {string} provider - 'openai' or 'elevenlabs'
   * @param {string} text - the script to convert to speech
   * @param {object} options - { voice (optional voice override) }
   */
  async generateVoice(provider, text, options = {}) {
    const normalizedProvider = (provider || 'openai').toLowerCase();

    if (normalizedProvider === 'openai') {
      const voice = options.voice || DEFAULT_OPENAI_VOICE;
      return await this.generateOpenAIVoice(text, voice);
    }

    if (normalizedProvider === 'elevenlabs' || normalizedProvider === '11labs') {
      const voiceId = options.voiceId || DEFAULT_ELEVENLABS_VOICE_ID;
      return await this.generateVoiceForReaction(text, voiceId);
    }

    throw new Error(`Unknown TTS provider: ${provider}. Supported: 'openai', 'elevenlabs'`);
  }

  /**
   * Get all available voices from 11Labs
   */
  async getAvailableVoices() {
    try {
      if (!this.apiKey) {
        throw new Error('ELEVENLABS_API_KEY not configured');
      }

      const response = await fetch(`${this.apiUrl}/voices`, {
        method: 'GET',
        headers: {
          'xi-api-key': this.apiKey
        }
      });

      if (!response.ok) {
        throw new Error(`11Labs API error: ${response.statusText}`);
      }

      const data = await response.json();
      
      // Return simplified voice list
      return {
        voices: data.voices.map(voice => ({
          voice_id: voice.voice_id,
          name: voice.name,
          category: voice.category,
          description: voice.description || '',
          preview_url: voice.preview_url || null
        })),
        default: 'Josh' // Default voice
      };

    } catch (error) {
      console.error('Error fetching voices:', error);
      throw error;
    }
  }

  /**
   * Generate voice audio for a single reaction
   */
  async generateVoiceForReaction(text, voiceId, options = {}) {
    try {
      if (!this.apiKey) {
        throw new Error('ELEVENLABS_API_KEY not configured');
      }

      const {
        stability = 0.5,
        similarity_boost = 0.75,
        style = 0.0,
        use_speaker_boost = true
      } = options;

      console.log(`Generating voice for text: "${text.substring(0, 50)}..." with voice ${voiceId}`);

      const response = await fetch(`${this.apiUrl}/text-to-speech/${voiceId}`, {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'Content-Type': 'application/json',
          'xi-api-key': this.apiKey
        },
        body: JSON.stringify({
          text: text,
          model_id: 'eleven_monolingual_v1',
          voice_settings: {
            stability,
            similarity_boost,
            style,
            use_speaker_boost
          }
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`11Labs TTS error: ${response.statusText} - ${errorText}`);
      }

      // Return audio buffer
      const audioBuffer = await response.buffer();
      console.log(`Voice generated successfully: ${audioBuffer.length} bytes`);
      
      return audioBuffer;

    } catch (error) {
      console.error('Error generating voice:', error);
      throw error;
    }
  }

  /**
   * Generate voices for multiple reactions
   */
  async generateVoicesForReactions(reactions, voiceId = 'TxGEqnHWrfWFTfGW9XjX') {
    try {
      const jobId = uuidv4();
      const audioDir = path.join(this.tempDir, jobId, 'audio');
      await fs.ensureDir(audioDir);

      console.log(`Generating ${reactions.length} voices with voice ID: ${voiceId}`);

      const results = [];

      for (let i = 0; i < reactions.length; i++) {
        const reaction = reactions[i];
        
        console.log(`Generating voice ${i + 1}/${reactions.length}...`);

        try {
          // Generate voice
          const audioBuffer = await this.generateVoiceForReaction(
            reaction.text,
            voiceId
          );

          // Save audio file
          const audioFileName = `reaction_${i}_${Date.now()}.mp3`;
          const audioPath = path.join(audioDir, audioFileName);
          await fs.writeFile(audioPath, audioBuffer);

          results.push({
            index: i,
            timestamp: reaction.timestamp,
            text: reaction.text,
            audioPath: audioPath,
            audioFileName: audioFileName,
            success: true
          });

          console.log(`Voice ${i + 1} generated: ${audioPath}`);

        } catch (error) {
          console.error(`Failed to generate voice ${i + 1}:`, error);
          results.push({
            index: i,
            timestamp: reaction.timestamp,
            text: reaction.text,
            audioPath: null,
            audioFileName: null,
            success: false,
            error: error.message
          });
        }
      }

      return {
        jobId,
        audioDir,
        results,
        totalGenerated: results.filter(r => r.success).length,
        totalFailed: results.filter(r => !r.success).length
      };

    } catch (error) {
      console.error('Error generating voices for reactions:', error);
      throw error;
    }
  }

  /**
   * Get voice ID by name
   */
  async getVoiceIdByName(voiceName) {
    try {
      const voicesData = await this.getAvailableVoices();
      const voice = voicesData.voices.find(
        v => v.name.toLowerCase() === voiceName.toLowerCase()
      );

      if (!voice) {
        // Default to Josh if voice not found
        const joshVoice = voicesData.voices.find(v => v.name === 'Josh');
        return joshVoice ? joshVoice.voice_id : 'TxGEqnHWrfWFTfGW9XjX';
      }

      return voice.voice_id;

    } catch (error) {
      console.error('Error getting voice ID:', error);
      // Default Josh voice ID
      return 'TxGEqnHWrfWFTfGW9XjX';
    }
  }
}

module.exports = new VoiceService();
