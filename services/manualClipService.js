/**
 * ✂️ MANUAL CLIP SERVICE
 * 
 * Manual video clipping with waveform visualization
 * User marks their own timestamps, system cuts with:
 * - Maximum quality (CRF 18 + 192k audio)
 * - Vertical reframing (9:16)
 * - Auto-captions (via Whisper transcription)
 * - Waveform data for visual timeline
 * - Video uploaded to R2 for in-browser playback
 */

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

const axios = require('axios');
const r2Service = require('./r2Service');
const downloadService = require('./downloadService');
const transcriptionService = require('./transcriptionService');
const manualVideoLibraryService = require('./manualVideoLibraryService');

// 🎭 Voice-disguise presets. `ratio` is the pitch multiplier: <1 lowers the
// voice (deeper), >1 raises it. We shift sample rate then restore tempo, so the
// timbre changes too — which makes a speaker harder to recognise while staying
// understandable. Keep these IDs in sync with the frontend.
const DISGUISE_PRESETS = {
  slight_deep: { label: 'Slightly Deeper', ratio: 0.92 },
  deep:        { label: 'Deeper',          ratio: 0.82 },
  masked:      { label: 'Masked (deep)',   ratio: 0.72 },
  slight_high: { label: 'Slightly Higher', ratio: 1.10 },
  high:        { label: 'Higher',          ratio: 1.22 },
};
const DISGUISE_SR = 48000;
// FFmpeg audio-filter chain that pitch-shifts by `ratio` while keeping duration.
function pitchFilterChain(ratio) {
  const r = Math.max(0.5, Math.min(2, Number(ratio) || 1));
  const tempo = (1 / r).toFixed(6);
  return `asetrate=${DISGUISE_SR}*${r},aresample=${DISGUISE_SR},atempo=${tempo}`;
}

class ManualClipService {
  constructor() {
    this.tempDir = process.env.TEMP_DIR || '/app/temp';
    this.jobs = new Map();
  }

  // ============================================================
  // STEP 1: PREPARE VIDEO
  // Download → Upload to R2 for playback → Generate waveform
  // ============================================================

  /**
   * Prepare a video for manual clipping
   * - Downloads from URL (or uses uploaded file)
   * - Uploads the full video to R2 so the frontend can play it
   * - Generates audio waveform data (peaks array)
   * - Returns video info + waveform + playback URL
   */
  async prepareVideo(input) {
    const jobId = uuidv4();
    const workDir = path.join(this.tempDir, `manual-${jobId}`);
    await fs.ensureDir(workDir);

    this.jobs.set(jobId, {
      status: 'preparing',
      step: 'starting',
      progress: 0,
      error: null,
      videoPath: null,
      playbackUrl: null,
      waveform: null,
      videoDuration: 0,
      videoTitle: ''
    });

    try {
      let videoPath;
      let videoTitle = 'Uploaded Video';
      let videoDuration = 0;

      // --- Download or use uploaded file ---
      this.updateJob(jobId, { step: 'downloading', progress: 5 });

      if (input.url) {
        console.log(`[ManualClip ${jobId}] Downloading from URL: ${input.url}`);
        const downloadResult = await downloadService.downloadVideo(input.url, `manual-dl-${jobId}`);
        videoPath = downloadResult.videoPath;
        videoTitle = downloadResult.title || 'Downloaded Video';
        videoDuration = downloadResult.duration || 0;
      } else if (input.videoPath) {
        videoPath = input.videoPath;
        // Use the original filename (without extension) as the title
        if (input.originalFilename) {
          const nameWithoutExt = require('path').parse(input.originalFilename).name;
          videoTitle = nameWithoutExt;
        }
      } else {
        throw new Error('Please provide a video URL or upload a video file.');
      }

      // Get duration if not known
      if (!videoDuration) {
        console.log(`[ManualClip ${jobId}] Getting duration for: ${videoPath}`);
        // Verify the file actually exists and is readable
        const fileExists = await fs.pathExists(videoPath);
        console.log(`[ManualClip ${jobId}] File exists: ${fileExists}`);
        if (fileExists) {
          const stats = await fs.stat(videoPath);
          console.log(`[ManualClip ${jobId}] File size: ${(stats.size / 1024 / 1024).toFixed(1)}MB`);
        }
        videoDuration = await this.getVideoDuration(videoPath);
      }

      console.log(`[ManualClip ${jobId}] Video: "${videoTitle}" (${this.formatTime(videoDuration)})`);

      this.updateJob(jobId, {
        videoPath,
        videoTitle,
        videoDuration,
        userId: input.userId || null,
        sourceKey: `manual-clip/${jobId}/source.mp4`,
        progress: 25
      });

      // --- Upload video to R2 for browser playback ---
      this.updateJob(jobId, { step: 'uploading_for_playback', progress: 30 });
      console.log(`[ManualClip ${jobId}] Uploading to R2 for playback...`);

      const r2VideoKey = `manual-clip/${jobId}/source.mp4`;
      const uploadResult = await r2Service.uploadFile(videoPath, r2VideoKey, 'video/mp4');
      const playbackUrl = uploadResult.downloadUrl;

      console.log(`[ManualClip ${jobId}] Playback URL: ${playbackUrl}`);

      this.updateJob(jobId, {
        playbackUrl,
        progress: 55
      });

      // --- Generate waveform data ---
      this.updateJob(jobId, { step: 'generating_waveform', progress: 60 });
      console.log(`[ManualClip ${jobId}] Generating waveform...`);

      const waveform = await this.generateWaveform(videoPath, workDir, videoDuration);

      console.log(`[ManualClip ${jobId}] Waveform generated: ${waveform.peaks.length} peaks`);

      // --- Done preparing ---
      const result = {
        success: true,
        jobId,
        videoTitle,
        videoDuration,
        videoDurationFormatted: this.formatTime(videoDuration),
        playbackUrl,
        waveform
      };

      this.updateJob(jobId, {
        status: 'ready',
        step: 'ready',
        progress: 100,
        waveform,
        playbackUrl
      });

      // --- Remember this video so the user can reopen it without re-uploading ---
      try {
        let fileSize = 0;
        try { fileSize = (await fs.stat(videoPath)).size; } catch { /* best-effort */ }
        await manualVideoLibraryService.add(input.userId, {
          jobId,
          title: videoTitle,
          duration: videoDuration,
          durationFormatted: this.formatTime(videoDuration),
          sourceKey: `manual-clip/${jobId}/source.mp4`,
          playbackUrl,
          waveformPeaks: waveform.peaks,
          fileSize,
          createdAt: new Date().toISOString(),
        });
      } catch (libErr) {
        console.error(`[ManualClip ${jobId}] Could not save to video library:`, libErr.message);
      }

      console.log(`[ManualClip ${jobId}] ✓ Video ready for manual clipping`);

      return result;

    } catch (error) {
      console.error(`[ManualClip ${jobId}] Preparation failed:`, error.message);
      this.updateJob(jobId, {
        status: 'error',
        error: error.message,
        progress: 0
      });
      throw error;
    }
  }

  /**
   * Make sure the source video is present locally for this job. If the
   * in-memory job or its temp file is gone (server restart or 24h cleanup),
   * rebuild it from the user's saved library by streaming the source back down
   * from R2. Returns the (possibly rebuilt) job. Throws if it can't be found.
   */
  async ensureSourceAvailable(jobId, userId) {
    let job = this.jobs.get(jobId);
    if (job && job.videoPath && await fs.pathExists(job.videoPath)) {
      return job;
    }

    const record = (await manualVideoLibraryService.get(userId, jobId))
      || (await manualVideoLibraryService.get(null, jobId));
    if (!record) {
      throw new Error('Video not found. Please prepare the video first.');
    }

    const sourceKey = record.sourceKey || `manual-clip/${jobId}/source.mp4`;
    const sourceUrl = record.playbackUrl || r2Service.getPublicUrl(sourceKey);
    const workDir = path.join(this.tempDir, `manual-${jobId}`);
    const videoPath = path.join(workDir, 'source.mp4');
    await fs.ensureDir(workDir);

    if (!await fs.pathExists(videoPath)) {
      console.log(`[ManualClip ${jobId}] Restoring source from R2 (${sourceKey})...`);
      await r2Service.downloadFile(sourceUrl, videoPath);
      console.log(`[ManualClip ${jobId}] ✓ Source restored to ${videoPath}`);
    }

    job = {
      ...(job || {}),
      status: job?.status || 'ready',
      step: 'ready',
      videoPath,
      videoTitle: record.title,
      videoDuration: record.duration,
      userId: userId || null,
      sourceKey,
      playbackUrl: record.playbackUrl,
      waveform: { peaks: record.waveformPeaks || [] },
    };
    this.jobs.set(jobId, job);
    return job;
  }

