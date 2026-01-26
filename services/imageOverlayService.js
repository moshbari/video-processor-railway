const { exec } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

class ImageOverlayService {
  constructor() {
    this.tempDir = process.env.TEMP_DIR || '/app/temp';
  }

  /**
   * Apply full-frame image overlay to video
   * Image and video should be same dimensions
   * @param {string} videoPath - Path to input video
   * @param {string} imagePath - Path to overlay image (PNG with transparency recommended)
   * @param {string} jobId - Optional job ID
   * @returns {Promise<Object>} Result with output path
   */
  async applyFullOverlay(videoPath, imagePath, jobId = null) {
    jobId = jobId || uuidv4();
    const workDir = path.join(this.tempDir, jobId);
    await fs.ensureDir(workDir);

    console.log(`[${jobId}] Starting full-frame image overlay...`);
    console.log(`[${jobId}] Video: ${videoPath}`);
    console.log(`[${jobId}] Image: ${imagePath}`);

    const outputPath = path.join(workDir, `overlay_${jobId}.mp4`);

    try {
      // FFmpeg command to overlay image on entire video
      // The image will be scaled to match video dimensions and placed on top
      const ffmpegCommand = `ffmpeg -y -i "${videoPath}" -i "${imagePath}" -filter_complex "[1:v]scale=iw:ih[ovr];[0:v][ovr]overlay=0:0:format=auto" -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 128k "${outputPath}"`;

      console.log(`[${jobId}] Running FFmpeg command...`);
      
      await this.runCommand(ffmpegCommand, jobId);

      // Verify output exists
      if (!await fs.pathExists(outputPath)) {
        throw new Error('FFmpeg completed but output file not found');
      }

      const stats = await fs.stat(outputPath);
      console.log(`[${jobId}] Output created: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

      return {
        success: true,
        jobId,
        outputPath,
        fileSize: stats.size
      };

    } catch (error) {
      console.error(`[${jobId}] Error:`, error.message);
      throw error;
    }
  }

  /**
   * Run shell command with promise
   */
  runCommand(command, jobId) {
    return new Promise((resolve, reject) => {
      console.log(`[${jobId}] Executing: ${command.substring(0, 200)}...`);
      
      exec(command, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          console.error(`[${jobId}] FFmpeg error:`, stderr);
          reject(new Error(`FFmpeg failed: ${stderr || error.message}`));
          return;
        }
        resolve(stdout);
      });
    });
  }

  /**
   * Clean up job files
   */
  async cleanup(jobId) {
    const workDir = path.join(this.tempDir, jobId);
    try {
      await fs.remove(workDir);
      console.log(`[${jobId}] Cleaned up work directory`);
    } catch (error) {
      console.error(`[${jobId}] Cleanup error:`, error.message);
    }
  }
}

module.exports = new ImageOverlayService();
