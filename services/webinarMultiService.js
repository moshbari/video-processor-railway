const { exec } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

class WebinarMultiService {
  constructor() {
    this.tempDir = process.env.TEMP_DIR || '/app/temp';
    this.sessions = new Map(); // Store session data (uploaded files)
    this.jobs = new Map(); // Store render job status
    this.jobsFilePath = path.join(this.tempDir, 'webinar-jobs.json');
    
    // Load persisted jobs on startup
    this.loadJobsFromFile();
  }

  // ============================================
  // JOBS PERSISTENCE
  // ============================================

  /**
   * Load jobs from file on startup
   */
  async loadJobsFromFile() {
    try {
      if (await fs.pathExists(this.jobsFilePath)) {
        const data = await fs.readJson(this.jobsFilePath);
        if (data && typeof data === 'object') {
          Object.entries(data).forEach(([jobId, job]) => {
            this.jobs.set(jobId, job);
          });
          console.log(`[Jobs] Loaded ${this.jobs.size} jobs from file`);
        }
      }
    } catch (error) {
      console.error('[Jobs] Error loading jobs from file:', error.message);
    }
  }

  /**
   * Save jobs to file for persistence
   */
  async saveJobsToFile() {
    try {
      const jobsObj = {};
      this.jobs.forEach((job, jobId) => {
        jobsObj[jobId] = job;
      });
      await fs.writeJson(this.jobsFilePath, jobsObj, { spaces: 2 });
    } catch (error) {
      console.error('[Jobs] Error saving jobs to file:', error.message);
    }
  }

  // ============================================
  // SESSION MANAGEMENT (for file uploads)
  // ============================================

  /**
   * Create a new session for file uploads
   */
  createSession() {
    const sessionId = uuidv4();
    const sessionDir = path.join(this.tempDir, 'webinar-sessions', sessionId);
    
    this.sessions.set(sessionId, {
      sessionId,
      createdAt: new Date().toISOString(),
      contentFiles: [], // { id, filename, originalName, status, order, size }
      ctaFiles: [],
      overlayImage: null,
      sessionDir
    });

    return sessionId;
  }

  /**
   * Get session data
   */
  getSession(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Add a file to a session
   */
  addFileToSession(sessionId, group, fileInfo) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    const fileId = uuidv4();
    const fileData = {
      id: fileId,
      filename: fileInfo.filename,
      originalName: fileInfo.originalName,
      path: fileInfo.path,
      size: fileInfo.size,
      status: 'uploaded',
      order: this.extractOrderFromFilename(fileInfo.originalName),
      uploadedAt: new Date().toISOString()
    };

    if (group === 'content') {
      session.contentFiles.push(fileData);
      // Auto-sort by order
      session.contentFiles.sort((a, b) => a.order - b.order);
    } else if (group === 'cta') {
      session.ctaFiles.push(fileData);
      // Auto-sort by order
      session.ctaFiles.sort((a, b) => a.order - b.order);
    } else if (group === 'overlay') {
      session.overlayImage = fileData;
    }

    this.sessions.set(sessionId, session);
    return fileData;
  }

  /**
   * Extract order number from filename (e.g., "clip_3.mp4" -> 3)
   */
  extractOrderFromFilename(filename) {
    // Try to find last number in filename before extension
    const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');
    const matches = nameWithoutExt.match(/(\d+)[^\d]*$/);
    if (matches) {
      return parseInt(matches[1], 10);
    }
    // If no number found, return high number to put at end
    return 9999;
  }

  /**
   * Update file order in session
   */
  updateFileOrder(sessionId, group, fileOrders) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    const files = group === 'content' ? session.contentFiles : session.ctaFiles;
    
    // fileOrders is array of { id, order }
    fileOrders.forEach(({ id, order }) => {
      const file = files.find(f => f.id === id);
      if (file) {
        file.order = order;
      }
    });

    // Re-sort
    files.sort((a, b) => a.order - b.order);
    this.sessions.set(sessionId, session);

