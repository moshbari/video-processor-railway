/**
 * ⚡ SPLIT REACT Service ⚡ - SIMPLIFIED VERSION
 * 
 * Creates reaction videos with TWO separate reaction clips:
 * 1. Watch Clip - User watching the original video
 * 2. React Clip - User's reaction after the video ends
 * 
 * SIMPLIFIED APPROACH:
 * - Clear audio handling at every step
 * - Simple scaling without complex filters
 * - Direct FFmpeg commands with proper audio mapping
 */

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');

/**
 * Run FFmpeg command with spawn
 */
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log(`[FFmpeg] Running: ffmpeg ${args.slice(0, 8).join(' ')}...`);
    
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`FFmpeg failed (code ${code}): ${stderr.slice(-300)}`));
      }
    });
  });
}

class TwoClipReactionService {
  constructor() {
    this.tempDir = process.env.TEMP_DIR || '/app/temp';
  }

  /**
   * Get video duration
   */
  async getVideoDuration(videoPath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) return reject(err);
        resolve(metadata.format.duration);
      });
    });
  }

  /**
   * Main method: Create two-clip reaction video
   */
  async createTwoClipReactionVideo(originalVideoPath, watchClipPath, reactClipPath, options = {}) {
    const {
      layoutMode = 'watchReact',
      pipPosition = 'top-right',
      pipScale = 35
    } = options;

    const jobId = uuidv4();
    const workDir = path.join(this.tempDir, jobId);
    await fs.ensureDir(workDir);

    console.log(`\n========================================`);
    console.log(`⚡ SPLIT REACT - Job: ${jobId}`);
    console.log(`Layout: ${layoutMode}`);
    console.log(`========================================\n`);

    try {
      // Get durations
      const [originalDuration, watchDuration, reactDuration] = await Promise.all([
        this.getVideoDuration(originalVideoPath),
        this.getVideoDuration(watchClipPath),
        this.getVideoDuration(reactClipPath)
      ]);

      console.log(`Original: ${originalDuration.toFixed(2)}s`);
      console.log(`Watch: ${watchDuration.toFixed(2)}s`);
      console.log(`React: ${reactDuration.toFixed(2)}s\n`);

      // Trim watch clip if needed
      let finalWatchPath = watchClipPath;
      if (watchDuration > originalDuration) {
        console.log('Trimming watch clip...');
        finalWatchPath = path.join(workDir, 'watch_trimmed.mp4');
        await this.trimVideo(watchClipPath, finalWatchPath, originalDuration);
      }

      // Target dimensions (portrait 9:16 for social media)
      const targetWidth = 1080;
      const targetHeight = 1920;
      const pipWidth = Math.round(targetWidth * (pipScale / 100));

      // Calculate PiP position
      const coords = this.getPipCoordinates(pipPosition, targetWidth, targetHeight, pipWidth);

      // Extract last frame from original
      console.log('Extracting last frame...');
      const lastFramePath = path.join(workDir, 'last_frame.jpg');
      await this.extractLastFrame(originalVideoPath, lastFramePath, originalDuration);

      // Create Part 1: Original with Watch overlay
      console.log('\n=== PART 1: Original + Watch ===');
      const part1Path = path.join(workDir, 'part1.mp4');
      
      if (layoutMode === 'faceCam') {
        // Face Cam: Watch is background, Original is PiP
        // Audio should come from Original (PiP)
        await this.createSimplePiP(
          finalWatchPath,  // Background (Watch)
          originalVideoPath,  // PiP (Original)
          part1Path,
          targetWidth,
          targetHeight,
          pipWidth,
          coords,
          false  // Audio from PiP (Original)
        );
      } else {
        // Watch & React: Original is background, Watch is PiP
        // Audio should come from Original (background)
        await this.createSimplePiP(
          originalVideoPath,  // Background (Original)
          finalWatchPath,  // PiP (Watch)
          part1Path,
          targetWidth,
          targetHeight,
          pipWidth,
          coords,
          true  // Audio from background (Original)
        );
      }

      // Create Part 2: Freeze frame with React
      console.log('\n=== PART 2: Freeze + React ===');
      const part2Path = path.join(workDir, 'part2.mp4');
      
      if (layoutMode === 'faceCam') {
        // Face Cam: React is background, Freeze is PiP
        await this.createFreezeReact(
          reactClipPath,  // Background
          lastFramePath,  // PiP (frozen)
          part2Path,
          reactDuration,
          targetWidth,
          targetHeight,
          pipWidth,
          coords,
          true  // React is background
        );
      } else {
        // Watch & React: Freeze is background, React is PiP
        await this.createFreezeReact(
          reactClipPath,  // Will be PiP
          lastFramePath,  // Will be background
          part2Path,
          reactDuration,
          targetWidth,
          targetHeight,
          pipWidth,
          coords,
          false  // React is PiP
        );
      }

      // Concatenate Part 1 + Part 2
      console.log('\n=== CONCATENATION ===');
      const finalPath = path.join(workDir, 'final_two_clip_reaction.mp4');
      await this.concatenate(part1Path, part2Path, finalPath);

      const stats = await fs.stat(finalPath);
      const finalDuration = await this.getVideoDuration(finalPath);

      console.log(`\n✓ COMPLETE - ${(stats.size / 1024 / 1024).toFixed(2)} MB\n`);

      return {
        success: true,
        jobId,
        outputPath: finalPath,
        layoutMode,
        originalDuration,
        reactClipDuration: reactDuration,
        totalDuration: finalDuration,
        fileSize: stats.size,
        downloadUrl: `/api/split-react/${jobId}/download`
      };

    } catch (error) {
      console.error('Error:', error.message);
      await fs.remove(workDir).catch(() => {});
      throw error;
    }
  }

  /**
   * Trim video
   */
  async trimVideo(input, output, duration) {
    const args = [
      '-y', '-i', input,
      '-t', duration.toString(),
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      output
    ];
    await runFFmpeg(args);
  }

  /**
   * Extract last frame
   */
  async extractLastFrame(videoPath, outputPath, duration) {
    const seekTime = Math.max(0, duration - 0.5);
    const args = [
      '-y',
      '-ss', seekTime.toString(),
      '-i', videoPath,
      '-vframes', '1',
      '-q:v', '2',
      outputPath
    ];
    await runFFmpeg(args);
  }

  /**
   * Get PiP coordinates
   */
  getPipCoordinates(position, mainWidth, mainHeight, pipWidth) {
    const padding = 20;
    const pipHeight = Math.round(pipWidth * (mainHeight / mainWidth));
    
    const positions = {
      'top-right': { x: mainWidth - pipWidth - padding, y: padding },
      'top-left': { x: padding, y: padding },
      'bottom-right': { x: mainWidth - pipWidth - padding, y: mainHeight - pipHeight - padding },
      'bottom-left': { x: padding, y: mainHeight - pipHeight - padding }
    };

    if (position === 'random') {
      const keys = Object.keys(positions);
      return positions[keys[Math.floor(Math.random() * keys.length)]];
    }

    return positions[position] || positions['top-right'];
  }

  /**
   * Create simple PiP video with GUARANTEED audio
   */
  async createSimplePiP(bgVideo, pipVideo, output, width, height, pipWidth, coords, audioFromBg) {
    console.log(`Background: ${path.basename(bgVideo)}`);
    console.log(`PiP: ${path.basename(pipVideo)}`);
    console.log(`Audio from: ${audioFromBg ? 'Background' : 'PiP'}`);

    // Step 1: Scale background to exact size WITH audio
    const bgScaled = output.replace('.mp4', '_bg.mp4');
    await runFFmpeg([
      '-y', '-i', bgVideo,
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      bgScaled
    ]);

    // Step 2: Scale PiP WITH audio - maintain original aspect ratio
    const pipScaled = output.replace('.mp4', '_pip.mp4');
    await runFFmpeg([
      '-y', '-i', pipVideo,
      '-vf', `scale=${pipWidth}:-2`, // -2 maintains aspect ratio
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      pipScaled
    ]);

    // Step 3: Overlay PiP on background with proper audio selection
    await runFFmpeg([
      '-y',
      '-i', bgScaled,
      '-i', pipScaled,
      '-filter_complex', `[0:v][1:v]overlay=${coords.x}:${coords.y}:shortest=1`,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-map', audioFromBg ? '0:a' : '1:a',
      '-c:a', 'aac', '-b:a', '128k',
      '-shortest',
      output
    ]);

    // Cleanup
    await fs.remove(bgScaled).catch(() => {});
    await fs.remove(pipScaled).catch(() => {});

    console.log('✓ Part created with audio\n');
  }

  /**
   * Create freeze frame + reaction overlay
   */
  async createFreezeReact(reactVideo, freezeFrame, output, duration, width, height, pipWidth, coords, reactIsBg) {
    console.log(`Creating freeze + react (react is ${reactIsBg ? 'background' : 'PiP'})`);

    // Step 1: Create freeze frame video (no audio)
    const freezeVideo = output.replace('.mp4', '_freeze.mp4');
    const freezeScale = reactIsBg 
      ? `scale=${pipWidth}:-2`  // PiP: maintain aspect ratio
      : `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
    
    await runFFmpeg([
      '-y',
      '-loop', '1',
      '-i', freezeFrame,
      '-t', duration.toString(),
      '-vf', freezeScale,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-r', '30',
      '-an',  // No audio
      freezeVideo
    ]);

    // Step 2: Scale reaction video WITH audio
    const reactScaled = output.replace('.mp4', '_react.mp4');
    const reactScale = reactIsBg 
      ? `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`
      : `scale=${pipWidth}:-2`;  // PiP: maintain aspect ratio
    
    await runFFmpeg([
      '-y', '-i', reactVideo,
      '-vf', reactScale,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      reactScaled
    ]);

    // Step 3: Overlay
    let filterComplex;
    if (reactIsBg) {
      // React is background, freeze is PiP
      filterComplex = `[0:v][1:v]overlay=${coords.x}:${coords.y}:shortest=1`;
    } else {
      // Freeze is background, react is PiP
      filterComplex = `[1:v][0:v]overlay=${coords.x}:${coords.y}:shortest=1`;
    }

    await runFFmpeg([
      '-y',
      '-i', reactScaled,
      '-i', freezeVideo,
      '-filter_complex', filterComplex,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
      '-map', '0:a',  // Always use react audio
      '-c:a', 'copy',
      '-shortest',
      output
    ]);

    // Cleanup
    await fs.remove(freezeVideo).catch(() => {});
    await fs.remove(reactScaled).catch(() => {});

    console.log('✓ Freeze + React created with audio\n');
  }

  /**
   * Concatenate two videos
   */
  async concatenate(part1, part2, output) {
    const concatList = output.replace('.mp4', '_concat.txt');
    await fs.writeFile(concatList, `file '${part1}'\nfile '${part2}'`);

    await runFFmpeg([
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatList,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      output
    ]);

    await fs.remove(concatList).catch(() => {});
    console.log('✓ Concatenation complete\n');
  }

  getOutputPath(jobId) {
    return path.join(this.tempDir, jobId, 'final_two_clip_reaction.mp4');
  }

  async cleanup(jobId) {
    await fs.remove(path.join(this.tempDir, jobId));
  }
}

module.exports = new TwoClipReactionService();
