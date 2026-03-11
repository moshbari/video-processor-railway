/**
 * Single Reaction Service
 * 
 * Handles full-length reaction videos with TWO layout modes:
 * 
 * 1. "Watch & React" Mode (watchReact):
 *    - Main video is FULL SCREEN (background)
 *    - Reaction video is small PiP in corner
 *    - Main video freezes on last frame when it ends
 *    - Reaction continues over frozen frame
 * 
 * 2. "Face Cam" Mode (faceCam):
 *    - Reaction video is FULL SCREEN (background) - person watching phone
 *    - Main video is small PiP in corner
 *    - Main video freezes on last frame when it ends
 *    - Reaction continues over frozen frame
 * 
 * Both modes: No splitting, no timestamps - just simple overlay
 */

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

class SingleReactionService {
  constructor() {
    this.tempDir = process.env.TEMP_DIR || '/app/temp';
    fs.ensureDirSync(this.tempDir);
  }

  /**
   * Get video duration in seconds
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
   * Get video dimensions
   */
  async getVideoDimensions(videoPath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) reject(err);
        else {
          const videoStream = metadata.streams.find(s => s.codec_type === 'video');
          if (videoStream) {
            resolve({
              width: videoStream.width,
              height: videoStream.height
            });
          } else {
            reject(new Error('No video stream found'));
          }
        }
      });
    });
  }

  /**
   * Extract the last frame of a video as an image
   * Uses a more robust approach that works with various video formats
   */
  async extractLastFrame(videoPath, outputPath, duration) {
    // Method 1: Try seeking to near the end
    // Use -sseof to seek from end of file (more reliable)
    const seekFromEnd = -0.5; // 0.5 seconds before end
    
    try {
      // First attempt: Use -sseof (seek from end)
      const cmd1 = `ffmpeg -sseof ${seekFromEnd} -i "${videoPath}" -update 1 -q:v 2 -frames:v 1 -y "${outputPath}"`;
      console.log('Extracting last frame (method 1 - sseof):', cmd1);
      await execPromise(cmd1);
      
      if (await fs.pathExists(outputPath)) {
        const stats = await fs.stat(outputPath);
        if (stats.size > 0) {
          console.log('  ✓ Last frame extracted successfully (method 1)');
          return outputPath;
        }
      }
    } catch (err) {
      console.log('  Method 1 failed, trying method 2...');
    }

    try {
      // Second attempt: Seek to specific time near end
      const seekTime = Math.max(0, duration - 0.5);
      const cmd2 = `ffmpeg -ss ${seekTime} -i "${videoPath}" -frames:v 1 -q:v 2 -y "${outputPath}"`;
      console.log('Extracting last frame (method 2 - ss time):', cmd2);
      await execPromise(cmd2);
      
      if (await fs.pathExists(outputPath)) {
        const stats = await fs.stat(outputPath);
        if (stats.size > 0) {
          console.log('  ✓ Last frame extracted successfully (method 2)');
          return outputPath;
        }
      }
    } catch (err) {
      console.log('  Method 2 failed, trying method 3...');
    }

    try {
      // Third attempt: Input seeking (slower but more compatible)
      const seekTime = Math.max(0, duration - 0.5);
      const cmd3 = `ffmpeg -i "${videoPath}" -ss ${seekTime} -frames:v 1 -q:v 2 -y "${outputPath}"`;
      console.log('Extracting last frame (method 3 - input seek):', cmd3);
      await execPromise(cmd3);
      
      if (await fs.pathExists(outputPath)) {
        const stats = await fs.stat(outputPath);
        if (stats.size > 0) {
          console.log('  ✓ Last frame extracted successfully (method 3)');
          return outputPath;
        }
      }
    } catch (err) {
      console.log('  Method 3 failed, trying method 4...');
    }

    try {
      // Fourth attempt: Use select filter to get last frame
      const cmd4 = `ffmpeg -i "${videoPath}" -vf "select='eq(n,0)'" -frames:v 1 -ss ${Math.max(0, duration - 1)} -q:v 2 -y "${outputPath}"`;
      console.log('Extracting last frame (method 4 - select filter):', cmd4);
      await execPromise(cmd4);
      
      if (await fs.pathExists(outputPath)) {
        const stats = await fs.stat(outputPath);
        if (stats.size > 0) {
          console.log('  ✓ Last frame extracted successfully (method 4)');
          return outputPath;
        }
      }
    } catch (err) {
      console.log('  Method 4 failed...');
    }

    // Final check
    if (!await fs.pathExists(outputPath)) {
      throw new Error(`Failed to extract last frame from video. Duration: ${duration}s`);
    }
    
    const finalStats = await fs.stat(outputPath);
    if (finalStats.size === 0) {
      await fs.remove(outputPath).catch(() => {});
      throw new Error(`Extracted frame is empty (0 bytes). Duration: ${duration}s`);
    }
    
    return outputPath;
  }

  /**
   * Create extended main video (original + frozen last frame)
   * 
   * @param {string} mainVideoPath - Path to main video
   * @param {string} lastFramePath - Path to last frame image
   * @param {number} mainDuration - Duration of main video
   * @param {number} totalDuration - Total duration needed (reaction video length)
   * @param {string} outputPath - Output path for extended video
   */
  async createExtendedMainVideo(mainVideoPath, lastFramePath, mainDuration, totalDuration, outputPath, dimensions) {
    const freezeDuration = totalDuration - mainDuration;
    console.log(`Creating extended video: ${mainDuration.toFixed(2)}s video + ${freezeDuration.toFixed(2)}s frozen frame`);

    // Create frozen frame video segment
    const frozenPath = outputPath.replace('.mp4', '_frozen.mp4');
    
    // Pass 1: Create frozen frame video with silent audio
    const frozenCmd = `ffmpeg -loop 1 -i "${lastFramePath}" -f lavfi -i anullsrc=r=48000:cl=stereo -t ${freezeDuration} -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -r 30 -c:a aac -ar 48000 -ac 2 -b:a 192k -shortest -y "${frozenPath}"`;
    console.log('Creating frozen segment:', frozenCmd);
    await execPromise(frozenCmd);

    // Normalize main video to same format
    const normalizedMainPath = outputPath.replace('.mp4', '_normalized.mp4');
    const normalizeCmd = `ffmpeg -i "${mainVideoPath}" -vf "scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=decrease,pad=${dimensions.width}:${dimensions.height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1" -r 30 -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2 -b:a 192k -y "${normalizedMainPath}"`;
    console.log('Normalizing main video:', normalizeCmd);
    await execPromise(normalizeCmd);

    // Create concat file
    const concatFilePath = outputPath.replace('.mp4', '_concat.txt');
    const concatContent = `file '${normalizedMainPath}'\nfile '${frozenPath}'`;
    await fs.writeFile(concatFilePath, concatContent);

    // Concatenate main video + frozen segment
    const concatCmd = `ffmpeg -f concat -safe 0 -i "${concatFilePath}" -c copy -movflags +faststart -y "${outputPath}"`;
    console.log('Concatenating:', concatCmd);
    await execPromise(concatCmd);

    // Cleanup temp files
    await fs.remove(frozenPath).catch(() => {});
    await fs.remove(normalizedMainPath).catch(() => {});
    await fs.remove(concatFilePath).catch(() => {});

    return outputPath;
  }

  /**
   * Get PiP overlay coordinates based on position
   */
  getPipCoordinates(position, mainWidth, mainHeight, pipWidth, pipHeight) {
    const padding = 20; // Padding from edges
    
    const positions = {
      'top-right': { x: mainWidth - pipWidth - padding, y: padding },
      'top-left': { x: padding, y: padding },
      'bottom-right': { x: mainWidth - pipWidth - padding, y: mainHeight - pipHeight - padding },
      'bottom-left': { x: padding, y: mainHeight - pipHeight - padding }
    };

    if (position === 'random') {
      const keys = ['top-right', 'top-left', 'bottom-right', 'bottom-left'];
      position = keys[Math.floor(Math.random() * keys.length)];
      console.log(`Random position selected: ${position}`);
    }

    return positions[position] || positions['top-right'];
  }

  /**
   * Create the final PiP video - SINGLE PASS with MIXED AUDIO
   * 
   * Mixes BOTH audio tracks together:
   * - Main/background video audio
   * - Reaction/PiP video audio
   * 
   * @param {string} backgroundVideoPath - Path to full-screen background video
   * @param {string} pipVideoPath - Path to PiP overlay video
   * @param {string} outputPath - Output path for final video
   * @param {string} pipPosition - Corner position for PiP
   * @param {object} dimensions - Target dimensions (from background video)
   * @param {number} pipScale - PiP size as percentage of background width (default 35%)
   * @param {string} workDir - Working directory for temp files (unused in single pass)
   */
  async createPipVideo(backgroundVideoPath, pipVideoPath, outputPath, pipPosition, dimensions, pipScale = 35, audioSource = 'both', workDir = null) {
    const { width: bgWidth, height: bgHeight } = dimensions;
    const pipWidth = Math.round(bgWidth * (pipScale / 100));
    const pipHeight = Math.round(pipWidth * (bgHeight / bgWidth)); // Maintain aspect ratio
    
    const coords = this.getPipCoordinates(pipPosition, bgWidth, bgHeight, pipWidth, pipHeight);
    
    console.log(`\n=== SINGLE PASS PiP Creation (Mixed Audio) ===`);
    console.log(`Background: ${bgWidth}x${bgHeight}`);
    console.log(`PiP size: ${pipWidth}x${pipHeight}`);
    console.log(`PiP position: (${coords.x}, ${coords.y})`);
    console.log(`Audio: BOTH tracks mixed together`);

    // Filter complex:
    // 1. Scale PiP video and overlay on background
    // 2. Mix both audio tracks together (amerge + pan for stereo output)
    const filterComplex = [
      // Video: scale PiP and overlay
      `[1:v]scale=${pipWidth}:${pipHeight}[pip]`,
      `[0:v][pip]overlay=${coords.x}:${coords.y}[outv]`,
      // Audio: mix both tracks together
      `[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0[outa]`
    ].join(';');

    const cmd = `ffmpeg -i "${backgroundVideoPath}" -i "${pipVideoPath}" -filter_complex "${filterComplex}" -map "[outv]" -map "[outa]" -c:v libx264 -preset fast -crf 23 -c:a aac -ar 48000 -ac 2 -b:a 192k -movflags +faststart -y "${outputPath}"`;
    
    console.log('Creating PiP video (single pass):', cmd);
    await execPromise(cmd);

    if (!await fs.pathExists(outputPath)) {
      throw new Error('Failed to create PiP video');
    }

    const stats = await fs.stat(outputPath);
    console.log(`✓ PiP video created - ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    console.log('=== SINGLE PASS Complete ===\n');

    return outputPath;
  }

  /**
   * Main function: Create single reaction PiP video
   * 
   * @param {string} mainVideoPath - Path to main/original video
   * @param {string} reactionVideoPath - Path to reaction video (longer than main)
   * @param {object} options - Options including layoutMode, pipPosition, pipScale
   */
  async createSingleReactionVideo(mainVideoPath, reactionVideoPath, options = {}) {
    const jobId = options.jobId || uuidv4();
    const workDir = path.join(this.tempDir, jobId);
    await fs.ensureDir(workDir);

    const pipPosition = options.pipPosition || 'top-right';
    const pipScale = options.pipScale || 35;
    
    // NEW: Layout mode - 'watchReact' (default) or 'faceCam'
    const layoutMode = options.layoutMode || 'watchReact';

    console.log(`\n${'='.repeat(60)}`);
    console.log(`SINGLE REACTION - Job: ${jobId}`);
    console.log(`Layout Mode: ${layoutMode === 'watchReact' ? '👀 Watch & React' : '🤳 Face Cam'}`);
    console.log(`Position: ${pipPosition}, Scale: ${pipScale}%`);
    console.log(`${'='.repeat(60)}\n`);

    try {
      // Step 1: Get video info
      console.log('Step 1: Analyzing videos...');
      const [mainDuration, reactionDuration, mainDimensions, reactionDimensions] = await Promise.all([
        this.getVideoDuration(mainVideoPath),
        this.getVideoDuration(reactionVideoPath),
        this.getVideoDimensions(mainVideoPath),
        this.getVideoDimensions(reactionVideoPath)
      ]);

      console.log(`  Main video: ${mainDuration.toFixed(2)}s (${mainDimensions.width}x${mainDimensions.height})`);
      console.log(`  Reaction video: ${reactionDuration.toFixed(2)}s (${reactionDimensions.width}x${reactionDimensions.height})`);

      // Determine which video needs extending (the one that ends first)
      const totalDuration = Math.max(mainDuration, reactionDuration);
      const needsMainFreeze = reactionDuration > mainDuration;

      if (layoutMode === 'watchReact') {
        // ===== WATCH & REACT MODE =====
        // Main video = full screen (background)
        // Reaction = PiP overlay
        // Main video freezes if shorter
        
        console.log('\n📺 WATCH & REACT MODE');
        console.log('   Main video: FULL SCREEN');
        console.log('   Reaction: PiP corner');

        let backgroundPath = mainVideoPath;
        const backgroundDimensions = mainDimensions;

        if (needsMainFreeze) {
          console.log('\nStep 2: Main video is shorter - extending with frozen frame...');
          const lastFramePath = path.join(workDir, 'main_last_frame.jpg');
          await this.extractLastFrame(mainVideoPath, lastFramePath, mainDuration);
          
          backgroundPath = path.join(workDir, 'extended_main.mp4');
          await this.createExtendedMainVideo(
            mainVideoPath,
            lastFramePath,
            mainDuration,
            totalDuration,
            backgroundPath,
            mainDimensions
          );
          await fs.remove(lastFramePath).catch(() => {});
          console.log('  ✓ Extended main video created');
        } else {
          console.log('\nStep 2: Skipped (main video is longer or equal)');
        }

        // Step 3: Create PiP overlay (reaction on top of main)
        console.log('\nStep 3: Creating PiP overlay (reaction in corner)...');
        const outputPath = path.join(workDir, 'final_single_reaction.mp4');
        await this.createPipVideo(
          backgroundPath,
          reactionVideoPath,
          outputPath,
          pipPosition,
          backgroundDimensions,
          pipScale,
          'pip',  // Audio from reaction (PiP)
          workDir  // Pass workDir for temp files
        );

        // Cleanup
        if (needsMainFreeze && backgroundPath !== mainVideoPath) {
          await fs.remove(backgroundPath).catch(() => {});
        }

        return this.buildResult(jobId, outputPath, {
          layoutMode,
          pipPosition,
          pipScale,
          mainDuration,
          reactionDuration,
          totalDuration,
          frozenFrameDuration: needsMainFreeze ? totalDuration - mainDuration : 0
        });

      } else {
        // ===== FACE CAM MODE =====
        // Reaction video = full screen (background) - person watching phone
        // Main video = PiP overlay
        // Main video freezes if shorter
        
        console.log('\n🤳 FACE CAM MODE');
        console.log('   Reaction: FULL SCREEN (person with phone)');
        console.log('   Main video: PiP corner');

        let pipPath = mainVideoPath;
        const backgroundDimensions = reactionDimensions;

        if (needsMainFreeze) {
          console.log('\nStep 2: Main video is shorter - extending with frozen frame...');
          const lastFramePath = path.join(workDir, 'main_last_frame.jpg');
          await this.extractLastFrame(mainVideoPath, lastFramePath, mainDuration);
          
          // For Face Cam, we need to extend main video to match reaction length
          // This extended main becomes the PiP
          pipPath = path.join(workDir, 'extended_main_pip.mp4');
          await this.createExtendedMainVideo(
            mainVideoPath,
            lastFramePath,
            mainDuration,
            totalDuration,
            pipPath,
            mainDimensions
          );
          await fs.remove(lastFramePath).catch(() => {});
          console.log('  ✓ Extended main video (for PiP) created');
        } else {
          console.log('\nStep 2: Skipped (main video is longer or equal)');
        }

        // Step 3: Create PiP overlay (main video on top of reaction)
        console.log('\nStep 3: Creating PiP overlay (main video in corner)...');
        const outputPath = path.join(workDir, 'final_single_reaction.mp4');
        await this.createPipVideo(
          reactionVideoPath,  // Reaction is background (full screen)
          pipPath,            // Main video is PiP
          outputPath,
          pipPosition,
          backgroundDimensions,
          pipScale,
          'background',  // Audio from reaction (which is now background)
          workDir  // Pass workDir for temp files
        );

        // Cleanup
        if (needsMainFreeze && pipPath !== mainVideoPath) {
          await fs.remove(pipPath).catch(() => {});
        }

        return this.buildResult(jobId, outputPath, {
          layoutMode,
          pipPosition,
          pipScale,
          mainDuration,
          reactionDuration,
          totalDuration,
          frozenFrameDuration: needsMainFreeze ? totalDuration - mainDuration : 0
        });
      }

    } catch (error) {
      console.error('Single reaction error:', error);
      await fs.remove(workDir).catch(() => {});
      throw error;
    }
  }

  /**
   * Build the result object
   */
  async buildResult(jobId, outputPath, stats) {
    const fileStats = await fs.stat(outputPath);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`✓ COMPLETE - ${(fileStats.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`${'='.repeat(60)}\n`);

    return {
      success: true,
      jobId,
      outputPath,
      layoutMode: stats.layoutMode,
      layoutModeName: stats.layoutMode === 'watchReact' ? 'Watch & React' : 'Face Cam',
      pipPosition: stats.pipPosition,
      pipScale: stats.pipScale,
      mainDuration: stats.mainDuration,
      reactionDuration: stats.reactionDuration,
      totalDuration: stats.totalDuration,
      frozenFrameDuration: stats.frozenFrameDuration,
      fileSize: fileStats.size,
      fileSizeMB: (fileStats.size / 1024 / 1024).toFixed(2),
      downloadUrl: `/api/single-reaction/${jobId}/download`
    };
  }

  /**
   * Get output path for a job
   */
  getOutputPath(jobId) {
    return path.join(this.tempDir, jobId, 'final_single_reaction.mp4');
  }

  /**
   * Cleanup job files
   */
  async cleanup(jobId) {
    const workDir = path.join(this.tempDir, jobId);
    await fs.remove(workDir);
    console.log(`Cleaned up single reaction job: ${jobId}`);
  }
}

module.exports = new SingleReactionService();
