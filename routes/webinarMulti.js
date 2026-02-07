const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const webinarMultiService = require('../services/webinarMultiService');
const r2Service = require('../services/r2Service');

// Increase timeout for file uploads (10 minutes per file)
router.use((req, res, next) => {
  req.setTimeout(10 * 60 * 1000);
  res.setTimeout(10 * 60 * 1000);
  next();
});

// Configure multer for individual file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const sessionId = req.params.sessionId || req.body.sessionId;
    const group = req.params.group || req.body.group;
    
    if (!sessionId) {
      return cb(new Error('Session ID required'));
    }

    const uploadDir = path.join(process.env.TEMP_DIR || '/app/temp', 'webinar-sessions', sessionId, group || 'uploads');
    await fs.ensureDir(uploadDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Sanitize filename: remove spaces and special characters
    const sanitized = file.originalname
      .replace(/[^a-zA-Z0-9._-]/g, '_')  // Replace special chars with underscore
      .replace(/_+/g, '_')                // Remove multiple underscores
      .replace(/^_|_$/g, '');             // Remove leading/trailing underscores
    
    const uniqueName = `${Date.now()}_${sanitized}`;
    console.log(`[Upload] Sanitized filename: ${file.originalname} -> ${uniqueName}`);
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { 
    fileSize: 5 * 1024 * 1024 * 1024 // 5GB max per individual file
  },
  fileFilter: (req, file, cb) => {
    const group = req.params.group || req.body.group;
    
    if (group === 'content' || group === 'cta') {
      const videoTypes = /mp4|mov|avi|webm|mkv/i;
      const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
      if (videoTypes.test(ext)) {
        cb(null, true);
      } else {
        cb(new Error('Only video files (MP4, MOV, AVI, WEBM, MKV) are allowed'));
      }
    } else if (group === 'overlay') {
      const imageTypes = /png|jpg|jpeg|gif|webp/i;
      const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
      if (imageTypes.test(ext)) {
        cb(null, true);
      } else {
        cb(new Error('Only image files (PNG, JPG, GIF, WEBP) are allowed'));
      }
    } else {
      cb(null, true);
    }
  }
});

// ============================================
// SESSION ENDPOINTS
// ============================================

/**
 * POST /api/webinar-multi/session
 * Create a new upload session
 */
