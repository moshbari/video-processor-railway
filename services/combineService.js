const ffmpeg = require('fluent-ffmpeg');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const r2Service = require('./r2Service');

// Store render progress for each job
const renderProgress = new Map();

class CombineService {
  constructor() {
    this.tempDir = '/app/temp';
  }

  // Progress tracking methods
  getProgress(jobId) {
    return renderProgress.get(jobId) || { status: 'unknown', progress: 0 };
  }

  updateProgress(progressMap, jobId, status, progress, downloadUrl = null) {
    const progressData = { status, progress: Math.round(progress), downloadUrl };
    progressMap.set(jobId, progressData);
    console.log(`[Progress] Job ${jobId}: ${status} - ${Math.round(progress)}%`);
  }

  generateFilename(mode, reactions) {
    const modePrefix = mode === 'pip' ? 'PIP' : 'SEQ';
    let textPart = 'Vid';
    if (reactions && reactions.length > 0) {
      const firstReaction = reactions[0];
      if (firstReaction && firstReaction.text) {
        const words = firstReaction.text.replace(/[^a-zA-Z\s]/g, '').trim().split(/\s+/);
        if (words.length > 0 && words[0].length > 0) {
          textPart = words[0].substring(0, 3);
          textPart = textPart.charAt(0).toUpperCase() + textPart.slice(1).toLowerCase();
        }
      }
    }
    const now = new Date();
    const gmt4 = new Date(now.getTime() + (4 * 60 * 60 * 1000));
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = gmt4.getUTCDate().toString().padStart(2, '0');
    const month = months[gmt4.getUTCMonth()];
    const year = gmt4.getUTCFullYear().toString().slice(-2);
    let hours = gmt4.getUTCHours();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    const minutes = gmt4.getUTCMinutes().toString().padStart(2, '0');
    const seconds = gmt4.getUTCSeconds().toString().padStart(2, '0');
    const timeStr = `${hours.toString().padStart(2, '0')}${minutes}${seconds}${ampm}`;
    const filename = `${modePrefix}-${textPart}-${month}${year}-${timeStr}.mp4`;
    console.log(`Generated filename: ${filename}`);
    return filename;
  }

  async combineFromSplit(jobId, reactions, mode = 'sequential', pipPosition = 'top-right') {
    const workDir = path.join(this.tempDir, jobId);
    const clipsDir = path.join(workDir, 'clips');

    // Update progress: starting
    const newJobId = uuidv4();
    this.updateProgress(renderProgress, newJobId, 'starting', 0);

    try {
      // Try to restore from R2 if local files don't exist
      if (!await fs.pathExists(clipsDir)) {
        console.log('Local clips not found, attempting to restore from R2...');
        await fs.ensureDir(clipsDir);

        try {
          const manifestKey = `${jobId}/manifest.json`;
          const manifestContent = await r2Service.downloadFile(manifestKey);
          const manifest = JSON.parse(manifestContent.toString());

          for (const clip of manifest.clips) {
            const clipKey = `${jobId}/${clip.filename}`;
            const clipPath = path.join(clipsDir, clip.filename);
            console.log(`Downloading clip from R2: ${clipKey}`);
            const clipContent = await r2Service.downloadFile(clipKey);
            await fs.writeFile(clipPath, clipContent);
          }
          console.log('Successfully restored clips from R2');
        } catch (r2Error) {
          console.error('Failed to restore from R2:', r2Error.message);
          throw new Error('Split job not found. Clips may have been cleaned up. Please re-split the video.');
        }
      }

      // Read manifest
      const manifestPath = path.join(workDir, 'manifest.json');
      if (!await fs.pathExists(manifestPath)) {
        const manifestKey = `${jobId}/manifest.json`;
        try {
          const manifestContent = await r2Service.downloadFile(manifestKey);
          await fs.writeFile(manifestPath, manifestContent);
        } catch (e) {
          throw new Error('Manifest not found locally or in R2');
        }
      }

      const manifest = await fs.readJson(manifestPath);
      const originalClips = manifest.clips.map(c => path.join(clipsDir, c.filename));

      // Start background render
      this.renderInBackground(newJobId, workDir, originalClips, reactions, mode, pipPosition);

      return {
        jobId: newJobId,
        status: 'processing',
        message: 'Render started in background. Poll /api/combine/progress/:jobId for status.'
      };

    } catch (error) {
      console.error('Combine from split error:', error);
      this.updateProgress(renderProgress, newJobId, 'error', 0);
      throw error;
    }
  }

