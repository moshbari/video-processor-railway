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
// IMPORTANT: resample to a known rate FIRST — `asetrate` reinterprets the sample
// rate, so if the source is (say) 44100 and we asetrate against 48000 the timing
// comes out wrong and the audio drifts. Normalizing to DISGUISE_SR up front keeps
// the duration exact for any source rate.
function pitchFilterChain(ratio) {
  const r = Math.max(0.5, Math.min(2, Number(ratio) || 1));
  const tempo = (1 / r).toFixed(6);
  return `aresample=${DISGUISE_SR},asetrate=${DISGUISE_SR}*${r},aresample=${DISGUISE_SR},atempo=${tempo}`;
}

// 🔊 Auto-level: even out speaker volumes (quiet guest up, loud host down),
// then normalize the whole thing to podcast loudness (-16 LUFS, what
// Spotify/Apple expect). Two dynaudnorm passes close even a 12+ dB speaker
// gap to under 1 dB (measured); one pass leaves several dB behind. t=0.01
// (~-40 dB) keeps room tone / breath gaps from being pumped up to speech
// level — quiet VOICES peak well above it, true silence stays below it.
// loudnorm internally upsamples to 192k, so resample back to our rate after.
const LEVEL_AF = `dynaudnorm=f=200:g=11:m=30:p=0.9:t=0.01,dynaudnorm=f=200:g=11:m=30:p=0.9:t=0.01,loudnorm=I=-16:TP=-1.5:LRA=11,aresample=${DISGUISE_SR}`;

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
    const levelAudio = !!options.levelAudio;
    // Split the 2->5 progress band between the two audio passes when both run.
    const disguiseTop = levelAudio ? 3.5 : 5;
    if (disguise.length > 0) {
      this.updateJob(jobId, { step: 'disguising_voices', currentClip: 'Disguising the marked voices…', progress: 2 });
      console.log(`  Disguising ${disguise.length} voice segment(s) before render`);
      const disguisedPath = path.join(seqDir, 'disguised_source.mp4');
      let built = null;
      try {
        built = await this.buildDisguisedSource(videoPath, disguise, videoDuration, disguisedPath, (pct) => {
          this.updateJob(jobId, { progress: Math.round(2 + (pct / 100) * (disguiseTop - 2)) }); // 2 -> 5 (or 3.5)
        });
      } catch (err) {
        // Disguise was requested — if it fails we must NOT fall through to a
        // render that exposes the guest's real voice. Fail the whole render.
        console.error(`[ManualClip ${jobId}] Disguise failed:`, err.message);
        throw new Error('Could not disguise the marked voices. Please try again.');
      }
      if (built) videoPath = built;
    }

    // Step 0b: 🔊 Auto-level voices — even out speaker volumes on the (possibly
    // already-disguised) source, so every hook AND the full video downstream
    // share the same balanced audio. If it fails we still render: an uneven mix
    // is annoying but not a privacy problem like a failed disguise would be.
    const removeSilences = !!options.removeSilences;
    if (levelAudio) {
      this.updateJob(jobId, { step: 'leveling_audio', currentClip: 'Evening out speaker volumes…', progress: Math.round(disguiseTop) });
      const leveledPath = path.join(seqDir, 'leveled_source.mp4');
      try {
        const built = await this.buildLeveledSource(videoPath, videoDuration, leveledPath, (pct) => {
          this.updateJob(jobId, { progress: Math.round(disguiseTop + (pct / 100) * (5 - disguiseTop)) }); // -> 5
        });
        if (built) videoPath = built;
      } catch (err) {
        console.error(`[ManualClip ${jobId}] Auto-level failed (rendering without it):`, err.message);
      }
    }

    // Step 0c: 🔇 Silence remover toggle — find the quiet gaps now and treat
    // them as extra Danger Zone cuts on the FULL video. Hooks are untouched:
    // their ranges were hand-picked. Detection runs on the (possibly disguised/
    // leveled) source, which shares the original timeline, so timestamps line
    // up with the user's cuts. Best-effort: a detection failure never blocks
    // the render.
    let silenceCuts = [];
    if (removeSilences) {
      this.updateJob(jobId, { step: 'detecting_silence', progress: 5, currentClip: 'Finding silent gaps…' });
      try {
        const silences = await this.detectSilences(videoPath, { thresholdDb: -30, minSilenceSec: 0.6 });
        const pad = 0.1; // keep a hair of each gap so speech isn't clipped
        silenceCuts = silences
          .map(s => ({ startTime: s.start + pad, endTime: s.end - pad }))
          .filter(c => c.endTime - c.startTime > 0.1);
        const gapSeconds = silenceCuts.reduce((sum, c) => sum + (c.endTime - c.startTime), 0);
        console.log(`  Silence remover: cutting ${silenceCuts.length} quiet gap(s) (${gapSeconds.toFixed(1)}s) from the full video`);
      } catch (err) {
        console.error(`[ManualClip ${jobId}] Silence detection failed (rendering without it):`, err.message);
      }
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
    // User's Danger Zone cuts + auto-detected silence gaps, merged as one list
    // (keepSegmentsFromRemovals de-overlaps them).
    const cuts = [...(Array.isArray(options.cuts) ? options.cuts : []), ...silenceCuts];
    let fullSeconds = videoDuration || 0;
    let cutsApplied = false;
    let removedSeconds = 0;
    // Kept segments of the full video (source time). Lower-third CTA times are
    // placed on the SOURCE timeline in the editor, so we map them through this.
    let fullKeeps = null;

    if (cuts.length > 0) {
      const keeps = this.keepSegmentsFromRemovals(cuts, videoDuration);
      fullKeeps = keeps;
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

    // Step 2b: 📺 Animated lower-third CTAs. Times are on the FINAL rendered
    // video's timeline (what the viewer sees), used directly — so "10:00" lands
    // at 10:00 in the delivered video, after any intro/hooks. They're burned
    // onto the FINISHED video below (during the concat, or during insert-weaving
    // when there are inserts — whichever produces the final file).
    let lowerThirdsAssPath = null;
    const lowerThirdsIn = Array.isArray(options.lowerThirds) ? options.lowerThirds : [];
    if (lowerThirdsIn.length > 0) {
      const mapped = lowerThirdsIn.map(lt => {
        const stay = !!lt.stay;
        const startSec = Math.max(0, Number(lt.startSec ?? lt.startTime) || 0);
        const e0 = Number(lt.endSec ?? lt.endTime);
        const endSec = stay ? null : (Number.isFinite(e0) ? e0 : startSec + 6);
        return { style: lt.style || 'bar', line1: lt.line1 || '', line2: lt.line2 || '', stay, startSec, endSec };
      }).filter(lt => lt.stay || (lt.endSec !== null && lt.endSec > lt.startSec + 0.2));

      if (mapped.length > 0) {
        try {
          const assPath = path.join(seqDir, 'lowerthirds.ass');
          const built = await this.buildLowerThirdsAss(mapped, assPath);
          if (built) {
            lowerThirdsAssPath = built;
            console.log(`  📺 ${mapped.length} lower-third CTA(s) at final-video times`);
          }
        } catch (err) {
          // A CTA-overlay failure must never kill the whole render.
          console.error(`[ManualClip ${jobId}] Lower-thirds build failed (rendering without them):`, err.message);
        }
      }
    }

    // Will we weave outside clips in afterwards? If so, the concat isn't the
    // final file — the overlays must burn during the weave so their final-video
    // times stay correct once inserts shift the timeline.
    const willWeaveInserts = (Array.isArray(options.inserts) ? options.inserts : [])
      .reduce((n, p) => n + (Array.isArray(p.clipUrls) ? p.clipUrls.filter(Boolean).length : 0), 0) > 0;

    // Step 2c: 🎬 Intro clip — an outside clip that plays at the VERY START of
    // the final video, before the hooks. Fetched to R2 in the editor (any
    // source), so we just download it and unshift it to the front. The user
    // explicitly added it, so if it can't be fetched we fail loudly rather than
    // hand back a video missing their intro. The full video stays the LAST
    // input, so the lower-thirds burn above is unaffected.
    const introUrl = options.introUrl ? String(options.introUrl) : null;
    if (introUrl) {
      this.updateJob(jobId, { step: 'adding_intro', progress: 61, currentClip: 'Adding your intro…' });
      console.log(`  🎬 Intro clip prepended to the front`);
      const introPath = path.join(seqDir, 'intro.mp4');
      try {
        await r2Service.downloadFile(introUrl, introPath);
      } catch (err) {
        console.error(`[ManualClip ${jobId}] Intro download failed:`, err.message);
        throw new Error('Could not add your intro clip. Please check it and try again.');
      }
      segmentPaths.unshift(introPath);
    }

    // Step 3: Concatenate everything into one 16:9 file.
    this.updateJob(jobId, {
      step: 'concatenating',
      progress: 62,
      currentClip: 'Stitching everything together...'
    });

    const outputPath = path.join(seqDir, 'podcast_sequence.mp4');
    await this.concatenateSequence16x9(segmentPaths, outputPath, totalSeconds, (pct) => {
      this.updateJob(jobId, { progress: Math.round(62 + (pct / 100) * 30) }); // 62 -> 92
    }, { finalSubtitles: willWeaveInserts ? null : lowerThirdsAssPath });

    // Guard: never report "complete" if the stitch produced no file (e.g. ffmpeg
    // ran out of memory). Fail loudly instead of handing back a dead link.
    if (!await fs.pathExists(outputPath)) {
      throw new Error('The final video could not be created. Please try again.');
    }

    // ➕ Weave in any outside clips (CTAs) the user lined up in the editor, at
    // their chosen times in the FINAL video. We splice them into the just-built
    // podcast file and overwrite it, so everything below sees the woven result.
    // If the user explicitly added clips and weaving fails, fail loudly rather
    // than quietly handing back a video that's missing their CTAs.
    const inserts = Array.isArray(options.inserts) ? options.inserts : [];
    const insertedClipCount = inserts.reduce((n, p) =>
      n + (Array.isArray(p.clipUrls) ? p.clipUrls.filter(Boolean).length : 0), 0);
    if (insertedClipCount > 0) {
      this.updateJob(jobId, { step: 'adding_clips', progress: 90, currentClip: 'Adding your extra clips…' });
      const woven = await this.weaveInsertsIntoFile(outputPath, inserts, seqDir, jobId, (pct) => {
        this.updateJob(jobId, { progress: Math.round(90 + (pct / 100) * 3) }); // 90 -> 93
      }, lowerThirdsAssPath).catch((err) => {
        console.error(`[ManualClip ${jobId}] Weaving extra clips failed:`, err.message);
        throw new Error('Built the video, but could not add your extra clips. Please check the links and try again.');
      });
      if (woven) await fs.move(woven, outputPath, { overwrite: true });
    }

    // 🖼️ Composite any background-image sections onto the finished video, at their
    // chosen times on the FINAL timeline (image full-frame + the video shrunk into
    // the overlay the user positioned). Done last so it sits on top of everything.
    const backgroundSections = Array.isArray(options.backgroundSections) ? options.backgroundSections : [];
    if (backgroundSections.length > 0) {
      this.updateJob(jobId, { step: 'adding_backgrounds', progress: 93, currentClip: 'Adding your background sections…' });
      const withBg = await this.compositeBackgroundSections(outputPath, backgroundSections, seqDir, jobId, (pct) => {
        this.updateJob(jobId, { progress: Math.round(93 + (pct / 100) * 2) }); // 93 -> 95
      }).catch((err) => {
        console.error(`[ManualClip ${jobId}] Background sections failed:`, err.message);
        throw new Error('Built the video, but could not add your background sections. Please try again.');
      });
      if (withBg) await fs.move(withBg, outputPath, { overwrite: true });
    }

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
    if (insertedClipCount > 0) titleParts.push(`${insertedClipCount} Clip${insertedClipCount !== 1 ? 's' : ''}`);
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
    // Free the LARGE intermediates right away — the container's temp disk is
    // small/ephemeral, and on a long video these are ~1GB+ each. Without this
    // they linger for 24h and pile up across renders until the disk fills and
    // the next render's final write fails ("Conversion failed!").
    await fs.remove(path.join(seqDir, 'disguised_source.mp4')).catch(() => {});
    await fs.remove(path.join(seqDir, 'disguised_source.mp4.filter.txt')).catch(() => {});
    await fs.remove(path.join(seqDir, 'leveled_source.mp4')).catch(() => {});
    await fs.remove(path.join(seqDir, 'leveled_source.mp4.audio.m4a')).catch(() => {});
    await fs.remove(path.join(seqDir, 'full_trimmed.mp4')).catch(() => {});
    await fs.remove(path.join(workDir, 'source.mp4')).catch(() => {});
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
  concatenateSequence16x9(inputPaths, outputPath, totalSeconds, onProgress, extra = {}) {
    return new Promise((resolve, reject) => {
      const n = inputPaths.length;
      const inputArgs = inputPaths.flatMap(p => ['-i', p]);

      // 📺 Optional: burn animated lower-third CTAs onto the FINAL (concatenated)
      // video, so their times line up with the delivered video's timeline.
      // libass reads the .ass; ':' \\ and ' in the path must be escaped.
      const subPath = extra.finalSubtitles;
      const subFilter = subPath
        ? `subtitles=filename='${String(subPath).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")}'`
        : '';

      const filterParts = [];
      let concatInputs = '';
      for (let i = 0; i < n; i++) {
        filterParts.push(`[${i}:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${i}]`);
        filterParts.push(`[${i}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${i}]`);
        concatInputs += `[v${i}][a${i}]`;
      }
      // Concat, then (optionally) burn the overlays onto the joined video stream.
      filterParts.push(`${concatInputs}concat=n=${n}:v=1:a=1[${subFilter ? 'cv' : 'outv'}][preAudio]`);
      if (subFilter) filterParts.push(`[cv]${subFilter}[outv]`);
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

  /**
   * Stitch a FINISHED render together with inserted clips in ONE pass, so the
   * existing render is re-encoded only ONCE — no extra quality loss beyond what
   * a normal render already costs. The base render is input 0; each inserted
   * clip is its own input. `items` is the ordered final timeline:
   *   { type: 'base', start, end }     -> a slice taken from input 0 via trim
   *   { type: 'clip', inputIndex }     -> a whole inserted-clip input
   * Every segment is standardised to 1920x1080@30fps + stereo 48k and the joins
   * are loudness-evened, exactly like concatenateSequence16x9 — but here the base
   * is split+trimmed inside the same graph instead of being pre-cut to disk
   * first (which would re-encode it a second time).
   */
  concatRenderWithInserts(inputPaths, items, outputPath, totalSeconds, onProgress, subtitlesPath = null) {
    return new Promise((resolve, reject) => {
      (async () => {
        const inputArgs = inputPaths.flatMap(p => ['-i', p]);
        // 📺 Optional: burn lower-third CTAs onto the final woven video at their
        // final-video times (this output IS the delivered video).
        const subFilter = subtitlesPath
          ? `subtitles=filename='${String(subtitlesPath).replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'")}'`
          : '';
        const baseItems = items.filter(it => it.type === 'base');
        const baseCount = baseItems.length;

        const V = '[%I%:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p';
        const A = '[%I%:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo';

        const parts = [];
        // Split input 0 (the render) into one branch per base slice, so the same
        // source stream can be trimmed into several non-overlapping pieces.
        if (baseCount > 0) {
          parts.push(`[0:v]split=${baseCount}${baseItems.map((_, i) => `[bv${i}]`).join('')}`);
          parts.push(`[0:a]asplit=${baseCount}${baseItems.map((_, i) => `[ba${i}]`).join('')}`);
        }

        let bIdx = 0;
        const concatLabels = [];
        items.forEach((it, j) => {
          if (it.type === 'base') {
            const s = Number(it.start).toFixed(3);
            const e = Number(it.end).toFixed(3);
            parts.push(`[bv${bIdx}]trim=start=${s}:end=${e},setpts=PTS-STARTPTS,scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p[v${j}]`);
            parts.push(`[ba${bIdx}]atrim=start=${s}:end=${e},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${j}]`);
            bIdx++;
          } else {
            parts.push(`${V.replace('%I%', it.inputIndex)}[v${j}]`);
            parts.push(`${A.replace('%I%', it.inputIndex)}[a${j}]`);
          }
          concatLabels.push(`[v${j}][a${j}]`);
        });
        parts.push(`${concatLabels.join('')}concat=n=${items.length}:v=1:a=1[${subFilter ? 'cv' : 'outv'}][preAudio]`);
        if (subFilter) parts.push(`[cv]${subFilter}[outv]`);
        parts.push(`[preAudio]loudnorm=I=-16:TP=-1.5:LRA=11[outa]`);

        // Pass the (potentially large) graph via a script file — no arg-length limit.
        const filterPath = `${outputPath}.filter.txt`;
        await fs.writeFile(filterPath, parts.join(';'));

        const args = [
          '-y',
          ...inputArgs,
          '-filter_complex_script', filterPath,
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

        console.log(`  [InsertConcat] ${items.length} segment(s) (base re-encoded once) -> 1920x1080@30fps + loudnorm`);
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
        proc.on('close', async (code) => {
          await fs.remove(filterPath).catch(() => {});
          if (code === 0) { console.log('  [InsertConcat] ✓ done'); resolve(outputPath); }
          else { console.error(stderr.slice(-800)); reject(new Error('Could not stitch the new video. Please try again.')); }
        });
        proc.on('error', (err) => reject(err));
      })().catch(reject);
    });
  }

  /**
   * Weave already-fetched outside clips (CTAs) into a finished video file at
   * chosen time points, and return the path to the woven result (or null if
   * there was nothing to weave). Used by the editor's Render Podcast so the user
   * can line up CTAs while editing and get them spliced into the final video in
   * the same flow. `inserts` is [{ atTime:Number|null, clipUrls:[String] }] where
   * atTime is seconds into the FINAL video (null / past-the-end = at the end).
   */
  async weaveInsertsIntoFile(basePath, inserts, workDir, jobId, onProgress, subtitlesPath = null) {
    const baseDuration = await this.getVideoDuration(basePath).catch(() => 0);

    // Download every clip to weave (dedupe by URL).
    const urls = [];
    for (const p of (inserts || [])) {
      for (const u of (Array.isArray(p.clipUrls) ? p.clipUrls : [])) {
        if (u && !urls.includes(u)) urls.push(u);
      }
    }
    if (urls.length === 0) return null;

    const localByUrl = new Map();
    let clipsTotalSeconds = 0;
    for (let i = 0; i < urls.length; i++) {
      const clipPath = path.join(workDir, `weave_${i + 1}.mp4`);
      await r2Service.downloadFile(urls[i], clipPath);
      localByUrl.set(urls[i], clipPath);
      clipsTotalSeconds += await this.getVideoDuration(clipPath).catch(() => 0);
    }

    // Normalise + sort the insertion points (null / past-the-end -> end).
    const pts = (inserts || [])
      .map((p, i) => {
        const raw = (p.atTime === null || p.atTime === undefined) ? baseDuration : parseFloat(p.atTime);
        const at = Math.max(0, Math.min(Number.isFinite(raw) ? raw : baseDuration, baseDuration));
        const clipUrls = (Array.isArray(p.clipUrls) ? p.clipUrls : []).filter(Boolean);
        return { at, clipUrls, _i: i };
      })
      .filter(p => p.clipUrls.length > 0)
      .sort((a, b) => (a.at - b.at) || (a._i - b._i));

    // Build the ordered timeline (base slices via trim of input 0 + clip inputs).
    const inputPaths = [basePath];
    const items = [];
    let cursor = 0;
    for (const p of pts) {
      if (p.at > cursor + 0.05) { items.push({ type: 'base', start: cursor, end: p.at }); cursor = p.at; }
      for (const u of p.clipUrls) {
        const lp = localByUrl.get(u);
        if (lp) { inputPaths.push(lp); items.push({ type: 'clip', inputIndex: inputPaths.length - 1 }); }
      }
    }
    if (cursor < baseDuration - 0.05) items.push({ type: 'base', start: cursor, end: baseDuration });

    if (items.length < 2) {
      for (const lp of localByUrl.values()) await fs.remove(lp).catch(() => {});
      return null;
    }

    const output = path.join(workDir, 'woven_with_inserts.mp4');
    await this.concatRenderWithInserts(inputPaths, items, output, baseDuration + clipsTotalSeconds, onProgress, subtitlesPath);
    for (const lp of localByUrl.values()) await fs.remove(lp).catch(() => {});
    console.log(`[ManualClip ${jobId}] ✓ Wove ${items.filter(it => it.type === 'clip').length} extra clip(s) into the final video`);
    return output;
  }

  // ============================================================
  // 🖼️ BACKGROUND IMAGE SECTIONS
  // ============================================================
  /**
   * Park one uploaded background image in R2 under the SAME project prefix as the
   * source video (manual-clip/{jobId}/backgrounds/…), so it shares the project's
   * lifespan and gets swept away with it. Returns the public URL + key the editor
   * keeps in the section and auto-saves.
   */
  async saveBackgroundImage(jobId, filePath, originalName) {
    let ext = (path.extname(originalName || '') || '').toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) ext = '.jpg';
    const mime = ext === '.png' ? 'image/png'
      : ext === '.webp' ? 'image/webp'
      : ext === '.gif' ? 'image/gif'
      : 'image/jpeg';
    const imgId = require('crypto').randomBytes(8).toString('hex');
    const key = `manual-clip/${jobId}/backgrounds/${imgId}${ext}`;
    const up = await r2Service.uploadFile(filePath, key, mime);
    await fs.remove(filePath).catch(() => {});
    return { imageId: imgId, imageUrl: up.downloadUrl, imageKey: key };
  }

  /**
   * Composite background-image sections onto a FINISHED render, in ONE pass.
   * For each section, during its time window on the final video we replace the
   * whole frame with the uploaded image (full-canvas, aspect preserved — either
   * "fit" = scaled to fit & letterboxed, or "original" = native pixels centered
   * & cropped/padded) and lay the video back on top as a smaller overlay the user
   * positioned/sized in the editor (pip = canvas fractions, top-left origin).
   * Sections that fail to download are skipped rather than failing the render.
   *
   * @param {string} basePath  the just-built final render
   * @param {Array}  sections  [{ startSec, endSec, imageUrl, fitMode, pip:{xPct,yPct,wPct} }]
   * @returns {Promise<string|null>} path to the composited file, or null if nothing applied
   */
  async compositeBackgroundSections(basePath, sections, workDir, jobId, onProgress) {
    const CW = 1920, CH = 1080;
    const even = (n) => { const v = Math.round(n); return v % 2 === 0 ? v : v - 1; };
    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

    const list = (Array.isArray(sections) ? sections : [])
      .filter(s => s && s.imageUrl && Number(s.endSec) > Number(s.startSec))
      .slice(0, 30); // guard against an absurd filtergraph
    if (list.length === 0) return null;

    const baseDuration = await this.getVideoDuration(basePath).catch(() => 0);
    if (!baseDuration) return null;

    // Download each section's image (dedupe identical URLs).
    const localByUrl = new Map();
    const usable = [];
    for (const s of list) {
      let local = localByUrl.get(s.imageUrl);
      if (!local) {
        let ext = (path.extname((s.imageUrl.split('?')[0]) || '') || '.jpg').toLowerCase();
        if (!['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) ext = '.jpg';
        local = path.join(workDir, `bg_src_${usable.length}${ext}`);
        try {
          await r2Service.downloadFile(s.imageUrl, local);
          localByUrl.set(s.imageUrl, local);
        } catch (err) {
          console.error(`[ManualClip ${jobId}] Background image download failed (${s.imageUrl}):`, err.message);
          continue; // skip this section, keep the render
        }
      }
      usable.push({ ...s, local });
    }
    if (usable.length === 0) return null;

    // Build the filtergraph. Input 0 = base render; inputs 1..K = images.
    const inputArgs = ['-i', basePath];
    for (const u of usable) inputArgs.push('-loop', '1', '-t', String(baseDuration.toFixed(3)), '-i', u.local);

    const parts = [];
    const K = usable.length;
    // One split branch feeds the final base; the rest feed each section's overlay.
    parts.push(`[0:v]split=${K + 1}[base]${usable.map((_, i) => `[p${i}]`).join('')}`);

    let prev = 'base';
    usable.forEach((s, i) => {
      const inIdx = i + 1;
      const s0 = Number(s.startSec).toFixed(3);
      const e0 = Number(s.endSec).toFixed(3);

      // Full-canvas background (aspect always preserved).
      if (s.fitMode === 'original') {
        // Native pixels, centered: crop the overflow, pad the shortfall.
        parts.push(`[${inIdx}:v]crop=w='min(iw,${CW})':h='min(ih,${CH})',pad=${CW}:${CH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p[bg${i}]`);
      } else {
        // Scaled to fit the canvas (up or down), then letterboxed & centered.
        parts.push(`[${inIdx}:v]scale=${CW}:${CH}:force_original_aspect_ratio=decrease,pad=${CW}:${CH}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p[bg${i}]`);
      }

      // The video overlay, sized & positioned from the editor's canvas fractions.
      const pw = even(clamp((s.pip?.wPct ?? 0.34) * CW, 40, CW));
      const px = even(clamp((s.pip?.xPct ?? 0.62) * CW, 0, CW - pw));
      const py = even(clamp((s.pip?.yPct ?? 0.6) * CH, 0, CH - 40));
      parts.push(`[p${i}]scale=${pw}:-2,setsar=1,fps=30,format=yuv420p[pip${i}]`);

      // During [start,end]: cover the frame with the image, then draw the video.
      parts.push(`[${prev}][bg${i}]overlay=0:0:enable='between(t,${s0},${e0})'[bgo${i}]`);
      parts.push(`[bgo${i}][pip${i}]overlay=${px}:${py}:enable='between(t,${s0},${e0})'[cx${i}]`);
      prev = `cx${i}`;
    });
    parts.push(`[${prev}]format=yuv420p[outv]`);

    const filterPath = `${basePath}.bgfilter.txt`;
    await fs.writeFile(filterPath, parts.join(';'));

    const outputPath = path.join(workDir, 'with_backgrounds.mp4');
    await new Promise((resolve, reject) => {
      const args = [
        '-y',
        ...inputArgs,
        '-filter_complex_script', filterPath,
        '-map', '[outv]',
        '-map', '0:a?',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
        '-c:a', 'copy',
        '-movflags', '+faststart',
        outputPath,
      ];
      console.log(`  [Backgrounds] ${K} section(s) -> full-canvas image + video overlay`);
      const proc = spawn('ffmpeg', args);
      let stderr = '';
      proc.stderr.on('data', (d) => {
        const str = d.toString();
        stderr += str;
        if (stderr.length > 20000) stderr = stderr.slice(-10000);
        const m = str.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d{2})/);
        if (m && onProgress && baseDuration > 0) {
          const cur = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 100;
          onProgress(Math.min(100, (cur / baseDuration) * 100));
        }
      });
      proc.on('close', async (code) => {
        await fs.remove(filterPath).catch(() => {});
        if (code === 0) { console.log('  [Backgrounds] ✓ done'); resolve(); }
        else { console.error(stderr.slice(-1200)); reject(new Error('Could not add your background sections. Please try again.')); }
      });
      proc.on('error', (err) => reject(err));
    });

    for (const lp of localByUrl.values()) await fs.remove(lp).catch(() => {});
    console.log(`[ManualClip ${jobId}] ✓ Composited ${K} background section(s) into the final video`);
    return outputPath;
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

  // ============================================================
  // ➕ ADD CLIPS TO A FINISHED RENDER
  // Splice extra clips (from ANY source) into an already-rendered video at
  // chosen time points, then stitch it all back into ONE new 16:9 file. The
  // original render is never touched — the result is saved as a NEW render.
  // ============================================================

  /**
   * Fetch ONE clip to insert, from any source — a URL (Tella / YouTube / TikTok /
   * Instagram / Google Drive link, etc.) OR an uploaded file — and park it on R2
   * so the insert-render step can pull it down. Reuses the exact same downloader
   * the main Clip Maker input uses, so every source it supports works here too.
   * Runs in the background; the frontend polls /status/:jobId and reads
   * generatedClips[0] (downloadUrl + duration) once status === 'complete'.
   *
   * @param {string} jobId - status/polling id for this fetch
   * @param {Object} input - { url } OR { videoPath, originalFilename }
   */
  async fetchInsertClip(jobId, input) {
    const workDir = path.join(this.tempDir, `insert-fetch-${jobId}`);
    await fs.ensureDir(workDir);

    this.updateJob(jobId, {
      status: 'generating', step: 'fetching_clip', progress: 5,
      currentClip: 'Getting your clip…', generatedClips: [], error: null,
    });

    let videoPath;
    let title = 'Clip';
    let duration = 0;

    if (input.url) {
      console.log(`[InsertClip ${jobId}] Fetching from URL: ${input.url}`);
      const dl = await downloadService.downloadVideo(input.url, `insert-${jobId}`);
      videoPath = dl.videoPath;
      title = dl.title || 'Clip';
      duration = dl.duration || 0;
    } else if (input.videoPath) {
      videoPath = input.videoPath;
      if (input.originalFilename) title = path.parse(input.originalFilename).name;
    } else {
      throw new Error('Please provide a clip URL or upload a clip file.');
    }

    if (!duration) duration = await this.getVideoDuration(videoPath).catch(() => 0);

    this.updateJob(jobId, { step: 'saving_clip', progress: 55, currentClip: 'Saving your clip…' });

    // Park it under its own prefix (not the permanent renders/sources) so it can
    // be cleaned up later without touching anyone's library.
    const key = `manual-clip-inserts/${jobId}.mp4`;
    const up = await r2Service.uploadFile(videoPath, key, 'video/mp4');

    const clip = {
      clipNumber: 1,
      title,
      duration,
      durationFormatted: this.formatTime(duration),
      downloadUrl: up.downloadUrl,
      r2Key: key,
      isInsertClip: true,
    };

    this.updateJob(jobId, {
      status: 'complete', step: 'done', progress: 100,
      currentClip: '', generatedClips: [clip], completedAt: new Date().toISOString(),
    });

    await fs.remove(workDir).catch(() => {});
    console.log(`[InsertClip ${jobId}] ✓ Clip ready: ${up.downloadUrl} (${this.formatTime(duration)})`);
    return clip;
  }

  /**
   * Splice already-fetched clips into a FINISHED render at chosen time points and
   * stitch the result into ONE new 16:9 file. Each "point" is { atTime, clipUrls }:
   * `atTime` is the number of seconds INTO the finished video where the clip(s)
   * go — everything after it slides later, nothing is covered or replaced. An
   * `atTime` of null (or past the end of the render) means "at the very end".
   * Unlimited points, unlimited clips per point. Saved as a NEW render; the
   * original render is left untouched.
   *
   * @param {string} jobId     - status/polling id for THIS insert render
   * @param {string} renderId  - the finished render to add clips to
   * @param {Array}  points    - [{ atTime:Number|null, clipUrls:[String] }]
   * @param {Object} options   - { userId, title }
   */
  async insertClipsIntoRender(jobId, renderId, points, options = {}) {
    const userId = options.userId || null;

    this.updateJob(jobId, {
      status: 'generating', step: 'starting_insert', progress: 0,
      totalClips: 1, completedClips: 0,
      currentClip: 'Opening your rendered video…', generatedClips: [], error: null,
    });

    // 1. Find the finished render (user's library first, then the public one).
    const record = (await manualVideoLibraryService.getRender(userId, renderId))
      || (await manualVideoLibraryService.getRender(null, renderId));
    if (!record) throw new Error('That rendered video is no longer available.');

    const workDir = path.join(this.tempDir, `insert-${jobId}`);
    const seqDir = path.join(workDir, 'sequence');
    await fs.ensureDir(seqDir);

    // 2. Bring the finished render down from R2.
    this.updateJob(jobId, { step: 'downloading_render', progress: 6, currentClip: 'Loading your video…' });
    const baseUrl = record.downloadUrl || (record.r2Key ? r2Service.getPublicUrl(record.r2Key) : null);
    if (!baseUrl) throw new Error('That rendered video is no longer available.');
    const basePath = path.join(workDir, 'base_render.mp4');
    await r2Service.downloadFile(baseUrl, basePath);
    const baseDuration = await this.getVideoDuration(basePath).catch(() => record.duration || 0);

    // 3. Download every clip to insert (dedupe by URL so a clip used at two
    //    points only downloads once).
    const urls = [];
    for (const p of (points || [])) {
      for (const u of (Array.isArray(p.clipUrls) ? p.clipUrls : [])) {
        if (u && !urls.includes(u)) urls.push(u);
      }
    }
    if (urls.length === 0) throw new Error('Add at least one clip to insert.');

    const localByUrl = new Map();
    let clipsTotalSeconds = 0;
    for (let i = 0; i < urls.length; i++) {
      this.updateJob(jobId, {
        step: `downloading_clip_${i + 1}`,
        progress: Math.round(8 + (i / urls.length) * 22), // 8 -> 30
        currentClip: `Fetching clip ${i + 1} of ${urls.length}…`,
      });
      const clipPath = path.join(workDir, `insert_${i + 1}.mp4`);
      await r2Service.downloadFile(urls[i], clipPath);
      localByUrl.set(urls[i], clipPath);
      clipsTotalSeconds += await this.getVideoDuration(clipPath).catch(() => 0);
    }

    // 4. Normalise + sort the insertion points by time. null / past-the-end -> end.
    const pts = (points || [])
      .map((p, i) => {
        const raw = (p.atTime === null || p.atTime === undefined) ? baseDuration : parseFloat(p.atTime);
        const at = Math.max(0, Math.min(Number.isFinite(raw) ? raw : baseDuration, baseDuration));
        const clipUrls = (Array.isArray(p.clipUrls) ? p.clipUrls : []).filter(Boolean);
        return { at, clipUrls, _i: i };
      })
      .filter(p => p.clipUrls.length > 0)
      .sort((a, b) => (a.at - b.at) || (a._i - b._i));

    // 5. Build the ordered timeline: base slice, clip(s), base slice, clip(s)…
    //    so each clip is spliced IN at its time and the rest of the video slides
    //    later. We DON'T pre-cut the base to disk (that would re-encode it an
    //    extra time, costing quality) — instead the base render is input 0 and
    //    gets split+trimmed inside the single stitch pass below, so the existing
    //    video is re-encoded only once. Each inserted clip is its own input.
    this.updateJob(jobId, { step: 'cutting_render', progress: 32, currentClip: 'Placing your clips…' });
    const inputPaths = [basePath];
    const items = [];
    let cursor = 0;
    for (const p of pts) {
      if (p.at > cursor + 0.05) {
        items.push({ type: 'base', start: cursor, end: p.at });
        cursor = p.at;
      }
      for (const u of p.clipUrls) {
        const lp = localByUrl.get(u);
        if (lp) {
          // A clip used at two spots becomes two inputs of the same file — fine.
          inputPaths.push(lp);
          items.push({ type: 'clip', inputIndex: inputPaths.length - 1 });
        }
      }
    }
    // Whatever is left of the original video after the last insertion point.
    if (cursor < baseDuration - 0.05) {
      items.push({ type: 'base', start: cursor, end: baseDuration });
    }

    if (items.length < 2) throw new Error('Nothing to add. Please add at least one clip.');

    // 6. Stitch everything into one 16:9 file in a single pass (mixed sources/
    //    sizes join seamlessly, loudness is evened out, base encoded just once).
    this.updateJob(jobId, { step: 'concatenating', progress: 38, currentClip: 'Stitching your new video together…' });
    const totalSeconds = baseDuration + clipsTotalSeconds;
    const outputPath = path.join(seqDir, 'render_with_inserts.mp4');
    await this.concatRenderWithInserts(inputPaths, items, outputPath, totalSeconds, (pct) => {
      this.updateJob(jobId, { progress: Math.round(38 + (pct / 100) * 54) }); // 38 -> 92
    });

    if (!await fs.pathExists(outputPath)) {
      throw new Error('The new video could not be created. Please try again.');
    }

    // 7. Make it downloadable straight from this server immediately, then push
    //    the durable copy to R2 (same pattern as the podcast render).
    const baseTitle = options.title || record.title || 'Video';
    const safeTitle = this.sanitizeFilename(baseTitle);
    const downloadName = `${safeTitle || 'video'}_plus_clips.mp4`;
    const finalDuration = await this.getVideoDuration(outputPath).catch(() => totalSeconds);
    const serverDownloadUrl = `${this.publicBaseUrl()}/api/manual-clip/download/${jobId}`;

    this.updateJob(jobId, {
      step: 'uploading', progress: 94,
      currentClip: 'Your video is ready — saving a cloud copy…',
      serverDownload: { path: outputPath, filename: downloadName },
      serverDownloadUrl,
    });

    const r2FileName = `manual-clips/${jobId}/render_with_inserts_${safeTitle}.mp4`;
    let r2Url = null;
    try {
      const up = await r2Service.uploadFile(outputPath, r2FileName);
      r2Url = up.downloadUrl;
    } catch (err) {
      console.error(`[InsertClip ${jobId}] R2 upload failed, serving local copy:`, err.message);
    }

    const insertedCount = pts.reduce((n, p) => n + p.clipUrls.length, 0);
    const resultClip = {
      clipNumber: 1,
      title: `${baseTitle} — +${insertedCount} clip${insertedCount !== 1 ? 's' : ''}`,
      isInsertResult: true,
      insertedCount,
      duration: finalDuration,
      durationFormatted: this.formatTime(finalDuration),
      downloadUrl: r2Url || serverDownloadUrl,
      serverDownloadUrl,
      hasCaptions: false,
    };

    this.updateJob(jobId, {
      status: 'complete', step: 'done', progress: 100,
      completedClips: 1, currentClip: '',
      generatedClips: [resultClip], completedAt: new Date().toISOString(),
    });

    console.log(`[InsertClip ${jobId}] ✓ Added ${insertedCount} clip(s) to render ${renderId}: ${resultClip.downloadUrl}`);

    // 8. Save the result as a NEW render (only once it's safely on R2, so a
    //    server-only URL can't die on restart).
    if (r2Url) {
      try {
        let renderSize = 0;
        try { renderSize = (await fs.stat(outputPath)).size; } catch { /* best-effort */ }
        await manualVideoLibraryService.addRender(userId, {
          title: resultClip.title,
          downloadUrl: r2Url,
          r2Key: r2FileName,
          fileSize: renderSize,
          duration: finalDuration,
          durationFormatted: this.formatTime(finalDuration),
          sourceJobId: record.sourceJobId || null,
          hookCount: 0,
          createdAt: new Date().toISOString(),
        });
      } catch (libErr) {
        console.error(`[InsertClip ${jobId}] Could not save render to library:`, libErr.message);
      }
    }

    // 9. Clean up: drop the downloaded clips + the base render copy now; keep the
    //    finished file on disk for a grace window for the direct download.
    for (const lp of localByUrl.values()) await fs.remove(lp).catch(() => {});
    await fs.remove(basePath).catch(() => {});
    this.scheduleServerCopyCleanup(jobId, outputPath, r2Url ? 15 * 60 * 1000 : 6 * 60 * 60 * 1000);

    return {
      success: true,
      jobId,
      downloadUrl: resultClip.downloadUrl,
      serverDownloadUrl,
      clips: [resultClip],
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

  // Max kept segments to put in one FFmpeg select expression. A very long
  // podcast with the silence remover on can produce hundreds of tiny gaps;
  // cramming them all into one `select=expr='between(t,..)+..'` builds a
  // filtergraph so big FFmpeg dies with "Cannot allocate memory". We cap the
  // expression size and stitch batches together instead.
  static DESILENCE_BATCH = 40;

  /**
   * Re-encode only the kept segments into one continuous file, so audio and
   * video are cut at exactly the same points and stay perfectly in sync.
   * Quality matches the rest of Clip Maker.
   *
   * For a handful of segments this is a single select/aselect pass. For many
   * segments (hundreds of silence gaps) we process them in batches — each batch
   * is its own small, memory-safe pass — then concat the batch files losslessly.
   */
  async renderKeptSegments(videoPath, keeps, totalSeconds, outputPath, onProgress) {
    const BATCH = this.constructor.DESILENCE_BATCH;

    // Small case: one pass, exactly as before.
    if (keeps.length <= BATCH) {
      console.log(`  [Desilence] ${keeps.length} kept segments -> one continuous file`);
      return this._renderKeptSegmentsPass(videoPath, keeps, totalSeconds, outputPath, onProgress);
    }

    // Large case: split into batches, render each into a part file, then concat.
    const batches = [];
    for (let i = 0; i < keeps.length; i += BATCH) batches.push(keeps.slice(i, i + BATCH));
    console.log(`  [Desilence] ${keeps.length} kept segments in ${batches.length} batch(es) of up to ${BATCH} -> stitched (memory-safe)`);

    const dir = path.dirname(outputPath);
    const base = path.basename(outputPath, path.extname(outputPath));
    const partPaths = [];
    let doneSeconds = 0; // kept seconds finished by previous batches (for progress)

    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi];
      const batchSeconds = batch.reduce((s, k) => s + (k.end - k.start), 0);
      const partPath = path.join(dir, `${base}_part_${String(bi + 1).padStart(3, '0')}.mp4`);
      const before = doneSeconds;
      await this._renderKeptSegmentsPass(videoPath, batch, batchSeconds, partPath, (pct) => {
        if (onProgress && totalSeconds > 0) {
          const cur = before + (pct / 100) * batchSeconds;
          onProgress(Math.min(100, (cur / totalSeconds) * 100));
        }
      });
      partPaths.push(partPath);
      doneSeconds += batchSeconds;
    }

    // Concat the part files. They share identical encode settings, so a
    // stream-copy concat is safe and lossless.
    const listPath = path.join(dir, `${base}_concat.txt`);
    const listBody = partPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
    await fs.writeFile(listPath, listBody);

    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-y',
        '-f', 'concat', '-safe', '0',
        '-i', listPath,
        '-c', 'copy',
        '-movflags', '+faststart',
        outputPath
      ]);
      let stderr = '';
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
        if (stderr.length > 20000) stderr = stderr.slice(-10000);
      });
      proc.on('close', (code) => {
        if (code === 0) resolve();
        else { console.error(stderr.slice(-800)); reject(new Error('Could not remove the silences. Please try again.')); }
      });
      proc.on('error', (err) => reject(err));
    });

    // Best-effort cleanup of the intermediate part files + list.
    await Promise.all(partPaths.map(p => fs.remove(p).catch(() => {})));
    await fs.remove(listPath).catch(() => {});

    console.log('  [Desilence] ✓ done');
    return outputPath;
  }

  // One memory-bounded select/aselect pass over `keeps`. Used directly for a
  // small number of segments, and once per batch for large ones.
  _renderKeptSegmentsPass(videoPath, keeps, totalSeconds, outputPath, onProgress) {
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
        if (code === 0) { resolve(outputPath); }
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
  // 📺 ANIMATED LOWER THIRDS (news-style CTA overlays)
  // ------------------------------------------------------------
  // Burned into the FULL-video portion of the podcast render via libass
  // (the same subtitle engine captions use). Each overlay flies in, holds,
  // and either slides away or stays pinned. Six broadcast styles, matching
  // the preview: Broadcast Bar, Glass Pill, Wipe Reveal, Kinetic Brackets,
  // Underline Draw, Neon Brand Bar.
  // ============================================================

  /**
   * Map a SOURCE-video timestamp onto the "kept" timeline (what's left after
   * Danger-Zone / silence cuts are removed). If the time lands inside a removed
   * gap it snaps to the nearest kept boundary. With no cuts this is identity.
   * @param {number} t        - source seconds
   * @param {Array}  keeps    - [{start,end}] kept segments in source time (sorted)
   * @returns {number} seconds on the kept (final full-video segment) timeline
   */
  mapTimeThroughKeeps(t, keeps) {
    if (!Array.isArray(keeps) || keeps.length === 0) return Math.max(0, t);
    let acc = 0;
    for (const k of keeps) {
      if (t >= k.end) { acc += (k.end - k.start); continue; }
      if (t <= k.start) return acc;                 // inside a gap before this keep
      return acc + (t - k.start);                   // inside this keep
    }
    return acc;                                      // past the end
  }

  /**
   * Build an ASS subtitle file describing the animated lower thirds, timed on
   * the full-video SEGMENT's own timeline (0 = start of the full video that
   * gets appended after the hooks). Returns the file path, or null if there is
   * nothing to draw.
   * @param {Array}  items      - [{ style, startSec, endSec, line1, line2, stay }]
   * @param {string} outputPath - where to write the .ass
   * @param {number} segDur     - full-video segment duration (for "stay" end)
   */
  async buildLowerThirdsAss(items, outputPath, segDur) {
    const list = (Array.isArray(items) ? items : []).filter(Boolean);
    if (list.length === 0) return null;

    const PLAY_W = 1920, PLAY_H = 1080;
    // Palette in ASS &HBBGGRR& order.
    const C = {
      cyan: 'CDE624', cyanB: 'E6FB6F', pink: 'A05BFF',
      ink: 'FFF8F3', amber: '38B6FF', darkTxt: '0A0A0A',
    };
    const X0 = 130;                 // left safe margin
    const FIN = 400, FOUT = 340;    // fly-in / fly-out (ms)

    // ---- ASS header + one Style per visual role -------------------------
    // BorderStyle=3 => an opaque box auto-fitted around the text (no width
    // measuring needed). The box colour is the OutlineColour; its alpha (the
    // AA in &HAABBGGRR&) sets transparency. BorderStyle=1 => outline+shadow.
    // Format: Name,Font,Size,Primary,Secondary,Outline,Back,Bold,Ital,Under,
    //   Strike,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Align,ML,MR,MV,Enc
    let ass = `[Script Info]
Title: Lower Thirds
ScriptType: v4.00+
PlayResX: ${PLAY_W}
PlayResY: ${PLAY_H}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: LTMain,Arial,62,&H00${C.ink},&H000000FF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,4,3,7,0,0,0,1
Style: LTKick,Arial,34,&H00${C.cyanB},&H000000FF,&H00000000,&H64000000,1,0,0,0,100,100,4,0,1,4,2,7,0,0,0,1
Style: LTBoxMain,Arial,58,&H00${C.ink},&H000000FF,&H1E0E0906,&H78000000,1,0,0,0,100,100,0,0,3,22,0,7,0,0,0,1
Style: LTBoxKick,Arial,32,&H00${C.cyanB},&H000000FF,&H1E0E0906,&H78000000,1,0,0,0,100,100,3,0,3,16,0,7,0,0,0,1
Style: LTPill,Arial,40,&H00${C.ink},&H000000FF,&H32120C0A,&H78000000,1,0,0,0,100,100,0,0,3,28,0,7,0,0,0,1
Style: LTTag,Arial,34,&H00${C.darkTxt},&H000000FF,&H00${C.amber},&H96000000,1,0,0,0,100,100,3,0,3,18,0,7,0,0,0,1
Style: LTDraw,Arial,40,&H00${C.cyan},&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

    const esc = (s) => String(s == null ? '' : s)
      .replace(/\\/g, ' ').replace(/[\{\}]/g, '').replace(/\r?\n/g, ' ').trim();
    const rect = (w, h) => `m 0 0 l ${w} 0 ${w} ${h} 0 ${h}`;
    const dialogue = (layer, start, end, style, x, y, sx, sy, stay, body) => {
      const move = (sx === x && sy === y) ? '' : `\\move(${sx},${sy},${x},${y},0,${FIN})`;
      const fad = `\\fad(${FIN},${stay ? 0 : FOUT})`;
      ass += `Dialogue: ${layer},${this.secondsToAssTime(start)},${this.secondsToAssTime(end)},${style},,0,0,0,,{\\an7\\pos(${x},${y})${move}${fad}}${body}\n`;
    };

    for (const it of list) {
      const style = String(it.style || 'bar');
      const stay = !!it.stay;
      const start = Math.max(0, Number(it.startSec) || 0);
      // Times are FINAL-video seconds. "Stay" → a very large end so libass keeps
      // it on screen until the real end of the video (whatever its length).
      const end = stay ? 359999 : Math.max(start + 0.6, Number(it.endSec) || start + 6);
      if (!stay && end <= start) continue;

      const l1 = esc(it.line1);
      const l2 = esc(it.line2);
      const up = (s) => s.toUpperCase();

      switch (style) {
        case 'pill': {
          const y = 902;
          const dot = `{\\1c&H${C.cyanB}&}●{\\1c&H${C.ink}&} `;
          const txt = l2 ? `${l1} · ${l2}` : (l1 || 'New this week');
          dialogue(3, start, end, 'LTPill', X0, y, X0, y + 46, stay, `${dot}${txt}`);
          break;
        }
        case 'wipe': {
          // Tag + message. The message box sat at a fixed X0+214, so any tag
          // longer than a short word ran underneath it and the two overlapped
          // into mush. Push the box past the tag's actual width instead; short
          // tags ("FREE") keep the original 214 spacing exactly.
          const y = 900;
          const tag = up(l1 || 'FREE');
          const tagW = Math.round(tag.length * 34 * 0.58) + 36; // Arial 34 bold + box padding
          const mainX = X0 + Math.max(214, tagW + 30);
          dialogue(3, start, end, 'LTTag', X0, y, X0 - 170, y, stay, tag);
          if (l2) dialogue(3, start, end, 'LTBoxMain', mainX, y + 2, mainX - 174, y + 2, stay, l2);
          break;
        }
        case 'brackets': {
          // A framed single row. It used to draw `l1 || l2`, which silently ate
          // line 2 whenever both were filled — a CTA would lose its domain. Join
          // them instead, and size the frame to the text: `span` was a fixed 780
          // so anything longer than ~22 characters ran straight through the
          // right bracket.
          const y = 884, th = 10, h = 92;
          const txt = (l1 && l2) ? `${l1} · ${l2}` : (l1 || l2 || '');
          const span = Math.max(400, Math.min(1660, 96 + Math.round(txt.length * 62 * 0.55)));
          dialogue(2, start, end, 'LTDraw', X0, y, X0 + 34, y, stay, `{\\1c&H${C.cyanB}&\\p1}${rect(th, h)}{\\p0}`);
          dialogue(2, start, end, 'LTDraw', X0 + span, y, X0 + span - 34, y, stay, `{\\1c&H${C.cyanB}&\\p1}${rect(th, h)}{\\p0}`);
          dialogue(3, start, end, 'LTMain', X0 + 48, y + 12, X0 + 48, y + 58, stay, txt);
          break;
        }
        case 'draw': {
          const ty = 838, uy = 918;
          dialogue(3, start, end, 'LTMain', X0, ty, X0, ty + 40, stay, l1 || l2 || '');
          // Two-tone underline (cyan -> pink) to echo the gradient preview.
          dialogue(2, start, end, 'LTDraw', X0, uy, X0 - 40, uy, stay, `{\\1c&H${C.cyan}&\\p1}${rect(320, 10)}{\\p0}`);
          dialogue(2, start, end, 'LTDraw', X0 + 320, uy, X0 + 280, uy, stay, `{\\1c&H${C.pink}&\\p1}${rect(260, 10)}{\\p0}`);
          if (l2 && l1) dialogue(3, start, end, 'LTKick', X0, uy + 26, X0, uy + 26, stay, l2);
          break;
        }
        case 'neon': {
          const ky = 794, my = 846;
          if (l1) dialogue(3, start, end, 'LTKick', X0 + 22, ky, X0 + 22, ky + 42, stay, `{\\1c&H${C.pink}&}${up(l1)}`);
          dialogue(2, start, end, 'LTDraw', X0, my, X0, my + 42, stay, `{\\1c&H${C.pink}&\\p1}${rect(10, 150)}{\\p0}`);
          dialogue(3, start, end, 'LTBoxMain', X0 + 34, my, X0 + 34, my + 42, stay, l2 || l1 || '');
          break;
        }
        case 'bar':
        default: {
          const ky = 792, my = 846;
          dialogue(2, start, end, 'LTDraw', X0, ky, X0 - 180, ky, stay, `{\\1c&H${C.cyan}&\\p1}${rect(10, 158)}{\\p0}`);
          if (l1) dialogue(3, start, end, 'LTBoxKick', X0 + 34, ky, X0 - 180 + 34, ky, stay, up(l1));
          dialogue(3, start, end, 'LTBoxMain', X0 + 34, l1 ? my : ky + 8, X0 - 180 + 34, l1 ? my : ky + 8, stay, l2 || l1 || '');
          break;
        }
      }
    }

    await fs.writeFile(outputPath, ass, 'utf8');
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
   * video stream is copied (fast) — only the audio is rebuilt.
   *
   * Approach: split the audio at the window boundaries, pitch-shift the disguise
   * pieces, and concat back in order. To keep A/V sync EXACT we (a) resample to a
   * known rate before any asetrate (so the pitch math is right for any source
   * rate) and (b) force each pitched piece to its precise target length with
   * apad+atrim — so the joined timeline can't drift. This stays light on memory
   * even with hundreds of windows (a volume-gated mix blew up the filtergraph and
   * OOM'd at ~130 windows; this peaks ~120 MB).
   */
  async buildDisguisedSource(videoPath, segments, duration, outputPath, onProgress) {
    const intervals = this.disguiseIntervals(segments, duration);
    // Nothing to disguise — signal the caller to use the original.
    if (!intervals.some(iv => iv.preset)) return null;

    const n = intervals.length;
    const parts = [`[0:a]aresample=${DISGUISE_SR},asplit=${n}${intervals.map((_, i) => `[a${i}]`).join('')}`];
    intervals.forEach((iv, i) => {
      const d = (iv.end - iv.start).toFixed(3);
      let chain = `atrim=${iv.start.toFixed(3)}:${iv.end.toFixed(3)},asetpts=PTS-STARTPTS`;
      if (iv.preset) {
        // Pitch-shift, then nail the piece to its exact length so concat never drifts.
        chain += `,${pitchFilterChain(DISGUISE_PRESETS[iv.preset].ratio)},apad=whole_dur=${d},atrim=0:${d}`;
      }
      parts.push(`[a${i}]${chain}[s${i}]`);
    });
    parts.push(`${intervals.map((_, i) => `[s${i}]`).join('')}concat=n=${n}:v=0:a=1[outa]`);

    // Large filtergraphs are passed via a script file (avoids any arg-length limit).
    const filterPath = `${outputPath}.filter.txt`;
    await fs.writeFile(filterPath, parts.join(';'));
    const audioPath = `${outputPath}.audio.m4a`;

    const disguiseCount = intervals.filter(iv => iv.preset).length;
    console.log(`  [Disguise] ${disguiseCount} window(s) over ${n} interval(s) — audio-first then copy-mux (sync-safe, low memory)`);

    // STEP 1 — build the disguised AUDIO only. We do NOT mux the video in this
    // pass: copying the big video while the audio filter lags makes ffmpeg
    // buffer the whole video in memory (OOM-kills the container on long files).
    await this._runFfmpeg([
      '-y', '-i', videoPath,
      '-filter_complex_script', filterPath,
      '-map', '[outa]',
      '-c:a', 'aac', '-ar', String(DISGUISE_SR), '-ac', '2', '-b:a', '320k',
      audioPath,
    ], { duration, onProgress, label: 'Disguise audio' });

    // STEP 2 — mux the original video (copy) with the disguised audio (copy).
    // Both streams are copied, so it's fast and buffers nothing.
    await this._runFfmpeg([
      '-y', '-i', videoPath, '-i', audioPath,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ], { label: 'Disguise mux' });

    await fs.remove(audioPath).catch(() => {});
    await fs.remove(filterPath).catch(() => {});
    console.log('  [Disguise] ✓ done');
    return outputPath;
  }

  /**
   * 🔊 Build a copy of the video whose AUDIO is auto-leveled (speaker volumes
   * evened out + podcast loudness). Video stream is copied — only the audio is
   * rebuilt. Same audio-first-then-copy-mux pattern as buildDisguisedSource so
   * long videos can't OOM the container.
   */
  async buildLeveledSource(videoPath, duration, outputPath, onProgress) {
    const audioPath = `${outputPath}.audio.m4a`;
    console.log('  [Level] Evening out speaker volumes — audio-first then copy-mux');

    await this._runFfmpeg([
      '-y', '-i', videoPath,
      '-vn', '-af', LEVEL_AF,
      '-c:a', 'aac', '-ar', String(DISGUISE_SR), '-ac', '2', '-b:a', '320k',
      audioPath,
    ], { duration, onProgress, label: 'Level audio' });

    await this._runFfmpeg([
      '-y', '-i', videoPath, '-i', audioPath,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ], { label: 'Level mux' });

    await fs.remove(audioPath).catch(() => {});
    console.log('  [Level] ✓ done');
    return outputPath;
  }

  // ============================================================
  // 🎙️ REVOICE — add / replace audio on hand-picked sections
  // ============================================================
  /**
   * Does this file actually carry an audio stream? Silent screen-recordings
   * don't — and ReVoice's headline use is "add a voiceover to a silent video",
   * so we must build the base track from generated silence when there's none.
   * Defaults to TRUE on probe failure (most videos do have audio).
   */
  hasAudioStream(filePath) {
    return new Promise((resolve) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) { resolve(true); return; }
        resolve((metadata.streams || []).some(s => s.codec_type === 'audio'));
      });
    });
  }

  /**
   * Park ONE recorded voice clip on R2 so a later render can pull it down.
   * Returns its public URL + measured duration (the editor needs the duration
   * to compare against the selected section and decide short/long handling).
   */
  async saveReVoiceAudio(jobId, filePath, originalName) {
    const ext = (path.extname(originalName || '') || '.webm').toLowerCase();
    const audioId = require('crypto').randomBytes(8).toString('hex');
    const duration = await this.getAudioDuration(filePath).catch(() => 0);
    const mime = ext === '.mp3' ? 'audio/mpeg'
      : ext === '.wav' ? 'audio/wav'
      : ext === '.m4a' || ext === '.mp4' ? 'audio/mp4'
      : ext === '.ogg' ? 'audio/ogg'
      : 'audio/webm';
    const key = `manual-clip/${jobId}/revoice/${audioId}${ext}`;
    const up = await r2Service.uploadFile(filePath, key, mime);
    await fs.remove(filePath).catch(() => {});
    return { audioId, audioUrl: up.downloadUrl, duration, key };
  }

  /**
   * Build a copy of the video whose AUDIO has the recorded clips dropped into
   * their marked sections. Same OOM-safe pattern as buildDisguisedSource:
   * build the new audio first, then copy-mux it back onto the untouched video.
   *
   * Each segment: { start, end, localPath, align, mode, fitMode, audioDuration }
   *   mode    'replace' = silence the original under the slot, then lay the clip
   *           'overlay' = keep the original and mix the clip on top
   *   align   'start' | 'end'  — where a SHORTER clip sits inside the slot
   *   fitMode 'auto' (decide by overflow), 'speed' (atempo to fit, Option-1
   *           default), 'trim' (cut the tail), 'none' (place as-is)
   *
   * `hasAudio` false ⇒ the source is silent; the base track is generated
   * silence (the "voiceover on a silent video" path).
   */
  async buildReVoicedSource(videoPath, segments, duration, hasAudio, outputPath, onProgress) {
    const segs = (segments || [])
      .filter(s => s && s.localPath)
      .map(s => ({
        start: Math.max(0, parseFloat(s.start) || 0),
        end: Math.max(0, parseFloat(s.end) || 0),
        localPath: s.localPath,
        align: s.align === 'end' ? 'end' : 'start',
        mode: s.mode === 'overlay' ? 'overlay' : 'replace',
        fitMode: ['speed', 'trim', 'none'].includes(s.fitMode) ? s.fitMode : 'auto',
        audioDuration: Math.max(0, parseFloat(s.audioDuration) || 0),
      }))
      .filter(s => s.end > s.start)
      .sort((a, b) => a.start - b.start);
    if (segs.length === 0) return null;

    // input 0 = video (always — Step 2 copies its video stream); 1..N = clips.
    const inputs = ['-i', videoPath];
    segs.forEach(s => inputs.push('-i', s.localPath));
    // When the source is silent, append a generated-silence input for the base.
    let baseIdx = 0;
    if (!hasAudio) {
      baseIdx = segs.length + 1;
      inputs.push('-f', 'lavfi', '-t', duration.toFixed(3), '-i', `anullsrc=r=${DISGUISE_SR}:cl=stereo`);
    }

    const parts = [];
    // Base track, resampled to a common format. For replace-mode segments, mute
    // the original underneath the slot (no-op on a silent base, harmless).
    let base = `[${baseIdx}:a]aresample=${DISGUISE_SR},aformat=sample_fmts=fltp:sample_rates=${DISGUISE_SR}:channel_layouts=stereo`;
    if (hasAudio) {
      segs.filter(s => s.mode === 'replace').forEach(s => {
        base += `,volume=enable='between(t,${s.start.toFixed(3)},${s.end.toFixed(3)})':volume=0`;
      });
    }
    parts.push(`${base}[base]`);

    const labels = ['[base]'];
    segs.forEach((s, i) => {
      const k = i + 1; // clip input index
      const slot = s.end - s.start;
      const A = s.audioDuration > 0 ? s.audioDuration : slot;
      let chain = `[${k}:a]aresample=${DISGUISE_SR},aformat=sample_fmts=fltp:sample_rates=${DISGUISE_SR}:channel_layouts=stereo`;

      // Decide how to fit the clip to the slot.
      let fit = s.fitMode;
      if (fit === 'auto') {
        const overflow = slot > 0 ? A / slot : 1;
        fit = A > slot ? (overflow <= 1.15 ? 'speed' : 'trim') : 'none';
      }

      let offset = s.start;
      if (A > slot && fit === 'speed') {
        // Option-1: gently speed up (pitch-preserved) so it fits the slot exactly.
        const tempo = Math.min(2.0, Math.max(0.5, A / slot));
        chain += `,atempo=${tempo.toFixed(5)},apad=whole_dur=${slot.toFixed(3)},atrim=0:${slot.toFixed(3)}`;
        offset = s.start;
      } else if (A > slot && fit === 'trim') {
        chain += `,atrim=0:${slot.toFixed(3)}`;
        offset = s.start;
      } else {
        // Shorter than (or equal to) the slot — align to start or end.
        offset = s.align === 'end' ? Math.max(0, s.end - A) : s.start;
        // For replace-mode, never let it spill past the (un-muted) end of the slot.
        if (s.mode === 'replace' && A > slot) chain += `,atrim=0:${slot.toFixed(3)}`;
      }

      chain += ',asetpts=PTS-STARTPTS';
      const offMs = Math.round(offset * 1000);
      if (offMs > 0) chain += `,adelay=${offMs}|${offMs}`;
      parts.push(`${chain}[r${i}]`);
      labels.push(`[r${i}]`);
    });

    // Sum everything at full volume (normalize=0 ⇒ no auto-attenuation). The base
    // is muted wherever a replace clip plays, so the sum doesn't double up.
    parts.push(`${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest[outa]`);

    const filterPath = `${outputPath}.filter.txt`;
    await fs.writeFile(filterPath, parts.join(';'));
    const audioPath = `${outputPath}.audio.m4a`;
    console.log(`  [ReVoice] ${segs.length} segment(s), source ${hasAudio ? 'has audio' : 'is SILENT'} — audio-first then copy-mux`);

    // STEP 1 — build the new audio only (don't mux the big video yet → low memory).
    await this._runFfmpeg([
      '-y', ...inputs,
      '-filter_complex_script', filterPath,
      '-map', '[outa]',
      '-c:a', 'aac', '-ar', String(DISGUISE_SR), '-ac', '2', '-b:a', '320k',
      audioPath,
    ], { duration, onProgress, label: 'ReVoice audio' });

    // STEP 2 — copy-mux the original video with the new audio (fast, buffers nothing).
    await this._runFfmpeg([
      '-y', '-i', videoPath, '-i', audioPath,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '320k',
      '-movflags', '+faststart',
      outputPath,
    ], { label: 'ReVoice mux' });

    await fs.remove(audioPath).catch(() => {});
    await fs.remove(filterPath).catch(() => {});
    console.log('  [ReVoice] ✓ done');
    return outputPath;
  }

  /**
   * Orchestrate a full ReVoice render: restore the source, pull each recorded
   * clip down from R2, rebuild the audio with buildReVoicedSource, then publish
   * exactly like renderPodcastSequence (server copy now, durable R2 copy +
   * library entry once uploaded). Frontend polls GET /status/:jobId.
   *
   * segments: [{ startTime, endTime, audioUrl, align, mode, fitMode, audioDuration }]
   */
  async reVoiceRender(jobId, segments, options = {}) {
    const userId = options.userId || null;
    const list = Array.isArray(segments) ? segments.filter(s => s && s.audioUrl) : [];
    if (list.length === 0) throw new Error('No audio sections to replace.');

    const job = await this.ensureSourceAvailable(jobId, userId);
    const videoPath = job.videoPath;
    const videoTitle = job.videoTitle || 'video';
    const videoDuration = job.videoDuration || await this.getVideoDuration(videoPath).catch(() => 0);

    this.updateJob(jobId, {
      status: 'generating', step: 'revoice_preparing', progress: 4,
      currentClip: 'Preparing your audio…', generatedClips: [], error: null,
    });

    const workDir = path.join(this.tempDir, `manual-${jobId}`, 'revoice');
    await fs.ensureDir(workDir);

    // Pull each recorded clip down locally and confirm its duration.
    const prepared = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const ext = path.extname(s.audioUrl.split('?')[0]) || '.webm';
      const localPath = path.join(workDir, `aud_${i}${ext}`);
      await r2Service.downloadFile(s.audioUrl, localPath);
      const audioDuration = parseFloat(s.audioDuration) > 0
        ? parseFloat(s.audioDuration)
        : await this.getAudioDuration(localPath).catch(() => 0);
      prepared.push({
        start: s.startTime, end: s.endTime, localPath,
        align: s.align, mode: s.mode, fitMode: s.fitMode, audioDuration,
      });
    }

    this.updateJob(jobId, { step: 'revoice_rendering', progress: 15, currentClip: 'Replacing the audio…' });

    const hasAudio = await this.hasAudioStream(videoPath);
    const outputPath = path.join(workDir, `revoiced_${jobId}.mp4`);
    const built = await this.buildReVoicedSource(videoPath, prepared, videoDuration, hasAudio, outputPath, (pct) => {
      this.updateJob(jobId, { progress: Math.round(15 + (pct / 100) * 75) }); // 15 -> 90
    });
    if (!built) throw new Error('No audio sections to replace.');

    // ---- Publish (mirrors renderPodcastSequence's tail) ----
    const safeTitle = this.sanitizeFilename(videoTitle);
    const downloadName = `${safeTitle || 'revoiced'}.mp4`;
    const finalDuration = await this.getVideoDuration(outputPath).catch(() => videoDuration);
    const serverDownloadUrl = `${this.publicBaseUrl()}/api/manual-clip/download/${jobId}`;

    this.updateJob(jobId, {
      step: 'uploading', progress: 94,
      currentClip: 'Your video is ready — saving a cloud copy...',
      serverDownload: { path: outputPath, filename: downloadName },
      serverDownloadUrl,
    });

    const r2FileName = `manual-clips/${jobId}/revoiced_${safeTitle}.mp4`;
    let r2Url = null;
    try {
      const uploadResult = await r2Service.uploadFile(outputPath, r2FileName);
      r2Url = uploadResult.downloadUrl;
    } catch (err) {
      console.error(`[ReVoice ${jobId}] R2 upload failed, serving local copy:`, err.message);
    }

    const resultClip = {
      clipNumber: 1,
      title: `${videoTitle} — ReVoiced (${list.length} section${list.length !== 1 ? 's' : ''})`,
      isSequence: true,
      duration: finalDuration,
      durationFormatted: this.formatTime(finalDuration),
      downloadUrl: r2Url || serverDownloadUrl,
      serverDownloadUrl,
      hasCaptions: false,
    };

    this.updateJob(jobId, {
      status: 'complete', step: 'done', progress: 100,
      currentClip: '', generatedClips: [resultClip],
      completedAt: new Date().toISOString(),
    });
    console.log(`[ReVoice ${jobId}] ✓ ReVoice complete: ${resultClip.downloadUrl}`);

    if (r2Url) {
      try {
        let renderSize = 0;
        try { renderSize = (await fs.stat(outputPath)).size; } catch { /* best-effort */ }
        await manualVideoLibraryService.addRender(userId, {
          title: `${videoTitle} (ReVoiced)`,
          downloadUrl: r2Url,
          r2Key: r2FileName,
          fileSize: renderSize,
          duration: finalDuration,
          durationFormatted: this.formatTime(finalDuration),
          sourceJobId: jobId,
          createdAt: new Date().toISOString(),
        });
      } catch (libErr) {
        console.error(`[ReVoice ${jobId}] Could not save render to library:`, libErr.message);
      }
    }

    // Keep the final file briefly for in-flight server downloads, then drop it
    // (R2 holds the durable copy). Also free the pulled-down clips.
    this.scheduleServerCopyCleanup(jobId, outputPath);
    for (const p of prepared) { await fs.remove(p.localPath).catch(() => {}); }

    return resultClip;
  }

  // Run one ffmpeg invocation as a promise, with optional progress reporting.
  _runFfmpeg(args, { duration, onProgress, label = 'ffmpeg' } = {}) {
    return new Promise((resolve, reject) => {
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
        if (code === 0) resolve();
        else { console.error(`  [${label}] ${stderr.slice(-700)}`); reject(new Error(`${label} failed`)); }
      });
      proc.on('error', (err) => reject(err));
    });
  }

  /**
   * Render a short audio-only preview of one segment with a disguise preset
   * applied, so the user can hear it and pick a voice before rendering. Returns
   * a public MP3 URL (kept briefly on R2). Capped to a few seconds.
   */
  async voicePreview(jobId, { startTime, endTime, preset, level, userId } = {}) {
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
    // Leveling previews get a longer window — the listener needs to hear BOTH
    // speakers (quiet and loud) to judge the balance.
    const maxDur = level ? 20 : 8;
    const dur = Math.min(maxDur, rawDur > 0 ? rawDur : 6);

    const ratio = DISGUISE_PRESETS[preset]?.ratio;
    // Chain: disguise pitch first (if any), then leveling — same order as a render.
    const afParts = [];
    if (ratio) afParts.push(pitchFilterChain(ratio));
    if (level) afParts.push(LEVEL_AF);
    const af = afParts.join(',');
    const tag = `${preset || 'orig'}${level ? '_lvl' : ''}`;
    const workDir = path.join(this.tempDir, `manual-${jobId}`, 'preview');
    await fs.ensureDir(workDir);
    const outPath = path.join(workDir, `prev_${tag}_${Math.round(start)}.mp3`);

    await new Promise((resolve, reject) => {
      const args = [
        '-y',
        '-ss', String(start),
        '-t', String(dur),
        '-i', videoPath,
        '-vn',
        ...(af ? ['-af', af] : []),
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

    const key = `manual-clip/${jobId}/preview/${tag}_${Math.round(start)}_${Math.round(dur)}.mp3`;
    const up = await r2Service.uploadFile(outPath, key, 'audio/mpeg');
    // Clean the local copy soon; R2 keeps the short-lived preview.
    this.scheduleServerCopyCleanup(`${jobId}-prev`, outPath, 10 * 60 * 1000);
    return { url: up.downloadUrl, preset: preset || null, leveled: !!level, durationPreviewed: dur };
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
   * Free a job's heavy render intermediates after a FAILED render, so a crashed
   * render doesn't leave ~GBs of temp files behind to fill the ephemeral disk.
   */
  async cleanupRenderTemp(jobId) {
    const workDir = path.join(this.tempDir, `manual-${jobId}`);
    await fs.remove(path.join(workDir, 'sequence')).catch(() => {});
    await fs.remove(path.join(workDir, 'source.mp4')).catch(() => {});
    await fs.remove(path.join(workDir, 'sections')).catch(() => {});
    await fs.remove(path.join(workDir, 'desilence')).catch(() => {});
    // ➕ Add-clips-to-render uses its own temp dirs.
    await fs.remove(path.join(this.tempDir, `insert-${jobId}`)).catch(() => {});
    await fs.remove(path.join(this.tempDir, `insert-fetch-${jobId}`)).catch(() => {});
    console.log(`[ManualClip ${jobId}] Cleaned up render temp after failure`);
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
