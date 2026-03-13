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
    
    // Clean up orphaned session directories on startup
    this.cleanupOrphanedSessions();
  }

  // ============================================
  // STARTUP CLEANUP
  // ============================================

  /**
   * Clean up orphaned session directories on startup
   * This prevents old files from being used in new sessions
   */
  async cleanupOrphanedSessions() {
    const sessionsDir = path.join(this.tempDir, 'webinar-sessions');
    try {
      if (await fs.pathExists(sessionsDir)) {
        const dirs = await fs.readdir(sessionsDir);
        for (const dir of dirs) {
          const dirPath = path.join(sessionsDir, dir);
          const stat = await fs.stat(dirPath);
          if (stat.isDirectory()) {
            // Delete all session directories on startup
            // (they're orphaned since sessions Map is empty on restart)
            await fs.remove(dirPath);
            console.log(`[Startup] Cleaned up orphaned session: ${dir}`);
          }
        }
      }
    } catch (error) {
      console.error('[Startup] Error cleaning orphaned sessions:', error.message);
    }
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
   * Extract order number from filename
   * Looks for the FIRST number in the filename
   * Examples:
   *   "1-intro.mp4" -> 1
   *   "3-Price Reveal.mp4" -> 3
   *   "10-Quiz.mp4" -> 10
   *   "intro.mp4" -> 9999 (no number found, sort to end)
   */
  extractOrderFromFilename(filename) {
    // Remove extension first
    const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');
    
    // Match the FIRST number in the filename
    const match = nameWithoutExt.match(/^(\d+)/);
    
    if (match) {
      return parseInt(match[1], 10);
    }
    
    // If no number at the start, try to find first number anywhere
    const anyMatch = nameWithoutExt.match(/(\d+)/);
    if (anyMatch) {
      return parseInt(anyMatch[1], 10);
    }
    
    // No number found - put at the end
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
   * Clean up session (delete all files and remove from memory)
   */
  async cleanupSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session && session.sessionDir) {
      try {
        await fs.remove(session.sessionDir);
        console.log(`[Session] Cleaned up session directory: ${sessionId}`);
      } catch (e) { 
        console.error(`[Session] Error cleaning up directory:`, e.message);
      }
    }
    this.sessions.delete(sessionId);
    console.log(`[Session] Deleted session from memory: ${sessionId}`);
  }

  /**
   * Delete a session explicitly (called when user starts new project)
   */
  async deleteSession(sessionId) {
    await this.cleanupSession(sessionId);
    return { success: true, message: 'Session deleted' };
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
        this.updateJobStatus(jobId, { progress: 5, step: `Preparing content videos (0/${session.contentFiles.length})...` });
        contentVideoPath = path.join(workDir, 'content_combined.mp4');
        await this.concatenateVideos(session.contentFiles.map(f => f.path), contentVideoPath, jobId, 'Content', 5, 45);
      }

      // Step 2: Concatenate CTA files (if any)
      let ctaVideoPath = null;
      if (session.ctaFiles.length > 0) {
        this.updateJobStatus(jobId, { progress: 45, step: `Preparing CTA videos (0/${session.ctaFiles.length})...` });
        ctaVideoPath = path.join(workDir, 'cta_combined.mp4');
        await this.concatenateVideos(session.ctaFiles.map(f => f.path), ctaVideoPath, jobId, 'CTA', 45, 70);
      }

      // Step 3: Apply overlay to CTA video (if overlay exists)
      let ctaWithOverlayPath = ctaVideoPath;
      if (ctaVideoPath && session.overlayImage) {
        this.updateJobStatus(jobId, { progress: 72, step: 'Applying overlay to CTA...' });
        ctaWithOverlayPath = path.join(workDir, 'cta_with_overlay.mp4');
        await this.applyOverlay(ctaVideoPath, session.overlayImage.path, ctaWithOverlayPath, jobId);
      }

      // Step 4: Combine content + CTA (or just use whichever exists)
      this.updateJobStatus(jobId, { progress: 80, step: 'Creating final video...' });
      finalOutputPath = path.join(workDir, `webinar_${jobId}.mp4`);

      if (contentVideoPath && ctaWithOverlayPath) {
        // Both exist - use seamless re-encoding concat to prevent blank frames at transition
        await this.concatenateVideosFinal([contentVideoPath, ctaWithOverlayPath], finalOutputPath, jobId);
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
  async concatenateVideos(videoPaths, outputPath, jobId, groupLabel = '', progressStart = 0, progressEnd = 100) {
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
    
    // First, standardize all videos — with per-file progress updates
    const standardizedPaths = [];
    const totalFiles = videoPaths.length;
    for (let i = 0; i < totalFiles; i++) {
      // Calculate progress within the allocated range
      const fileProgress = Math.round(progressStart + ((i / totalFiles) * (progressEnd - progressStart)));
      const stepText = groupLabel 
        ? `Processing ${groupLabel} video ${i + 1} of ${totalFiles}...`
        : `Standardizing video ${i + 1} of ${totalFiles}...`;
      this.updateJobStatus(jobId, { progress: fileProgress, step: stepText });
      
      const stdPath = path.join(concatDir, `std_${i}.mp4`);
      await this.standardizeVideo(videoPaths[i], stdPath, jobId);
      standardizedPaths.push(stdPath);
    }

    // Update progress for the concat step itself
    const concatStepText = groupLabel ? `Joining ${totalFiles} ${groupLabel} videos...` : `Joining ${totalFiles} videos...`;
    this.updateJobStatus(jobId, { progress: progressEnd - 1, step: concatStepText });

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
   * Safe concatenation for the final Content + CTA join
   * Uses the concat FILTER (not demuxer) which re-encodes the video
   * This prevents blank/black frames at the transition point
   */
  async concatenateVideosFinal(videoPaths, outputPath, jobId) {
    if (videoPaths.length === 0) {
      throw new Error('No videos to concatenate');
    }

    if (videoPaths.length === 1) {
      await fs.copy(videoPaths[0], outputPath);
      return;
    }

    // Build inputs and filter_complex for concat filter (re-encodes for seamless join)
    const inputs = videoPaths.map(p => `-i "${p}"`).join(' ');
    const filterParts = videoPaths.map((_, i) => `[${i}:v:0][${i}:a:0]`).join('');
    const filterComplex = `${filterParts}concat=n=${videoPaths.length}:v=1:a=1[outv][outa]`;

    const command = `ffmpeg -y ${inputs} -filter_complex "${filterComplex}" -map "[outv]" -map "[outa]" -c:v libx264 -preset medium -crf 23 -r 30 -pix_fmt yuv420p -c:a aac -b:a 128k -ar 44100 -ac 2 -movflags +faststart "${outputPath}"`;

    console.log(`[${jobId}] Final seamless concatenation (re-encoding for smooth transition)...`);
    await this.runCommand(command, jobId);
  }

  /**
   * Standardize video for consistent concatenation
   * Forces consistent resolution, pixel format, frame rate, and audio settings
   * so there are NO blank frames when videos are joined together
   */
  async standardizeVideo(inputPath, outputPath, jobId) {
    const command = `ffmpeg -y -i "${inputPath}" -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:black,setsar=1" -c:v libx264 -preset medium -crf 23 -r 30 -pix_fmt yuv420p -c:a aac -b:a 128k -ar 44100 -ac 2 "${outputPath}"`;
    console.log(`[${jobId}] Standardizing video to 1920x1080 @ 30fps...`);
    await this.runCommand(command, jobId);
  }

  /**
   * Apply full-frame image overlay to video
   * Scales overlay to match video dimensions
   * Outputs with same standardized settings to prevent blank frames during transitions
   */
  async applyOverlay(videoPath, imagePath, outputPath, jobId) {
    // Use scale2ref to scale overlay image to match video dimensions
    // Output with same standardized settings as standardizeVideo to prevent transition glitches
    const command = `ffmpeg -y -i "${videoPath}" -i "${imagePath}" -filter_complex "[0:v][1:v]scale2ref[base][ovr];[base][ovr]overlay=0:0:format=auto" -c:v libx264 -preset medium -crf 23 -r 30 -pix_fmt yuv420p -c:a aac -b:a 128k -ar 44100 -ac 2 "${outputPath}"`;
    
    console.log(`[${jobId}] Applying overlay (with standardized output)...`);
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