  /**
   * Convert an ALREADY-SAVED library video to match YouTube timestamps, in
   * place — without the user re-uploading. Pulls the stored source down from
   * R2, re-encodes it to a clean constant-frame-rate copy, uploads that as the
   * new source, regenerates the duration + waveform, and points the saved
   * record at the matched copy. Progress is reported on the normal /status
   * channel so the frontend can poll it. Idempotent: a video already marked
   * normalized is returned untouched.
   */
  async normalizeSavedVideo(jobId, options = {}) {
    const userId = options.userId || null;

    this.updateJob(jobId, {
      status: 'generating',
      step: 'normalizing_saved',
      progress: 2,
      currentClip: 'Getting your video ready…',
      generatedClips: [],
      error: null,
    });

    const record = (await manualVideoLibraryService.get(userId, jobId))
      || (await manualVideoLibraryService.get(null, jobId));
    if (!record) throw new Error('That video is no longer available.');

    // Already matched — nothing to do.
    if (record.normalized) {
      this.updateJob(jobId, { status: 'ready', step: 'normalized', progress: 100, currentClip: '' });
      return { success: true, jobId, alreadyNormalized: true };
    }

    const workDir = path.join(this.tempDir, `manual-${jobId}`);
    await fs.ensureDir(workDir);

    // 1. Bring the current (un-matched) source down from R2.
    const srcKey = record.sourceKey || `manual-clip/${jobId}/source.mp4`;
    const srcUrl = record.playbackUrl || r2Service.getPublicUrl(srcKey);
    const originalPath = path.join(workDir, 'orig_for_norm.mp4');
    this.updateJob(jobId, { step: 'normalizing_saved', progress: 6, currentClip: 'Fetching your video…' });
    console.log(`[ManualClip ${jobId}] Normalizing saved video — downloading source (${srcKey})...`);
    await r2Service.downloadFile(srcUrl, originalPath);

    // 2. Re-encode to constant frame rate (the YouTube-matching step).
    this.updateJob(jobId, { step: 'normalizing_saved', progress: 12, currentClip: 'Matching YouTube timestamps…' });
    const normalizedPath = path.join(workDir, 'normalized.mp4');
    await this.normalizeToConstantFps(originalPath, normalizedPath, (pct) => {
      this.updateJob(jobId, { progress: Math.round(12 + (pct / 100) * 70) }); // 12 -> 82
    });

    // 3. Upload the matched copy to a NEW key (so the old public URL can't serve
    //    a stale cached copy), then refresh duration + waveform from it.
    this.updateJob(jobId, { step: 'normalizing_saved', progress: 85, currentClip: 'Saving the matched copy…' });
    const newKey = `manual-clip/${jobId}/source_yt.mp4`;
    const up = await r2Service.uploadFile(normalizedPath, newKey, 'video/mp4');
    const newPlaybackUrl = up.downloadUrl;

    this.updateJob(jobId, { step: 'normalizing_saved', progress: 90, currentClip: 'Refreshing the waveform…' });
    const newDuration = await this.getVideoDuration(normalizedPath).catch(() => record.duration || 0);
    const waveform = await this.generateWaveform(normalizedPath, workDir, newDuration)
      .catch(() => ({ peaks: record.waveformPeaks || [] }));

    // 4. Point the saved record at the matched copy from now on.
    await manualVideoLibraryService.updateVideo(userId, jobId, {
      sourceKey: newKey,
      playbackUrl: newPlaybackUrl,
      duration: newDuration,
      durationFormatted: this.formatTime(newDuration),
      waveformPeaks: waveform.peaks || [],
      normalized: true,
    });

    // Best-effort: remove the old un-matched source to save space.
    if (record.sourceKey && record.sourceKey !== newKey) {
      r2Service.deleteFile(record.sourceKey).catch(() => {});
    }

    // 5. Reflect on the in-memory job and signal completion (step === 'normalized').
    this.updateJob(jobId, {
      status: 'ready',
      step: 'normalized',
      progress: 100,
      currentClip: '',
      videoPath: normalizedPath,
      videoDuration: newDuration,
      playbackUrl: newPlaybackUrl,
      sourceKey: newKey,
      waveform: { peaks: waveform.peaks || [] },
    });

    console.log(`[ManualClip ${jobId}] ✓ Saved video matched to YouTube: ${newPlaybackUrl}`);
    return { success: true, jobId, playbackUrl: newPlaybackUrl, duration: newDuration };
  }

  // ============================================================
  // WAVEFORM GENERATION
  // ============================================================

  /**
   * Generate audio waveform data from video
   * Returns an array of peak values (0.0 - 1.0) for drawing in the frontend
   * 
   * Uses FFmpeg to extract raw audio samples, then compute peaks
   * Target: ~800 peaks (enough resolution for a nice waveform)
   */
  async generateWaveform(videoPath, workDir, duration) {
    const rawAudioPath = path.join(workDir, 'waveform_audio.raw');

    try {
      // Extract mono raw audio at low sample rate for peak computation
      // 8000 Hz mono = 8000 samples per second
      // For a 10-minute video: 4.8M samples → we'll downsample to ~800 peaks
      await new Promise((resolve, reject) => {
        ffmpeg(videoPath)
          .noVideo()
          .audioChannels(1)
          .audioFrequency(8000)
          .format('s16le') // 16-bit signed little-endian raw PCM
          .on('end', resolve)
          .on('error', (err) => {
            console.error('Waveform audio extraction error:', err.message);
            reject(err);
          })
          .save(rawAudioPath);
      });

      // Read raw audio data
      const rawBuffer = await fs.readFile(rawAudioPath);

      // Convert to 16-bit samples
      const numSamples = rawBuffer.length / 2; // 2 bytes per sample (s16le)
      const sampleRate = 8000;

      // Target number of peaks for the waveform display
      const targetPeaks = 800;
      const samplesPerPeak = Math.max(1, Math.floor(numSamples / targetPeaks));

      const peaks = [];

      for (let i = 0; i < targetPeaks && i * samplesPerPeak < numSamples; i++) {
        const start = i * samplesPerPeak;
        const end = Math.min(start + samplesPerPeak, numSamples);

        let maxAbs = 0;
        for (let j = start; j < end; j++) {
          const offset = j * 2;
          if (offset + 1 < rawBuffer.length) {
            const sample = rawBuffer.readInt16LE(offset);
            const abs = Math.abs(sample);
            if (abs > maxAbs) maxAbs = abs;
          }
        }

        // Normalize to 0.0 - 1.0
        peaks.push(Math.round((maxAbs / 32768) * 1000) / 1000);
      }

      // Clean up raw audio
      await fs.remove(rawAudioPath).catch(() => {});

      return {
        peaks,
        duration,
        sampleRate: targetPeaks / duration, // peaks per second
        totalPeaks: peaks.length
      };

    } catch (error) {
      console.error('Waveform generation failed:', error.message);
      // Return a minimal flat waveform as fallback so the UI still works
      const fallbackPeaks = Array(800).fill(0).map(() =>
        Math.round(Math.random() * 0.3 * 1000) / 1000
      );
      return {
        peaks: fallbackPeaks,
        duration,
        sampleRate: 800 / duration,
        totalPeaks: 800,
        fallback: true
      };
    }
  }

  // ============================================================
  // STEP 2: GENERATE CLIPS
  // Cut at user-specified timestamps with max quality
  // ============================================================

  /**
   * Generate clips from user-defined timestamps
   * 
   * @param {string} jobId - Job ID from prepare step
   * @param {Array} clips - Array of { title, startTime, endTime }
   * @param {Object} options - { format, captionStyle, addCaptions }
   */
  async generateManualClips(jobId, clips, options = {}) {
    const job = await this.ensureSourceAvailable(jobId, options.userId);

    const {
      format = 'vertical',
      captionStyle = 'bold_white',
      addCaptions = true
    } = options;

    const videoPath = job.videoPath;
    const videoDuration = job.videoDuration;
    const workDir = path.join(this.tempDir, `manual-${jobId}`);
    const clipsDir = path.join(workDir, 'clips');
    await fs.ensureDir(clipsDir);

    const totalClips = clips.length;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[ManualClip ${jobId}] GENERATING ${totalClips} CLIPS`);
    console.log(`  Format: ${format} | Captions: ${addCaptions} | Style: ${captionStyle}`);
    console.log(`  Quality: CRF 18 + 192k audio (MAXIMUM)`);
    console.log('='.repeat(60));

    this.updateJob(jobId, {
      status: 'generating',
      step: 'starting_generation',
      progress: 0,
      totalClips,
      completedClips: 0,
      currentClip: '',
      generatedClips: []
    });

    // If captions requested, we need transcription for the relevant segments
    let transcription = null;
    if (addCaptions) {
      try {
        this.updateJob(jobId, { step: 'transcribing_for_captions', progress: 5, currentClip: 'Transcribing audio for captions...' });
        console.log(`[ManualClip ${jobId}] Transcribing for captions...`);

        const audioPath = path.join(workDir, 'caption_audio.mp3');
        await this.extractAudioForTranscription(videoPath, audioPath);

        const audioStats = await fs.stat(audioPath);
        const audioSizeMB = audioStats.size / (1024 * 1024);

        if (audioSizeMB <= 25) {
          transcription = await transcriptionService.transcribe(audioPath, {
            response_format: 'verbose_json'
          });
        } else {
          transcription = await this.transcribeLongAudio(audioPath, workDir, jobId);
        }

        console.log(`[ManualClip ${jobId}] Transcription complete: ${transcription.segments.length} segments`);
        await fs.remove(audioPath).catch(() => {});
      } catch (transcribeError) {
        console.error(`[ManualClip ${jobId}] Transcription failed, continuing without captions:`, transcribeError.message);
        transcription = null;
      }
    }

    const generatedClips = [];
    const clipStartProgress = addCaptions ? 15 : 5; // After transcription or immediately
    const progressPerClip = (95 - clipStartProgress) / totalClips;

    for (let i = 0; i < totalClips; i++) {
      const clip = clips[i];
      const clipNum = i + 1;

      try {
        // Validate timestamps
        let startTime = parseFloat(clip.startTime);
        let endTime = parseFloat(clip.endTime);
        const title = clip.title || `Clip ${clipNum}`;

        if (isNaN(startTime) || isNaN(endTime)) {
          throw new Error('Invalid timestamps');
        }

        // Clamp to video bounds
        startTime = Math.max(0, startTime);
        endTime = Math.min(endTime, videoDuration);

        if (endTime <= startTime) {
          throw new Error('End time must be after start time');
        }

        const clipDuration = endTime - startTime;
        console.log(`\n[ManualClip ${jobId}] Clip ${clipNum}/${totalClips}: "${title}" (${this.formatTime(startTime)} → ${this.formatTime(endTime)}, ${this.formatTime(clipDuration)})`);

        this.updateJob(jobId, {
          step: `generating_clip_${clipNum}`,
          progress: Math.round(clipStartProgress + (i * progressPerClip)),
          completedClips: i,
          currentClip: title
        });

        // Step A: Extract raw clip at MAXIMUM QUALITY
        const rawClipPath = path.join(clipsDir, `raw_${clipNum}.mp4`);
        await this.extractClipMaxQuality(videoPath, startTime, endTime, rawClipPath);

        // Step B: Get transcript segments for this time range (for captions)
        let clipSegments = [];
        if (addCaptions && transcription && transcription.segments) {
          clipSegments = this.getSegmentsForTimeRange(transcription.segments, startTime, endTime);
        }

        // Step C: Generate subtitle file if we have segments
        let subtitlePath = null;
        if (addCaptions && clipSegments.length > 0) {
          subtitlePath = path.join(clipsDir, `subs_${clipNum}.ass`);
          await this.generateStyledSubtitles(clipSegments, startTime, subtitlePath, captionStyle);
        }

        // Step D: Apply vertical reframe + burn captions (MAX QUALITY)
        const finalClipPath = path.join(clipsDir, `clip_${clipNum}.mp4`);
        await this.processClipMaxQuality(rawClipPath, finalClipPath, {
          format,
          subtitlePath,
          addCaptions: addCaptions && subtitlePath !== null
        });

        // Step E: Upload to R2
        const safeTitle = this.sanitizeFilename(title);
        const r2FileName = `manual-clips/${jobId}/clip_${clipNum}_${safeTitle}.mp4`;
        const uploadResult = await r2Service.uploadFile(finalClipPath, r2FileName);

        generatedClips.push({
          clipNumber: clipNum,
          title,
          startTime,
          endTime,
          duration: clipDuration,
          durationFormatted: this.formatTime(clipDuration),
          startFormatted: this.formatTime(startTime),
          endFormatted: this.formatTime(endTime),
          downloadUrl: uploadResult.downloadUrl,
          hasCaptions: addCaptions && clipSegments.length > 0
        });

        console.log(`✓ Clip ${clipNum} complete: ${uploadResult.downloadUrl}`);

        // Clean up intermediary files
        await fs.remove(rawClipPath).catch(() => {});
        if (subtitlePath) await fs.remove(subtitlePath).catch(() => {});

      } catch (clipError) {
        console.error(`✗ Clip ${clipNum} failed:`, clipError.message);
        generatedClips.push({
          clipNumber: clipNum,
          title: clip.title || `Clip ${clipNum}`,
          startTime: clip.startTime,
          endTime: clip.endTime,
          error: `This clip could not be generated: ${clipError.message}`
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
      generatedClips,
      completedAt: new Date().toISOString()
    });

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[ManualClip ${jobId}] GENERATION COMPLETE`);
    console.log(`${successCount}/${totalClips} clips generated successfully`);
    console.log('='.repeat(60));

