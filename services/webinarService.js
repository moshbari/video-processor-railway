const { exec } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

class WebinarService {
  constructor() {
    this.tempDir = process.env.TEMP_DIR || '/app/temp';
    this.jobs = new Map(); // Store job status in memory
  }

  /**
   * Get job status
   */
  getJobStatus(jobId) {
    return this.jobs.get(jobId) || null;
  }

  /**
   * Get all jobs (for listing)
   */
  getAllJobs() {
    const jobs = [];
    this.jobs.forEach((job, id) => {
      jobs.push({ jobId: id, ...job });
    });
    // Sort by createdAt descending (newest first)
    jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return jobs;
  }

  /**
   * Update job status
   */
  updateJobStatus(jobId, updates) {
    const job = this.jobs.get(jobId) || {};
    this.jobs.set(jobId, { ...job, ...updates, updatedAt: new Date().toISOString() });
  }

  /**
   * Process webinar: Apply overlay to video2, then concatenate with video1
   * @param {string} video1Path - Path to first video (no overlay)
   * @param {string} video2Path - Path to second video (will have overlay)
   * @param {string} imagePath - Path to overlay image
   * @param {string} jobId - Job ID
   * @returns {Promise<Object>} Result with output path
   */
  async processWebinar(video1Path, video2Path, imagePath, jobId) {
    const workDir = path.join(this.tempDir, jobId);
    await fs.ensureDir(workDir);

    console.log(`[${jobId}] Starting webinar processing...`);
    console.log(`[${jobId}] Video 1 (intro): ${video1Path}`);
    console.log(`[${jobId}] Video 2 (CTA): ${video2Path}`);
    console.log(`[${jobId}] Overlay image: ${imagePath}`);

    this.updateJobStatus(jobId, { status: 'processing', progress: 0, step: 'Starting...' });

    try {
      // Step 1: Standardize Video 1 (10%)
      this.updateJobStatus(jobId, { progress: 10, step: 'Preparing Video 1...' });
      const video1Standardized = path.join(workDir, 'video1_std.mp4');
      await this.standardizeVideo(video1Path, video1Standardized, jobId);

      // Step 2: Standardize Video 2 (25%)
      this.updateJobStatus(jobId, { progress: 25, step: 'Preparing Video 2...' });
      const video2Standardized = path.join(workDir, 'video2_std.mp4');
      await this.standardizeVideo(video2Path, video2Standardized, jobId);

      // Step 3: Apply overlay to Video 2 (50%)
      this.updateJobStatus(jobId, { progress: 50, step: 'Applying overlay to Video 2...' });
      const video2WithOverlay = path.join(workDir, 'video2_overlay.mp4');
      await this.applyOverlay(video2Standardized, imagePath, video2WithOverlay, jobId);

      // Step 4: Concatenate videos (75%)
      this.updateJobStatus(jobId, { progress: 75, step: 'Combining videos...' });
      const outputPath = path.join(workDir, `webinar_${jobId}.mp4`);
      await this.concatenateVideos(video1Standardized, video2WithOverlay, outputPath, jobId);

      // Verify output exists
      if (!await fs.pathExists(outputPath)) {
        throw new Error('Processing completed but output file not found');
      }

      const stats = await fs.stat(outputPath);
      console.log(`[${jobId}] Output created: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

      this.updateJobStatus(jobId, { progress: 90, step: 'Uploading to storage...' });

      return {
        success: true,
        jobId,
        outputPath,
        fileSize: stats.size
      };

    } catch (error) {
      console.error(`[${jobId}] Error:`, error.message);
      this.updateJobStatus(jobId, { 
        status: 'failed', 
        progress: 0, 
        step: 'Failed',
        error: error.message 
      });
      throw error;
    }
  }

  /**
   * Standardize video for consistent concatenation
   */
  async standardizeVideo(inputPath, outputPath, jobId) {
    const command = `ffmpeg -y -i "${inputPath}" -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1" -c:v libx264 -preset medium -crf 23 -r 30 -pix_fmt yuv420p -c:a aac -b:a 128k -ar 44100 -ac 2 "${outputPath}"`;
    
    console.log(`[${jobId}] Standardizing video to 1920x1080 @ 30fps...`);
    await this.runCommand(command, jobId);
  }

  /**
   * Apply full-frame image overlay to video
   */
  async applyOverlay(videoPath, imagePath, outputPath, jobId) {
    // Use scale2ref to scale overlay image to match video dimensions
    // Output with same standardized settings as standardizeVideo to prevent transition glitches
    const command = `ffmpeg -y -i "${videoPath}" -i "${imagePath}" -filter_complex "[0:v][1:v]scale2ref[base][ovr];[base][ovr]overlay=0:0:format=auto" -c:v libx264 -preset medium -crf 23 -r 30 -pix_fmt yuv420p -c:a aac -b:a 128k -ar 44100 -ac 2 "${outputPath}"`;
    
    console.log(`[${jobId}] Applying overlay (with standardized output)...`);
    await this.runCommand(command, jobId);
  }

  /**
   * Concatenate two videos using concat filter
   */
  async concatenateVideos(video1Path, video2Path, outputPath, jobId) {
    // Using concat filter with full re-encoding for seamless, gap-free transitions
    const command = `ffmpeg -y -i "${video1Path}" -i "${video2Path}" -filter_complex "[0:v:0][0:a:0][1:v:0][1:a:0]concat=n=2:v=1:a=1[outv][outa]" -map "[outv]" -map "[outa]" -c:v libx264 -preset medium -crf 23 -r 30 -pix_fmt yuv420p -c:a aac -b:a 128k -ar 44100 -ac 2 -movflags +faststart "${outputPath}"`;
    
    console.log(`[${jobId}] Concatenating videos (re-encoding for seamless transition)...`);
    await this.runCommand(command, jobId);
  }

  /**
   * Run shell command with promise
   */
  runCommand(command, jobId) {
    return new Promise((resolve, reject) => {
      console.log(`[${jobId}] Executing: ${command.substring(0, 150)}...`);
      
      exec(command, { maxBuffer: 100 * 1024 * 1024 }, (error, stdout, stderr) => {
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

  /**
   * Remove old jobs from memory (older than 7 days)
   */
  cleanupOldJobs() {
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    this.jobs.forEach((job, jobId) => {
      if (new Date(job.createdAt).getTime() < sevenDaysAgo) {
        this.jobs.delete(jobId);
        console.log(`Removed old job from memory: ${jobId}`);
      }
    });
  }
}

module.exports = new WebinarService();
