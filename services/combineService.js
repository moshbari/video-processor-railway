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
   * Get video duration using ffprobe
   */
  async getVideoDuration(videoPath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata.format.duration);
      });
    });
  }

  /**
   * Get video dimensions using ffprobe
   */
  async getVideoDimensions(videoPath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) reject(err);
        else {
          const videoStream = metadata.streams.find(s => s.codec_type === 'video');
          resolve({
            width: videoStream.width,
            height: videoStream.height
          });
        }
      });
    });
  }

  /**
   * Extract the last frame from a video as an image
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
    
    // Go back 0.5 seconds from end to ensure we get a frame
    const seekTime = Math.max(0, duration - 0.5);
    console.log(`Seeking to: ${seekTime}s`);
    
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(seekTime)
        .frames(1)
        .outputOptions(['-q:v', '2', '-y'])
        .on('start', (cmd) => {
          console.log('Extract frame command:', cmd);
        })
        .on('end', async () => {
          // Verify the file was created
          if (await fs.pathExists(outputPath)) {
            const stats = await fs.stat(outputPath);
            console.log(`Frame extracted successfully: ${outputPath} (${stats.size} bytes)`);
            resolve(outputPath);
          } else {
            reject(new Error(`Frame extraction completed but file not found: ${outputPath}`));
          }
        })
        .on('error', (err) => {
          console.error('Frame extraction error:', err);
          reject(err);
        })
        .save(outputPath);
    });
  }

  /**
   * Create PiP segment: frozen last frame with reaction overlay
   * - Reaction video is 35% width, top-right corner
   * - Maintains reaction video aspect ratio
   * - Only reaction audio plays
   */
  async createPipSegment(originalClipPath, reactionPath, outputPath, targetWidth = 1080, targetHeight = 1920) {
    const workDir = path.dirname(outputPath);
    const lastFramePath = path.join(workDir, `lastframe_${Date.now()}.jpg`);
    
    try {
      console.log('=== Starting PiP Segment Creation ===');
      console.log(`Original clip: ${originalClipPath}`);
      console.log(`Reaction: ${reactionPath}`);
      console.log(`Output: ${outputPath}`);
      
      // Extract last frame
      console.log('Step 1: Extracting last frame...');
      await this.extractLastFrame(originalClipPath, lastFramePath);
      
      // Double-check the frame exists
      if (!await fs.pathExists(lastFramePath)) {
        throw new Error(`Last frame file not found after extraction: ${lastFramePath}`);
      }
      console.log('Step 1: Complete - frame extracted');
      
      // Get reaction video duration and dimensions
      console.log('Step 2: Getting reaction video info...');
      const reactionDuration = await this.getVideoDuration(reactionPath);
      const reactionDims = await this.getVideoDimensions(reactionPath);
      
      console.log(`Creating PiP segment: ${reactionDuration.toFixed(2)}s, reaction dims: ${reactionDims.width}x${reactionDims.height}`);
      
      // Calculate PiP size (35% of target width, maintain aspect ratio)
      const pipWidth = Math.round(targetWidth * 0.35);
      const pipHeight = Math.round(pipWidth * (reactionDims.height / reactionDims.width));
      
      // Position: top-right corner with 20px padding
      const pipX = targetWidth - pipWidth - 20;
      const pipY = 20;
      
      console.log(`PiP dimensions: ${pipWidth}x${pipHeight}, position: (${pipX}, ${pipY})`);
      
      // Build filter_complex string manually for precise control
      const filterComplex = [
        // Scale the frozen frame to target resolution
        `[0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:black,setsar=1[bg]`,
        // Scale reaction video to PiP size, maintaining aspect ratio
        `[1:v]scale=${pipWidth}:${pipHeight}:force_original_aspect_ratio=decrease,setsar=1[pip]`,
        // Overlay PiP on frozen frame
        `[bg][pip]overlay=${pipX}:${pipY}:shortest=1[outv]`
      ].join(';');
      
      console.log('Step 3: Rendering PiP segment...');
      
      return new Promise((resolve, reject) => {
        ffmpeg()
          .input(lastFramePath)
          .inputOptions(['-loop', '1'])
          .input(reactionPath)
          .outputOptions([
            '-filter_complex', filterComplex,
            '-map', '[outv]',
            '-map', '1:a',
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '23',
            '-c:a', 'aac',
            '-ar', '44100',
            '-ac', '2',
            '-b:a', '128k',
            '-t', String(reactionDuration),
            '-movflags', '+faststart',
            '-y'
          ])
          .on('start', (cmd) => {
            console.log('Creating PiP segment with command:', cmd);
          })
          .on('progress', (progress) => {
            if (progress.percent) {
              console.log(`  PiP rendering: ${Math.round(progress.percent)}%`);
            }
          })
          .on('end', async () => {
            // Cleanup last frame
            await fs.remove(lastFramePath).catch(() => {});
            console.log('PiP segment created successfully');
            resolve(outputPath);
          })
          .on('error', async (err) => {
            await fs.remove(lastFramePath).catch(() => {});
            console.error('PiP segment error:', err);
            reject(err);
          })
          .save(outputPath);
      });
      
    } catch (error) {
      await fs.remove(lastFramePath).catch(() => {});
      console.error('createPipSegment error:', error);
      throw error;
    }
  }

  /**
   * Combine original clips with reaction clips
   * 
   * Supports two modes:
   * - 'sequential' (default): clip1 → reaction1_fullscreen → clip2 → reaction2_fullscreen
   * - 'pip': clip1 → frozen_frame + reaction1_pip → clip2 → frozen_frame + reaction2_pip
   * 
   * @param {string[]} originalClips - Array of original clip paths
   * @param {string[]} reactionClips - Array of reaction clip paths (can have nulls)
   * @param {string} jobId - Optional job ID
   * @param {object} options - Options including mode ('sequential' or 'pip')
   */
  async combineClipsWithReactions(originalClips, reactionClips, jobId = null, options = {}) {
    jobId = jobId || uuidv4();
    const workDir = path.join(this.tempDir, jobId);
    await fs.ensureDir(workDir);

    // Mode: 'sequential' (original) or 'pip' (new)
    const mode = options.mode || 'sequential';
    
    // Target resolution (default 1080x1920 for vertical/portrait)
    const targetWidth = options.targetWidth || 1080;
    const targetHeight = options.targetHeight || 1920;

    console.log(`\n========================================`);
    console.log(`Combine Mode: ${mode.toUpperCase()}`);
    console.log(`========================================\n`);

    try {
      console.log(`Combining ${originalClips.length} clips with ${reactionClips.length} reactions...`);
      console.log(`Target resolution: ${targetWidth}x${targetHeight}`);

      const processedClips = [];
      
      for (let i = 0; i < originalClips.length; i++) {
        const originalPath = originalClips[i];
        const reactionPath = reactionClips[i];
        
        console.log(`\n--- Processing clip ${i + 1}/${originalClips.length} ---`);
        console.log(`Original: ${originalPath}`);
        console.log(`Reaction: ${reactionPath || 'none'}`);
        
        // Normalize original clip
        const normalizedOriginalPath = path.join(workDir, `normalized_original_${i}.mp4`);
        console.log('Normalizing original clip...');
        await this.normalizeClip(originalPath, normalizedOriginalPath, targetWidth, targetHeight);
        processedClips.push(normalizedOriginalPath);
        
        // Process reaction if exists
        if (reactionPath && await fs.pathExists(reactionPath)) {
          if (mode === 'pip') {
            // PiP MODE: Create frozen frame + reaction overlay segment
            const pipSegmentPath = path.join(workDir, `pip_segment_${i}.mp4`);
            console.log('Creating PiP segment (frozen frame + reaction overlay)...');
            
            // Use the NORMALIZED clip for frame extraction (ensures consistent format)
            await this.createPipSegment(
              normalizedOriginalPath,  // Use normalized clip for frame extraction
              reactionPath,
              pipSegmentPath,
              targetWidth,
              targetHeight
            );
            processedClips.push(pipSegmentPath);
          } else {
            // SEQUENTIAL MODE: Normalize and add full reaction video
            const normalizedReactionPath = path.join(workDir, `normalized_reaction_${i}.mp4`);
            console.log('Normalizing reaction clip (sequential mode)...');
            await this.normalizeClip(reactionPath, normalizedReactionPath, targetWidth, targetHeight);
            processedClips.push(normalizedReactionPath);
          }
        } else {
          console.log('No reaction for this clip, skipping reaction segment');
        }
      }

      console.log(`\nTotal segments to concatenate: ${processedClips.length}`);

      // Create concat file
      const concatFilePath = path.join(workDir, 'concat.txt');
      const concatContent = processedClips
        .map(clipPath => `file '${clipPath}'`)
        .join('\n');
      
      await fs.writeFile(concatFilePath, concatContent);

      // Concatenate all clips
      const outputPath = path.join(workDir, 'final_combined.mp4');
      await this.concatenateClips(concatFilePath, outputPath);

      // Get file info
      const stats = await fs.stat(outputPath);

      return {
        jobId,
        mode,
        outputPath,
        segmentCount: processedClips.length,
        originalCount: originalClips.length,
        reactionCount: reactionClips.filter(c => c).length,
        fileSize: stats.size,
        downloadUrl: `/api/combine/${jobId}/download`
      };

    } catch (error) {
      console.error('Combine error:', error);
      // Cleanup on error
      await fs.remove(workDir).catch(() => {});
      throw error;
    }
  }

  /**
   * Normalize a clip to consistent format for concatenation
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
   * Concatenate clips using FFmpeg concat demuxer
   */
  async concatenateClips(concatFilePath, outputPath) {
    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatFilePath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions([
          '-c', 'copy',
          '-movflags', '+faststart',
          '-y'
        ])
        .on('start', (cmd) => {
          console.log('Concatenating with command:', cmd);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            console.log(`  Concatenating: ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => {
          console.log('Clips concatenated successfully');
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error('Concatenation error:', err);
          reject(err);
        })
        .save(outputPath);
    });
  }

  /**
   * Get the output path for a job
   */
  getOutputPath(jobId) {
    return path.join(this.tempDir, jobId, 'final_combined.mp4');
  }

  /**
   * Cleanup job files
   */
  async cleanup(jobId) {
    const workDir = path.join(this.tempDir, jobId);
    await fs.remove(workDir);
    console.log(`Cleaned up job: ${jobId}`);
  }
}

module.exports = new CombineService();