    // Clean up work directory (keep clips until they expire naturally)
    // The R2 lifecycle will handle cleanup of uploaded clips

    return {
      success: true,
      jobId,
      totalClips,
      successCount,
      clips: generatedClips
    };
  }

  // ============================================================
  // 🎙️ PODCAST MULTI-HOOK SEQUENCE
  // ============================================================
  /**
   * Render selected "hook" sections (in the user-defined order) followed by
   * the FULL source video, concatenated into ONE 16:9 video with no
   * transitions. Reuses the same prepared job + status polling as generate.
   *
   * @param {string} jobId - Job ID from the prepare step
   * @param {Array}  hooks - [{ startTime, endTime, order }]
   * @param {Object} options - { title }
   */
  async renderPodcastSequence(jobId, hooks, options = {}) {
    const job = await this.ensureSourceAvailable(jobId, options.userId);

    let videoPath = job.videoPath;
    const videoDuration = job.videoDuration;
    const videoTitle = options.title || job.videoTitle || 'Podcast';

    const workDir = path.join(this.tempDir, `manual-${jobId}`);
    const seqDir = path.join(workDir, 'sequence');
    await fs.ensureDir(seqDir);

    // Sort hooks by their sequence number (stable; ties keep insertion order).
    const ordered = hooks
      .map((h, i) => ({ ...h, _i: i, order: Number(h.order) || (i + 1) }))
      .sort((a, b) => (a.order - b.order) || (a._i - b._i));

    const totalHooks = ordered.length;
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[ManualClip ${jobId}] RENDERING PODCAST SEQUENCE`);
    console.log(`  Hooks: ${totalHooks} (in order) + full video at end`);
    console.log(`  Output: single 16:9 file, no transitions`);
    console.log('='.repeat(60));

    this.updateJob(jobId, {
      status: 'generating',
      step: 'starting_sequence',
      progress: 0,
      totalClips: totalHooks,
      completedClips: 0,
      currentClip: 'Preparing your video...',
      generatedClips: []
    });

    // Step 0: If any voices are being disguised, build a disguised copy of the
    // source first and use it for EVERYTHING below (hooks + full video), so the
    // disguise is consistent throughout the final render.
    const disguise = Array.isArray(options.disguise) ? options.disguise : [];
    if (disguise.length > 0) {
      this.updateJob(jobId, { step: 'disguising_voices', currentClip: 'Disguising the marked voices…', progress: 2 });
      console.log(`  Disguising ${disguise.length} voice segment(s) before render`);
      const disguisedPath = path.join(seqDir, 'disguised_source.mp4');
      const built = await this.buildDisguisedSource(videoPath, disguise, videoDuration, disguisedPath, (pct) => {
        this.updateJob(jobId, { progress: Math.round(2 + (pct / 100) * 3) }); // 2 -> 5
      }).catch(err => { console.error(`[ManualClip ${jobId}] Disguise failed:`, err.message); return null; });
      if (built) videoPath = built;
    }

    // Step 1: Extract each hook section at max quality, in order.
    const segmentPaths = [];
    let hooksTotalSeconds = 0;
    for (let i = 0; i < totalHooks; i++) {
      const hook = ordered[i];
      const startTime = Math.max(0, parseFloat(hook.startTime));
      const endTime = Math.min(parseFloat(hook.endTime), videoDuration);
      if (isNaN(startTime) || isNaN(endTime) || endTime <= startTime) {
        throw new Error(`Hook ${i + 1} has invalid timestamps.`);
      }

      this.updateJob(jobId, {
        step: `extracting_hook_${i + 1}`,
        progress: Math.round(5 + (i / totalHooks) * 50), // 5 -> 55
        completedClips: i,
        currentClip: `Cutting hook ${i + 1} of ${totalHooks}...`
      });

      const segPath = path.join(seqDir, `hook_${String(i + 1).padStart(2, '0')}.mp4`);
      console.log(`  Hook ${i + 1}/${totalHooks} [order ${hook.order}]: ${this.formatTime(startTime)} → ${this.formatTime(endTime)}`);
      await this.extractClipMaxQuality(videoPath, startTime, endTime, segPath);
      segmentPaths.push(segPath);
      hooksTotalSeconds += (endTime - startTime);
    }

    // Step 2: Build the FINAL segment from the FULL source video. If the user
    // marked any "remove" sections (Danger Zone), cut those out first so the
    // full video at the end has them deleted; otherwise use the whole video.
    const cuts = Array.isArray(options.cuts) ? options.cuts : [];
    let fullSeconds = videoDuration || 0;
    let cutsApplied = false;
    let removedSeconds = 0;

    if (cuts.length > 0) {
      const keeps = this.keepSegmentsFromRemovals(cuts, videoDuration);
      const keptSeconds = keeps.reduce((s, k) => s + (k.end - k.start), 0);
      removedSeconds = Math.max(0, videoDuration - keptSeconds);

      if (keeps.length > 0 && removedSeconds > 0.1) {
        console.log(`  Removing ${removedSeconds.toFixed(1)}s of marked sections from the full video (${keeps.length} kept segment(s))`);
        this.updateJob(jobId, {
          step: 'removing_sections',
          progress: 56,
          currentClip: `Cutting out ${this.formatTime(removedSeconds)} of removed sections...`
        });
        const trimmedPath = path.join(seqDir, 'full_trimmed.mp4');
        await this.renderKeptSegments(videoPath, keeps, keptSeconds, trimmedPath, (pct) => {
          this.updateJob(jobId, { progress: Math.round(56 + (pct / 100) * 6) }); // 56 -> 62
        });
        segmentPaths.push(trimmedPath);
        fullSeconds = keptSeconds;
        cutsApplied = true;
      } else {
        // Nothing meaningful to cut — append the whole video.
        segmentPaths.push(videoPath);
      }
    } else {
      segmentPaths.push(videoPath);
    }

    const totalSeconds = hooksTotalSeconds + fullSeconds;

    // Step 3: Concatenate everything into one 16:9 file.
    this.updateJob(jobId, {
      step: 'concatenating',
      progress: 62,
      currentClip: 'Stitching everything together...'
    });

    const outputPath = path.join(seqDir, 'podcast_sequence.mp4');
    await this.concatenateSequence16x9(segmentPaths, outputPath, totalSeconds, (pct) => {
      this.updateJob(jobId, { progress: Math.round(62 + (pct / 100) * 30) }); // 62 -> 92
    });

    // Step 4: The finished render is on local disk now. Make it downloadable
    // straight from THIS server immediately — so the user can grab it without
    // waiting for the (sometimes slow) cloud upload. R2 is still the durable
    // home; we hand off to it once the upload completes.
    const safeTitle = this.sanitizeFilename(videoTitle);
    const downloadName = `${safeTitle || 'podcast'}.mp4`;
    const finalDuration = await this.getVideoDuration(outputPath).catch(() => 0);
    const serverDownloadUrl = `${this.publicBaseUrl()}/api/manual-clip/download/${jobId}`;

    this.updateJob(jobId, {
      step: 'uploading',
      progress: 94,
      currentClip: 'Your video is ready — saving a cloud copy...',
      // The local file the /download/:jobId route streams until R2 has the copy.
      serverDownload: { path: outputPath, filename: downloadName },
      serverDownloadUrl
    });

    // Upload the single result to R2 (durable storage).
    const r2FileName = `manual-clips/${jobId}/podcast_sequence_${safeTitle}.mp4`;
    let r2Url = null;
    try {
      const uploadResult = await r2Service.uploadFile(outputPath, r2FileName);
      r2Url = uploadResult.downloadUrl;
    } catch (err) {
      // Cloud upload failed — the local server copy is still downloadable, so
      // the user isn't blocked. We keep that copy around longer below.
      console.error(`[ManualClip ${jobId}] R2 upload failed, serving local copy:`, err.message);
    }

    // Friendly title describing what's in the file.
    const titleParts = [];
    if (totalHooks > 0) titleParts.push(`${totalHooks} Hook${totalHooks !== 1 ? 's' : ''}`);
    titleParts.push('Full Video');
    let sequenceTitle = `${videoTitle} — ${titleParts.join(' + ')}`;
    if (cutsApplied) sequenceTitle += ` (−${this.formatTime(removedSeconds)} removed)`;

    // Single-item result so the existing download screen renders it unchanged.
    const sequenceClip = {
      clipNumber: 1,
      title: sequenceTitle,
      isSequence: true,
      hookCount: totalHooks,
      sectionsRemoved: cutsApplied ? cuts.length : 0,
      removedSeconds: cutsApplied ? removedSeconds : 0,
      removedFormatted: cutsApplied ? this.formatTime(removedSeconds) : null,
      duration: finalDuration,
      durationFormatted: this.formatTime(finalDuration),
      // Prefer the durable R2 URL once it exists; otherwise serve the local copy.
      downloadUrl: r2Url || serverDownloadUrl,
      serverDownloadUrl,
      hasCaptions: false
    };

    this.updateJob(jobId, {
      status: 'complete',
      step: 'done',
      progress: 100,
      completedClips: totalHooks,
      currentClip: '',
      generatedClips: [sequenceClip],
      completedAt: new Date().toISOString()
    });

    console.log(`[ManualClip ${jobId}] ✓ Podcast sequence complete: ${sequenceClip.downloadUrl}`);

    // Save the finished render to the user's library as its own downloadable
    // project, so it's never lost once the download screen is closed. Only
    // when it actually made it to R2 (a server-only URL would die on restart).
    if (r2Url) {
      try {
        let renderSize = 0;
        try { renderSize = (await fs.stat(outputPath)).size; } catch { /* best-effort */ }
        await manualVideoLibraryService.addRender(options.userId, {
          title: videoTitle,
          downloadUrl: r2Url,
          r2Key: r2FileName,
          fileSize: renderSize,
          duration: finalDuration,
          durationFormatted: this.formatTime(finalDuration),
          sourceJobId: jobId,
          hookCount: totalHooks,
          createdAt: new Date().toISOString(),
        });
      } catch (libErr) {
        console.error(`[ManualClip ${jobId}] Could not save render to library:`, libErr.message);
      }
    }

    // Clean up the hook segments now (not the final file). Keep the final
    // render on disk for a grace window so any in-flight server download
    // finishes, then remove it — R2 holds the durable copy. If R2 failed,
    // keep the local copy much longer so the user can still download it.
    for (const p of segmentPaths) {
      if (p !== videoPath) await fs.remove(p).catch(() => {});
    }
    this.scheduleServerCopyCleanup(jobId, outputPath, r2Url ? 15 * 60 * 1000 : 6 * 60 * 60 * 1000);

    return {
      success: true,
      jobId,
      downloadUrl: sequenceClip.downloadUrl,
      serverDownloadUrl,
      clips: [sequenceClip]
    };
  }

  /**
   * Concatenate multiple video files into ONE 16:9 (1920x1080) video.
   * No transitions. Every input is scaled+padded to 1920x1080@30fps and the
   * audio is loudness-normalized so the joins are seamless even when the hook
   * sections and the full video have slightly different specs.
   */
  concatenateSequence16x9(inputPaths, outputPath, totalSeconds, onProgress) {
    return new Promise((resolve, reject) => {
      const n = inputPaths.length;
      const inputArgs = inputPaths.flatMap(p => ['-i', p]);

      const filterParts = [];
      let concatInputs = '';
      for (let i = 0; i < n; i++) {
        filterParts.push(`[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]`);
        filterParts.push(`[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${i}]`);
        concatInputs += `[v${i}][a${i}]`;
      }
      filterParts.push(`${concatInputs}concat=n=${n}:v=1:a=1[outv][preAudio]`);
      filterParts.push(`[preAudio]loudnorm=I=-16:TP=-1.5:LRA=11[outa]`);

      const args = [
        '-y',
        ...inputArgs,
        '-filter_complex', filterParts.join(';'),
        '-map', '[outv]',
        '-map', '[outa]',
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '20',
        '-c:a', 'aac',
        '-b:a', '320k',
        '-movflags', '+faststart',
        outputPath
      ];

      console.log(`  [Concat 16:9] ${n} inputs -> 1920x1080@30fps + loudnorm`);
      const proc = spawn('ffmpeg', args);
      let stderr = '';
      proc.stderr.on('data', (d) => {
        const s = d.toString();
        stderr += s;
        if (stderr.length > 20000) stderr = stderr.slice(-10000);
        const m = s.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
        if (m && onProgress && totalSeconds > 0) {
          const cur = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 100;
          onProgress(Math.min(100, (cur / totalSeconds) * 100));
        }
      });
      proc.on('close', (code) => {
        if (code === 0) { console.log('  [Concat 16:9] ✓ done'); resolve(outputPath); }
        else { console.error(stderr.slice(-800)); reject(new Error('Could not stitch the final video. Please try again.')); }
      });
      proc.on('error', (err) => reject(err));
    });
  }

  // ============================================================
  // 🔇 ONE-CLICK SILENCE REMOVER
  // ============================================================
  /**
   * Remove the quiet gaps from the WHOLE prepared video in one click.
   * - Finds silent stretches with ffmpeg's silencedetect
   * - Keeps every "loud" segment (leaving a little padding so speech isn't clipped)
   * - Re-encodes them back into ONE continuous file (audio + video stay in sync)
   * Result is saved to the user's renders library, same as a podcast render.
   *
   * @param {string} jobId  - Job ID from the prepare step
   * @param {Object} options - { userId, thresholdDb, minSilenceSec, paddingSec, title }
   */
  async removeSilence(jobId, options = {}) {
    this.updateJob(jobId, {
      status: 'generating',
      step: 'starting_silence_removal',
      progress: 2,
      totalClips: 1,
      completedClips: 0,
      currentClip: 'Getting your video ready...',
      generatedClips: []
    });

    const job = await this.ensureSourceAvailable(jobId, options.userId);

    const videoPath = job.videoPath;
    const videoDuration = job.videoDuration || await this.getVideoDuration(videoPath).catch(() => 0);
    const videoTitle = options.title || job.videoTitle || 'Video';

    // Tuning (sensible defaults; -30dB & 0.6s is a good "remove dead air" baseline).
    const thresholdDb = Number.isFinite(options.thresholdDb) ? options.thresholdDb : -30;
    const minSilenceSec = Number.isFinite(options.minSilenceSec) ? options.minSilenceSec : 0.6;
    const paddingSec = Number.isFinite(options.paddingSec) ? options.paddingSec : 0.1;

    const workDir = path.join(this.tempDir, `manual-${jobId}`);
    const desilenceDir = path.join(workDir, 'desilence');
    await fs.ensureDir(desilenceDir);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[ManualClip ${jobId}] REMOVING SILENCES`);
    console.log(`  Threshold: ${thresholdDb}dB | Min gap: ${minSilenceSec}s | Padding: ${paddingSec}s`);
    console.log('='.repeat(60));

    // Step 1: Detect the silent stretches.
    this.updateJob(jobId, { step: 'detecting_silence', progress: 8, currentClip: 'Finding silent gaps...' });
    const silences = await this.detectSilences(videoPath, { thresholdDb, minSilenceSec });
    console.log(`[ManualClip ${jobId}] Found ${silences.length} silent stretch(es)`);

    // Step 2: Work out which "loud" parts to keep.
    const keeps = this.keepSegmentsFromSilences(silences, videoDuration, paddingSec);
    const keptSeconds = keeps.reduce((sum, k) => sum + (k.end - k.start), 0);
    const removedSeconds = Math.max(0, videoDuration - keptSeconds);
    console.log(`[ManualClip ${jobId}] Keeping ${keeps.length} segment(s), removing ${removedSeconds.toFixed(1)}s of silence`);

    // Nothing meaningful to cut — tell the user kindly instead of re-encoding the whole thing.
    if (keeps.length === 0 || removedSeconds < 0.5) {
      this.updateJob(jobId, {
        status: 'error',
        error: "Good news — there were no long silent gaps to remove in this video."
      });
      return { success: false, jobId, removedSeconds };
    }

    // Step 3: Re-encode the kept parts into one continuous file.
    this.updateJob(jobId, {
      step: 'removing_silence',
      progress: 15,
      currentClip: `Cutting out ${this.formatTime(removedSeconds)} of dead air...`
    });

    const outputPath = path.join(desilenceDir, 'desilenced.mp4');
    await this.renderKeptSegments(videoPath, keeps, keptSeconds, outputPath, (pct) => {
      this.updateJob(jobId, { progress: Math.round(15 + (pct / 100) * 78) }); // 15 -> 93
    });

    // Step 4: Make it downloadable straight from this server immediately, then
    // push the durable copy to R2 — same pattern as the podcast render.
    const safeTitle = this.sanitizeFilename(videoTitle);
    const downloadName = `${safeTitle || 'video'}_no_silence.mp4`;
    const finalDuration = await this.getVideoDuration(outputPath).catch(() => keptSeconds);
    const serverDownloadUrl = `${this.publicBaseUrl()}/api/manual-clip/download/${jobId}`;

    this.updateJob(jobId, {
      step: 'uploading',
      progress: 95,
      currentClip: 'Your video is ready — saving a cloud copy...',
      serverDownload: { path: outputPath, filename: downloadName },
      serverDownloadUrl
    });

    const r2FileName = `manual-clips/${jobId}/desilenced_${safeTitle}.mp4`;
    let r2Url = null;
    try {
      const uploadResult = await r2Service.uploadFile(outputPath, r2FileName);
      r2Url = uploadResult.downloadUrl;
    } catch (err) {
      console.error(`[ManualClip ${jobId}] R2 upload failed, serving local copy:`, err.message);
    }

    const removedPercent = videoDuration > 0
      ? Math.round((removedSeconds / videoDuration) * 100)
      : 0;

    const resultClip = {
      clipNumber: 1,
      title: `${videoTitle} — Silence Removed`,
      isSilenceRemoval: true,
      // --- Silence-removal report ---
      originalDuration: videoDuration,
      originalFormatted: this.formatTime(videoDuration),
      removedSeconds,
      removedFormatted: this.formatTime(removedSeconds),
      removedPercent,
      newDuration: finalDuration,
      newFormatted: this.formatTime(finalDuration),
      duration: finalDuration,
      durationFormatted: this.formatTime(finalDuration),
      downloadUrl: r2Url || serverDownloadUrl,
      serverDownloadUrl,
      hasCaptions: false
    };

    this.updateJob(jobId, {
      status: 'complete',
      step: 'done',
      progress: 100,
      completedClips: 1,
      currentClip: '',
      generatedClips: [resultClip],
      completedAt: new Date().toISOString()
    });

    console.log(`[ManualClip ${jobId}] ✓ Silence removal complete: ${resultClip.downloadUrl}`);

    // Save the finished render to the user's library (only once it's safely on R2).
    if (r2Url) {
      try {
        let renderSize = 0;
        try { renderSize = (await fs.stat(outputPath)).size; } catch { /* best-effort */ }
        await manualVideoLibraryService.addRender(options.userId, {
          title: `${videoTitle} — Silence Removed`,
          downloadUrl: r2Url,
          r2Key: r2FileName,
          fileSize: renderSize,
          duration: finalDuration,
          durationFormatted: this.formatTime(finalDuration),
          sourceJobId: jobId,
          hookCount: 0,
          createdAt: new Date().toISOString(),
        });
      } catch (libErr) {
        console.error(`[ManualClip ${jobId}] Could not save render to library:`, libErr.message);
      }
    }

    // Keep the local copy around for a grace window (longer if R2 failed) so the
    // direct download stays alive; the source video is never touched.
    this.scheduleServerCopyCleanup(jobId, outputPath, r2Url ? 15 * 60 * 1000 : 6 * 60 * 60 * 1000);

    return {
      success: true,
      jobId,
      removedSeconds,
      downloadUrl: resultClip.downloadUrl,
      serverDownloadUrl,
      clips: [resultClip]
    };
  }

  /**
   * Turn the user's "remove these ranges" list into the segments to KEEP.
   * Clamps each range to the video, merges overlapping/adjacent removals, then
   * returns the complement over [0, duration]. Result is [{ start, end }]
   * covering everything that was NOT marked for removal.
   */
  keepSegmentsFromRemovals(removals, duration) {
    const cuts = (removals || [])
      .map(r => ({
        start: Math.max(0, Math.min(parseFloat(r.startTime), duration)),
        end: Math.max(0, Math.min(parseFloat(r.endTime), duration)),
      }))
      .filter(r => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end - r.start > 0.05)
      .sort((a, b) => a.start - b.start);

    // Merge overlapping/touching cuts so the complement is clean.
    const merged = [];
    for (const c of cuts) {
      const last = merged[merged.length - 1];
      if (last && c.start <= last.end) last.end = Math.max(last.end, c.end);
      else merged.push({ ...c });
    }

    // Keep = complement of the merged cuts over the whole timeline.
    const keeps = [];
    let cursor = 0;
    for (const c of merged) {
      if (c.start > cursor) keeps.push({ start: cursor, end: c.start });
      cursor = Math.max(cursor, c.end);
    }
    if (cursor < duration) keeps.push({ start: cursor, end: duration });

    return keeps.filter(k => k.end - k.start > 0.05);
  }

  /**
   * Run ffmpeg silencedetect and return an array of { start, end } silent ranges.
   */
  detectSilences(videoPath, { thresholdDb = -30, minSilenceSec = 0.6 } = {}) {
    return new Promise((resolve, reject) => {
      const args = [
        '-i', videoPath,
        '-af', `silencedetect=noise=${thresholdDb}dB:d=${minSilenceSec}`,
        '-f', 'null', '-'
      ];
      const proc = spawn('ffmpeg', args);
      let stderr = '';
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
        // silencedetect can be chatty on long files — keep memory bounded.
        if (stderr.length > 2_000_000) stderr = stderr.slice(-1_000_000);
      });
      proc.on('error', (err) => reject(err));
      proc.on('close', () => {
        const silences = [];
        let curStart = null;
        const lines = stderr.split('\n');
        for (const line of lines) {
          const startMatch = line.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/);
          if (startMatch) { curStart = parseFloat(startMatch[1]); continue; }
          const endMatch = line.match(/silence_end:\s*(-?\d+(?:\.\d+)?)/);
          if (endMatch && curStart !== null) {
            const end = parseFloat(endMatch[1]);
            if (end > curStart) silences.push({ start: Math.max(0, curStart), end });
            curStart = null;
          }
        }
        resolve(silences);
      });
    });
  }

  /**
   * Turn a list of silent ranges into the "loud" segments to keep, leaving a
   * little padding of silence around speech so cuts don't sound abrupt.
   * Returns [{ start, end }] covering the non-silent parts of [0, duration].
   */
  keepSegmentsFromSilences(silences, duration, paddingSec = 0.1) {
    // Shrink each silence inward by the padding; drop any that become too short
    // to bother cutting (this also enforces a minimum real cut length).
    const cuts = [];
    for (const s of silences) {
      const start = s.start + paddingSec;
      const end = s.end - paddingSec;
      if (end - start > 0.05) cuts.push({ start, end });
    }
    cuts.sort((a, b) => a.start - b.start);

    // Keep = complement of the cuts over the whole timeline.
    const keeps = [];
    let cursor = 0;
    for (const c of cuts) {
      if (c.start > cursor) keeps.push({ start: cursor, end: Math.min(c.start, duration) });
      cursor = Math.max(cursor, c.end);
    }
    if (cursor < duration) keeps.push({ start: cursor, end: duration });

    // Drop any sliver segments left behind.
    return keeps.filter(k => k.end - k.start > 0.05);
  }

  /**
   * Re-encode only the kept segments into one continuous file using a single
   * select/aselect pass, so audio and video are cut at exactly the same points
   * and stay perfectly in sync. Quality matches the rest of Clip Maker.
   */
  renderKeptSegments(videoPath, keeps, totalSeconds, outputPath, onProgress) {
    return new Promise((resolve, reject) => {
      // between(t,a,b) summed with '+' — exactly one term is 1 inside a kept range.
      // Wrapped in expr='...' single quotes so the commas stay literal in the graph.
      const expr = keeps
        .map(k => `between(t,${k.start.toFixed(3)},${k.end.toFixed(3)})`)
        .join('+');

      const args = [
        '-y',
        '-i', videoPath,
        '-vf', `select=expr='${expr}',setpts=N/FRAME_RATE/TB`,
        '-af', `aselect=expr='${expr}',asetpts=N/SR/TB`,
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '20',
        '-c:a', 'aac',
        '-ar', '48000',
        '-ac', '2',
        '-b:a', '320k',
        '-movflags', '+faststart',
        outputPath
      ];

      console.log(`  [Desilence] ${keeps.length} kept segments -> one continuous file`);
      const proc = spawn('ffmpeg', args);
      let stderr = '';
      proc.stderr.on('data', (d) => {
        const s = d.toString();
        stderr += s;
        if (stderr.length > 20000) stderr = stderr.slice(-10000);
        const m = s.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
        if (m && onProgress && totalSeconds > 0) {
          const cur = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 100;
          onProgress(Math.min(100, (cur / totalSeconds) * 100));
        }
      });
      proc.on('close', (code) => {
        if (code === 0) { console.log('  [Desilence] ✓ done'); resolve(outputPath); }
        else { console.error(stderr.slice(-800)); reject(new Error('Could not remove the silences. Please try again.')); }
      });
      proc.on('error', (err) => reject(err));
    });
  }

  // ============================================================
  // VIDEO PROCESSING — MAXIMUM QUALITY
  // ============================================================

  /**
   * Extract a clip at MAXIMUM quality
   * CRF 18 = visually lossless
   * 192k AAC audio
   */
  extractClipMaxQuality(videoPath, startTime, endTime, outputPath) {
    const duration = endTime - startTime;

    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(startTime)
        .duration(duration)
        .outputOptions([
          '-c:v', 'libx264',
          '-preset', 'medium',       // Better quality than 'fast' at cost of speed
          '-crf', '20',              // MAXIMUM visual quality (visually lossless)
          '-c:a', 'aac',
          '-ar', '48000',            // 48kHz audio (studio quality)
          '-ac', '2',                // Stereo
          '-b:a', '320k',            // High bitrate audio
          '-avoid_negative_ts', 'make_zero',
          '-y'
        ])
        .on('start', () => {
          console.log(`  Extracting (CRF 18): ${this.formatTime(startTime)} → ${this.formatTime(endTime)}`);
        })
        .on('end', () => {
          console.log(`  ✓ Raw clip extracted (max quality)`);
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error('  ✗ Extraction error:', err.message);
          reject(new Error('Could not extract this clip. Please check the timestamps and try again.'));
        })
        .save(outputPath);
    });
  }

  /**
   * Process clip with MAX quality: vertical reframe + burn captions
   * CRF 18 + 192k audio
   */
  async processClipMaxQuality(inputPath, outputPath, options) {
    const { format, subtitlePath, addCaptions } = options;

    let filterParts = [];

    // --- Reframing ---
    if (format === 'vertical') {
      // 9:16 vertical (1080x1920)
      filterParts.push('scale=-1:1920');
      filterParts.push('crop=1080:1920');
    } else if (format === 'square') {
      // 1:1 square (1080x1080)
      filterParts.push('scale=-1:1080');
      filterParts.push('crop=1080:1080');
    }
    // 'original' = no reframing

    // --- Captions ---
    if (addCaptions && subtitlePath && await fs.pathExists(subtitlePath)) {
      const escapedSubPath = subtitlePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
      filterParts.push(`ass='${escapedSubPath}'`);
    }

    // If no processing needed, just copy
    if (filterParts.length === 0) {
      await fs.copy(inputPath, outputPath);
      return;
    }

    const filterChain = filterParts.join(',');

    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-vf', filterChain,
          '-c:v', 'libx264',
          '-preset', 'medium',       // Better quality
          '-crf', '20',              // MAXIMUM visual quality
          '-c:a', 'aac',
          '-ar', '48000',
          '-ac', '2',
          '-b:a', '320k',            // High bitrate audio
          '-y'
        ])
        .on('start', () => {
          console.log(`  Processing (MAX quality): ${format} + ${addCaptions ? 'captions' : 'no captions'}`);
        })
        .on('end', () => {
          console.log(`  ✓ Clip processed (CRF 18 + 192k)`);
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error('  ✗ Processing error:', err.message);
          reject(new Error('Could not process this clip. Please try again.'));
        })
        .save(outputPath);
    });
  }

  // ============================================================
  // TRANSCRIPTION & CAPTIONS (reused from opusClipService pattern)
  // ============================================================

  /**
   * Extract audio for Whisper transcription (compressed)
   */
  extractAudioForTranscription(videoPath, audioPath) {
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .noVideo()
        .audioCodec('libmp3lame')
        .audioBitrate('64k')
        .audioChannels(1)
        .audioFrequency(16000)
        .format('mp3')
        .on('end', () => {
          console.log('✓ Audio extracted for transcription');
          resolve(audioPath);
        })
        .on('error', (err) => {
          reject(new Error('Could not extract audio from video.'));
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

    const duration = await this.getAudioDuration(audioPath);
    const chunkDuration = 600; // 10 minutes
    const numChunks = Math.ceil(duration / chunkDuration);

    console.log(`[ManualClip ${jobId}] Splitting audio into ${numChunks} chunks`);

    let allSegments = [];
    let fullText = '';

    for (let i = 0; i < numChunks; i++) {
      const startTime = i * chunkDuration;
      const chunkPath = path.join(chunksDir, `chunk_${i + 1}.mp3`);

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

      console.log(`[ManualClip ${jobId}] Transcribing chunk ${i + 1}/${numChunks}...`);
      const chunkTranscription = await transcriptionService.transcribe(chunkPath, {
        response_format: 'verbose_json'
      });

      const adjustedSegments = (chunkTranscription.segments || []).map(seg => ({
        ...seg,
        start: seg.start + startTime,
        end: seg.end + startTime
      }));

      allSegments = allSegments.concat(adjustedSegments);
      fullText += ' ' + (chunkTranscription.text || '');
    }

    await fs.remove(chunksDir).catch(() => {});

    return {
      text: fullText.trim(),
      segments: allSegments,
      duration
    };
  }

  /**
   * Get transcript segments that fall within a time range
   */
  getSegmentsForTimeRange(segments, startTime, endTime) {
    return segments.filter(seg => {
      // Include segments that overlap with our time range
      return seg.end > startTime && seg.start < endTime;
    }).map(seg => ({
      ...seg,
      // Clamp segment times to clip boundaries
      start: Math.max(seg.start, startTime),
      end: Math.min(seg.end, endTime)
    }));
  }

  /**
   * Generate styled ASS subtitles for a clip
   * Same format as opusClipService for consistency
   */
  async generateStyledSubtitles(segments, clipStartTime, outputPath, style) {
    let fontName = 'Arial';
    let fontSize = 48;
    let primaryColor = '&H00FFFFFF';
    let outlineColor = '&H00000000';
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
        primaryColor = '&H0000FF00';
        outlineColor = '&H00000000';
        fontSize = 48;
        bold = 1;
        break;
      case 'clean_minimal':
        primaryColor = '&H00FFFFFF';
        outlineColor = '&H80000000';
        fontSize = 42;
        outlineWidth = 2;
        shadowDepth = 1;
        bold = 0;
        break;
    }

    // Build ASS file
    let assContent = `[Script Info]
Title: Manual Clip Captions
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},${primaryColor},&H000000FF,${outlineColor},&H00000000,${bold},0,0,0,100,100,0,0,1,${outlineWidth},${shadowDepth},${alignment},40,40,80,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    // Add dialogue lines
    for (const seg of segments) {
      // Adjust timing relative to clip start
      const relStart = Math.max(0, seg.start - clipStartTime);
      const relEnd = seg.end - clipStartTime;

      const startAss = this.secondsToAssTime(relStart);
      const endAss = this.secondsToAssTime(relEnd);

      // Word wrap for vertical video
      const wrappedText = this.wrapText(seg.text.trim(), 35);
      const assText = wrappedText.replace(/\n/g, '\\N');

      if (assText) {
        assContent += `Dialogue: 0,${startAss},${endAss},Default,,0,0,0,,${assText}\n`;
      }
    }

    await fs.writeFile(outputPath, assContent, 'utf8');
    return outputPath;
  }

  // ============================================================
  // UTILITY METHODS
  // ============================================================

  getVideoDuration(videoPath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          console.error(`[ManualClip] FFprobe error for ${videoPath}:`, err.message || err);
          reject(new Error('Could not read video file.'));
          return;
        }
        resolve(metadata.format.duration || 0);
      });
    });
  }

  /**
   * Read the video's frame rate and snap it to the nearest standard rate
   * (24/25/30/50/60). Used as the target for constant-frame-rate normalization
   * so the result looks like a normal YouTube-style encode. Defaults to 30.
   */
  detectStandardFps(videoPath) {
    return new Promise((resolve) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) { resolve(30); return; }
        const v = (metadata.streams || []).find(s => s.codec_type === 'video');
        const raw = (v && (v.avg_frame_rate || v.r_frame_rate)) || '30/1';
        const [n, d] = String(raw).split('/').map(Number);
        let fps = d ? n / d : Number(raw);
        if (!Number.isFinite(fps) || fps <= 0) fps = 30;
        const standard = [24, 25, 30, 50, 60];
        const nearest = standard.reduce((best, s) =>
          Math.abs(s - fps) < Math.abs(best - fps) ? s : best, 30);
        resolve(nearest);
      });
    });
  }

  /**
   * Re-encode a video into a clean, CONSTANT-frame-rate copy whose timeline
   * matches what YouTube produces. The original resolution is kept; only the
   * frame timing is regularised and the presentation timestamps are reset to
   * start at 0 (which also bakes in any container edit-list / start offset).
   * This is what makes pasted YouTube timestamps land on the right moment.
   */
  async normalizeToConstantFps(inputPath, outputPath, onProgress) {
    const duration = await this.getVideoDuration(inputPath).catch(() => 0);
    const fps = await this.detectStandardFps(inputPath);
    console.log(`  [Normalize] target ${fps}fps CFR, keeping source resolution`);

    return new Promise((resolve, reject) => {
      const args = [
        '-y',
        '-fflags', '+genpts',
        '-i', inputPath,
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-vsync', 'cfr',
        '-r', String(fps),
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '18',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-ar', '48000',
        '-ac', '2',
        '-b:a', '192k',
        '-movflags', '+faststart',
        outputPath
      ];

      const proc = spawn('ffmpeg', args);
      let stderr = '';
      proc.stderr.on('data', (d) => {
        const s = d.toString();
        stderr += s;
        if (stderr.length > 20000) stderr = stderr.slice(-10000);
        const m = s.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
        if (m && onProgress && duration > 0) {
          const cur = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 100;
          onProgress(Math.min(100, (cur / duration) * 100));
        }
      });
      proc.on('close', (code) => {
        if (code === 0) { console.log('  [Normalize] ✓ done'); resolve(outputPath); }
        else { console.error(stderr.slice(-800)); reject(new Error('Could not prepare the video for YouTube timestamp matching. Please try again.')); }
      });
      proc.on('error', (err) => reject(err));
    });
  }

  // ============================================================
  // 🎭 VOICE DISGUISE
  // ============================================================
  /**
   * Order a list of disguise segments [{startTime,endTime,preset}] into a clean,
   * non-overlapping timeline of intervals that tile [0, duration]. Each interval
   * is either { start, end, preset: null } (untouched) or { start, end, preset }.
   */
  disguiseIntervals(segments, duration) {
    const segs = (segments || [])
      .map(s => ({
        start: Math.max(0, Math.min(parseFloat(s.startTime), duration)),
        end: Math.max(0, Math.min(parseFloat(s.endTime), duration)),
        preset: DISGUISE_PRESETS[s.preset] ? s.preset : 'deep',
      }))
      .filter(s => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end - s.start > 0.05)
      .sort((a, b) => a.start - b.start);

    const intervals = [];
    let cursor = 0;
    for (const s of segs) {
      const start = Math.max(s.start, cursor); // clip away any overlap with the previous one
      if (start >= s.end) continue;
      if (start > cursor) intervals.push({ start: cursor, end: start, preset: null });
      intervals.push({ start, end: s.end, preset: s.preset });
      cursor = s.end;
    }
    if (cursor < duration) intervals.push({ start: cursor, end: duration, preset: null });
    return intervals;
  }

  /**
   * Build a copy of the video whose AUDIO is pitch-disguised during the chosen
   * segments (each with its own preset), and untouched everywhere else. The
   * video stream is copied (fast) — only the audio is rebuilt. Used to make the
   * "disguised source" that the whole render is then cut from.
   */
  buildDisguisedSource(videoPath, segments, duration, outputPath, onProgress) {
    const intervals = this.disguiseIntervals(segments, duration);
    // Nothing to disguise — signal the caller to use the original.
    if (!intervals.some(iv => iv.preset)) return Promise.resolve(null);

    return new Promise((resolve, reject) => {
      const n = intervals.length;
      const parts = [`[0:a]asplit=${n}${intervals.map((_, i) => `[a${i}]`).join('')}`];
      intervals.forEach((iv, i) => {
        const trim = `atrim=${iv.start.toFixed(3)}:${iv.end.toFixed(3)},asetpts=PTS-STARTPTS`;
        const chain = iv.preset
          ? `${trim},${pitchFilterChain(DISGUISE_PRESETS[iv.preset].ratio)}`
          : trim;
        parts.push(`[a${i}]${chain}[s${i}]`);
      });
      parts.push(`${intervals.map((_, i) => `[s${i}]`).join('')}concat=n=${n}:v=0:a=1[outa]`);

      const args = [
        '-y',
        '-i', videoPath,
        '-filter_complex', parts.join(';'),
        '-map', '0:v:0',
        '-map', '[outa]',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-ar', String(DISGUISE_SR),
        '-ac', '2',
        '-b:a', '320k',
        '-movflags', '+faststart',
        outputPath,
      ];

      const presetList = intervals.filter(iv => iv.preset).map(iv => iv.preset).join(', ');
      console.log(`  [Disguise] ${intervals.filter(iv => iv.preset).length} segment(s) [${presetList}] over ${n} interval(s)`);
      const proc = spawn('ffmpeg', args);
      let stderr = '';
      proc.stderr.on('data', (d) => {
        const s = d.toString();
        stderr += s;
        if (stderr.length > 20000) stderr = stderr.slice(-10000);
        const m = s.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
        if (m && onProgress && duration > 0) {
          const cur = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 100;
          onProgress(Math.min(100, (cur / duration) * 100));
        }
      });
      proc.on('close', (code) => {
        if (code === 0) { console.log('  [Disguise] ✓ done'); resolve(outputPath); }
        else { console.error(stderr.slice(-800)); reject(new Error('Could not disguise the voices. Please try again.')); }
      });
      proc.on('error', (err) => reject(err));
    });
  }

  /**
   * Render a short audio-only preview of one segment with a disguise preset
   * applied, so the user can hear it and pick a voice before rendering. Returns
   * a public MP3 URL (kept briefly on R2). Capped to a few seconds.
   */
  async voicePreview(jobId, { startTime, endTime, preset, userId } = {}) {
    // Stream just the needed seconds straight from R2 (no full download). Prefer
    // a local copy if the job already has one, else the public playback URL.
    const memJob = this.jobs.get(jobId);
    let srcInput = (memJob && memJob.videoPath && await fs.pathExists(memJob.videoPath)) ? memJob.videoPath : null;
    if (!srcInput) {
      const rec = (await manualVideoLibraryService.get(userId, jobId))
        || (await manualVideoLibraryService.get(null, jobId));
      srcInput = rec?.playbackUrl || (rec?.sourceKey ? r2Service.getPublicUrl(rec.sourceKey) : null)
        || memJob?.playbackUrl;
    }
    if (!srcInput) throw new Error('That video is no longer available for preview.');
    const videoPath = srcInput;
    const start = Math.max(0, parseFloat(startTime) || 0);
    const rawDur = Math.max(0, (parseFloat(endTime) || 0) - start);
    const dur = Math.min(8, rawDur > 0 ? rawDur : 6); // preview at most 8s

    const ratio = DISGUISE_PRESETS[preset]?.ratio;
    const workDir = path.join(this.tempDir, `manual-${jobId}`, 'preview');
    await fs.ensureDir(workDir);
    const outPath = path.join(workDir, `prev_${preset || 'orig'}_${Math.round(start)}.mp3`);

    await new Promise((resolve, reject) => {
      const args = [
        '-y',
        '-ss', String(start),
        '-t', String(dur),
        '-i', videoPath,
        '-vn',
        ...(ratio ? ['-af', pitchFilterChain(ratio)] : []),
        '-c:a', 'libmp3lame',
        '-q:a', '4',
        outPath,
      ];
      const proc = spawn('ffmpeg', args);
      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-4000); });
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error('preview failed: ' + stderr.slice(-300))));
      proc.on('error', reject);
    });

    const key = `manual-clip/${jobId}/preview/${preset || 'orig'}_${Math.round(start)}_${Math.round(dur)}.mp3`;
    const up = await r2Service.uploadFile(outPath, key, 'audio/mpeg');
    // Clean the local copy soon; R2 keeps the short-lived preview.
    this.scheduleServerCopyCleanup(`${jobId}-prev`, outPath, 10 * 60 * 1000);
    return { url: up.downloadUrl, preset: preset || null, durationPreviewed: dur };
  }

  // ============================================================
  // 🗣️ AUTO SPEAKER DETECTION (AssemblyAI diarization)
  // ============================================================
  /**
   * Ask AssemblyAI to label "who spoke when", then group the result by speaker
   * so the user can pick which speaker(s) to disguise. Runs in the background;
   * the frontend polls /status (done when step === 'speakers_ready', and the
   * grouped speakers are returned on the status payload).
   */
  async detectSpeakers(jobId, { userId } = {}) {
    const apiKey = process.env.ASSEMBLYAI_API_KEY;
    this.updateJob(jobId, {
      status: 'generating', step: 'detecting_speakers', progress: 3,
      currentClip: 'Listening for different speakers…', speakers: null, error: null,
    });
    if (!apiKey) {
      this.updateJob(jobId, { status: 'error', error: "Speaker detection isn't set up yet — an AssemblyAI key is needed." });
      throw new Error('Missing ASSEMBLYAI_API_KEY');
    }

    // A public URL AssemblyAI can fetch (the R2 source).
    const memJob = this.jobs.get(jobId);
    let srcUrl = memJob?.playbackUrl;
    if (!srcUrl) {
      const rec = (await manualVideoLibraryService.get(userId, jobId))
        || (await manualVideoLibraryService.get(null, jobId));
      srcUrl = rec?.playbackUrl || (rec?.sourceKey ? r2Service.getPublicUrl(rec.sourceKey) : null);
    }
    if (!srcUrl) throw new Error('That video is no longer available.');

    const headers = { authorization: apiKey, 'content-type': 'application/json' };

    // 1. Submit the job (auto-detect language so Bengali etc. works).
    this.updateJob(jobId, { progress: 8, currentClip: 'Sending the audio for analysis…' });
    const submit = await axios.post(
      'https://api.assemblyai.com/v2/transcript',
      { audio_url: srcUrl, speaker_labels: true, language_detection: true },
      { headers, timeout: 60000 }
    );
    const id = submit.data.id;
    console.log(`[ManualClip ${jobId}] AssemblyAI transcript ${id} submitted`);

    // 2. Poll until done (~up to 25 min for very long files).
    let data = null;
    for (let i = 0; i < 300; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const poll = await axios.get(`https://api.assemblyai.com/v2/transcript/${id}`, { headers, timeout: 60000 });
      data = poll.data;
      if (data.status === 'completed') break;
      if (data.status === 'error') throw new Error(data.error || 'Speaker detection failed.');
      this.updateJob(jobId, { progress: Math.min(92, 12 + i), currentClip: 'Working out who spoke when…' });
    }
    if (!data || data.status !== 'completed') throw new Error('Speaker detection timed out. Please try again.');

    // 3. Group utterances by speaker; merge near-adjacent turns into clean ranges.
    const merge = (segs, gap = 0.8) => {
      const s = [...segs].sort((a, b) => a.startTime - b.startTime);
      const out = [];
      for (const x of s) {
        const last = out[out.length - 1];
        if (last && x.startTime - last.endTime <= gap) last.endTime = Math.max(last.endTime, x.endTime);
        else out.push({ ...x });
      }
      return out;
    };
    const bySpeaker = new Map();
    for (const u of (Array.isArray(data.utterances) ? data.utterances : [])) {
      const k = u.speaker || '?';
      if (!bySpeaker.has(k)) bySpeaker.set(k, { speaker: k, segments: [], sample: '' });
      const g = bySpeaker.get(k);
      const start = (u.start || 0) / 1000, end = (u.end || 0) / 1000;
      if (end > start) {
        g.segments.push({ startTime: start, endTime: end });
        if (g.sample.length < 90 && u.text) g.sample = (g.sample ? `${g.sample} ` : '') + u.text;
      }
    }
    const speakers = Array.from(bySpeaker.values()).map(s => {
      const segments = merge(s.segments);
      const totalSeconds = segments.reduce((sum, x) => sum + (x.endTime - x.startTime), 0);
      return {
        speaker: `Speaker ${s.speaker}`,
        segments,
        count: segments.length,
        totalSeconds,
        totalFormatted: this.formatTime(totalSeconds),
        sample: s.sample.slice(0, 90),
      };
    }).sort((a, b) => b.totalSeconds - a.totalSeconds);

    this.updateJob(jobId, { status: 'ready', step: 'speakers_ready', progress: 100, currentClip: '', speakers });
    console.log(`[ManualClip ${jobId}] ✓ Detected ${speakers.length} speaker(s)`);
    return { success: true, speakers };
  }

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

  secondsToAssTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const cs = Math.floor((seconds % 1) * 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  }

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

  sanitizeFilename(name) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_')
      .replace(/_+/g, '_')
      .substring(0, 50);
  }

  updateJob(jobId, updates) {
    const current = this.jobs.get(jobId) || {};
    this.jobs.set(jobId, { ...current, ...updates });
  }

  getJobStatus(jobId) {
    return this.jobs.get(jobId) || null;
  }

  // Where THIS server is reachable for direct file downloads. Lets the frontend
  // grab a finished render from us before the R2 cloud copy is ready.
  publicBaseUrl() {
    const base = process.env.PUBLIC_BASE_URL
      || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null)
      || 'https://video-processor-staging.up.railway.app';
    return base.replace(/\/$/, '');
  }

  // Remove a finished render from local disk after a grace window, so the server
  // copy stays downloadable "until it's in R2" plus a safety buffer for any
  // in-flight download. Never touches the source video.
  scheduleServerCopyCleanup(jobId, filePath, delayMs = 15 * 60 * 1000) {
    const timer = setTimeout(async () => {
      await fs.remove(filePath).catch(() => {});
      const job = this.jobs.get(jobId);
      if (job && job.serverDownload && job.serverDownload.path === filePath) {
        this.updateJob(jobId, { serverDownload: null });
      }
    }, delayMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  /**
   * Get all completed manual clip jobs (for import into Multi-Clip Editor)
   * Returns jobs that have successfully generated clips with R2 download URLs
   */
  getAllCompletedJobs() {
    const completedJobs = [];

    for (const [jobId, job] of this.jobs.entries()) {
      if (job.status === 'complete' && job.generatedClips && job.generatedClips.length > 0) {
        // Only include clips that have a download URL (successfully uploaded to R2)
        const successfulClips = job.generatedClips.filter(c => c.downloadUrl);

        if (successfulClips.length > 0) {
          completedJobs.push({
            jobId,
            videoTitle: job.videoTitle || 'Untitled Video',
            clipCount: successfulClips.length,
            createdAt: job.completedAt || new Date().toISOString(),
            clips: successfulClips.map(c => ({
              clipNumber: c.clipNumber,
              title: c.title,
              duration: c.duration,
              durationFormatted: c.durationFormatted,
              startFormatted: c.startFormatted,
              endFormatted: c.endFormatted,
              downloadUrl: c.downloadUrl
            }))
          });
        }
      }
    }

    // Sort newest first
    completedJobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return completedJobs;
  }

  /**
   * 🔗 COMBO CLIPS — Combine selected clips into one sequential video
   * 
   * Downloads selected clips from R2, concatenates them in order,
   * uploads the result back to R2 under combo-clips/ prefix.
   * 
   * Quality matches Split React: CRF 20, medium preset, 320k audio, 48000 Hz
   * Filename: COMBO-[videoTitle]-[dd-mm-yy]-[hh-mm-ss-GST].mp4
   */
  async combineClips(clipUrls, videoTitle) {
    const { spawn } = require('child_process');
    const comboId = uuidv4();
    const tempDir = process.env.TEMP_DIR || '/app/temp';
    const workDir = path.join(tempDir, `combo-${comboId}`);
    await fs.ensureDir(workDir);

    console.log(`[ComboClip] Starting combo: ${clipUrls.length} clips, title: "${videoTitle}"`);

    try {
      // Step 1: Download all clips from R2 to local temp
      const localPaths = [];
      for (let i = 0; i < clipUrls.length; i++) {
        const localPath = path.join(workDir, `input_${i + 1}.mp4`);
        console.log(`[ComboClip] Downloading clip ${i + 1}/${clipUrls.length}...`);
        
        await r2Service.downloadFile(clipUrls[i], localPath);
        localPaths.push(localPath);
        
        const fileSize = (await fs.stat(localPath)).size;
        console.log(`[ComboClip] ✓ Clip ${i + 1} downloaded (${(fileSize / 1024 / 1024).toFixed(1)}MB)`);
      }

      // Step 2: Probe first clip to check if it has audio
      const hasAudio = await new Promise((resolve) => {
        const probe = spawn('ffprobe', [
          '-v', 'quiet',
          '-select_streams', 'a',
          '-show_entries', 'stream=index',
          '-of', 'csv=p=0',
          localPaths[0]
        ]);
        let output = '';
        probe.stdout.on('data', (data) => { output += data.toString(); });
        probe.on('close', () => {
          resolve(output.trim().length > 0);
        });
        probe.on('error', () => resolve(false));
      });

      console.log(`[ComboClip] Audio detected: ${hasAudio}`);

      // Step 3: Concatenate using concat filter
      const outputPath = path.join(workDir, 'combo_output.mp4');

      const inputArgs = [];
      localPaths.forEach(p => {
        inputArgs.push('-i', p);
      });

      // Build filter_complex — handle both with-audio and without-audio cases
      const filterParts = [];
      const concatInputs = [];

      if (hasAudio) {
        // Clips have audio — normalize both video and audio streams
        for (let i = 0; i < localPaths.length; i++) {
          filterParts.push(`[${i}:v]fps=30,format=yuv420p,setsar=1[v${i}]`);
          filterParts.push(`[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${i}]`);
          concatInputs.push(`[v${i}][a${i}]`);
        }
        filterParts.push(`${concatInputs.join('')}concat=n=${localPaths.length}:v=1:a=1[outv][outa]`);
      } else {
        // No audio — video-only concat, generate silent audio
        for (let i = 0; i < localPaths.length; i++) {
          filterParts.push(`[${i}:v]fps=30,format=yuv420p,setsar=1[v${i}]`);
          concatInputs.push(`[v${i}]`);
        }
        filterParts.push(`${concatInputs.join('')}concat=n=${localPaths.length}:v=1:a=0[outv]`);
      }

      const filterComplex = filterParts.join(';');

      const ffmpegArgs = [
        '-y',
        ...inputArgs,
        '-filter_complex', filterComplex,
        '-map', '[outv]',
      ];

      if (hasAudio) {
        ffmpegArgs.push('-map', '[outa]');
        ffmpegArgs.push('-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '320k');
      }

      ffmpegArgs.push(
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '20',
        '-movflags', '+faststart',
        outputPath
      );

      console.log(`[ComboClip] Concatenating ${localPaths.length} clips...`);

      await new Promise((resolve, reject) => {
        const proc = spawn('ffmpeg', ffmpegArgs);
        let stderr = '';
        proc.stderr.on('data', (data) => { stderr += data.toString(); });
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`FFmpeg concat failed (code ${code}): ${stderr.slice(-500)}`));
        });
        proc.on('error', (err) => reject(err));
      });

      console.log(`[ComboClip] ✓ Concat complete`);

      // Step 3: Generate filename with GST timestamp (UTC+4)
      const now = new Date();
      const gst = new Date(now.getTime() + (4 * 60 * 60 * 1000)); // UTC+4
      const dd = String(gst.getUTCDate()).padStart(2, '0');
      const mm = String(gst.getUTCMonth() + 1).padStart(2, '0');
      const yy = String(gst.getUTCFullYear()).slice(-2);
      const hh = String(gst.getUTCHours()).padStart(2, '0');
      const min = String(gst.getUTCMinutes()).padStart(2, '0');
      const ss = String(gst.getUTCSeconds()).padStart(2, '0');

      // Clean title for filename safety
      const safeTitle = (videoTitle || 'untitled')
        .replace(/[^a-zA-Z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .substring(0, 50);

      const comboFileName = `COMBO-${safeTitle}-${dd}-${mm}-${yy}-${hh}-${min}-${ss}-GST.mp4`;
      const r2Key = `combo-clips/${comboId}/${comboFileName}`;

      // Step 4: Upload to R2
      console.log(`[ComboClip] Uploading to R2: ${r2Key}`);
      const uploadResult = await r2Service.uploadFile(outputPath, r2Key, 'video/mp4');
      console.log(`[ComboClip] ✓ Upload complete: ${uploadResult.downloadUrl}`);

      // Step 5: Cleanup temp files
      await fs.remove(workDir).catch(() => {});

      return {
        success: true,
        comboId,
        fileName: comboFileName,
        downloadUrl: uploadResult.downloadUrl,
        r2Key,
        clipCount: clipUrls.length
      };

    } catch (error) {
      console.error(`[ComboClip] Error:`, error.message);
      // Cleanup on error
      await fs.remove(workDir).catch(() => {});
      throw error;
    }
  }
}

module.exports = new ManualClipService();
