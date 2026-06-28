const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const OpenAI = require('openai');

// Default voices per provider (hardcoded for v1 — picker can come later)
const DEFAULT_OPENAI_VOICE = 'nova';   // clear, neutral
const DEFAULT_ELEVENLABS_VOICE_ID = 'TxGEqnHWrfWFTfGW9XjX'; // Josh

// ── ReVoice AI text-to-voice catalog ──────────────────────────────────────
// Ported from the multi-voice-over-clip-creator app so ReVoice can offer the
// same providers/voices. The render pipeline only needs an audio file, so all
// three providers feed the same saveReVoiceAudio() flow.
const OPENAI_TTS_HD_MODEL = 'tts-1-hd';
const OPENAI_TTS_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];

const ELEVENLABS_TTS_MODEL = 'eleven_multilingual_v2';

// Stock ElevenLabs voices — stable public IDs that work on any account and,
// crucially, WITHOUT the `voices_read` API permission. Used as the fallback
// when listing the live library fails (e.g. a key scoped to TTS only).
const ELEVENLABS_STOCK_VOICES = [
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel · calm female' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella · soft female' },
  { id: 'MF3mGyEYCl7XYWbV9V6O', name: 'Elli · emotional female' },
  { id: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi · strong female' },
  { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni · well-rounded male' },
  { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh · deep male' },
  { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam · deep male' },
  { id: 'VR6AewLTigWG4xSOukaG', name: 'Arnold · crisp male' },
  { id: 'yoZ06aMxZJJ28mfd3POQ', name: 'Sam · raspy male' },
  { id: 'IKne3meq5aSn9XLyUdCD', name: 'Charlie · Australian male' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George · warm UK male' },
];

// Speechmatics TTS preview API — voice is passed in the URL path, WAV output.
// Docs: https://docs.speechmatics.com/text-to-speech/quickstart
const SPEECHMATICS_TTS_URL = 'https://preview.tts.speechmatics.com/generate';
const SPEECHMATICS_TTS_VOICES = [
  { id: 'sarah', name: 'Sarah · UK · friendly support' },
  { id: 'theo',  name: 'Theo · UK · trusted presenter' },
  { id: 'jack',  name: 'Jack · US · support specialist' },
  { id: 'megan', name: 'Megan · US · clear companion' },
];

// Generous cap — ReVoice sections are usually short, but a long overlay is fine.
const MAX_TTS_CHARS = 5000;

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

  // ========================================================================
  // 🎙️ ReVoice AI text-to-voice — unified catalog + generator (3 providers)
  // ========================================================================

  /**
   * Which providers are usable right now (i.e. their API key is set) + the
   * voices each one offers. ElevenLabs voices are fetched live; OpenAI and
   * Speechmatics are fixed lists. Best-effort: a provider that errors while
   * listing simply comes back with no voices.
   *
   * Returns: { providers: [{ id, name, available, voices: [{ id, name }] }] }
   */
  async getTtsCatalog() {
    const openaiAvailable = !!process.env.OPENAI_API_KEY;
    const elevenAvailable = !!this.apiKey;
    const speechmaticsAvailable = !!(process.env.SPEECHMATICS_API_KEY || '').trim();

    // Prefer the account's live library (includes custom/cloned voices); fall
    // back to stock voices when the key can't list them (no voices_read perm).
    let elevenVoices = [];
    if (elevenAvailable) {
      try {
        const data = await this.getAvailableVoices();
        elevenVoices = (data.voices || []).map(v => ({ id: v.voice_id, name: v.name }));
      } catch (e) {
        console.error('[VoiceService] ElevenLabs voice list failed, using stock voices:', e.message);
      }
      if (elevenVoices.length === 0) elevenVoices = ELEVENLABS_STOCK_VOICES;
    }

    return {
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          available: openaiAvailable,
          voices: OPENAI_TTS_VOICES.map(v => ({ id: v, name: v[0].toUpperCase() + v.slice(1) })),
        },
        {
          id: 'elevenlabs',
          name: 'ElevenLabs',
          available: elevenAvailable,
          voices: elevenVoices,
        },
        {
          id: 'speechmatics',
          name: 'Speechmatics',
          available: speechmaticsAvailable,
          voices: SPEECHMATICS_TTS_VOICES,
        },
      ],
    };
  }

  // ========================================================================
  // 🎬 DOC FACTORY — simple "male / female + accent" voice picker
  // ========================================================================
  // The creator just chooses a gender and an accent; we map that to a real
  // provider + voice. Only providers whose API key is set are offered, and
  // OpenAI (which already powers this backend) is the always-on fallback.
  // Earlier entries are preferred when several match.
  _docFactoryVoicePresets() {
    return [
      { accent: 'US',         gender: 'female', provider: 'openai',       voice: 'nova',                  label: 'Nova · warm US female' },
      { accent: 'US',         gender: 'male',   provider: 'openai',       voice: 'onyx',                  label: 'Onyx · deep US male' },
      { accent: 'UK',         gender: 'male',   provider: 'elevenlabs',   voice: 'JBFqnCBsd6RMkjVDRZzb',  label: 'George · warm UK male' },
      { accent: 'UK',         gender: 'female', provider: 'speechmatics', voice: 'sarah',                 label: 'Sarah · UK female' },
      { accent: 'UK',         gender: 'male',   provider: 'speechmatics', voice: 'theo',                  label: 'Theo · UK male' },
      { accent: 'Australian', gender: 'male',   provider: 'elevenlabs',   voice: 'IKne3meq5aSn9XLyUdCD',  label: 'Charlie · Australian male' },
      { accent: 'US',         gender: 'female', provider: 'elevenlabs',   voice: '21m00Tcm4TlvDq8ikWAM',  label: 'Rachel · calm US female' },
      { accent: 'US',         gender: 'male',   provider: 'elevenlabs',   voice: 'pNInz6obpgDQGcFmaJgB',  label: 'Adam · deep US male' },
    ];
  }

  _providerAvailable(p) {
    if (p === 'openai') return !!process.env.OPENAI_API_KEY;
    if (p === 'elevenlabs') return !!this.apiKey;
    if (p === 'speechmatics') return !!(process.env.SPEECHMATICS_API_KEY || '').trim();
    return false;
  }

  /** The gender/accent presets that actually work right now (key is set). */
  docFactoryVoiceOptions() {
    return this._docFactoryVoicePresets().filter((v) => this._providerAvailable(v.provider));
  }

  /**
   * Turn { gender, accent } into a real { provider, voice }. Falls back to the
   * best available match by gender, then to OpenAI's default voices.
   */
  resolveDocFactoryVoice({ gender, accent } = {}) {
    const g = (gender || '').toLowerCase();
    const a = (accent || '').toLowerCase();
    const avail = this.docFactoryVoiceOptions();
    const exact = avail.find((v) => v.gender === g && v.accent.toLowerCase() === a);
    if (exact) return { provider: exact.provider, voice: exact.voice, label: exact.label };
    const byGender = avail.find((v) => v.gender === g);
    if (byGender) return { provider: byGender.provider, voice: byGender.voice, label: byGender.label };
    // last resort: OpenAI defaults
    const voice = g === 'male' ? 'onyx' : 'nova';
    return { provider: 'openai', voice, label: `${voice[0].toUpperCase() + voice.slice(1)} · default` };
  }

  /**
   * Generate speech from text for ReVoice. Returns the raw audio so the caller
   * can park it on R2 (same path as a recorded clip).
   *
   * @param {object} opts
   * @param {string} opts.provider  'openai' | 'elevenlabs' | 'speechmatics'
   * @param {string} opts.text      the words to speak
   * @param {string} opts.voice     OpenAI voice name / ElevenLabs voiceId / Speechmatics voice id
   * @returns {Promise<{ buffer: Buffer, ext: string, mime: string }>}
   */
  async generateTTS({ provider = 'openai', text, voice }) {
    const clean = (text || '').trim();
    if (!clean) throw new Error('Please type some text to turn into a voice.');
    if (clean.length > MAX_TTS_CHARS) {
      throw new Error(`That text is too long (${clean.length} chars). Keep it under ${MAX_TTS_CHARS}.`);
    }
    const p = (provider || 'openai').toLowerCase();

    if (p === 'openai') {
      if (!process.env.OPENAI_API_KEY) throw new Error('OpenAI is not configured on the server.');
      const v = OPENAI_TTS_VOICES.includes(voice) ? voice : DEFAULT_OPENAI_VOICE;
      const openai = this.getOpenAIClient();
      const resp = await openai.audio.speech.create({
        model: OPENAI_TTS_HD_MODEL,
        voice: v,
        input: clean,
        response_format: 'mp3',
      });
      const buffer = Buffer.from(await resp.arrayBuffer());
      return { buffer, ext: '.mp3', mime: 'audio/mpeg' };
    }

    if (p === 'elevenlabs' || p === '11labs') {
      if (!this.apiKey) throw new Error('ElevenLabs is not configured on the server.');
      const voiceId = voice || DEFAULT_ELEVENLABS_VOICE_ID;
      const response = await fetch(
        `${this.apiUrl}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_192`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': this.apiKey,
            'Content-Type': 'application/json',
            'Accept': 'audio/mpeg',
          },
          body: JSON.stringify({ text: clean, model_id: ELEVENLABS_TTS_MODEL }),
        }
      );
      if (!response.ok) {
        const t = await response.text();
        throw new Error(`ElevenLabs ${response.status}: ${t.slice(0, 300)}`);
      }
      const buffer = await response.buffer();
      return { buffer, ext: '.mp3', mime: 'audio/mpeg' };
    }

    if (p === 'speechmatics') {
      const key = (process.env.SPEECHMATICS_API_KEY || '').trim();
      if (!key) throw new Error('Speechmatics is not configured on the server.');
      if (!SPEECHMATICS_TTS_VOICES.some(sv => sv.id === voice)) {
        throw new Error(`Unknown Speechmatics voice: ${voice}`);
      }
      const response = await fetch(`${SPEECHMATICS_TTS_URL}/${encodeURIComponent(voice)}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type': 'application/json',
          'Accept': 'audio/wav',
        },
        body: JSON.stringify({ text: clean }),
      });
      if (!response.ok) {
        const t = await response.text();
        throw new Error(`Speechmatics ${response.status}: ${t.slice(0, 300)}`);
      }
      const buffer = await response.buffer();
      return { buffer, ext: '.wav', mime: 'audio/wav' };
    }

    throw new Error(`Unknown TTS provider: ${provider}`);
  }
}

module.exports = new VoiceService();
