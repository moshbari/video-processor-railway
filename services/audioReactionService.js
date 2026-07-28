/**
 * 🎙️ AUDIO REACTION SERVICE - FIXED V2
 * 
 * Creates "faceless" reaction videos where:
 * - Original video plays normally
 * - At reaction points, video FREEZES on last frame
 * - Audio reaction plays over the frozen frame
 * - Video continues after audio ends
 * 
 * Audio normalization ensures consistent volume levels
 * 
 * FIXED: Uses same clip loading logic as combine.js (r2Service.downloadSplitJob)
 */

const ffmpeg = require('fluent-ffmpeg');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const r2Service = require('./r2Service');
const voiceService = require('./voiceService');
const captionService = require('./captionService');
const usageService = require('./usageService');

// Store render progress for polling
const renderProgress = {};

// Store voiceover-generation progress for polling (separate from render progress)
const voiceoverProgress = {};

const TEMP_DIR = process.env.TEMP_DIR || '/app/temp';

// The finished Audio RANT is always a 1080x1920 vertical video at 30fps.
// EVERY segment (original clip + rant segment) is built to EXACTLY these
// settings in its own single-input pass, so the final join is a plain
// stitch — no giant multi-input filter graph. See concatenateSegments().
const FINAL_W = 1080;
const FINAL_H = 1920;
const FINAL_FPS = 30;
// Fit-inside-and-letterbox to the final frame, with a square pixel ratio.
// Identical for every segment => the segments are byte-for-byte compatible.
// out_range=tv matters for the rant segments: they are built from a JPEG still,
// which decodes as FULL-range, and a full-range segment spliced between
// limited-range clips shows up as a brightness/contrast jump at every reaction.
const STANDARD_VF = `scale=${FINAL_W}:${FINAL_H}:force_original_aspect_ratio=decrease:out_range=tv,pad=${FINAL_W}:${FINAL_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FINAL_FPS},format=yuv420p`;

class AudioReactionService {
  
  constructor() {
    this.tempDir = TEMP_DIR;
  }

  /**
   * Get current render progress
   */
  getProgress(jobId) {
    return renderProgress[jobId] || { status: 'unknown', progress: 0 };
  }

  /**
   * Update render progress
   */
  updateProgress(jobId, status, progress, message = '') {
    renderProgress[jobId] = { 
      status, 
      progress: Math.round(progress), 
      message,
      updatedAt: Date.now()
    };
    console.log(`[AudioReaction] Job ${jobId}: ${status} - ${Math.round(progress)}% ${message}`);
  }

