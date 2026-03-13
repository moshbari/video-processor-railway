/**
 * 🎬 OPUS CLIP SERVICE
 * 
 * AI-powered viral clip extraction from long videos
 * Features:
 * - AI finds the best viral-worthy moments
 * - Virality scoring (1-100)
 * - Vertical reframing (9:16 for TikTok/Reels/Shorts)
 * - Auto-captions burned into video
 * - Batch clip extraction
 */

const OpenAI = require('openai');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const r2Service = require('./r2Service');
const downloadService = require('./downloadService');
const transcriptionService = require('./transcriptionService');

class OpusClipService {
  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    this.tempDir = process.env.TEMP_DIR || '/app/temp';
    this.jobs = new Map(); // Track job progress
  }

  // ============================================================
  // STEP 1: ANALYZE - Download, Transcribe, Find Viral Moments
  // ============================================================

  /**
   * Full analysis pipeline: Download → Transcribe → AI Find Moments
   * Returns clip suggestions with virality scores
   */
  async analyzeVideo(input) {
    const jobId = uuidv4();
    const workDir = path.join(this.tempDir, `opus-${jobId}`);
    await fs.ensureDir(workDir);

    this.jobs.set(jobId, {
      status: 'analyzing',
      step: 'starting',
      progress: 0,
      clips: [],
      error: null
    });

    try {
      let videoPath;
      let videoTitle = 'Uploaded Video';
      let videoDuration = 0;

      // --- STEP 1A: Get the video ---
      this.updateJob(jobId, { step: 'downloading', progress: 5 });

      if (input.url) {
        // Download from URL
        console.log(`[OpusClip ${jobId}] Downloading from URL: ${input.url}`);
        const downloadResult = await downloadService.downloadVideo(input.url, `opus-dl-${jobId}`);
        videoPath = downloadResult.videoPath;
        videoTitle = downloadResult.title || 'Downloaded Video';
        videoDuration = downloadResult.duration || 0;
      } else if (input.videoPath) {
        // Already uploaded
        videoPath = input.videoPath;
      } else {
        throw new Error('Please provide a video URL or upload a video file.');
      }

      // Get video duration if not known
      if (!videoDuration) {
        videoDuration = await this.getVideoDuration(videoPath);
      }

      console.log(`[OpusClip ${jobId}] Video: "${videoTitle}" (${this.formatTime(videoDuration)})`);

      // --- STEP 1B: Extract audio for transcription ---
      this.updateJob(jobId, { step: 'extracting_audio', progress: 15 });

      const audioPath = path.join(workDir, 'audio.mp3');
      console.log(`[OpusClip ${jobId}] Extracting audio for transcription...`);
      await this.extractAudioForTranscription(videoPath, audioPath);

      // Check audio file size - Whisper has 25MB limit
      const audioStats = await fs.stat(audioPath);
      const audioSizeMB = audioStats.size / (1024 * 1024);
      console.log(`[OpusClip ${jobId}] Audio size: ${audioSizeMB.toFixed(1)}MB`);

      if (audioSizeMB > 25) {
        // For very long videos, we need to split audio and transcribe in chunks
        console.log(`[OpusClip ${jobId}] Audio too large, splitting into chunks...`);
      }

      // --- STEP 1C: Transcribe with Whisper ---
      this.updateJob(jobId, { step: 'transcribing', progress: 30 });
      console.log(`[OpusClip ${jobId}] Transcribing with Whisper...`);

      let transcription;
      if (audioSizeMB <= 25) {
        transcription = await transcriptionService.transcribe(audioPath, {
          response_format: 'verbose_json'
        });
      } else {
        // Split audio into 10-minute chunks and transcribe each
        transcription = await this.transcribeLongAudio(audioPath, workDir, jobId);
      }

      console.log(`[OpusClip ${jobId}] Transcription complete: ${transcription.segments.length} segments`);

      // --- STEP 1D: AI finds viral moments ---
      this.updateJob(jobId, { step: 'finding_moments', progress: 60 });
      console.log(`[OpusClip ${jobId}] AI analyzing for viral moments...`);

      const clipSuggestions = await this.findViralMoments(
        transcription,
        videoDuration,
        input.clipCount || 10,
        input.clipLength || { min: 15, max: 60 },
        input.contentType || 'general'
      );

      console.log(`[OpusClip ${jobId}] Found ${clipSuggestions.length} viral moments`);

      // --- DONE - Return suggestions ---
      this.updateJob(jobId, {
        status: 'analyzed',
        step: 'complete',
        progress: 100,
        clips: clipSuggestions
      });

      // Store data for generation step
      const analysisData = {
        jobId,
        videoPath,
        videoTitle,
        videoDuration,
        transcription,
        clipSuggestions,
        workDir
      };

      // Save analysis to disk so we can use it later
      await fs.writeJson(path.join(workDir, 'analysis.json'), {
        ...analysisData,
        // Don't save full transcription to JSON - save separately
        transcription: null
      });
      await fs.writeJson(path.join(workDir, 'transcription.json'), transcription);

      return {
        success: true,
        jobId,
        videoTitle,
        videoDuration: this.formatTime(videoDuration),
        videoDurationSeconds: videoDuration,
        totalSuggestions: clipSuggestions.length,
        clips: clipSuggestions
      };

    } catch (error) {
      console.error(`[OpusClip ${jobId}] Analysis error:`, error);
      this.updateJob(jobId, { status: 'error', error: error.message });
      throw error;
    }
  }

  // ============================================================
  // STEP 2: GENERATE - Extract, Reframe, Caption selected clips
  // ============================================================

  /**
   * Generate selected clips with vertical reframing and captions
   */
  async generateClips(jobId, selectedClipIndices, options = {}) {
    const workDir = path.join(this.tempDir, `opus-${jobId}`);

    // Load saved analysis
    const analysisExists = await fs.pathExists(path.join(workDir, 'analysis.json'));
    if (!analysisExists) {
      throw new Error('Analysis not found. Please analyze the video first.');
    }

    const analysis = await fs.readJson(path.join(workDir, 'analysis.json'));
    const transcription = await fs.readJson(path.join(workDir, 'transcription.json'));

    const videoPath = analysis.videoPath;
    const allClips = analysis.clipSuggestions;

    // Filter to selected clips only
    const selectedClips = selectedClipIndices
      ? allClips.filter((_, index) => selectedClipIndices.includes(index))
      : allClips; // If none specified, generate all

    const totalClips = selectedClips.length;
    const outputFormat = options.format || 'vertical'; // vertical, square, original
    const captionStyle = options.captionStyle || 'bold_white'; // bold_white, yellow_outline, etc.
    const addCaptions = options.addCaptions !== false; // Default: true

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[OpusClip ${jobId}] GENERATING ${totalClips} CLIPS`);
    console.log(`Format: ${outputFormat} | Captions: ${addCaptions}`);
    console.log('='.repeat(60));

    this.updateJob(jobId, {
      status: 'generating',
      step: 'starting_generation',
      progress: 0,
      totalClips,
      completedClips: 0
    });

    const clipsDir = path.join(workDir, 'clips');
    await fs.ensureDir(clipsDir);

    const generatedClips = [];

    for (let i = 0; i < selectedClips.length; i++) {
      const clip = selectedClips[i];
      const clipNum = i + 1;
      const progressPercent = Math.round(((i) / totalClips) * 90);

      console.log(`\n--- Clip ${clipNum}/${totalClips}: "${clip.title}" ---`);
      this.updateJob(jobId, {
        step: `generating_clip_${clipNum}`,
        progress: progressPercent,
        completedClips: i,
        currentClip: clip.title
      });

      try {
        // Step A: Extract the raw clip from original video
        const rawClipPath = path.join(clipsDir, `raw_${clipNum}.mp4`);
        await this.extractClip(videoPath, clip.startTime, clip.endTime, rawClipPath);

        // Step B: Get transcript segments for this clip's timerange
        const clipSegments = this.getSegmentsForTimeRange(
          transcription.segments,
          clip.startTime,
          clip.endTime
        );

        // Step C: Generate subtitle file (ASS format for styled captions)
        let subtitlePath = null;
        if (addCaptions && clipSegments.length > 0) {
          subtitlePath = path.join(clipsDir, `subs_${clipNum}.ass`);
          await this.generateStyledSubtitles(clipSegments, clip.startTime, subtitlePath, captionStyle);
        }

        // Step D: Apply vertical reframe + burn captions
        const finalClipPath = path.join(clipsDir, `clip_${clipNum}.mp4`);
        await this.processClip(rawClipPath, finalClipPath, {
          format: outputFormat,
          subtitlePath,
          addCaptions
        });

        // Step E: Upload to R2
        const r2FileName = `opus-clips/${jobId}/clip_${clipNum}_${this.sanitizeFilename(clip.title)}.mp4`;
        const uploadResult = await r2Service.uploadFile(finalClipPath, r2FileName);

        generatedClips.push({
          clipNumber: clipNum,
          title: clip.title,
          viralityScore: clip.viralityScore,
          startTime: clip.startTime,
          endTime: clip.endTime,
          duration: clip.endTime - clip.startTime,
          durationFormatted: this.formatTime(clip.endTime - clip.startTime),
          downloadUrl: uploadResult.downloadUrl,
          hookText: clip.hookText,
          tags: clip.tags
        });

        console.log(`✓ Clip ${clipNum} complete: ${uploadResult.downloadUrl}`);

        // Clean up raw clip to save disk space
        await fs.remove(rawClipPath).catch(() => {});

      } catch (clipError) {
        console.error(`✗ Clip ${clipNum} failed:`, clipError.message);
        generatedClips.push({
          clipNumber: clipNum,
          title: clip.title,
          error: 'This clip could not be generated. Please try again.',
          viralityScore: clip.viralityScore
        });
      }
    }

    // Final status
    const successCount = generatedClips.filter(c => c.downloadUrl).length;

    this.updateJob(jobId, {
      status: 'complete',
      step: 'done',
      progress: 100,
      completedClips: totalClips,
      generatedClips
    });

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[OpusClip ${jobId}] GENERATION COMPLETE`);
    console.log(`${successCount}/${totalClips} clips generated successfully`);
    console.log('='.repeat(60));

    return {
      success: true,
      jobId,
      totalClips,
      successCount,
      clips: generatedClips
    };
  }

  // ============================================================
  // AI VIRAL MOMENT FINDER
  // ============================================================

  /**
   * Use GPT to analyze transcript and find viral-worthy moments
   */
  async findViralMoments(transcription, videoDuration, clipCount, clipLength, contentType) {
    const transcriptText = transcription.segments.map(seg => 
      `[${this.formatTime(seg.start)} - ${this.formatTime(seg.end)}] ${seg.text}`
    ).join('\n');

    const prompt = `You are a viral content expert. Analyze this video transcript and find the ${clipCount} BEST moments that would make great short-form clips for TikTok, YouTube Shorts, and Instagram Reels.

VIDEO DURATION: ${this.formatTime(videoDuration)}
CONTENT TYPE: ${contentType}
DESIRED CLIP LENGTH: ${clipLength.min}-${clipLength.max} seconds each
NUMBER OF CLIPS NEEDED: ${clipCount}

TRANSCRIPT:
${transcriptText}

RULES FOR FINDING VIRAL MOMENTS:
1. Each clip MUST be ${clipLength.min}-${clipLength.max} seconds long
2. Each clip should be a COMPLETE thought or moment (don't cut mid-sentence)
3. Prioritize moments that are: emotional, funny, surprising, controversial, educational, or inspiring
4. Each clip needs a strong "hook" in the first 3 seconds that makes people stop scrolling
5. Clips should make sense on their own without needing context from the full video
6. Start timestamps must come from ACTUAL timestamps in the transcript
7. Clips must NOT overlap with each other
8. End time must NEVER exceed ${this.formatTime(videoDuration)} (the video duration)

For each clip, provide:
- title: A catchy title for the clip (max 60 chars)
- hookText: The first line/hook that grabs attention (what appears in first 3 seconds)
- startTime: Start time in SECONDS (must align with a transcript timestamp)
- endTime: End time in SECONDS
- viralityScore: Score from 1-100 based on viral potential
- reason: Why this moment would go viral (1-2 sentences)
- tags: 2-3 relevant hashtag suggestions (without the # symbol)

RESPOND WITH ONLY valid JSON in this exact format (no markdown, no backticks, no extra text):
{
  "clips": [
    {
      "title": "clip title here",
      "hookText": "the hook line here",
      "startTime": 0,
      "endTime": 30,
      "viralityScore": 85,
      "reason": "why this would go viral",
      "tags": ["tag1", "tag2", "tag3"]
    }
  ]
}`;

    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are a viral content strategist who finds the best clip-worthy moments in videos. You ONLY respond with valid JSON. No markdown, no backticks, no explanation text.'
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 4000
    });

    let responseText = response.choices[0].message.content.trim();
    
    // Clean up response - remove any markdown formatting
    responseText = responseText.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

    try {
      const parsed = JSON.parse(responseText);
      let clips = parsed.clips || [];

      // Validate and clean up clips
      clips = clips
        .filter(clip => {
          // Ensure valid timestamps
          if (clip.startTime >= clip.endTime) return false;
          if (clip.startTime < 0) return false;
          if (clip.endTime > videoDuration) clip.endTime = videoDuration;
          if (clip.endTime - clip.startTime < clipLength.min * 0.5) return false; // Too short
          return true;
        })
        .map(clip => ({
          title: clip.title || 'Untitled Clip',
          hookText: clip.hookText || '',
          startTime: Math.round(clip.startTime * 100) / 100,
          endTime: Math.round(clip.endTime * 100) / 100,
          duration: Math.round((clip.endTime - clip.startTime) * 100) / 100,
          durationFormatted: this.formatTime(clip.endTime - clip.startTime),
          startFormatted: this.formatTime(clip.startTime),
          endFormatted: this.formatTime(clip.endTime),
          viralityScore: Math.min(100, Math.max(1, clip.viralityScore || 50)),
          reason: clip.reason || '',
          tags: clip.tags || []
        }))
        // Sort by virality score (highest first)
        .sort((a, b) => b.viralityScore - a.viralityScore);

      return clips;

    } catch (parseError) {
      console.error('Failed to parse AI response:', responseText.substring(0, 200));
      throw new Error('AI could not analyze this video. Please try again.');
    }
  }

  // ============================================================
  // VIDEO PROCESSING HELPERS
  // ============================================================

  /**
   * Extract audio from video (compressed for Whisper)
   */
  extractAudioForTranscription(videoPath, audioPath) {
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .noVideo()
        .audioCodec('libmp3lame')
        .audioBitrate('64k')        // Low bitrate to keep file small
        .audioChannels(1)            // Mono
        .audioFrequency(16000)       // 16kHz is fine for speech
        .format('mp3')
        .on('end', () => {
          console.log('✓ Audio extracted for transcription');
          resolve(audioPath);
        })
        .on('error', (err) => {
          console.error('Audio extraction error:', err.message);
          reject(new Error('Could not extract audio from video. The file may be corrupted.'));
        })
        .save(audioPath);
    });
  }

  /**
   * Transcribe long audio by splitting into 10-minute chunks
   */
  async transcribeLongAudio(audioPath, workDir, jobId) {
    const chunksDir = path.join(workDir, 'audio_chunks');
    await fs.ensureDir(chunksDir);

    // Get audio duration
    const duration = await this.getAudioDuration(audioPath);
    const chunkDuration = 600; // 10 minutes per chunk
    const numChunks = Math.ceil(duration / chunkDuration);

    console.log(`[OpusClip ${jobId}] Splitting audio into ${numChunks} chunks of ${chunkDuration}s`);

    let allSegments = [];
    let fullText = '';

    for (let i = 0; i < numChunks; i++) {
      const startTime = i * chunkDuration;
      const chunkPath = path.join(chunksDir, `chunk_${i + 1}.mp3`);

      // Extract chunk
      await new Promise((resolve, reject) => {
        ffmpeg(audioPath)
          .seekInput(startTime)
          .duration(chunkDuration)
          .audioCodec('libmp3lame')
          .audioBitrate('64k')
          .audioChannels(1)
          .audioFrequency(16000)
          .on('end', resolve)
          .on('error', reject)
          .save(chunkPath);
      });

      // Transcribe chunk
      console.log(`[OpusClip ${jobId}] Transcribing chunk ${i + 1}/${numChunks}...`);
      const chunkTranscription = await transcriptionService.transcribe(chunkPath, {
        response_format: 'verbose_json'
      });

      // Adjust timestamps by adding the chunk's start offset
      const adjustedSegments = (chunkTranscription.segments || []).map(seg => ({
        ...seg,
        start: seg.start + startTime,
        end: seg.end + startTime
      }));

      allSegments = allSegments.concat(adjustedSegments);
      fullText += ' ' + (chunkTranscription.text || '');

      // Update progress (30-60% range during transcription)
      const transcribeProgress = 30 + Math.round((i / numChunks) * 30);
      this.updateJob(jobId, { progress: transcribeProgress });
    }

    // Clean up chunks
    await fs.remove(chunksDir).catch(() => {});

    return {
      text: fullText.trim(),
      segments: allSegments,
      language: 'auto',
      duration
    };
  }

  /**
   * Extract a clip from the original video
   */
  extractClip(videoPath, startTime, endTime, outputPath) {
    const duration = endTime - startTime;

    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(startTime)
        .duration(duration)
        .outputOptions([
          '-c:v', 'libx264',
          '-preset', 'medium',
          '-crf', '20',
          '-c:a', 'aac',
          '-ar', '48000',
          '-ac', '2',
          '-b:a', '320k',
          '-avoid_negative_ts', 'make_zero',
          '-y'
        ])
        .on('start', () => {
          console.log(`  Extracting: ${this.formatTime(startTime)} → ${this.formatTime(endTime)}`);
        })
        .on('end', () => {
          console.log(`  ✓ Raw clip extracted`);
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error('  ✗ Extraction error:', err.message);
          reject(new Error('Could not extract this clip. Please try again.'));
        })
        .save(outputPath);
    });
  }

  /**
   * Process clip: Apply vertical reframe + burn captions
   */
  async processClip(inputPath, outputPath, options) {
    const { format, subtitlePath, addCaptions } = options;

    // Build FFmpeg filter chain
    let filterParts = [];
    let outputWidth, outputHeight;

    // --- Reframing ---
    if (format === 'vertical') {
      // 9:16 vertical (1080x1920)
      outputWidth = 1080;
      outputHeight = 1920;
      // Center crop: scale to fill height, then crop width
      filterParts.push(`scale=-1:${outputHeight}`);
      filterParts.push(`crop=${outputWidth}:${outputHeight}`);
    } else if (format === 'square') {
      // 1:1 square (1080x1080)
      outputWidth = 1080;
      outputHeight = 1080;
      filterParts.push(`scale=-1:${outputHeight}`);
      filterParts.push(`crop=${outputWidth}:${outputHeight}`);
    } else {
      // Keep original dimensions
      outputWidth = null;
      outputHeight = null;
    }

    // --- Captions ---
    if (addCaptions && subtitlePath && await fs.pathExists(subtitlePath)) {
      // Use ASS subtitle filter for styled captions
      // Escape special characters in the path for FFmpeg
      const escapedSubPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
      filterParts.push(`ass='${escapedSubPath}'`);
    }

    // If no filters needed, just copy
    if (filterParts.length === 0) {
      await fs.copy(inputPath, outputPath);
      return;
    }

    const filterChain = filterParts.join(',');

    return new Promise((resolve, reject) => {
      const command = ffmpeg(inputPath);

      command.outputOptions([
        '-vf', filterChain,
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '20',
        '-c:a', 'aac',
        '-ar', '48000',
        '-ac', '2',
        '-b:a', '320k',
        '-y'
      ]);

      command
        .on('start', (cmd) => {
          console.log(`  Processing: ${format} + ${addCaptions ? 'captions' : 'no captions'}`);
        })
        .on('end', () => {
          console.log(`  ✓ Clip processed`);
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error('  ✗ Processing error:', err.message);
          reject(new Error('Could not process this clip. Please try again.'));
        })
        .save(outputPath);
    });
  }

  /**
   * Generate styled ASS subtitle file for a clip
   * ASS format gives us full control over font, size, color, position, animation
   */
  async generateStyledSubtitles(segments, clipStartTime, outputPath, style) {
    // Determine style settings
    let fontName = 'Arial';
    let fontSize = 48;
    let primaryColor = '&H00FFFFFF'; // White
    let outlineColor = '&H00000000'; // Black
    let outlineWidth = 3;
    let shadowDepth = 2;
    let bold = 1;
    let alignment = 2; // Bottom center

    switch (style) {
      case 'bold_white':
        primaryColor = '&H00FFFFFF';
        outlineColor = '&H00000000';
        fontSize = 52;
        bold = 1;
        break;
      case 'yellow_outline':
        primaryColor = '&H0000FFFF'; // Yellow in ASS (BGR)
        outlineColor = '&H00000000';
        fontSize = 48;
        bold = 1;
        break;
      case 'neon_green':
        primaryColor = '&H0000FF00'; // Green
        outlineColor = '&H00000000';
        fontSize = 48;
        bold = 1;
        break;
      case 'clean_minimal':
        primaryColor = '&H00FFFFFF';
        outlineColor = '&H80000000'; // Semi-transparent black
        fontSize = 42;
        outlineWidth = 2;
        bold = 0;
        break;
      default:
        // Default bold white
        break;
    }

    // Build ASS file content
    let ass = `[Script Info]
Title: OpusClip Captions
ScriptType: v4.00+
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: None
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},${primaryColor},&H000000FF,${outlineColor},&H80000000,${bold},0,0,0,100,100,0,0,1,${outlineWidth},${shadowDepth},${alignment},40,40,120,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    // Add each segment as a dialogue line
    for (const seg of segments) {
      // Adjust time relative to clip start
      const relStart = Math.max(0, seg.start - clipStartTime);
      const relEnd = seg.end - clipStartTime;

      const startStr = this.secondsToAssTime(relStart);
      const endStr = this.secondsToAssTime(relEnd);

      // Clean up text - remove leading/trailing whitespace
      let text = seg.text.trim();

      // Break long lines (max ~35 chars per line for vertical video)
      text = this.wrapText(text, 35);

      // Convert newlines to ASS line breaks
      text = text.replace(/\n/g, '\\N');

      ass += `Dialogue: 0,${startStr},${endStr},Default,,0,0,0,,${text}\n`;
    }

    await fs.writeFile(outputPath, ass, 'utf8');
    console.log(`  ✓ Subtitles generated: ${segments.length} lines`);
  }

  // ============================================================
  // UTILITY HELPERS
  // ============================================================

  /**
   * Get transcript segments that fall within a time range
   */
  getSegmentsForTimeRange(segments, startTime, endTime) {
    return segments.filter(seg => {
      // Include segment if it overlaps with the clip timerange
      return seg.start < endTime && seg.end > startTime;
    });
  }

  /**
   * Get video duration using ffprobe
   */
  getVideoDuration(videoPath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          reject(new Error('Could not read video file.'));
          return;
        }
        resolve(metadata.format.duration || 0);
      });
    });
  }

  /**
   * Get audio duration using ffprobe
   */
  getAudioDuration(audioPath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(audioPath, (err, metadata) => {
        if (err) {
          reject(new Error('Could not read audio file.'));
          return;
        }
        resolve(metadata.format.duration || 0);
      });
    });
  }

  /**
   * Format seconds to M:SS or H:MM:SS
   */
  formatTime(seconds) {
    if (!seconds || seconds <= 0) return '0:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  /**
   * Convert seconds to ASS timestamp format (H:MM:SS.CC)
   */
  secondsToAssTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const cs = Math.floor((seconds % 1) * 100); // centiseconds
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }

  /**
   * Word-wrap text at specified character width
   */
  wrapText(text, maxWidth) {
    if (text.length <= maxWidth) return text;

    const words = text.split(' ');
    let lines = [];
    let currentLine = '';

    for (const word of words) {
      if ((currentLine + ' ' + word).trim().length <= maxWidth) {
        currentLine = (currentLine + ' ' + word).trim();
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);

    return lines.join('\n');
  }

  /**
   * Sanitize filename for R2 storage
   */
  sanitizeFilename(name) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_')
      .replace(/_+/g, '_')
      .substring(0, 50);
  }

  /**
   * Update job status
   */
  updateJob(jobId, updates) {
    const current = this.jobs.get(jobId) || {};
    this.jobs.set(jobId, { ...current, ...updates });
  }

  /**
   * Get job status
   */
  getJobStatus(jobId) {
    return this.jobs.get(jobId) || null;
  }
}

module.exports = new OpusClipService();