    return files;
  }

  /**
   * Remove a file from session
   */
  async removeFileFromSession(sessionId, group, fileId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    let files = group === 'content' ? session.contentFiles : 
                group === 'cta' ? session.ctaFiles : null;

    if (group === 'overlay') {
      if (session.overlayImage && session.overlayImage.id === fileId) {
        // Delete physical file
        try {
          await fs.remove(session.overlayImage.path);
        } catch (e) { /* ignore */ }
        session.overlayImage = null;
      }
    } else if (files) {
      const fileIndex = files.findIndex(f => f.id === fileId);
      if (fileIndex !== -1) {
        // Delete physical file
        try {
          await fs.remove(files[fileIndex].path);
        } catch (e) { /* ignore */ }
        files.splice(fileIndex, 1);
      }
    }

    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Clean up session
   */
  async cleanupSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session && session.sessionDir) {
      try {
        await fs.remove(session.sessionDir);
      } catch (e) { /* ignore */ }
    }
    this.sessions.delete(sessionId);
  }

  // ============================================
  // RENDER JOB MANAGEMENT
  // ============================================

  /**
   * Get job status
   */
  getJobStatus(jobId) {
    return this.jobs.get(jobId) || null;
  }

  /**
   * Get all jobs
   */
  getAllJobs() {
    const jobs = [];
    this.jobs.forEach((job, id) => {
      jobs.push({ jobId: id, ...job });
    });
    jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return jobs;
  }

  /**
   * Update job status
   */
  updateJobStatus(jobId, updates) {
    const job = this.jobs.get(jobId) || {};
    this.jobs.set(jobId, { ...job, ...updates, updatedAt: new Date().toISOString() });
    
    // Persist to file
    this.saveJobsToFile();
  }

  // ============================================
  // VIDEO PROCESSING
  // ============================================

  /**
   * Process webinar from session files
   */
  async processWebinar(sessionId, jobId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Session not found');

    const workDir = path.join(this.tempDir, 'webinar-render', jobId);
    await fs.ensureDir(workDir);

    console.log(`[${jobId}] Starting webinar processing...`);
    console.log(`[${jobId}] Content files: ${session.contentFiles.length}`);
    console.log(`[${jobId}] CTA files: ${session.ctaFiles.length}`);
    console.log(`[${jobId}] Overlay: ${session.overlayImage ? 'Yes' : 'No'}`);

    this.updateJobStatus(jobId, { status: 'processing', progress: 0, step: 'Starting...' });

    try {
      let finalOutputPath;

      // Step 1: Concatenate content files (if any)
      let contentVideoPath = null;
      if (session.contentFiles.length > 0) {
        this.updateJobStatus(jobId, { progress: 10, step: 'Combining content videos...' });
        contentVideoPath = path.join(workDir, 'content_combined.mp4');
        await this.concatenateVideos(session.contentFiles.map(f => f.path), contentVideoPath, jobId);
      }

      // Step 2: Concatenate CTA files (if any)
      let ctaVideoPath = null;
      if (session.ctaFiles.length > 0) {
        this.updateJobStatus(jobId, { progress: 30, step: 'Combining CTA videos...' });
        ctaVideoPath = path.join(workDir, 'cta_combined.mp4');
        await this.concatenateVideos(session.ctaFiles.map(f => f.path), ctaVideoPath, jobId);
      }

      // Step 3: Apply overlay to CTA video (if overlay exists)
      let ctaWithOverlayPath = ctaVideoPath;
      if (ctaVideoPath && session.overlayImage) {
        this.updateJobStatus(jobId, { progress: 50, step: 'Applying overlay to CTA...' });
        ctaWithOverlayPath = path.join(workDir, 'cta_with_overlay.mp4');
        await this.applyOverlay(ctaVideoPath, session.overlayImage.path, ctaWithOverlayPath, jobId);
      }

      // Step 4: Combine content + CTA (or just use whichever exists)
      this.updateJobStatus(jobId, { progress: 75, step: 'Creating final video...' });
      finalOutputPath = path.join(workDir, `webinar_${jobId}.mp4`);

      if (contentVideoPath && ctaWithOverlayPath) {
        // Both exist - concatenate them
        await this.concatenateVideos([contentVideoPath, ctaWithOverlayPath], finalOutputPath, jobId);
      } else if (contentVideoPath) {
        // Only content exists
        await fs.copy(contentVideoPath, finalOutputPath);
      } else if (ctaWithOverlayPath) {
        // Only CTA exists
        await fs.copy(ctaWithOverlayPath, finalOutputPath);
      } else {
        throw new Error('No video files to process');
      }

      // Verify output
      if (!await fs.pathExists(finalOutputPath)) {
        throw new Error('Processing completed but output file not found');
      }

      const stats = await fs.stat(finalOutputPath);
      console.log(`[${jobId}] Output created: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

      this.updateJobStatus(jobId, { progress: 90, step: 'Uploading to storage...' });

      return {
        success: true,
        jobId,
        outputPath: finalOutputPath,
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
   * Concatenate multiple videos using concat filter
   */
  async concatenateVideos(videoPaths, outputPath, jobId) {
    if (videoPaths.length === 0) {
      throw new Error('No videos to concatenate');
    }

    if (videoPaths.length === 1) {
      // Just copy the single file
      await fs.copy(videoPaths[0], outputPath);
      return;
    }

    // Create concat file list
    const concatDir = path.dirname(outputPath);
    const listPath = path.join(concatDir, `concat_list_${Date.now()}.txt`);
    
    // First, standardize all videos
    const standardizedPaths = [];
    for (let i = 0; i < videoPaths.length; i++) {
      const stdPath = path.join(concatDir, `std_${i}.mp4`);
      await this.standardizeVideo(videoPaths[i], stdPath, jobId);
      standardizedPaths.push(stdPath);
    }

    // Create concat list file
    const listContent = standardizedPaths.map(p => `file '${p}'`).join('\n');
    await fs.writeFile(listPath, listContent);

    // Concatenate using concat demuxer (works well with standardized files)
    const command = `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${outputPath}"`;
    
    console.log(`[${jobId}] Concatenating ${videoPaths.length} videos...`);
    await this.runCommand(command, jobId);

    // Cleanup temp files
    await fs.remove(listPath);
    for (const stdPath of standardizedPaths) {
      await fs.remove(stdPath);
    }
  }

  /**
   * Standardize video for consistent concatenation
   */
  async standardizeVideo(inputPath, outputPath, jobId) {
    const command = `ffmpeg -y -i "${inputPath}" -c:v libx264 -preset medium -crf 23 -r 30 -c:a aac -b:a 128k -ar 44100 "${outputPath}"`;
    console.log(`[${jobId}] Standardizing video...`);
    await this.runCommand(command, jobId);
  }

  /**
   * Apply full-frame image overlay to video
   * Scales overlay to match video dimensions
   */
  async applyOverlay(videoPath, imagePath, outputPath, jobId) {
    // Use scale2ref to scale overlay image to match video dimensions
    const command = `ffmpeg -y -i "${videoPath}" -i "${imagePath}" -filter_complex "[0:v][1:v]scale2ref[base][ovr];[base][ovr]overlay=0:0:format=auto" -c:v libx264 -preset medium -crf 23 -c:a aac -b:a 128k "${outputPath}"`;
    
    console.log(`[${jobId}] Applying overlay...`);
    await this.runCommand(command, jobId);
  }

  /**
   * Run shell command
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
   * Clean up render job files
   */
  async cleanupJob(jobId) {
    const workDir = path.join(this.tempDir, 'webinar-render', jobId);
    try {
      await fs.remove(workDir);
      console.log(`[${jobId}] Cleaned up work directory`);
    } catch (error) {
      console.error(`[${jobId}] Cleanup error:`, error.message);
    }
  }

  /**
   * Remove old jobs/sessions from memory (keep 7 days to match R2 retention)
   */
  cleanupOldData() {
    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    let cleaned = 0;
    
    this.jobs.forEach((job, jobId) => {
      if (new Date(job.createdAt).getTime() < sevenDaysAgo) {
        this.jobs.delete(jobId);
        cleaned++;
      }
    });

    this.sessions.forEach((session, sessionId) => {
      if (new Date(session.createdAt).getTime() < sevenDaysAgo) {
        this.cleanupSession(sessionId);
      }
    });
    
    if (cleaned > 0) {
      console.log(`[Jobs] Cleaned up ${cleaned} old jobs`);
      this.saveJobsToFile();
    }
  }
}

module.exports = new WebinarMultiService();