router.post('/session', (req, res) => {
  try {
    const sessionId = webinarMultiService.createSession();
    console.log(`[Session] Created new session: ${sessionId}`);
    
    res.json({
      success: true,
      sessionId
    });
  } catch (error) {
    console.error('[Session] Error creating session:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/webinar-multi/session/:sessionId
 * Get session data (all uploaded files)
 */
router.get('/session/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const session = webinarMultiService.getSession(sessionId);

  if (!session) {
    return res.status(404).json({
      success: false,
      error: 'Session not found'
    });
  }

  res.json({
    success: true,
    session: {
      sessionId: session.sessionId,
      createdAt: session.createdAt,
      contentFiles: session.contentFiles.map(f => ({
        id: f.id,
        originalName: f.originalName,
        size: f.size,
        status: f.status,
        order: f.order
      })),
      ctaFiles: session.ctaFiles.map(f => ({
        id: f.id,
        originalName: f.originalName,
        size: f.size,
        status: f.status,
        order: f.order
      })),
      overlayImage: session.overlayImage ? {
        id: session.overlayImage.id,
        originalName: session.overlayImage.originalName,
        size: session.overlayImage.size,
        status: session.overlayImage.status
      } : null
    }
  });
});

/**
 * DELETE /api/webinar-multi/session/:sessionId
 * Delete a session and all its files (used when starting new project)
 */
router.delete('/session/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  
  console.log(`[Session] Deleting session: ${sessionId}`);

  try {
    await webinarMultiService.deleteSession(sessionId);
    
    res.json({
      success: true,
      message: 'Session deleted successfully'
    });
  } catch (error) {
    console.error(`[Session] Error deleting session:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// FILE UPLOAD ENDPOINTS
// ============================================

/**
 * POST /api/webinar-multi/session/:sessionId/upload/:group
 * Upload a single file to a group (content, cta, or overlay)
 */
router.post('/session/:sessionId/upload/:group', upload.single('file'), async (req, res) => {
  const { sessionId, group } = req.params;

  console.log(`[Upload] Received file for session ${sessionId}, group: ${group}`);

  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No file uploaded'
      });
    }

    if (!['content', 'cta', 'overlay'].includes(group)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid group. Must be: content, cta, or overlay'
      });
    }

    const fileInfo = {
      filename: req.file.filename,
      originalName: req.file.originalname,
      path: req.file.path,
      size: req.file.size
    };

    const fileData = webinarMultiService.addFileToSession(sessionId, group, fileInfo);

    console.log(`[Upload] File added: ${fileData.originalName} (${(fileData.size / 1024 / 1024).toFixed(2)} MB)`);

    res.json({
      success: true,
      file: {
        id: fileData.id,
        originalName: fileData.originalName,
        size: fileData.size,
        status: fileData.status,
        order: fileData.order
      }
    });

  } catch (error) {
    console.error(`[Upload] Error:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/webinar-multi/session/:sessionId/file/:group/:fileId
 * Remove a file from session
 */
router.delete('/session/:sessionId/file/:group/:fileId', async (req, res) => {
  const { sessionId, group, fileId } = req.params;

  try {
    await webinarMultiService.removeFileFromSession(sessionId, group, fileId);
    
    console.log(`[Delete] Removed file ${fileId} from ${group}`);

    res.json({
      success: true,
      message: 'File removed'
    });

  } catch (error) {
    console.error(`[Delete] Error:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /api/webinar-multi/session/:sessionId/reorder/:group
 * Update file order in a group
 */
router.put('/session/:sessionId/reorder/:group', express.json(), (req, res) => {
  const { sessionId, group } = req.params;
  const { fileOrders } = req.body; // Array of { id, order }

  try {
    if (!fileOrders || !Array.isArray(fileOrders)) {
      return res.status(400).json({
        success: false,
        error: 'fileOrders array required'
      });
    }

    const updatedFiles = webinarMultiService.updateFileOrder(sessionId, group, fileOrders);

    console.log(`[Reorder] Updated order for ${group}: ${updatedFiles.map(f => f.originalName).join(', ')}`);

    res.json({
      success: true,
      files: updatedFiles.map(f => ({
        id: f.id,
        originalName: f.originalName,
        order: f.order
      }))
    });

  } catch (error) {
    console.error(`[Reorder] Error:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// RENDER ENDPOINTS
// ============================================

/**
 * POST /api/webinar-multi/render/:sessionId
 * Start rendering the webinar from session files
 */
router.post('/render/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  const jobId = uuidv4();

  console.log(`[Render] Starting render for session ${sessionId}, job ${jobId}`);

  try {
    const session = webinarMultiService.getSession(sessionId);
    
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    // Validate we have files to process
    if (session.contentFiles.length === 0 && session.ctaFiles.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No video files to process. Add files to Content or CTA group.'
      });
    }

    // Initialize job status
    webinarMultiService.updateJobStatus(jobId, {
      status: 'queued',
      progress: 0,
      step: 'Queued',
      createdAt: new Date().toISOString(),
      sessionId,
      contentCount: session.contentFiles.length,
      ctaCount: session.ctaFiles.length,
      hasOverlay: !!session.overlayImage,
      downloadUrl: null,
      filename: null
    });

    // Respond immediately
    res.json({
      success: true,
      jobId,
      message: 'Rendering started. Check status at /api/webinar-multi/status/' + jobId
    });

    // Start background processing (don't await)
    processInBackground(sessionId, jobId);

  } catch (error) {
    console.error(`[Render] Error:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Background processing function
 */
async function processInBackground(sessionId, jobId) {
  try {
    console.log(`[${jobId}] Starting background processing...`);

    // Process the webinar
    const result = await webinarMultiService.processWebinar(sessionId, jobId);

    // Generate filename with date
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = now.toISOString().slice(11, 16).replace(':', '');
    const outputFilename = `WEBINAR_${dateStr}_${timeStr}.mp4`;

    // Upload to R2
    const r2Key = `webinar-multi/${jobId}/${outputFilename}`;
    console.log(`[${jobId}] Uploading to R2: ${r2Key}`);
    
    const uploadResult = await r2Service.uploadFile(result.outputPath, r2Key, 'video/mp4');

    // Update job status with download URL
    webinarMultiService.updateJobStatus(jobId, {
      status: 'complete',
      progress: 100,
      step: 'Complete',
      downloadUrl: uploadResult.downloadUrl,
      filename: outputFilename,
      completedAt: new Date().toISOString()
    });

    // Clean up render files (but keep session for potential re-render)
    await webinarMultiService.cleanupJob(jobId);

    console.log(`[${jobId}] Background processing complete!`);

  } catch (error) {
    console.error(`[${jobId}] Background processing failed:`, error.message);
    
    webinarMultiService.updateJobStatus(jobId, {
      status: 'failed',
      progress: 0,
      step: 'Failed',
      error: error.message
    });

    try {
      await webinarMultiService.cleanupJob(jobId);
    } catch (cleanupError) {
      console.error(`[${jobId}] Cleanup error:`, cleanupError.message);
    }
  }
}

/**
 * POST /api/webinar-multi/session/:sessionId/import-library
 * Import a library clip into the session (download from R2 and register)
 */
router.post('/session/:sessionId/import-library', express.json(), async (req, res) => {
  const { sessionId } = req.params;
  const { clipId, overlayId, group, order } = req.body;
  const userId = req.headers['x-user-id'];

  console.log(`[Import Library] Session: ${sessionId}, Group: ${group}, ClipId: ${clipId || 'none'}, OverlayId: ${overlayId || 'none'}`);

  try {
    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'User ID required. Please log in.'
      });
    }

    const session = webinarMultiService.getSession(sessionId);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    if (!['content', 'cta', 'overlay'].includes(group)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid group. Must be: content, cta, or overlay'
      });
    }

    const clipLibraryService = require('../services/clipLibraryService');

    // Handle overlay import
    if (group === 'overlay' && overlayId) {
      const destDir = path.join(session.sessionDir, 'overlay');
      await fs.ensureDir(destDir);

      const { localPath, overlay } = await clipLibraryService.downloadOverlayToTemp(userId, overlayId, destDir);

      const fileData = webinarMultiService.addFileToSession(sessionId, 'overlay', {
        filename: overlay.filename,
        originalName: overlay.name + path.extname(overlay.filename),
        path: localPath,
        size: overlay.size || 0
      });

      console.log(`[Import Library] Overlay "${overlay.name}" imported into session`);

      return res.json({
        success: true,
        file: {
          id: fileData.id,
          originalName: fileData.originalName,
          size: fileData.size,
          status: 'uploaded',
          source: 'library'
        }
      });
    }

    // Handle clip import
    if (!clipId) {
      return res.status(400).json({
        success: false,
        error: 'clipId required for content/cta import'
      });
    }

    const destDir = path.join(session.sessionDir, group);
    await fs.ensureDir(destDir);

    const { localPath, clip } = await clipLibraryService.downloadClipToTemp(userId, clipId, destDir);

    // Build a filename that preserves order if provided
    const orderPrefix = order !== undefined ? `${order}-` : '';
    const friendlyFilename = `${orderPrefix}${clip.name}${path.extname(clip.filename)}`;

    // Rename the downloaded file to include order prefix for the auto-sort
    const finalPath = path.join(destDir, `${Date.now()}_${friendlyFilename}`);
    await fs.move(localPath, finalPath, { overwrite: true });

    const fileData = webinarMultiService.addFileToSession(sessionId, group, {
      filename: path.basename(finalPath),
      originalName: friendlyFilename,
      path: finalPath,
      size: clip.size || 0
    });

    console.log(`[Import Library] Clip "${clip.name}" imported into session as ${group} (order: ${fileData.order})`);

    res.json({
      success: true,
      file: {
        id: fileData.id,
        originalName: fileData.originalName,
        size: fileData.size,
        status: 'uploaded',
        order: fileData.order,
        source: 'library'
      }
    });

  } catch (error) {
    console.error(`[Import Library] Error:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/webinar-multi/status/:jobId
 * Get render job status
 */
router.get('/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const status = webinarMultiService.getJobStatus(jobId);

  if (!status) {
    return res.status(404).json({
      success: false,
      error: 'Job not found'
    });
  }

  res.json({
    success: true,
    jobId,
    ...status
  });
});

/**
 * GET /api/webinar-multi/jobs
 * Get all render jobs
 */
router.get('/jobs', (req, res) => {
  const jobs = webinarMultiService.getAllJobs();
  
  res.json({
    success: true,
    jobs
  });
});

/**
 * GET /api/webinar-multi/health
 * Health check
 */
router.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'webinar-multi',
    status: 'operational'
  });
});

module.exports = router;
