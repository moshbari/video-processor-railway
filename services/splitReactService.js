/**
 * ⚡ SPLIT REACT Service ⚡
 * 
 * Creates reaction videos with TWO separate reaction clips:
 * 1. Watch Clip - User watching the original video (synced with original, auto-trimmed if longer)
 * 2. React Clip - User's reaction after the video ends (plays over frozen last frame)
 * 
 * Supports two layout modes:
 * - watchReact: Original video full screen, user clips in PiP corner
 * - faceCam: User clips full screen, original video in PiP corner
 * 
 * Final output structure:
 * [Original plays WITH Watch Clip as PiP] → [Freeze last frame + React Clip plays]
 * 
 * Part of RANT Squad Video Editor
 */

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

class TwoClipReactionService {
  constructor() {
    this.tempDir = process.env.TEMP_DIR || '/app/temp';
    this.outputDir = process.env.OUTPUT_DIR || '/app/outputs';
  }

  /**
   * Get video duration using ffprobe
   */
  async getVideoDuration(videoPath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          console.error('ffprobe error:', err);
          return reject(err);
        }
        const duration = metadata.format.duration;
        console.log(`Duration of ${path.basename(videoPath)}: ${duration}s`);
        resolve(duration);
      });
    });
  }

  /**
   * Get video dimensions using ffprobe
   */
  async getVideoDimensions(videoPath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) return reject(err);
        const videoStream = metadata.streams.find(s => s.codec_type === 'video');
        if (!videoStream) return reject(new Error('No video stream found'));
        resolve({
          width: videoStream.width,
          height: videoStream.height
        });
      });
    });
  }

  /**
   * Trim video to specified duration
   */
  async trimVideo(inputPath, outputPath, duration) {
    console.log(`Trimming video to ${duration}s: ${inputPath}`);
    
    const cmd = `ffmpeg -y -i "${inputPath}" -t ${duration} -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k "${outputPath}"`;
    
    try {
      await execPromise(cmd);
      console.log(`✓ Trimmed video saved: ${outputPath}`);
      return outputPath;
    } catch (error) {
      console.error('Trim error:', error);
      throw error;
    }
  }

  /**
   * Extract last frame from video as JPG
   */
  async extractLastFrame(videoPath, outputPath, duration) {
    console.log(`Extracting last frame from ${videoPath} at ${duration}s`);
    
    // Seek to slightly before the end to ensure we get a frame
    const seekTime = Math.max(0, duration - 0.1);
    const cmd = `ffmpeg -y -ss ${seekTime} -i "${inputPath}" -vframes 1 -q:v 2 "${outputPath}"`;
    
    try {
      await execPromise(cmd.replace('${inputPath}', videoPath));
      console.log(`✓ Last frame extracted: ${outputPath}`);
      return outputPath;
    } catch (error) {
      console.error('Frame extraction error:', error);
      throw error;
    }
  }

  /**
   * Calculate PiP coordinates based on position and dimensions
   */
  getPipCoordinates(position, mainWidth, mainHeight, pipWidth, pipHeight) {
    const padding = 20;
    
    const positions = {
      'top-right': { x: mainWidth - pipWidth - padding, y: padding },
      'top-left': { x: padding, y: padding },
      'bottom-right': { x: mainWidth - pipWidth - padding, y: mainHeight - pipHeight - padding },
      'bottom-left': { x: padding, y: mainHeight - pipHeight - padding },
      'random': null
    };

    if (position === 'random') {
      const keys = ['top-right', 'top-left', 'bottom-right', 'bottom-left'];
      const randomKey = keys[Math.floor(Math.random() * keys.length)];
      return positions[randomKey];
    }

    return positions[position] || positions['top-right'];
  }

  /**
   * Main method: Create two-clip reaction video
   * 
   * @param {string} originalVideoPath - Path to original video
   * @param {string} watchClipPath - Path to user's "watching" clip
   * @param {string} reactClipPath - Path to user's "reaction" clip
   * @param {object} options - Configuration options
   * @returns {object} Result with output path and metadata
   */
  async createTwoClipReactionVideo(originalVideoPath, watchClipPath, reactClipPath, options = {}) {
    const {
      layoutMode = 'watchReact',  // 'watchReact' or 'faceCam'
      pipPosition = 'top-right',
      pipScale = 35
    } = options;

    const jobId = uuidv4();
    const workDir = path.join(this.tempDir, jobId);
    await fs.ensureDir(workDir);

    console.log(`\n========================================`);
    console.log(`⚡ SPLIT REACT - Job: ${jobId}`);
    console.log(`Layout Mode: ${layoutMode === 'watchReact' ? '👀 Watch & React' : '🤳 Face Cam'}`);
    console.log(`PiP Position: ${pipPosition}, Scale: ${pipScale}%`);
    console.log(`========================================\n`);

    try {
      // Step 1: Get durations of all videos
      console.log('Step 1: Getting video durations...');
      const originalDuration = await this.getVideoDuration(originalVideoPath);
      const watchDuration = await this.getVideoDuration(watchClipPath);
      const reactDuration = await this.getVideoDuration(reactClipPath);

      console.log(`  Original: ${originalDuration.toFixed(2)}s`);
      console.log(`  Watch Clip: ${watchDuration.toFixed(2)}s`);
      console.log(`  React Clip: ${reactDuration.toFixed(2)}s`);

      // Step 2: Trim watch clip if longer than original
      let finalWatchClipPath = watchClipPath;
      if (watchDuration > originalDuration) {
        console.log(`\nStep 2: Trimming watch clip to match original (${originalDuration.toFixed(2)}s)...`);
        const trimmedPath = path.join(workDir, 'watch_trimmed.mp4');
        await this.trimVideo(watchClipPath, trimmedPath, originalDuration);
        finalWatchClipPath = trimmedPath;
      } else {
        console.log('\nStep 2: Watch clip is same length or shorter - no trimming needed');
      }

      // Step 3: Get dimensions
      console.log('\nStep 3: Getting video dimensions...');
      const originalDims = await this.getVideoDimensions(originalVideoPath);
      const watchDims = await this.getVideoDimensions(finalWatchClipPath);
      const reactDims = await this.getVideoDimensions(reactClipPath);

      console.log(`  Original: ${originalDims.width}x${originalDims.height}`);
      console.log(`  Watch: ${watchDims.width}x${watchDims.height}`);
      console.log(`  React: ${reactDims.width}x${reactDims.height}`);

      // Step 4: Calculate target dimensions and PiP size
      // Use 1920x1080 as target or original dimensions, whichever is smaller
      const targetWidth = Math.min(originalDims.width, 1920);
      const targetHeight = Math.min(originalDims.height, 1080);
      
      // Calculate PiP dimensions (maintaining aspect ratio)
      const pipTargetWidth = Math.round(targetWidth * (pipScale / 100));
      
      // Step 5: Create Part 1 - Original video with Watch Clip as PiP
      console.log('\nStep 4: Creating Part 1 - Original with Watch Clip PiP overlay...');
      const part1Path = path.join(workDir, 'part1_watching.mp4');
      await this.createPipOverlay(
        originalVideoPath,
        finalWatchClipPath,
        part1Path,
        {
          layoutMode,
          pipPosition,
          pipScale,
          targetWidth,
          targetHeight
        }
      );

      // Step 6: Extract last frame of Part 1 for freeze frame background
      console.log('\nStep 5: Extracting last frame for freeze background...');
      const lastFramePath = path.join(workDir, 'last_frame.jpg');
      await this.extractLastFrameRaw(part1Path, lastFramePath);

      // Step 7: Create Part 2 - Freeze frame with React Clip
      console.log('\nStep 6: Creating Part 2 - Freeze frame with React Clip...');
      const part2Path = path.join(workDir, 'part2_reacting.mp4');
      await this.createFreezeWithReaction(
        lastFramePath,
        reactClipPath,
        part2Path,
        {
          layoutMode,
          pipPosition,
          pipScale,
          targetWidth,
          targetHeight,
          duration: reactDuration
        }
      );

      // Step 8: Concatenate Part 1 and Part 2
      console.log('\nStep 7: Concatenating parts into final video...');
      const finalPath = path.join(workDir, 'final_two_clip_reaction.mp4');
      await this.concatenateVideos([part1Path, part2Path], finalPath);

      // Get final file stats
      const stats = await fs.stat(finalPath);
      const finalDuration = await this.getVideoDuration(finalPath);

      console.log(`\n========================================`);
      console.log(`✓ SPLIT REACT COMPLETE`);
      console.log(`  Job ID: ${jobId}`);
      console.log(`  Duration: ${finalDuration.toFixed(2)}s`);
      console.log(`  File Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
      console.log(`========================================\n`);

      return {
        success: true,
        jobId,
        outputPath: finalPath,
        layoutMode,
        layoutModeName: layoutMode === 'watchReact' ? 'Watch & React' : 'Face Cam',
        originalDuration,
        watchClipDuration: originalDuration, // After trim
        reactClipDuration: reactDuration,
        totalDuration: finalDuration,
        fileSize: stats.size,
        fileSizeMB: (stats.size / 1024 / 1024).toFixed(2),
        downloadUrl: `/api/split-react/${jobId}/download`
      };

    } catch (error) {
      console.error('Two clip reaction error:', error);
      await fs.remove(workDir).catch(() => {});
      throw error;
    }
  }

  /**
   * Create PiP overlay video (Original + Watch clip)
   */
  async createPipOverlay(mainVideoPath, overlayVideoPath, outputPath, options) {
    const { layoutMode, pipPosition, pipScale, targetWidth, targetHeight } = options;

    // Determine which video is background and which is PiP based on layout mode
    const bgVideo = layoutMode === 'watchReact' ? mainVideoPath : overlayVideoPath;
    const pipVideo = layoutMode === 'watchReact' ? overlayVideoPath : mainVideoPath;

    // Calculate PiP dimensions
    const pipWidth = Math.round(targetWidth * (pipScale / 100));
    const pipHeight = Math.round(pipWidth * (9/16)); // Assuming 16:9 aspect ratio for PiP

    // Get PiP coordinates
    const coords = this.getPipCoordinates(pipPosition, targetWidth, targetHeight, pipWidth, pipHeight);

    console.log(`  Background: ${layoutMode === 'watchReact' ? 'Original' : 'Watch Clip'}`);
    console.log(`  PiP: ${layoutMode === 'watchReact' ? 'Watch Clip' : 'Original'}`);
    console.log(`  PiP Size: ${pipWidth}x${pipHeight} at (${coords.x}, ${coords.y})`);

    // FFmpeg command with complex filter
    const filterComplex = [
      // Scale background to target size
      `[0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1[bg]`,
      // Scale PiP video
      `[1:v]scale=${pipWidth}:-2,setsar=1[pip]`,
      // Overlay PiP on background
      `[bg][pip]overlay=${coords.x}:${coords.y}:shortest=1[outv]`
    ].join(';');

    const cmd = `ffmpeg -y -i "${bgVideo}" -i "${pipVideo}" -filter_complex "${filterComplex}" -map "[outv]" -map 0:a? -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -shortest "${outputPath}"`;

    try {
      await execPromise(cmd);
      console.log(`  ✓ Part 1 created: ${outputPath}`);
      return outputPath;
    } catch (error) {
      console.error('PiP overlay error:', error);
      throw error;
    }
  }

  /**
   * Extract last frame using raw ffmpeg command
   */
  async extractLastFrameRaw(videoPath, outputPath) {
    const duration = await this.getVideoDuration(videoPath);
    const seekTime = Math.max(0, duration - 0.1);

    const cmd = `ffmpeg -y -ss ${seekTime} -i "${videoPath}" -vframes 1 -q:v 2 "${outputPath}"`;

    try {
      await execPromise(cmd);
      console.log(`  ✓ Last frame extracted: ${outputPath}`);
      return outputPath;
    } catch (error) {
      console.error('Frame extraction error:', error);
      throw error;
    }
  }

  /**
   * Create freeze frame video with reaction clip overlay
   */
  async createFreezeWithReaction(framePath, reactClipPath, outputPath, options) {
    const { layoutMode, pipPosition, pipScale, targetWidth, targetHeight, duration } = options;

    // Calculate PiP dimensions
    const pipWidth = Math.round(targetWidth * (pipScale / 100));
    const pipHeight = Math.round(pipWidth * (9/16));

    // Get PiP coordinates
    const coords = this.getPipCoordinates(pipPosition, targetWidth, targetHeight, pipWidth, pipHeight);

    // Three-pass method for reliable audio-video sync
    // Pass 1: Create background video from freeze frame
    const bgVideoPath = outputPath.replace('.mp4', '_bg.mp4');
    
    // In Face Cam mode, the reaction is full screen and original (freeze) is PiP
    // In Watch & React mode, the freeze frame is full screen and reaction is PiP
    
    if (layoutMode === 'faceCam') {
      // Face Cam: React clip full screen, freeze frame as PiP
      console.log(`  Creating Face Cam layout (React full screen, freeze as PiP)...`);
      
      // Escape the frame path for FFmpeg movie filter (replace spaces and special chars)
      const escapedFramePath = framePath.replace(/\\/g, '/').replace(/'/g, "'\\''");
      
      const filterComplex = [
        // Scale react clip to full screen
        `[0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,setsar=1[bg]`,
        // Loop freeze frame and scale to PiP size - use input instead of movie filter
        `[1:v]scale=${pipWidth}:-2,setsar=1[pip]`,
        // Overlay PiP on background
        `[bg][pip]overlay=${coords.x}:${coords.y}:shortest=1[outv]`
      ].join(';');

      // Use two inputs instead of movie filter to avoid path escaping issues
      const cmd = `ffmpeg -y -i "${reactClipPath}" -loop 1 -t ${duration} -i "${framePath}" -filter_complex "${filterComplex}" -map "[outv]" -map 0:a? -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -t ${duration} "${outputPath}"`;

      await execPromise(cmd);
    } else {
      // Watch & React: Freeze frame full screen, react clip as PiP
      console.log(`  Creating Watch & React layout (Freeze full screen, React as PiP)...`);
      
      // Step 1: Create background video from freeze frame
      const bgCmd = `ffmpeg -y -loop 1 -i "${framePath}" -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -c:v libx264 -preset fast -crf 23 -t ${duration} -pix_fmt yuv420p -c:a aac -shortest "${bgVideoPath}"`;
      await execPromise(bgCmd);

      // Step 2: Overlay react clip on background
      const filterComplex = [
        `[1:v]scale=${pipWidth}:-2,setsar=1[pip]`,
        `[0:v][pip]overlay=${coords.x}:${coords.y}:shortest=1[outv]`
      ].join(';');

      const cmd = `ffmpeg -y -i "${bgVideoPath}" -i "${reactClipPath}" -filter_complex "${filterComplex}" -map "[outv]" -map 1:a? -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k "${outputPath}"`;

      await execPromise(cmd);

      // Cleanup background video
      await fs.remove(bgVideoPath).catch(() => {});
    }

    console.log(`  ✓ Part 2 created: ${outputPath}`);
    return outputPath;
  }

  /**
   * Concatenate multiple videos into one
   */
  async concatenateVideos(videoPaths, outputPath) {
    const workDir = path.dirname(outputPath);
    const concatListPath = path.join(workDir, 'concat_list.txt');

    // Create concat list file
    const concatContent = videoPaths.map(p => `file '${p}'`).join('\n');
    await fs.writeFile(concatListPath, concatContent);

    const cmd = `ffmpeg -y -f concat -safe 0 -i "${concatListPath}" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k "${outputPath}"`;

    try {
      await execPromise(cmd);
      console.log(`  ✓ Final video created: ${outputPath}`);
      return outputPath;
    } catch (error) {
      console.error('Concatenation error:', error);
      throw error;
    }
  }

  /**
   * Get output path for a job
   */
  getOutputPath(jobId) {
    return path.join(this.tempDir, jobId, 'final_two_clip_reaction.mp4');
  }

  /**
   * Cleanup job files
   */
  async cleanup(jobId) {
    const workDir = path.join(this.tempDir, jobId);
    await fs.remove(workDir);
    console.log(`Cleaned up Split React job: ${jobId}`);
  }
}

module.exports = new TwoClipReactionService();