  /**
   * Get video/audio duration using ffprobe
   */
  async getMediaDuration(filePath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          console.error('Error getting duration:', err);
          reject(err);
        } else {
          resolve(metadata.format.duration || 0);
        }
      });
    });
  }

  /**
   * Get the EXACT audio content duration by DECODING and counting samples.
   *
   * Why not `format.duration`? For VBR MP3 the header value is only an estimate
   * (often reads short) and for browser webm mic recordings it is frequently 0 —
   * so it can't be trusted to cap a reaction segment. Counting the actually
   * decoded samples (nb_read_samples / sample_rate) is exact for every format,
   * including webm. Returns 0 if it can't be determined (caller then skips the
   * cap and relies on `-shortest`).
   */
  async getAccurateAudioDuration(filePath) {
    return new Promise((resolve) => {
      const cmd = `ffprobe -v error -select_streams a:0 -count_samples -show_entries stream=nb_read_samples,sample_rate -of json "${filePath}"`;
      exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
        if (error) return resolve(0);
        try {
          const s = JSON.parse(stdout).streams?.[0] || {};
          const samples = parseInt(s.nb_read_samples, 10);
          const rate = parseInt(s.sample_rate, 10);
          if (Number.isFinite(samples) && Number.isFinite(rate) && rate > 0 && samples > 0) {
            return resolve(samples / rate);
          }
        } catch (_) { /* fall through */ }
        resolve(0);
      });
    });
  }

  /**
   * Get video dimensions
   */
  async getVideoDimensions(videoPath) {
    return new Promise((resolve) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          console.error('Probe error:', err.message);
          resolve({ width: 1080, height: 1920 });
          return;
        }
        const videoStream = metadata.streams.find(s => s.codec_type === 'video');
        if (videoStream) {
          resolve({
            width: videoStream.width || 1080,
            height: videoStream.height || 1920
          });
        } else {
          resolve({ width: 1080, height: 1920 });
        }
      });
    });
  }

  /**
   * EXACT SAME LOGIC AS combine.js - Ensure split clips are available
   * Checks local first, then restores from R2 if needed
   */
  async ensureSplitClipsAvailable(splitJobId) {
    const splitDir = path.join(this.tempDir, splitJobId, 'clips');
    
    console.log(`[AudioReaction] Checking local clips at: ${splitDir}`);
    
    // Check if clips exist locally
    if (await fs.pathExists(splitDir)) {
      const files = await fs.readdir(splitDir);
      const clips = files.filter(f => f.startsWith('clip_') && f.endsWith('.mp4'));
      if (clips.length > 0) {
        console.log(`[AudioReaction] ✅ Found ${clips.length} local clips`);
        return splitDir;
      }
    }
    
    console.log('[AudioReaction] Local clips not found, attempting to restore from R2...');
    
    // Check if R2 is configured
    if (!r2Service.isConfigured()) {
      throw new Error('Split job not found locally and R2 is not configured');
    }
    
    // Create job directory and download from R2
    const jobDir = path.join(this.tempDir, splitJobId);
    await fs.ensureDir(jobDir);
    
    try {
      await r2Service.downloadSplitJob(splitJobId, jobDir);
      console.log(`[AudioReaction] ✅ Restored clips from R2`);
      return path.join(jobDir, 'clips');
    } catch (err) {
      console.error(`[AudioReaction] ❌ R2 restore failed:`, err.message);
      throw new Error(`Split job not found. Clips may have been cleaned up. Please re-split the video.`);
    }
  }

  /**
   * Extract clip number from filename
   */
  extractClipNumber(filename) {
    const match = filename.match(/(\d+)/);
    if (match) {
      return parseInt(match[1], 10);
    }
    return null;
  }

  /**
   * Extract the last frame from a video clip as JPG image
   */
  async extractLastFrame(videoPath, outputPath) {
    return new Promise((resolve, reject) => {
      const cmd = `ffmpeg -y -sseof -0.5 -i "${videoPath}" -vframes 1 -q:v 2 "${outputPath}"`;
      exec(cmd, (error, stdout, stderr) => {
        if (error) {
          console.error('[AudioReaction] Extract frame error:', stderr);
          reject(error);
        } else {
          console.log('[AudioReaction] ✓ Last frame extracted');
          resolve(outputPath);
        }
      });
    });
  }

  /**
   * Measure the true integrated loudness of a file's audio (loudnorm pass 1).
   * Returns the measured values needed for an accurate two-pass normalization,
   * or null if the audio is silent/unmeasurable (caller then falls back to one-pass).
   */
  async measureLoudness(inputPath) {
    return new Promise((resolve) => {
      const cmd = `ffmpeg -hide_banner -i "${inputPath}" -af "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json" -f null -`;
      exec(cmd, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
        try {
          const output = stderr || '';
          // loudnorm prints its JSON report as the last { ... } block on stderr
          const start = output.lastIndexOf('{');
          const end = output.lastIndexOf('}');
          if (start === -1 || end === -1 || end < start) {
            console.warn('[AudioReaction] Loudness measure: no JSON found — falling back to one-pass');
            return resolve(null);
          }
          const json = JSON.parse(output.substring(start, end + 1));
          const measured = {
            input_i: parseFloat(json.input_i),
            input_tp: parseFloat(json.input_tp),
            input_lra: parseFloat(json.input_lra),
            input_thresh: parseFloat(json.input_thresh),
            target_offset: parseFloat(json.target_offset),
          };
          // -inf / NaN means silent or unmeasurable → use safe one-pass fallback
          if (!Number.isFinite(measured.input_i) || measured.input_i <= -70) {
            console.warn('[AudioReaction] Loudness measure silent/invalid — falling back to one-pass');
            return resolve(null);
          }
          console.log(`[AudioReaction] Measured loudness: ${measured.input_i} LUFS (${path.basename(inputPath)})`);
          resolve(measured);
        } catch (e) {
          console.warn('[AudioReaction] Loudness measure parse failed — falling back to one-pass:', e.message);
          resolve(null);
        }
      });
    });
  }

  /**
   * Build the loudnorm audio filter string.
   * With measurements → accurate linear two-pass normalization (everything lands at exactly -16 LUFS).
   * Without → the original one-pass behaviour (safe fallback for silent/odd clips).
   */
  buildLoudnormFilter(measured) {
    if (!measured) {
      return 'loudnorm=I=-16:TP=-1.5:LRA=11';
    }
    const offset = Number.isFinite(measured.target_offset) ? measured.target_offset : 0;
    return `loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${offset}:linear=true`;
  }

  /**
   * Create a frozen frame video with audio
   * The frozen frame that plays during audio reaction
   */
  async createFrozenFrameWithAudio(framePath, audioPath, outputPath, targetWidth, targetHeight) {
    // Pass 1: measure the rant audio so pass 2 hits -16 LUFS exactly
    const measured = await this.measureLoudness(audioPath);
    const afilter = this.buildLoudnormFilter(measured);
    return new Promise(async (resolve, reject) => {
      try {
        // Use the DECODE-accurate content duration (not the ffprobe estimate) to
        // cap the segment. This is the fix for "the frame freezes for a couple of
        // seconds after every reaction": `loudnorm` flushes its internal true-peak
        // limiter lookahead at end-of-stream as ~1.5–2s of extra SILENT samples,
        // which `-shortest` would otherwise include — adding dead, frozen video to
        // every reaction. Capping the output at the real spoken length drops that
        // flushed silence. (`apad` used to sit after loudnorm and made this worse.)
        const accurate = await this.getAccurateAudioDuration(audioPath);
        const audioDuration = accurate > 0 ? accurate : await this.getMediaDuration(audioPath);
        // Small tail so frame-boundary rounding can never clip the last word.
        const HOLD = 0.15;
        // Only cap when we trust the length (>0). If it is unknown (0), fall back
        // to `-shortest` alone so we never produce an empty/truncated reaction.
        const capArg = audioDuration > 0 ? `-t ${(audioDuration + HOLD).toFixed(3)}` : '';
        console.log(`[AudioReaction] Creating frozen frame video (${audioDuration.toFixed(2)}s ${accurate > 0 ? 'exact' : 'estimated'}${capArg ? `, capped +${HOLD}s` : ', -shortest'}) with normalized audio (${measured ? 'two-pass' : 'one-pass fallback'})...`);

        const cmd = `ffmpeg -y -loop 1 -i "${framePath}" -i "${audioPath}" -vf "${STANDARD_VF}" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -ar 44100 -ac 2 -af "${afilter}" ${capArg} -shortest -pix_fmt yuv420p -color_range tv "${outputPath}"`;

        exec(cmd, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
          if (error) {
            console.error('[AudioReaction] Frozen frame creation error:', stderr ? stderr.substring(stderr.length - 500) : error.message);
            reject(error);
          } else {
            console.log(`[AudioReaction] ✓ Frozen frame with audio created (${audioDuration.toFixed(2)}s)`);
            resolve(outputPath);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Normalize audio in original video clips for consistent levels
   */
  async normalizeVideoClip(inputPath, outputPath) {
    // Pass 1: measure the clip's true loudness so pass 2 hits -16 LUFS exactly
    const measured = await this.measureLoudness(inputPath);
    const afilter = this.buildLoudnormFilter(measured);
    return new Promise((resolve, reject) => {
      console.log(`[AudioReaction] Normalizing clip (${measured ? 'two-pass' : 'one-pass fallback'}): ${path.basename(inputPath)}`);

      const cmd = `ffmpeg -y -i "${inputPath}" -vf "${STANDARD_VF}" -c:v libx264 -preset fast -crf 23 -r ${FINAL_FPS} -c:a aac -b:a 192k -ar 44100 -ac 2 -af "${afilter}" -pix_fmt yuv420p "${outputPath}"`;

      exec(cmd, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          console.error('[AudioReaction] Normalization error:', stderr ? stderr.substring(stderr.length - 300) : error.message);
          reject(error);
        } else {
          console.log(`[AudioReaction] ✓ Clip normalized`);
          resolve(outputPath);
        }
      });
    });
  }

  /**
   * Join all finished segments into the final video.
   *
   * This used to open EVERY segment at once as a separate FFmpeg input and
   * scale/pad each one inside one huge filter_complex. That graph grows with
   * the number of reactions, and past ~13 inputs FFmpeg (5.1, as shipped in
   * the container) fails while it is still WIRING the graph up:
   *
   *   [Parsed_scale_65] Failed to configure output pad on Parsed_scale_65
   *   Error reinitializing filters!  ->  "FFmpeg concat failed with code 1"
   *
   * A 4-, 5- or 6-reaction rant rendered fine; an 8-reaction rant (17 inputs)
   * failed every single time, at the same place. So the join is now the
   * concat DEMUXER: it opens ONE segment at a time, which means the cost is
   * flat no matter how many reactions there are. That is safe here because
   * every segment was already built to identical settings (STANDARD_VF +
   * 44100Hz stereo) by normalizeVideoClip() / createFrozenFrameWithAudio().
   */
  async concatenateSegments(segments, outputPath, jobId) {
    console.log(`[AudioReaction] Joining ${segments.length} segments (one at a time)...`);
    segments.forEach((s, i) => console.log(`  [${i}] ${path.basename(s)}`));

    // Concat-demuxer list file. Paths are ours (temp dir, no quotes in names),
    // but escape single quotes anyway so an odd filename can never break it.
    const listPath = path.join(path.dirname(outputPath), 'concat_list.txt');
    const listBody = segments
      .map(s => `file '${path.resolve(s).replace(/'/g, "'\\''")}'`)
      .join('\n');
    await fs.writeFile(listPath, listBody + '\n');

    return new Promise((resolve, reject) => {
      const args = [
        '-y',
        '-f', 'concat',
        '-safe', '0',
        '-i', listPath,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-r', String(FINAL_FPS),
        '-c:a', 'aac',
        '-b:a', '192k',
        '-ar', '44100',
        '-ac', '2',
        '-movflags', '+faststart',
        outputPath
      ];

      const ffmpegProcess = spawn('ffmpeg', args);

      let stderrOutput = '';

      ffmpegProcess.stderr.on('data', (data) => {
        const str = data.toString();
        stderrOutput += str;
        if (stderrOutput.length > 20000) stderrOutput = stderrOutput.slice(-10000);
        const timeMatch = str.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
        if (timeMatch) {
          this.updateProgress(jobId, 'rendering', 80, `Joining: ${timeMatch[1]}`);
        }
      });

      ffmpegProcess.on('close', async (code) => {
        await fs.remove(listPath).catch(() => {});
        if (code === 0) {
          console.log('[AudioReaction] ✓ Join complete');
          resolve(outputPath);
        } else {
          const lastLines = stderrOutput.split('\n').slice(-15).join('\n');
          console.error(`[AudioReaction] FFmpeg join failed:\n${lastLines}`);
          reject(new Error(`FFmpeg concat failed with code ${code}`));
        }
      });

      ffmpegProcess.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Build ONE "rant" segment: freeze on the given clip's last frame and play the
   * reaction audio over it (optionally with burned captions).
   * Returns the path to the finished segment, ready to be concatenated.
   * Extracted so both the normal per-clip path AND the safety-net append path
   * (for reactions whose clipIndex has no matching clip) use identical logic.
   */
  async buildRantSegment(sourceClipPath, reaction, workDir, label, targetWidth, targetHeight, captionsEnabled, captionStyle) {
    // Freeze on the last frame of the source clip
    const framePath = path.join(workDir, `frame_${label}.jpg`);
    await this.extractLastFrame(sourceClipPath, framePath);

    // Frozen frame + reaction audio (duration auto-matched to the audio)
    const frozenWithAudioPath = path.join(workDir, `frozen_audio_${label}.mp4`);
    await this.createFrozenFrameWithAudio(framePath, reaction.audioPath, frozenWithAudioPath, targetWidth, targetHeight);

    // OPTIONAL: burn captions onto this rant section ONLY (never on original clips)
    let finalRantPath = frozenWithAudioPath;
    if (captionsEnabled) {
      const captionedRantPath = path.join(workDir, `frozen_audio_${label}_captioned.mp4`);
      try {
        await captionService.addCaptionsToVideo(
          frozenWithAudioPath,
          captionedRantPath,
          captionStyle,
          { width: targetWidth, height: targetHeight }
        );
        finalRantPath = captionedRantPath;
        console.log(`[AudioReaction] ✓ Captions added to rant ${label}`);
        await fs.remove(frozenWithAudioPath).catch(() => {});
      } catch (capErr) {
        console.error(`[AudioReaction] ⚠ Caption burn failed for rant ${label}, using uncaptioned version:`, capErr.message);
        finalRantPath = frozenWithAudioPath;
      }
    }

    // Clean up the frame image
    await fs.remove(framePath).catch(() => {});
    return finalRantPath;
  }

  /**
   * MAIN FUNCTION: Combine clips with audio reactions
   * @param {string} jobId - Split job ID
   * @param {Array} audioReactions - Array of { clipIndex, audioPath }
   * @param {Object} options - Optional rendering options
   * @param {boolean} options.captions - Burn captions onto rant sections (default false)
   * @param {string} options.captionStyle - One of the 8 caption style names (default 'boldPop')
   */
  async combineClipsWithAudioReactions(jobId, audioReactions, options = {}) {
    const captionsEnabled = options.captions === true;
    const requestedStyle = options.captionStyle || 'boldPop';
    const captionStyle = captionService.isValidStyle(requestedStyle) ? requestedStyle : 'boldPop';

    const workDir = path.join(this.tempDir, jobId, 'audio_render');
    await fs.ensureDir(workDir);
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[AudioReaction] 🎙️ Starting Audio-Only RANT render`);
    console.log(`[AudioReaction] Job ID: ${jobId}`);
    console.log(`[AudioReaction] Audio reactions: ${audioReactions.length}`);
    console.log(`[AudioReaction] Captions: ${captionsEnabled ? `✅ ON (${captionStyle})` : '❌ OFF'}`);
    console.log(`${'='.repeat(60)}\n`);
    
    this.updateProgress(jobId, 'starting', 0, 'Initializing...');
    
    try {
      // Step 1: Load clips using SAME LOGIC as combine.js
      this.updateProgress(jobId, 'loading', 5, 'Loading split clips...');
      
      const splitDir = await this.ensureSplitClipsAvailable(jobId);
      
      // Get clip files sorted by number
      const files = await fs.readdir(splitDir);
      const clipFiles = files
        .filter(f => f.startsWith('clip_') && f.endsWith('.mp4'))
        .sort((a, b) => {
          const numA = this.extractClipNumber(a) || 0;
          const numB = this.extractClipNumber(b) || 0;
          return numA - numB;
        });
      
      if (clipFiles.length === 0) {
        throw new Error('No clips found in split job');
      }
      
      const clipPaths = clipFiles.map(f => path.join(splitDir, f));
      console.log(`[AudioReaction] ✅ Found ${clipPaths.length} clips`);
      
      this.updateProgress(jobId, 'loading', 20, `Found ${clipPaths.length} clips`);
      
      // Every segment is built straight to the FINAL frame (1080x1920). The
      // old code built segments at the source size and let the final join
      // resize them — that meant two resizes, and captions were sized for the
      // source frame and then shrunk with it.
      const dimensions = await this.getVideoDimensions(clipPaths[0]);
      const targetWidth = FINAL_W;
      const targetHeight = FINAL_H;
      console.log(`[AudioReaction] Source ${dimensions.width}x${dimensions.height} → final ${targetWidth}x${targetHeight}`);
      
      // Step 2: Create map of which clips have audio reactions.
      // Group by clipIndex into ARRAYS (not a single value) so that if two
      // reactions ever resolve to the same clip they BOTH play instead of one
      // silently overwriting the other.
      const reactionMap = {};
      for (const reaction of audioReactions) {
        const idx = parseInt(reaction.clipIndex, 10);
        if (!Number.isFinite(idx)) {
          console.warn(`[AudioReaction] ⚠ Reaction has invalid clipIndex (${reaction.clipIndex}) — will be appended at the end so it is not lost`);
          continue; // handled by the safety-net append below
        }
        if (!reactionMap[idx]) reactionMap[idx] = [];
        reactionMap[idx].push(reaction);
        console.log(`[AudioReaction] Reaction mapped: clip ${idx} → ${path.basename(reaction.audioPath)}`);
      }

      // Track which clipIndexes actually got a matching clip on disk, so we can
      // detect (and rescue) any reaction whose clipIndex has no clip — the root
      // cause of "the last reaction is missing" when the splitter dropped a
      // sub-0.5s segment and the clip count fell below the reaction count.
      const placedClipIndexes = new Set();

      // Step 3: Build all segments
      this.updateProgress(jobId, 'processing', 25, 'Processing clips...');

      const allSegments = [];
      const totalClips = clipPaths.length;
      let lastNormalizedClipPath = null;

      for (let i = 0; i < totalClips; i++) {
        const clipPath = clipPaths[i];
        const clipIndex = i + 1;  // 1-based index

        console.log(`\n[AudioReaction] Processing clip ${clipIndex}/${totalClips}...`);

        // Normalize the original clip's audio
        const normalizedClipPath = path.join(workDir, `clip_${clipIndex}_normalized.mp4`);
        await this.normalizeVideoClip(clipPath, normalizedClipPath);
        allSegments.push(normalizedClipPath);
        lastNormalizedClipPath = normalizedClipPath;

        // Add every audio reaction attached to this clip (usually 0 or 1)
        const clipReactions = reactionMap[clipIndex] || [];
        for (let r = 0; r < clipReactions.length; r++) {
          const reaction = clipReactions[r];
          console.log(`[AudioReaction] 🎙️ Adding audio reaction after clip ${clipIndex}`);
          if (captionsEnabled) {
            this.updateProgress(jobId, 'processing', 25 + ((i + 0.5) / totalClips) * 45, `Adding captions to rant ${clipIndex}/${totalClips}...`);
          }
          const label = clipReactions.length > 1 ? `${clipIndex}_${r + 1}` : `${clipIndex}`;
          const finalRantPath = await this.buildRantSegment(
            normalizedClipPath, reaction, workDir, label,
            targetWidth, targetHeight, captionsEnabled, captionStyle
          );
          allSegments.push(finalRantPath);
        }
        if (clipReactions.length) placedClipIndexes.add(clipIndex);

        const progress = 25 + ((i + 1) / totalClips) * 45;
        this.updateProgress(jobId, 'processing', progress, `Processed clip ${clipIndex}/${totalClips}`);
      }

      // SAFETY NET: any reaction whose clipIndex never matched a clip on disk
      // (out of range, or invalid) would previously be dropped SILENTLY. Instead,
      // freeze on the last real clip's final frame and append these at the very
      // end so the reaction always makes it into the video (and we log loudly).
      const unplaced = audioReactions
        .filter(r => !placedClipIndexes.has(parseInt(r.clipIndex, 10)))
        .sort((a, b) => (parseInt(a.clipIndex, 10) || 0) - (parseInt(b.clipIndex, 10) || 0));
      if (unplaced.length && lastNormalizedClipPath) {
        console.warn(`[AudioReaction] ⚠️ ${unplaced.length} reaction(s) had no matching clip (clipIndex out of range for ${totalClips} clips): [${unplaced.map(r => r.clipIndex).join(', ')}] — appending them at the end so none are lost`);
        for (let u = 0; u < unplaced.length; u++) {
          const reaction = unplaced[u];
          const finalRantPath = await this.buildRantSegment(
            lastNormalizedClipPath, reaction, workDir, `overflow_${u + 1}`,
            targetWidth, targetHeight, captionsEnabled, captionStyle
          );
          allSegments.push(finalRantPath);
        }
      }

      // Step 4: Concatenate all segments
      this.updateProgress(jobId, 'rendering', 70, 'Creating final video...');
      
      // Generate output filename
      const now = new Date();
      const gmt4Offset = 4 * 60 * 60 * 1000;
      const gmt4Date = new Date(now.getTime() + gmt4Offset);
      const timestamp = gmt4Date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      
      const firstReactionText = audioReactions[0]?.text || 'audio';
      const shortText = firstReactionText.substring(0, 3).replace(/[^a-zA-Z0-9]/g, '').toUpperCase() || 'AUD';
      const outputFilename = `AUDIO_${shortText}_${timestamp}.mp4`;
      const outputPath = path.join(workDir, outputFilename);
      
      await this.concatenateSegments(allSegments, outputPath, jobId);
      
      // Step 5: Upload to R2
      this.updateProgress(jobId, 'uploading', 90, 'Uploading to cloud...');
      
      const r2Key = `renders/${jobId}/${outputFilename}`;
      
      // IMPORTANT: r2Service.uploadFile expects (localFilePath, r2Key, contentType)
      const uploadResult = await r2Service.uploadFile(outputPath, r2Key, 'video/mp4');
      
      const downloadUrl = uploadResult.downloadUrl || await r2Service.getSignedUrl(r2Key, 7 * 24 * 60 * 60);
      
      console.log(`[AudioReaction] ✅ Uploaded to R2: ${r2Key}`);
      
      // Done!
      this.updateProgress(jobId, 'complete', 100, 'Done!');
      
      // Store download URL in progress for frontend to access
      renderProgress[jobId].downloadUrl = downloadUrl;
      renderProgress[jobId].filename = outputFilename;
      
      console.log(`\n${'='.repeat(60)}`);
      console.log(`[AudioReaction] 🎉 AUDIO-ONLY RANT COMPLETE!`);
      console.log(`[AudioReaction] Filename: ${outputFilename}`);
      console.log(`${'='.repeat(60)}\n`);
      
      return {
        success: true,
        jobId,
        filename: outputFilename,
        downloadUrl,
        segments: allSegments.length
      };
      
    } catch (error) {
      console.error(`[AudioReaction] ❌ Render failed:`, error);
      this.updateProgress(jobId, 'error', 0, error.message);
      throw error;
    }
  }

  /**
   * Upload audio reaction file to server
   */
  async uploadAudioReaction(jobId, clipIndex, audioBuffer, originalFilename) {
    const workDir = path.join(this.tempDir, jobId, 'audio_reactions');
    await fs.ensureDir(workDir);
    
    const ext = path.extname(originalFilename) || '.mp3';
    const audioPath = path.join(workDir, `reaction_${clipIndex}${ext}`);
    
    await fs.writeFile(audioPath, audioBuffer);
    console.log(`[AudioReaction] ✅ Audio reaction ${clipIndex} saved: ${audioPath}`);
    
    return audioPath;
  }

  // ===========================================================================
  // VOICEOVER GENERATION (NEW - April 2026)
  // ===========================================================================
  // Generates audio from reaction scripts using OpenAI TTS or 11Labs,
  // saves locally + uploads to R2, and returns data ready for /render.
  // Eliminates the manual external-audio-creation step from the user flow.

  /**
   * Get current voiceover-generation progress
   */
  getVoiceoverProgress(jobId) {
    return voiceoverProgress[jobId] || { status: 'unknown', progress: 0 };
  }

  /**
   * Update voiceover-generation progress
   */
  updateVoiceoverProgress(jobId, status, progress, message = '', extra = {}) {
    voiceoverProgress[jobId] = {
      status,
      progress: Math.round(progress),
      message,
      updatedAt: Date.now(),
      ...extra
    };
    console.log(`[Voiceover] Job ${jobId}: ${status} - ${Math.round(progress)}% ${message}`);
  }

  /**
   * MAIN FUNCTION: Generate voiceovers for all reaction scripts
   *
   * For each reaction: calls TTS, saves locally (so existing /render flow
   * works unchanged), and ALSO uploads to R2 as a backup (in case Railway
   * restarts before user clicks Render).
   *
   * @param {string} jobId - the split job ID (same as the Audio RANT session)
   * @param {string} provider - 'openai' (default) or 'elevenlabs'
   * @param {Array} reactions - [{ clipIndex, text, timestamp? }]
   * @param {string|null} voice - optional voice override (for OpenAI: 'nova', 'onyx', etc.; for 11Labs: a voice ID). Null = use provider default.
   * @returns {object} { success, jobId, provider, voice, reactions: [...], totalGenerated, totalFailed }
   */
  async generateVoiceoversForJob(jobId, provider, reactions, voice = null, userId = null, email = null) {
    const workDir = path.join(this.tempDir, jobId, 'audio_reactions');
    await fs.ensureDir(workDir);

    const total = reactions.length;
    const normalizedProvider = (provider || 'openai').toLowerCase();
    // Tally characters actually turned into speech so we can attribute the AI
    // voiceover (TTS) cost to this user (see usageService).
    let billedChars = 0;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Voiceover] 🎙️ Generating ${total} voiceovers (${normalizedProvider}, voice=${voice || 'default'})`);
    console.log(`[Voiceover] Job: ${jobId}`);
    console.log(`${'='.repeat(60)}\n`);

    this.updateVoiceoverProgress(jobId, 'starting', 0, `Generating ${total} voiceovers with ${normalizedProvider}...`);

    // Build options object passed to voiceService.generateVoice()
    // - For OpenAI, the field name is `voice`
    // - For 11Labs, the field name is `voiceId`
    const ttsOptions = {};
    if (voice) {
      if (normalizedProvider === 'openai') {
        ttsOptions.voice = voice;
      } else if (normalizedProvider === 'elevenlabs' || normalizedProvider === '11labs') {
        ttsOptions.voiceId = voice;
      }
    }

    const results = [];

    for (let i = 0; i < total; i++) {
      const reaction = reactions[i];
      const clipIndex = parseInt(reaction.clipIndex, 10);
      const text = (reaction.text || '').trim();

      const baseProgress = 5 + (i / total) * 85;

      try {
        if (!clipIndex || isNaN(clipIndex)) {
          throw new Error(`Invalid clipIndex: ${reaction.clipIndex}`);
        }
        if (!text) {
          throw new Error('Reaction text is empty');
        }

        this.updateVoiceoverProgress(
          jobId,
          'generating',
          baseProgress,
          `Generating voiceover ${i + 1} of ${total}...`
        );

        // 1. Call TTS (with optional voice override)
        const audioBuffer = await voiceService.generateVoice(normalizedProvider, text, ttsOptions);

        // 2. Save locally (matches the path structure used by manual upload)
        const localFilename = `reaction_${clipIndex}.mp3`;
        const localPath = path.join(workDir, localFilename);
        await fs.writeFile(localPath, audioBuffer);
        console.log(`[Voiceover] ✓ Saved locally: ${localPath}`);

        // 3. Upload to R2 as backup (so it survives Railway restarts)
        let audioR2Url = null;
        try {
          if (r2Service.isConfigured()) {
            const r2Key = `audio-reactions/${jobId}/${localFilename}`;
            const uploadResult = await r2Service.uploadBuffer(audioBuffer, r2Key, 'audio/mpeg');
            audioR2Url = uploadResult.downloadUrl || r2Service.getPublicUrl(r2Key);
            console.log(`[Voiceover] ✓ Uploaded to R2: ${r2Key}`);
          } else {
            console.log(`[Voiceover] ⚠ R2 not configured, skipping cloud backup`);
          }
        } catch (r2Err) {
          // R2 upload failure is non-fatal — local file is still good for immediate render
          console.warn(`[Voiceover] ⚠ R2 upload failed (non-fatal): ${r2Err.message}`);
        }

        billedChars += text.length;

        results.push({
          clipIndex,
          text,
          timestamp: reaction.timestamp || null,
          audioPath: localPath,
          audioR2Url,
          success: true
        });

      } catch (err) {
        console.error(`[Voiceover] ❌ Failed for clip ${clipIndex}: ${err.message}`);
        results.push({
          clipIndex,
          text,
          timestamp: reaction.timestamp || null,
          audioPath: null,
          audioR2Url: null,
          success: false,
          error: err.message
        });
      }
    }

    const totalGenerated = results.filter(r => r.success).length;
    const totalFailed = results.filter(r => !r.success).length;

    const finalStatus = totalFailed === 0 ? 'complete' : (totalGenerated === 0 ? 'error' : 'complete_with_errors');
    const finalMessage = totalFailed === 0
      ? `All ${totalGenerated} voiceovers ready`
      : `${totalGenerated} of ${total} voiceovers ready (${totalFailed} failed)`;

    // Record the AI voiceover spend for this user (non-fatal — never blocks).
    if (billedChars > 0) {
      usageService.record({
        userId, email, feature: 'audio-rant',
        provider: normalizedProvider === '11labs' ? 'elevenlabs' : normalizedProvider,
        model: voice || 'default',
        characters: billedChars,
        meta: { jobId, voiceovers: totalGenerated, voice: voice || null },
      });
    }

    this.updateVoiceoverProgress(jobId, finalStatus, 100, finalMessage, {
      reactions: results,
      totalGenerated,
      totalFailed,
      provider: normalizedProvider,
      voice: voice || null
    });

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[Voiceover] 🎉 ${finalMessage}`);
    console.log(`${'='.repeat(60)}\n`);

    return {
      success: totalGenerated > 0,
      jobId,
      provider: normalizedProvider,
      voice: voice || null,
      reactions: results,
      totalGenerated,
      totalFailed
    };
  }
}

module.exports = new AudioReactionService();
