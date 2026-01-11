/**
 * Single Reaction Service
 * 
 * Handles "watch first, react at end" style reaction videos where:
 * - One main video plays normally, then freezes on last frame
 * - One reaction video (slightly longer) overlays in PiP throughout
 * - No splitting, no timestamps - just simple overlay
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
   */
  async extractLastFrame(videoPath, outputPath, duration) {
    // Seek to 0.1 seconds before end to get last frame
    const seekTime = Math.max(0, duration - 0.1);
    
    const cmd = `ffmpeg -ss ${seekTime} -i "${videoPath}" -vframes 1 -q:v 2 -y "${outputPath}"`;
    console.log('Extracting last frame:', cmd);
    
    await execPromise(cmd);
    
    if (!await fs.pathExists(outputPath)) {
      throw new Error('Failed to extract last frame');
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
    const frozenCmd = `ffmpeg -loop 1 -i "${lastFramePath}" -f lavfi -i anullsrc=r=44100:cl=stereo -t ${freezeDuration} -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -r 30 -c:a aac -b:a 128k -shortest -y "${frozenPath}"`;
    console.log('Creating frozen segment:', frozenCmd);
    await execPromise(frozenCmd);

    // Normalize main video to same format
    const normalizedMainPath = outputPath.replace('.mp4', '_normalized.mp4');
    const normalizeCmd = `ffmpeg -i "${mainVideoPath}" -vf "scale=${dimensions.width}:${dimensions.height}:force_original_aspect_ratio=decrease,pad=${dimensions.width}:${dimensions.height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1" -r 30 -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -c:a aac -ar 44100 -ac 2 -b:a 128k -y "${normalizedMainPath}"`;
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
   * Create the final PiP video
   * 
   * @param {string} extendedMainPath - Path to extended main video (with frozen frame)
   * @param {string} reactionPath - Path to reaction video
   * @param {string} outputPath - Output path for final video
   * @param {string} pipPosition - Corner position for PiP
   * @param {object} dimensions - Target dimensions
   * @param {number} pipScale - PiP size as percentage of main video width (default 35%)
   */
  async createPipVideo(extendedMainPath, reactionPath, outputPath, pipPosition, dimensions, pipScale = 35) {
    const { width: mainWidth, height: mainHeight } = dimensions;
    const pipWidth = Math.round(mainWidth * (pipScale / 100));
    const pipHeight = Math.round(pipWidth * (mainHeight / mainWidth)); // Maintain aspect ratio
    
    const coords = this.getPipCoordinates(pipPosition, mainWidth, mainHeight, pipWidth, pipHeight);
    
    console.log(`PiP overlay: ${pipWidth}x${pipHeight} at position (${coords.x}, ${coords.y})`);

    // Complex filter to overlay reaction on extended main video
    // Uses reaction video's audio
    const filterComplex = [
      `[1:v]scale=${pipWidth}:${pipHeight}[pip]`,
      `[0:v][pip]overlay=${coords.x}:${coords.y}[outv]`
    ].join(';');

    const cmd = `ffmpeg -i "${extendedMainPath}" -i "${reactionPath}" -filter_complex "${filterComplex}" -map "[outv]" -map 1:a -c:v libx264 -preset fast -crf 23 -c:a aac -ar 44100 -ac 2 -b:a 128k -movflags +faststart -y "${outputPath}"`;
    
    console.log('Creating PiP video:', cmd);
    await execPromise(cmd);

    if (!await fs.pathExists(outputPath)) {
      throw new Error('Failed to create PiP video');
    }

    return outputPath;
  }

  /**
   * Main function: Create single reaction PiP video
   * 
   * @param {string} mainVideoPath - Path to main/original video
   * @param {string} reactionVideoPath - Path to reaction video (longer than main)
   * @param {object} options - Options including pipPosition, pipScale
   */
  async createSingleReactionVideo(mainVideoPath, reactionVideoPath, options = {}) {
    const jobId = options.jobId || uuidv4();
    const workDir = path.join(this.tempDir, jobId);
    await fs.ensureDir(workDir);

    const pipPosition = options.pipPosition || 'top-right';
    const pipScale = options.pipScale || 35;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`SINGLE REACTION PiP - Job: ${jobId}`);
    console.log(`Position: ${pipPosition}, Scale: ${pipScale}%`);
    console.log(`${'='.repeat(60)}\n`);

    try {
      // Step 1: Get video info
      console.log('Step 1: Analyzing videos...');
      const [mainDuration, reactionDuration, mainDimensions] = await Promise.all([
        this.getVideoDuration(mainVideoPath),
        this.getVideoDuration(reactionVideoPath),
        this.getVideoDimensions(mainVideoPath)
      ]);

      console.log(`  Main video: ${mainDuration.toFixed(2)}s (${mainDimensions.width}x${mainDimensions.height})`);
      console.log(`  Reaction video: ${reactionDuration.toFixed(2)}s`);

      if (reactionDuration <= mainDuration) {
        console.log('  Warning: Reaction video is shorter than or equal to main video.');
        console.log('  The main video will not freeze - just direct overlay.');
      }

      const totalDuration = Math.max(mainDuration, reactionDuration);
      const needsFreeze = reactionDuration > mainDuration;

      // Step 2: Extract last frame (if needed)
      let extendedMainPath = mainVideoPath;
      
      if (needsFreeze) {
        console.log('\nStep 2: Extracting last frame...');
        const lastFramePath = path.join(workDir, 'last_frame.jpg');
        await this.extractLastFrame(mainVideoPath, lastFramePath, mainDuration);
        console.log('  ✓ Last frame extracted');

        // Step 3: Create extended main video
        console.log('\nStep 3: Creating extended main video with frozen frame...');
        extendedMainPath = path.join(workDir, 'extended_main.mp4');
        await this.createExtendedMainVideo(
          mainVideoPath,
          lastFramePath,
          mainDuration,
          totalDuration,
          extendedMainPath,
          mainDimensions
        );
        console.log('  ✓ Extended video created');

        // Cleanup last frame
        await fs.remove(lastFramePath).catch(() => {});
      } else {
        console.log('\nStep 2 & 3: Skipped (reaction not longer than main)');
      }

      // Step 4: Create PiP overlay
      console.log('\nStep 4: Creating PiP overlay...');
      const outputPath = path.join(workDir, 'final_single_reaction.mp4');
      await this.createPipVideo(
        extendedMainPath,
        reactionVideoPath,
        outputPath,
        pipPosition,
        mainDimensions,
        pipScale
      );
      console.log('  ✓ PiP video created');

      // Cleanup extended main if we created it
      if (needsFreeze && extendedMainPath !== mainVideoPath) {
        await fs.remove(extendedMainPath).catch(() => {});
      }

      // Get final file info
      const stats = await fs.stat(outputPath);

      console.log(`\n${'='.repeat(60)}`);
      console.log(`✓ COMPLETE - ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
      console.log(`${'='.repeat(60)}\n`);

      return {
        success: true,
        jobId,
        outputPath,
        pipPosition,
        pipScale,
        mainDuration,
        reactionDuration,
        totalDuration,
        frozenFrameDuration: needsFreeze ? totalDuration - mainDuration : 0,
        fileSize: stats.size,
        fileSizeMB: (stats.size / 1024 / 1024).toFixed(2),
        downloadUrl: `/api/single-reaction/${jobId}/download`
      };

    } catch (error) {
      console.error('Single reaction error:', error);
      await fs.remove(workDir).catch(() => {});
      throw error;
    }
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