  async renderInBackground(jobId, workDir, originalClips, reactions, mode, pipPosition) {
    try {
      console.log(`\n[Background] Starting render job ${jobId}`);
      console.log(`  Mode: ${mode}`);
      console.log(`  Original clips: ${originalClips.length}`);
      console.log(`  Reactions: ${reactions.filter(r => r).length}`);

      this.updateProgress(renderProgress, jobId, 'preparing', 5);

      const processedClips = [];
      const totalSteps = originalClips.length * 2;
      let completedSteps = 0;

      // Get target dimensions from first clip
      const probePath = originalClips[0];
      const dimensions = await this.getVideoDimensions(probePath);
      const targetWidth = dimensions.width || 1080;
      const targetHeight = dimensions.height || 1920;

      console.log(`\nTarget dimensions: ${targetWidth}x${targetHeight}`);

      // Process each original clip with its reaction
      for (let i = 0; i < originalClips.length; i++) {
        const originalPath = originalClips[i];
        const reactionData = reactions[i];

        console.log(`\nProcessing pair ${i + 1}/${originalClips.length}`);
        console.log(`  Original: ${path.basename(originalPath)}`);
        console.log(`  Reaction: ${reactionData ? 'provided' : 'NONE'}`);

        // Add original clip (already 30fps from split)
        processedClips.push(originalPath);

        completedSteps++;
        const progressPercent = (completedSteps / totalSteps) * 80;
        this.updateProgress(renderProgress, jobId, 'rendering', progressPercent);

        if (reactionData) {
          // Save reaction video from base64
          const reactionPath = path.join(workDir, `reaction_${i}.mp4`);
          const base64Data = reactionData.replace(/^data:video\/\w+;base64,/, '');
          await fs.writeFile(reactionPath, Buffer.from(base64Data, 'base64'));

          if (mode === 'pip') {
            // PiP mode: create overlay segment
            const pipOutputPath = path.join(workDir, `pip_${i}.mp4`);
            console.log(`Creating PiP segment (position: ${pipPosition})...`);
            await this.createPipSegment(originalPath, reactionPath, pipOutputPath, targetWidth, targetHeight, pipPosition);
            processedClips.push(pipOutputPath);
          } else {
            // SEQUENTIAL MODE: Standardize reaction clip to 30fps BEFORE concatenation
            const standardizedPath = path.join(workDir, `standardized_reaction_${i}.mp4`);
            console.log(`Standardizing reaction clip to 30fps...`);
            await this.standardizeClipTo30fps(reactionPath, standardizedPath);
            processedClips.push(standardizedPath);
          }

          completedSteps++;
          const progressPercent = (completedSteps / totalSteps) * 80;
          this.updateProgress(renderProgress, jobId, 'rendering', progressPercent);
        }
      }

      // Concatenate all processed clips
      this.updateProgress(renderProgress, jobId, 'concatenating', 85);
      const concatFilePath = path.join(workDir, 'concat_list.txt');
      const concatContent = processedClips.map(p => `file '${p}'`).join('\n');
      await fs.writeFile(concatFilePath, concatContent);

      const outputFilename = this.generateFilename(mode, reactions);
      const outputPath = path.join(workDir, outputFilename);

      console.log(`\nConcatenating ${processedClips.length} clips...`);
      await this.concatenateClips(concatFilePath, outputPath, jobId);

      // Upload to R2
      this.updateProgress(renderProgress, jobId, 'uploading to R2', 95);
      const stats = await fs.stat(outputPath);
      console.log(`\n✓ FINAL VIDEO: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

      const r2Key = `combined/${outputFilename}`;
      console.log(`Uploading to R2: ${r2Key}`);
      const downloadUrl = await r2Service.uploadFile(outputPath, r2Key);
      console.log(`✓ Uploaded to R2: ${downloadUrl}`);

      // Mark as complete
      this.updateProgress(renderProgress, jobId, 'complete', 100, downloadUrl);
      console.log(`\n[Background] ✓ Render complete for job ${jobId}`);
      console.log(`[Background] R2 Link: ${downloadUrl}`);

      return { downloadUrl, outputPath };

    } catch (error) {
      console.error(`[Background] ✗ Render failed for job ${jobId}:`, error);
      this.updateProgress(renderProgress, jobId, 'error', 0);
      throw error;
    }
  }

  // ==========================================
  // KEY FIX: Standardize reaction clips to 30fps
  // This prevents the fast-forward issue!
  // ==========================================
  async standardizeClipTo30fps(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      console.log(`  Standardizing: ${path.basename(inputPath)} -> ${path.basename(outputPath)}`);
      
      ffmpeg(inputPath)
        .outputOptions([
          '-r', '30',              // Output at 30fps
          '-vsync', 'cfr',         // CONSTANT frame rate - KEY FIX!
          '-c:v', 'libx264',       // Re-encode video
          '-preset', 'fast',       // Balance speed/quality
          '-crf', '23',            // Quality setting
          '-c:a', 'aac',           // Re-encode audio
          '-ar', '44100',          // Standard audio sample rate
          '-b:a', '128k',          // Audio bitrate
          '-y'                     // Overwrite output
        ])
        .on('start', cmd => console.log(`  Standardize cmd: ffmpeg -i input ${cmd.split(' ').slice(-10).join(' ')}`))
        .on('progress', p => {
          if (p.percent) console.log(`    Standardizing: ${Math.round(p.percent)}%`);
        })
        .on('end', () => {
          console.log(`  ✓ Standardized to 30fps: ${path.basename(outputPath)}`);
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error(`  ✗ Standardize failed:`, err.message);
          reject(err);
        })
        .save(outputPath);
    });
  }

  // ==========================================
  // FIXED: Concatenation with proper frame rate handling
  // ==========================================
  async concatenateClips(concatFilePath, outputPath, jobId) {
    return new Promise((resolve, reject) => {
      console.log(`  Running: ffmpeg -y -f concat -safe 0...`);
      
      // Use filter_complex for both video fps AND audio normalization together
      const filterComplex = '[0:v]fps=30[v];[0:a]loudnorm=I=-16:TP=-1.5:LRA=11[a]';
      
      ffmpeg()
        .input(concatFilePath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .complexFilter(filterComplex, ['v', 'a'])
        .outputOptions([
          '-map', '[v]',           // Use filtered video
          '-map', '[a]',           // Use filtered audio
          '-r', '30',              // Output 30fps
          '-vsync', 'cfr',         // Constant frame rate
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '23',
          '-c:a', 'aac',
          '-b:a', '128k',
          '-movflags', '+faststart',
          '-y'
        ])
        .on('start', cmd => console.log(`  Concat command started`))
        .on('progress', p => {
          // Calculate progress based on time, not frames (more accurate)
          if (p.timemark) {
            console.log(`  Concat progress: ${p.timemark}`);
          }
        })
        .on('end', () => {
          console.log('Concatenation complete');
          this.updateProgress(renderProgress, jobId, 'complete', 100);
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error('Concat error:', err.message);
          reject(err);
        })
        .save(outputPath);
    });
  }

  async createPipSegment(originalPath, reactionPath, outputPath, targetWidth, targetHeight, pipPosition) {
    console.log('\n=== THREE-PASS PiP Creation ===');
    const workDir = path.dirname(outputPath);

    // Get durations
    const originalDuration = await this.getVideoDuration(originalPath);
    const reactionDuration = await this.getVideoDuration(reactionPath);
    console.log(`Original duration: ${originalDuration}s`);
    console.log(`Reaction duration: ${reactionDuration}s`);

    // Handle invalid durations
    if (!originalDuration || originalDuration <= 0 || !reactionDuration || reactionDuration <= 0) {
      console.log('WARNING: Invalid duration detected, using fallback...');
      await fs.copy(reactionPath, outputPath);
      return outputPath;
    }

    // Pass 1: Extract last frame from reaction
    console.log('--- Pass 1: Extract frame ---');
    const lastFramePath = path.join(workDir, `last_frame_${Date.now()}.jpg`);
    await this.extractLastFrame(reactionPath, lastFramePath);

    // Pass 2: Create background video (exact duration)
    console.log('--- Pass 2: Create background video ---');
    const bgPath = path.join(workDir, `bg_${Date.now()}.mp4`);
    const bgDuration = originalDuration + 0.5;
    await this.createBackgroundVideo(lastFramePath, bgPath, bgDuration, targetWidth, targetHeight, reactionPath);

    // Pass 3: Overlay original on background
    console.log('--- Pass 3: Overlay PiP ---');
    const coords = await this.getPipCoordinates(targetWidth, targetHeight, pipPosition);
    await this.overlayPip(bgPath, originalPath, outputPath, coords, targetWidth, targetHeight);

    // Cleanup temp files
    await fs.remove(lastFramePath).catch(() => {});
    await fs.remove(bgPath).catch(() => {});

    console.log('=== THREE-PASS Complete ===\n');
    const stats = await fs.stat(outputPath);
    console.log(`✓ Pass 3 complete - Final video: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    return outputPath;
  }

  async extractLastFrame(videoPath, outputPath) {
    return new Promise((resolve, reject) => {
      const cmd = `ffmpeg -y -sseof -1 -i "${videoPath}" -vframes 1 -q:v 2 "${outputPath}"`;
      exec(cmd, (error, stdout, stderr) => {
        if (error) {
          console.error('Extract frame error:', stderr);
          reject(error);
        } else {
          console.log('  ✓ Last frame extracted');
          resolve(outputPath);
        }
      });
    });
  }

  async createBackgroundVideo(framePath, outputPath, duration, width, height, audioSource) {
    return new Promise((resolve, reject) => {
      const cmd = `ffmpeg -y -loop 1 -i "${framePath}" -i "${audioSource}" -t ${duration} -vf "scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=30" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -shortest "${outputPath}"`;
      exec(cmd, (error, stdout, stderr) => {
        if (error) {
          console.error('Background video error:', stderr);
          reject(error);
        } else {
          console.log(`  ✓ Background video created (${duration}s)`);
          resolve(outputPath);
        }
      });
    });
  }

  async overlayPip(bgPath, pipPath, outputPath, coords, targetWidth, targetHeight) {
    return new Promise((resolve, reject) => {
      const pipWidth = Math.floor(targetWidth * 0.25);
      const pipHeight = Math.floor(targetHeight * 0.25);

      const filterComplex = `[1:v]scale=${pipWidth}:${pipHeight}[pip];[0:v][pip]overlay=${coords.x}:${coords.y}[outv]`;

      const cmd = `ffmpeg -y -i "${bgPath}" -i "${pipPath}" -filter_complex "${filterComplex}" -map "[outv]" -map 0:a -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k "${outputPath}"`;

      exec(cmd, (error, stdout, stderr) => {
        if (error) {
          console.error('Overlay error:', stderr);
          reject(error);
        } else {
          console.log('  ✓ PiP overlay complete');
          resolve(outputPath);
        }
      });
    });
  }

  async getPipCoordinates(targetWidth, targetHeight, pipPosition) {
    const pipWidth = Math.floor(targetWidth * 0.25);
    const pipHeight = Math.floor(targetHeight * 0.25);
    const padding = 20;

    const positions = {
      'top-right': { x: targetWidth - pipWidth - padding, y: padding },
      'top-left': { x: padding, y: padding },
      'bottom-right': { x: targetWidth - pipWidth - padding, y: targetHeight - pipHeight - padding },
      'bottom-left': { x: padding, y: targetHeight - pipHeight - padding }
    };

    if (pipPosition === 'random') {
      const keys = Object.keys(positions);
      const randomKey = keys[Math.floor(Math.random() * keys.length)];
      console.log(`  Random position selected: ${randomKey}`);
      return positions[randomKey];
    }

    return positions[pipPosition] || positions['top-right'];
  }

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

  async getVideoDuration(videoPath) {
    return new Promise((resolve) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          console.error('Probe error:', err.message);
          resolve(0);
          return;
        }
        const duration = metadata.format?.duration || 0;
        resolve(parseFloat(duration));
      });
    });
  }
}

module.exports = new CombineService();
