const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

class CombineService {
  constructor() {
    this.outputDir = process.env.OUTPUT_DIR || '/app/outputs';
    this.tempDir = process.env.TEMP_DIR || '/app/temp';
  }

  /**
   * Get video metadata using ffprobe
   */
  async getVideoMetadata(videoPath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          reject(err);
          return;
        }
        
        const streams = metadata.streams || [];
        const videoStream = streams.find(s => s.codec_type === 'video');
        const audioStream = streams.find(s => s.codec_type === 'audio');
        
        const parseValidDuration = (val) => {
          const num = parseFloat(val);
          return (isNaN(num) || num <= 0) ? 0 : num;
        };
        
        const formatDuration = parseValidDuration(metadata.format?.duration);
        const videoDuration = videoStream ? parseValidDuration(videoStream.duration) || formatDuration : 0;
        const audioDuration = audioStream ? parseValidDuration(audioStream.duration) || formatDuration : 0;
        
        // Use the maximum of all durations
        const duration = Math.max(formatDuration, videoDuration, audioDuration);
        
        resolve({
          duration,
          formatDuration,
          videoDuration,
          audioDuration,
          width: videoStream?.width || 0,
          height: videoStream?.height || 0,
          hasVideo: !!videoStream,
          hasAudio: !!audioStream
        });
      });
    });
  }

  /**
   * Get video duration using ffprobe
   */
  async getVideoDuration(videoPath) {
    const meta = await this.getVideoMetadata(videoPath);
    return meta.duration;
  }

  /**
   * Get video dimensions using ffprobe
   */
  async getVideoDimensions(videoPath) {
    const meta = await this.getVideoMetadata(videoPath);
    return { width: meta.width, height: meta.height };
  }

  /**
   * Extract the last frame from a video as an image
   */
  async extractLastFrame(videoPath, outputPath) {
    const duration = await this.getVideoDuration(videoPath);
    const seekTime = Math.max(0, duration - 0.1);
    
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(seekTime)
        .frames(1)
        .outputOptions(['-q:v', '2', '-y'])
        .on('end', () => resolve(outputPath))
        .on('error', reject)
        .save(outputPath);
    });
  }

  /**
   * Create a video from a still image (for background)
   * This is PASS 2 of the three-pass method
   */
  async createVideoFromImage(imagePath, outputPath, duration, targetWidth, targetHeight) {
    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(imagePath)
        .inputOptions(['-loop', '1'])
        .outputOptions([
          '-vf', `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '23',
          '-t', String(duration),
          '-pix_fmt', 'yuv420p',
          '-r', '30',
          '-y'
        ])
        .on('start', cmd => console.log('Creating background video:', cmd))
        .on('end', () => {
          console.log(`Background video created: ${duration}s`);
          resolve(outputPath);
        })
        .on('error', reject)
        .save(outputPath);
    });
  }

  /**
   * Overlay PiP on background video
   * This is PASS 3 of the three-pass method
   */
  async overlayPipOnBackground(backgroundPath, reactionPath, outputPath, pipWidth, pipHeight, pipX, pipY, hasAudio) {
    return new Promise((resolve, reject) => {
      const filterComplex = [
        `[1:v]scale=${pipWidth}:${pipHeight}:force_original_aspect_ratio=decrease,setsar=1[pip]`,
        `[0:v][pip]overlay=${pipX}:${pipY}[outv]`
      ].join(';');

      const outputOptions = [
        '-filter_complex', filterComplex,
        '-map', '[outv]',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-movflags', '+faststart',
        '-y'
      ];

      // Add audio mapping - use reaction audio if available
      if (hasAudio) {
        outputOptions.push('-map', '1:a', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k');
      }

      ffmpeg()
        .input(backgroundPath)
        .input(reactionPath)
        .outputOptions(outputOptions)
        .on('start', cmd => console.log('Overlay PiP:', cmd))
        .on('progress', p => {
          if (p.percent) console.log(`  Overlay: ${Math.round(p.percent)}%`);
        })
        .on('end', () => {
          console.log('PiP overlay complete');
          resolve(outputPath);
        })
        .on('error', reject)
        .save(outputPath);
    });
  }

  /**
   * Calculate PiP coordinates based on position
   * @param {string} position - 'top-right', 'bottom-right', 'bottom-left', 'top-left', or 'random'
   * @param {number} targetWidth - Width of the target video
   * @param {number} targetHeight - Height of the target video
   * @param {number} pipWidth - Width of the PiP overlay
   * @param {number} pipHeight - Height of the PiP overlay
   * @param {number} padding - Padding from edges (default: 20)
   * @returns {object} - { x, y, position } coordinates and resolved position name
   */
  getPipCoordinates(position, targetWidth, targetHeight, pipWidth, pipHeight, padding = 20) {
    const positions = {
      'top-right': { 
        x: targetWidth - pipWidth - padding, 
        y: padding 
      },
      'bottom-right': { 
        x: targetWidth - pipWidth - padding, 
        y: targetHeight - pipHeight - padding 
      },
      'bottom-left': { 
        x: padding, 
        y: targetHeight - pipHeight - padding 
      },
      'top-left': { 
        x: padding, 
        y: padding 
      }
    };
    
    // Handle random position
    let resolvedPosition = position;
    if (position === 'random') {
      const positionKeys = Object.keys(positions);
      resolvedPosition = positionKeys[Math.floor(Math.random() * positionKeys.length)];
      console.log(`Random position selected: ${resolvedPosition}`);
    }
    
    // Default to top-right if invalid position
    if (!positions[resolvedPosition]) {
      console.warn(`Invalid position "${resolvedPosition}", defaulting to top-right`);
      resolvedPosition = 'top-right';
    }
    
    return {
      ...positions[resolvedPosition],
      position: resolvedPosition
    };
  }

  /**
   * Create PiP segment using THREE-PASS method for reliable audio/video sync:
   * - PASS 1: Extract last frame as JPG
   * - PASS 2: Create background video from that frame (exact duration matching audio)
   * - PASS 3: Overlay reaction video on background
   * 
   * @param {string} originalClipPath - Path to original clip
   * @param {string} reactionPath - Path to reaction video
   * @param {string} outputPath - Path for output file
   * @param {number} targetWidth - Target video width (default: 1080)
   * @param {number} targetHeight - Target video height (default: 1920)
   * @param {string} pipPosition - PiP position: 'top-right', 'bottom-right', 'bottom-left', 'top-left', 'random'
   */
  async createPipSegment(originalClipPath, reactionPath, outputPath, targetWidth = 1080, targetHeight = 1920, pipPosition = 'top-right') {
    const workDir = path.dirname(outputPath);
    const timestamp = Date.now();
    const lastFramePath = path.join(workDir, `lastframe_${timestamp}.jpg`);
    const backgroundVideoPath = path.join(workDir, `background_${timestamp}.mp4`);
    
    try {
      console.log('\n=== THREE-PASS PiP Creation ===');
      console.log(`Original: ${originalClipPath}`);
      console.log(`Reaction: ${reactionPath}`);
      console.log(`Requested position: ${pipPosition}`);
      
      // Verify reaction file exists
      if (!await fs.pathExists(reactionPath)) {
        throw new Error(`Reaction file not found: ${reactionPath}`);
      }
      
      // Get reaction metadata FIRST to know the duration
      const reactionMeta = await this.getVideoMetadata(reactionPath);
      console.log(`Reaction metadata:`);
      console.log(`  - Video duration: ${reactionMeta.videoDuration}s`);
      console.log(`  - Audio duration: ${reactionMeta.audioDuration}s`);
      console.log(`  - Max duration (used): ${reactionMeta.duration}s`);
      console.log(`  - Dimensions: ${reactionMeta.width}x${reactionMeta.height}`);
      console.log(`  - Has audio: ${reactionMeta.hasAudio}`);
      
      if (!reactionMeta.hasVideo || reactionMeta.width <= 0 || reactionMeta.height <= 0) {
        throw new Error('Reaction has no valid video');
      }
      
      // Use the MAX duration (ensures audio doesn't get cut)
      const totalDuration = reactionMeta.duration;
      if (totalDuration <= 0 || isNaN(totalDuration)) {
        throw new Error(`Invalid duration: ${totalDuration}`);
      }
      
      // Calculate PiP dimensions (35% width, maintain aspect ratio)
      const pipWidth = Math.round(targetWidth * 0.35);
      const pipHeight = Math.round(pipWidth * (reactionMeta.height / reactionMeta.width));
      
      // Get coordinates based on position
      const coords = this.getPipCoordinates(pipPosition, targetWidth, targetHeight, pipWidth, pipHeight);
      const pipX = coords.x;
      const pipY = coords.y;
      
      console.log(`PiP: ${pipWidth}x${pipHeight} at ${coords.position} (${pipX}, ${pipY})`);
      
      // PASS 1: Extract last frame
      console.log('\n--- Pass 1: Extract frame ---');
      await this.extractLastFrame(originalClipPath, lastFramePath);
      
      if (!await fs.pathExists(lastFramePath)) {
        throw new Error('Failed to extract last frame');
      }
      console.log('Pass 1 complete: Frame extracted');
      
      // PASS 2: Create background video from frame (EXACT duration to match audio)
      console.log('\n--- Pass 2: Create background video ---');
      await this.createVideoFromImage(lastFramePath, backgroundVideoPath, totalDuration, targetWidth, targetHeight);
      
      if (!await fs.pathExists(backgroundVideoPath)) {
        throw new Error('Failed to create background video');
      }
      console.log('Pass 2 complete: Background video created');
      
      // PASS 3: Overlay PiP on background
      console.log('\n--- Pass 3: Overlay PiP ---');
      await this.overlayPipOnBackground(
        backgroundVideoPath, 
        reactionPath, 
        outputPath, 
        pipWidth, 
        pipHeight, 
        pipX, 
        pipY, 
        reactionMeta.hasAudio
      );
      
      // Cleanup temp files
      await fs.remove(lastFramePath).catch(() => {});
      await fs.remove(backgroundVideoPath).catch(() => {});
      
      if (await fs.pathExists(outputPath)) {
        const stats = await fs.stat(outputPath);
        console.log(`\n=== PiP Complete: ${(stats.size/1024/1024).toFixed(2)} MB ===\n`);
        return outputPath;
      } else {
        throw new Error('PiP output file not created');
      }
      
    } catch (error) {
      // Cleanup on error
      await fs.remove(lastFramePath).catch(() => {});
      await fs.remove(backgroundVideoPath).catch(() => {});
      console.error('createPipSegment error:', error);
      throw error;
    }
  }

  /**
   * Normalize a clip to consistent format
   */
  async normalizeClip(inputPath, outputPath, targetWidth = 1080, targetHeight = 1920) {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-vf', `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
          '-r', '30',
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '23',
          '-c:a', 'aac',
          '-ar', '44100',
          '-ac', '2',
          '-b:a', '128k',
          '-movflags', '+faststart',
          '-y'
        ])
        .on('start', (cmd) => {
          console.log('Normalizing with command:', cmd);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            console.log(`  Normalizing: ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => {
          console.log('Clip normalized successfully');
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error('Normalization error:', err);
          reject(err);
        })
        .save(outputPath);
    });
  }

  /**
   * Combine original clips with reaction clips
   * 
   * Supports two modes:
   * - 'sequential' (default): clip1 → reaction1_fullscreen → clip2 → reaction2_fullscreen
   * - 'pip': clip1 → frozen_frame + reaction1_pip → clip2 → frozen_frame + reaction2_pip
   * 
   * For 'pip' mode, supports pipPosition:
   * - 'top-right' (default), 'bottom-right', 'bottom-left', 'top-left', 'random'
   */
  async combineClipsWithReactions(originalClips, reactionClips, outputFileName = null, options = {}) {
    const mode = options.mode || 'sequential';
    const pipPosition = options.pipPosition || 'top-right';
    const jobId = uuidv4();
    const workDir = path.join(this.tempDir, jobId);
    
    await fs.ensureDir(workDir);
    
    console.log('\n' + '='.repeat(60));
    console.log('COMBINE CLIPS WITH REACTIONS');
    console.log('='.repeat(60));
    console.log(`Job ID: ${jobId}`);
    console.log(`Mode: ${mode}`);
    if (mode === 'pip') {
      console.log(`PiP Position: ${pipPosition}`);
    }
    console.log(`Original clips: ${originalClips.length}`);
    console.log(`Reaction clips: ${reactionClips.length}`);
    
    try {
      // Build array of reactions matching original clips
      const reactions = [];
      for (let i = 0; i < originalClips.length; i++) {
        reactions.push(reactionClips[i] || null);
      }
      
      const processedClips = [];
      const targetWidth = 1080;
      const targetHeight = 1920;
      
      for (let i = 0; i < originalClips.length; i++) {
        const originalPath = originalClips[i];
        const reactionPath = reactions[i];
        
        console.log(`\n--- Processing clip ${i + 1}/${originalClips.length} ---`);
        console.log(`Original: ${path.basename(originalPath)}`);
        console.log(`Reaction: ${reactionPath ? path.basename(reactionPath) : 'NONE'}`);
        
        // Normalize the original clip
        const normalizedOriginalPath = path.join(workDir, `normalized_original_${i}.mp4`);
        console.log('Normalizing original clip...');
        await this.normalizeClip(originalPath, normalizedOriginalPath, targetWidth, targetHeight);
        processedClips.push(normalizedOriginalPath);
        
        // Process reaction based on mode
        if (reactionPath) {
          if (mode === 'pip') {
            // PiP mode: frozen frame + reaction overlay (THREE-PASS method)
            const pipOutputPath = path.join(workDir, `pip_${i}.mp4`);
            console.log(`Creating PiP segment (position: ${pipPosition})...`);
            await this.createPipSegment(
              normalizedOriginalPath, 
              reactionPath, 
              pipOutputPath, 
              targetWidth, 
              targetHeight,
              pipPosition
            );
            processedClips.push(pipOutputPath);
          } else {
            // Sequential mode: full-screen reaction
            const normalizedReactionPath = path.join(workDir, `normalized_reaction_${i}.mp4`);
            console.log('Normalizing reaction clip...');
            await this.normalizeClip(reactionPath, normalizedReactionPath, targetWidth, targetHeight);
            processedClips.push(normalizedReactionPath);
          }
        }
      }
      
      console.log('\n--- Creating final video ---');
      console.log('Clips to concatenate:');
      processedClips.forEach((p, i) => {
        console.log(`  ${i + 1}. ${path.basename(p)}`);
      });

      // Create concat file
      const concatPath = path.join(workDir, 'concat.txt');
      const concatContent = processedClips.map(p => `file '${p}'`).join('\n');
      await fs.writeFile(concatPath, concatContent);

      // Concatenate
      const outputPath = path.join(workDir, 'final_combined.mp4');
      await this.concatenateClips(concatPath, outputPath);

      if (!await fs.pathExists(outputPath)) {
        throw new Error('Final video not created');
      }
      
      const stats = await fs.stat(outputPath);
      console.log(`\n✓ FINAL VIDEO: ${(stats.size/1024/1024).toFixed(2)} MB`);

      return {
        jobId,
        mode,
        pipPosition: mode === 'pip' ? pipPosition : null,
        outputPath,
        segmentCount: processedClips.length,
        originalCount: originalClips.length,
        reactionCount: reactions.filter(c => c).length,
        fileSize: stats.size,
        downloadUrl: `/api/combine/${jobId}/download`
      };

    } catch (error) {
      console.error('Combine error:', error);
      await fs.remove(workDir).catch(() => {});
      throw error;
    }
  }

  async concatenateClips(concatFilePath, outputPath) {
    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatFilePath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-c', 'copy', '-movflags', '+faststart', '-y'])
        .on('start', cmd => console.log('Concat:', cmd))
        .on('progress', p => {
          if (p.percent) console.log(`  Concat: ${Math.round(p.percent)}%`);
        })
        .on('end', () => {
          console.log('Concatenation complete');
          resolve(outputPath);
        })
        .on('error', reject)
        .save(outputPath);
    });
  }

  getOutputPath(jobId) {
    return path.join(this.tempDir, jobId, 'final_combined.mp4');
  }

  async cleanup(jobId) {
    const workDir = path.join(this.tempDir, jobId);
    await fs.remove(workDir);
    console.log(`Cleaned up job: ${jobId}`);
  }
}

module.exports = new CombineService();
