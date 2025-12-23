const OpenAI = require('openai');
const fs = require('fs-extra');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');

class TranscriptionService {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  }

  /**
   * Transcribe audio from video file using OpenAI Whisper
   */
  async transcribe(videoPath, options = {}) {
    try {
      console.log(`Transcribing: ${videoPath}`);

      // Check if file exists
      const exists = await fs.pathExists(videoPath);
      if (!exists) {
        throw new Error('Video file not found');
      }

      // Get file stats
      const stats = await fs.stat(videoPath);
      const fileSizeMB = stats.size / (1024 * 1024);
      
      console.log(`File size: ${fileSizeMB.toFixed(2)}MB`);

      // OpenAI Whisper has a 25MB limit, so we might need to extract audio separately
      if (fileSizeMB > 25) {
        throw new Error('File too large for direct transcription. Please extract audio first.');
      }

      // Create read stream
      const fileStream = fs.createReadStream(videoPath);

      // Call OpenAI Whisper API
      const transcription = await this.openai.audio.transcriptions.create({
        file: fileStream,
        model: 'whisper-1',
        response_format: options.response_format || 'verbose_json',
        language: options.language || undefined, // Auto-detect if not specified
        prompt: options.prompt || undefined,
        temperature: options.temperature || 0
      });

      // Parse response based on format
      if (options.response_format === 'verbose_json' || !options.response_format) {
        return {
          text: transcription.text,
          language: transcription.language,
          duration: transcription.duration,
          segments: transcription.segments ? transcription.segments.map(seg => ({
            id: seg.id,
            start: seg.start,
            end: seg.end,
            text: seg.text.trim(),
            tokens: seg.tokens,
            temperature: seg.temperature,
            avg_logprob: seg.avg_logprob,
            compression_ratio: seg.compression_ratio,
            no_speech_prob: seg.no_speech_prob
          })) : []
        };
      } else {
        return {
          text: transcription.text || transcription,
          segments: []
        };
      }

    } catch (error) {
      console.error('Transcription error:', error);
      throw new Error(`Transcription failed: ${error.message}`);
    }
  }

  /**
   * Alternative: Use your existing Railway transcription service
   */
  async transcribeWithRailway(videoPath, railwayEndpoint) {
    try {
      // Check if Railway endpoint is configured
      if (!railwayEndpoint) {
        throw new Error('Railway transcription endpoint not configured');
      }

      // Create form data
      const formData = new FormData();
      formData.append('video', fs.createReadStream(videoPath));

      // Call your Railway transcription service
      const response = await axios.post(railwayEndpoint, formData, {
        headers: {
          ...formData.getHeaders()
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });

      return response.data;

    } catch (error) {
      throw new Error(`Railway transcription failed: ${error.message}`);
    }
  }

  /**
   * Format transcript for display
   */
  formatTranscript(transcription, format = 'srt') {
    if (!transcription.segments || transcription.segments.length === 0) {
      return transcription.text;
    }

    switch (format) {
      case 'srt':
        return this.toSRT(transcription.segments);
      case 'vtt':
        return this.toVTT(transcription.segments);
      case 'json':
        return JSON.stringify(transcription, null, 2);
      case 'text':
      default:
        return transcription.text;
    }
  }

  /**
   * Convert to SRT format
   */
  toSRT(segments) {
    return segments.map((seg, index) => {
      const startTime = this.formatTimestamp(seg.start);
      const endTime = this.formatTimestamp(seg.end);
      return `${index + 1}\n${startTime} --> ${endTime}\n${seg.text}\n`;
    }).join('\n');
  }

  /**
   * Convert to VTT format
   */
  toVTT(segments) {
    const header = 'WEBVTT\n\n';
    const content = segments.map(seg => {
      const startTime = this.formatTimestamp(seg.start, true);
      const endTime = this.formatTimestamp(seg.end, true);
      return `${startTime} --> ${endTime}\n${seg.text}\n`;
    }).join('\n');
    return header + content;
  }

  /**
   * Format timestamp for subtitles
   */
  formatTimestamp(seconds, isVTT = false) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);

    const separator = isVTT ? '.' : ',';
    
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}${separator}${String(ms).padStart(3, '0')}`;
  }

  /**
   * Extract audio from video for transcription
   */
  async extractAudio(videoPath, outputPath) {
    const ffmpeg = require('fluent-ffmpeg');
    
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .noVideo()
        .audioCodec('libmp3lame')
        .audioBitrate('128k')
        .format('mp3')
        .on('end', () => resolve(outputPath))
        .on('error', reject)
        .save(outputPath);
    });
  }
}

module.exports = new TranscriptionService();
