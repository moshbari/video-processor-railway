const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');

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
   * Uses exec with raw ffmpeg command for reliability
   */
  async extractLastFrame(videoPath, outputPath) {
    console.log(`Extracting last frame from: ${videoPath}`);
    console.log(`Output path: ${outputPath}`);
    
    // Verify input exists
    if (!await fs.pathExists(videoPath)) {
      throw new Error(`Input video does not exist: ${videoPath}`);
    }
    
    const duration = await this.getVideoDuration(videoPath);
    console.log(`Video duration: ${duration}s`);
    
    if (duration <= 0 || isNaN(duration)) {
      throw new Error(`Invalid video duration: ${duration}`);
    }
    
    // Calculate seek time - handle very short videos
    let seekTime;
    if (duration < 1) {
      seekTime = Math.max(0, duration * 0.5);
    } else {
      seekTime = Math.max(0, duration - 0.5);
    }
    console.log(`Seeking to: ${seekTime}s`);
    
    return new Promise((resolve, reject) => {
      // Use raw ffmpeg command via exec for reliability
      const cmd = `ffmpeg -y -ss ${seekTime} -i "${videoPath}" -frames:v 1 -q:v 2 "${outputPath}"`;
      console.log(`Extract frame command: ${cmd}`);
      
      exec(cmd, async (error, stdout, stderr) => {
        if (error) {
          console.error('Frame extraction error:', stderr);
          reject(new Error(`Frame extraction failed: ${error.message}`));
          return;
        }
        
        // Verify the file was created
        if (await fs.pathExists(outputPath)) {
          const stats = await fs.stat(outputPath);
          if (stats.size > 0) {
            console.log(`Frame extracted successfully: ${outputPath} (${stats.size} bytes)`);
            resolve(outputPath);
          } else {
            reject(new Error(`Frame extracted but file is empty: ${outputPath}`));
          }
        } else {
          // Try alternative method - extract from start if end fails
          console.log('Frame extraction from end failed, trying from start...');
          const altCmd = `ffmpeg -y -i "${videoPath}" -frames:v 1 -q:v 2 "${outputPath}"`;
          
          exec(altCmd, async (altError, altStdout, altStderr) => {
            if (altError) {
              reject(new Error(`Frame extraction failed (both attempts): ${altError.message}`));
              return;
            }
            
            if (await fs.pathExists(outputPath)) {
              const stats = await fs.stat(outputPath);
              if (stats.size > 0) {
                console.log(`Frame extracted (from start): ${outputPath} (${stats.size} bytes)`);
                resolve(outputPath);
              } else {
                reject(new Error('Frame extraction produced empty file'));
              }
            } else {
              reject(new Error('Frame extraction completed but file not found'));
            }
          });
        }
      });
    });
  }

  /**
   * Create a video from a still image (for background)
   * This is PASS 2 of the three-pass method
   */
  async createVideoFromImage(imagePath, outputPath, duration, targetWidth, targetHeight) {
    console.log(`Creating background video: ${duration}s at ${targetWidth}x${targetHeight}`);
    
    return new Promise((resolve, reject) => {
      // Use raw ffmpeg command via exec for reliability
      const cmd = `ffmpeg -y -loop 1 -i "${imagePath}" -vf "scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:black,setsar=1" -c:v libx264 -preset fast -crf 23 -t ${duration} -pix_fmt yuv420p -r 30 "${outputPath}"`;
      console.log(`Background video command: ${cmd}`);
      
      exec(cmd, { maxBuffer: 50 * 1024 * 1024 }, async (error, stdout, stderr) => {
        if (error) {
          console.error('Background video error:', stderr);
          reject(new Error(`Background video creation failed: ${error.message}`));
          return;
        }
        
        if (await fs.pathExists(outputPath)) {
          const stats = await fs.stat(outputPath);
          console.log(`Background video created: ${outputPath} (${(stats.size/1024/1024).toFixed(2)} MB)`);
          resolve(outputPath);
        } else {
          reject(new Error('Background video creation completed but file not found'));
        }
      });
    });
  }

  /**
   * Overlay PiP on background video
   * This is PASS 3 of the three-pass method
   */
  async overlayPipOnBackground(backgroundPath, reactionPath, outputPath, pipWidth, pipHeight, pipX, pipY, hasAudio) {
    console.log(`Overlay PiP: ${pipWidth}x${pipHeight} at (${pipX}, ${pipY})`);
    
    return new Promise((resolve, reject) => {
      const filterComplex = `[1:v]scale=${pipWidth}:${pipHeight}:force_original_aspect_ratio=decrease,setsar=1[pip];[0:v][pip]overlay=${pipX}:${pipY}[outv]`;
      
      // Build audio mapping
      const audioArgs = hasAudio ? '-map 1:a -c:a aac -ar 44100 -ac 2 -b:a 128k' : '';
      
      const cmd = `ffmpeg -y -i "${backgroundPath}" -i "${reactionPath}" -filter_complex "${filterComplex}" -map "[outv]" ${audioArgs} -c:v libx264 -preset fast -crf 23 -movflags +faststart "${outputPath}"`;
      console.log(`Overlay command: ${cmd}`);
      
      exec(cmd, { maxBuffer: 50 * 1024 * 1024 }, async (error, stdout, stderr) => {
        if (error) {
          console.error('Overlay error:', stderr);
          reject(new Error(`PiP overlay failed: ${error.message}`));
          return;
        }
        
        if (await fs.pathExists(outputPath)) {
          const stats = await fs.stat(outputPath);
          console.log(`PiP overlay complete: ${outputPath} (${(stats.size/1024/1024).toFixed(2)} MB)`);
          resolve(outputPath);
        } else {
          reject(new Error('PiP overlay completed but file not found'));
        }
      });
    });
  }

  /**
   * Calculate PiP coordinates based on position
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
   * Create PiP segment using THREE-PASS method for reliable audio/video sync
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
      
      // Verify files exist
      if (!await fs.pathExists(originalClipPath)) {
        throw new Error(`Original clip not found: ${originalClipPath}`);
      }
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
        throw new Error('Failed to extract last frame - file not created');
      }
      const frameStats = await fs.stat(lastFramePath);
      console.log(`Pass 1 complete: Frame extracted (${frameStats.size} bytes)`);
      
      // PASS 2: Create background video from frame (EXACT duration to match audio)
      console.log('\n--- Pass 2: Create background video ---');
      await this.createVideoFromImage(lastFramePath, backgroundVideoPath, totalDuration, targetWidth, targetHeight);
      
      if (!await fs.pathExists(backgroundVideoPath)) {
        throw new Error('Failed to create background video - file not created');
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
