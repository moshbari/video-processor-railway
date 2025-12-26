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
        
        let maxDuration = Math.max(videoDuration, audioDuration, formatDuration);
        if (maxDuration <= 0) {
          maxDuration = formatDuration || 1;
        }
        
        const width = videoStream?.width || 0;
        const height = videoStream?.height || 0;
        
        resolve({
          duration: maxDuration,
          videoDuration,
          audioDuration,
          formatDuration,
          width,
          height,
          hasVideo: !!videoStream && width > 0 && height > 0,
          hasAudio: !!audioStream
        });
      });
    });
  }

  async getVideoDuration(videoPath) {
    const metadata = await this.getVideoMetadata(videoPath);
    return metadata.duration;
  }

  async getVideoDimensions(videoPath) {
    const metadata = await this.getVideoMetadata(videoPath);
    return { width: metadata.width, height: metadata.height };
  }

  /**
   * Extract the last frame from a video as an image
   */
  async extractLastFrame(videoPath, outputPath) {
    console.log(`Extracting last frame from: ${videoPath}`);
    
    if (!await fs.pathExists(videoPath)) {
      throw new Error(`Input video does not exist: ${videoPath}`);
    }
    
    const duration = await this.getVideoDuration(videoPath);
    let seekTime = duration < 1 ? Math.max(0, duration * 0.8) : Math.max(0, duration - 0.5);
    
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(seekTime)
        .frames(1)
        .outputOptions(['-q:v', '2', '-y'])
        .on('start', cmd => console.log('Extract frame:', cmd))
        .on('end', async () => {
          if (await fs.pathExists(outputPath)) {
            const stats = await fs.stat(outputPath);
            if (stats.size > 0) {
              console.log(`Frame extracted: ${stats.size} bytes`);
              resolve(outputPath);
            } else {
              reject(new Error('Frame file is empty'));
            }
          } else {
            reject(new Error('Frame file not found'));
          }
        })
        .on('error', reject)
        .save(outputPath);
    });
  }

  /**
   * Create a video from a still image with specified duration
   * This creates a proper video file, not a looped input
   */
  async createVideoFromImage(imagePath, outputPath, duration, width, height) {
    console.log(`Creating ${duration}s video from image at ${width}x${height}`);
    
    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(imagePath)
        .inputOptions(['-loop', '1'])
        .outputOptions([
          '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p`,
          '-t', String(duration),
          '-r', '30',
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '23',
          '-an',  // No audio for background
          '-y'
        ])
        .on('start', cmd => console.log('Create background video:', cmd))
        .on('end', async () => {
          if (await fs.pathExists(outputPath)) {
            console.log('Background video created');
            resolve(outputPath);
          } else {
            reject(new Error('Background video not created'));
          }
        })
        .on('error', reject)
        .save(outputPath);
    });
  }

  /**
   * Overlay PiP on background video (two separate inputs, simpler filter)
   */
  async overlayPipOnBackground(backgroundPath, reactionPath, outputPath, pipWidth, pipHeight, pipX, pipY) {
    console.log(`Overlaying PiP (${pipWidth}x${pipHeight}) at (${pipX}, ${pipY})`);
    
    const reactionMeta = await this.getVideoMetadata(reactionPath);
    
    return new Promise((resolve, reject) => {
      const command = ffmpeg()
        .input(backgroundPath)
        .input(reactionPath);
      
      // Simple filter: scale reaction and overlay on background
      const filterComplex = `[1:v]scale=${pipWidth}:${pipHeight}:force_original_aspect_ratio=decrease,setsar=1[pip];[0:v][pip]overlay=${pipX}:${pipY}[outv]`;
      
      const outputOptions = [
        '-filter_complex', filterComplex,
        '-map', '[outv]',
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-r', '30'
      ];
      
      // Add audio from reaction if available
      if (reactionMeta.hasAudio) {
        outputOptions.push('-map', '1:a', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k');
      }
      
      outputOptions.push('-movflags', '+faststart', '-y');
      
      command
        .outputOptions(outputOptions)
        .on('start', cmd => console.log('Overlay PiP:', cmd))
        .on('progress', p => {
          if (p.percent) console.log(`  Overlay: ${Math.round(p.percent)}%`);
        })
        .on('end', async () => {
          if (await fs.pathExists(outputPath)) {
            const stats = await fs.stat(outputPath);
            if (stats.size > 0) {
              console.log(`PiP overlay complete: ${stats.size} bytes`);
              resolve(outputPath);
            } else {
              reject(new Error('Output file is empty'));
            }
          } else {
            reject(new Error('Output file not found'));
          }
        })
        .on('error', reject)
        .save(outputPath);
    });
  }

  /**
   * Create PiP segment using TWO-PASS method:
   * Pass 1: Create background video from frozen frame
   * Pass 2: Overlay scaled reaction video on background
   */
  async createPipSegment(originalClipPath, reactionPath, outputPath, targetWidth = 1080, targetHeight = 1920) {
    const workDir = path.dirname(outputPath);
    const timestamp = Date.now();
    const lastFramePath = path.join(workDir, `lastframe_${timestamp}.jpg`);
    const backgroundVideoPath = path.join(workDir, `background_${timestamp}.mp4`);
    
    try {
      console.log('\n=== TWO-PASS PiP Creation ===');
      console.log(`Original: ${originalClipPath}`);
      console.log(`Reaction: ${reactionPath}`);
      
      // Verify files exist
      if (!await fs.pathExists(reactionPath)) {
        throw new Error(`Reaction file not found: ${reactionPath}`);
      }
      
      // Get reaction metadata FIRST to know the duration
      const reactionMeta = await this.getVideoMetadata(reactionPath);
      console.log(`Reaction: ${reactionMeta.duration.toFixed(2)}s, ${reactionMeta.width}x${reactionMeta.height}, hasAudio: ${reactionMeta.hasAudio}`);
      
      if (!reactionMeta.hasVideo || reactionMeta.width <= 0 || reactionMeta.height <= 0) {
        throw new Error('Reaction has no valid video');
      }
      
      const totalDuration = reactionMeta.duration;
      if (totalDuration <= 0 || isNaN(totalDuration)) {
        throw new Error(`Invalid duration: ${totalDuration}`);
      }
      
      // Calculate PiP dimensions (35% width, maintain aspect ratio)
      const pipWidth = Math.round(targetWidth * 0.35);
      const pipHeight = Math.round(pipWidth * (reactionMeta.height / reactionMeta.width));
      const pipX = targetWidth - pipWidth - 20;  // Top-right with padding
      const pipY = 20;
      
      console.log(`PiP: ${pipWidth}x${pipHeight} at (${pipX}, ${pipY})`);
      
      // PASS 1: Extract last frame
      console.log('\n--- Pass 1: Extract frame ---');
      await this.extractLastFrame(originalClipPath, lastFramePath);
      
      // PASS 2: Create background video from frame
      console.log('\n--- Pass 2: Create background video ---');
      await this.createVideoFromImage(lastFramePath, backgroundVideoPath, totalDuration, targetWidth, targetHeight);
      
      // PASS 3: Overlay PiP on background
      console.log('\n--- Pass 3: Overlay PiP ---');
      await this.overlayPipOnBackground(backgroundVideoPath, reactionPath, outputPath, pipWidth, pipHeight, pipX, pipY);
      
      // Cleanup temp files
      await fs.remove(lastFramePath).catch(() => {});
      await fs.remove(backgroundVideoPath).catch(() => {});
      
      console.log('=== PiP Creation Complete ===\n');
      return outputPath;
      
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
    const metadata = await this.getVideoMetadata(inputPath);
    const videoFilter = `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
    
    if (metadata.hasAudio) {
      return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .outputOptions([
            '-vf', videoFilter,
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
          .on('start', cmd => console.log('Normalize:', cmd))
          .on('progress', p => {
            if (p.percent) console.log(`  Normalizing: ${Math.round(p.percent)}%`);
          })
          .on('end', () => {
            console.log('Normalized successfully');
            resolve(outputPath);
          })
          .on('error', reject)
          .save(outputPath);
      });
    } else {
      // Add silent audio
      console.log('Adding silent audio track');
      const filterComplex = `[0:v]${videoFilter}[v];anullsrc=r=44100:cl=stereo[a]`;
      
      return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .outputOptions([
            '-filter_complex', filterComplex,
            '-map', '[v]',
            '-map', '[a]',
            '-r', '30',
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '23',
            '-c:a', 'aac',
            '-ar', '44100',
            '-ac', '2',
            '-b:a', '128k',
            '-shortest',
            '-movflags', '+faststart',
            '-y'
          ])
          .on('start', cmd => console.log('Normalize (add audio):', cmd))
          .on('progress', p => {
            if (p.percent) console.log(`  Normalizing: ${Math.round(p.percent)}%`);
          })
          .on('end', () => {
            console.log('Normalized successfully (silent audio added)');
            resolve(outputPath);
          })
          .on('error', reject)
          .save(outputPath);
      });
    }
  }

  /**
   * Combine clips with reactions
   */
  async combineClipsWithReactions(originalClips, reactionClips, jobId = null, options = {}) {
    jobId = jobId || uuidv4();
    const workDir = path.join(this.tempDir, jobId);
    await fs.ensureDir(workDir);

    const mode = options.mode || 'sequential';
    const targetWidth = options.targetWidth || 1080;
    const targetHeight = options.targetHeight || 1920;

    console.log(`\n${'='.repeat(50)}`);
    console.log(`COMBINE MODE: ${mode.toUpperCase()}`);
    console.log(`${'='.repeat(50)}\n`);

    try {
      if (!Array.isArray(originalClips) || originalClips.length === 0) {
        throw new Error('No original clips provided');
      }
      
      const reactions = Array.isArray(reactionClips) ? reactionClips : [];
      console.log(`Processing ${originalClips.length} clips with ${reactions.length} reactions`);

      const processedClips = [];
      
      for (let i = 0; i < originalClips.length; i++) {
        const originalPath = originalClips[i];
        const reactionPath = reactions[i] || null;
        
        console.log(`\n${'─'.repeat(40)}`);
        console.log(`CLIP ${i + 1}/${originalClips.length}`);
        console.log(`${'─'.repeat(40)}`);
        console.log(`Original: ${originalPath}`);
        console.log(`Reaction: ${reactionPath || 'none'}`);
        
        // Verify original exists
        if (!await fs.pathExists(originalPath)) {
          console.error(`Original not found, skipping`);
          continue;
        }
        
        // Normalize original clip
        const normalizedOriginalPath = path.join(workDir, `norm_orig_${i}.mp4`);
        console.log('\nNormalizing original...');
        await this.normalizeClip(originalPath, normalizedOriginalPath, targetWidth, targetHeight);
        
        if (!await fs.pathExists(normalizedOriginalPath)) {
          console.error('Failed to normalize original, skipping');
          continue;
        }
        processedClips.push(normalizedOriginalPath);
        
        // Process reaction
        if (reactionPath && typeof reactionPath === 'string' && await fs.pathExists(reactionPath)) {
          
          // ALWAYS normalize reaction first
          const normalizedReactionPath = path.join(workDir, `norm_react_${i}.mp4`);
          console.log('\nNormalizing reaction...');
          
          try {
            await this.normalizeClip(reactionPath, normalizedReactionPath, targetWidth, targetHeight);
            
            if (!await fs.pathExists(normalizedReactionPath)) {
              throw new Error('Normalized reaction not created');
            }
            
            if (mode === 'pip') {
              // PiP MODE
              const pipPath = path.join(workDir, `pip_${i}.mp4`);
              console.log('\nCreating PiP segment...');
              
              try {
                await this.createPipSegment(
                  normalizedOriginalPath,
                  normalizedReactionPath,
                  pipPath,
                  targetWidth,
                  targetHeight
                );
                
                if (await fs.pathExists(pipPath)) {
                  const stats = await fs.stat(pipPath);
                  if (stats.size > 1000) {  // At least 1KB
                    processedClips.push(pipPath);
                    console.log(`✓ PiP segment added (${(stats.size/1024/1024).toFixed(2)} MB)`);
                  } else {
                    throw new Error('PiP file too small');
                  }
                } else {
                  throw new Error('PiP file not created');
                }
              } catch (pipErr) {
                console.error(`PiP failed: ${pipErr.message}`);
                console.log('Falling back to sequential...');
                processedClips.push(normalizedReactionPath);
              }
            } else {
              // Sequential mode
              processedClips.push(normalizedReactionPath);
              console.log('✓ Reaction added (sequential)');
            }
          } catch (normErr) {
            console.error(`Reaction normalization failed: ${normErr.message}`);
          }
        } else {
          console.log('No reaction for this clip');
        }
      }

      if (processedClips.length === 0) {
        throw new Error('No clips processed successfully');
      }

      console.log(`\n${'─'.repeat(40)}`);
      console.log(`CONCATENATING ${processedClips.length} segments`);
      console.log(`${'─'.repeat(40)}`);

      // Create concat file
      const concatPath = path.join(workDir, 'concat.txt');
      const concatContent = processedClips.map(p => `file '${p}'`).join('\n');
      await fs.writeFile(concatPath, concatContent);
      console.log('Concat list:\n' + concatContent);

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
