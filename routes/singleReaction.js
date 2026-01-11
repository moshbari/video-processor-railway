/**
 * Single Reaction Routes
 * 
 * API endpoints for full-length reaction videos with TWO layout modes:
 * 
 * 1. "Watch & React" (watchReact): Main video full screen, reaction in PiP corner
 * 2. "Face Cam" (faceCam): Reaction full screen, main video in PiP corner
 * 
 * Endpoints:
 * - POST /api/single-reaction/from-url - Create from video URL + uploaded reaction
 * - POST /api/single-reaction/from-upload - Create from two uploaded videos
 * - GET /api/single-reaction/projects - List all saved projects
 * - GET /api/single-reaction/projects/:projectId - Get single project
 * - DELETE /api/single-reaction/projects/:projectId - Delete project
 * - GET /api/single-reaction/:jobId/download - Download final video
 * - GET /api/single-reaction/:jobId/status - Check job status
 * - DELETE /api/single-reaction/:jobId - Cleanup job
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

const singleReactionService = require('../services/singleReactionService');
const downloadService = require('../services/downloadService');
const r2Service = require('../services/r2Service');
const projectMetadataService = require('../services/projectMetadataService');

// Configure multer for video uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = process.env.TEMP_DIR || '/app/temp';
    fs.ensureDirSync(uploadDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}_${file.originalname}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo', 'video/x-matroska'];
    if (allowedTypes.includes(file.mimetype) || file.originalname.match(/\.(mp4|mov|webm|avi|mkv)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'), false);
    }
  }
});

// ============================================================
// PROJECT LISTING ENDPOINTS
// ============================================================

/**
 * GET /api/single-reaction/projects
 * 
 * List all saved projects
 * Query params:
 * - limit: Max number of projects to return (default: 20)
 * - includeExpired: Include expired projects (default: false)
 */
router.get('/projects', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const includeExpired = req.query.includeExpired === 'true';

    const projects = await projectMetadataService.getProjects({
      limit,
      excludeExpired: !includeExpired
    });

    res.json({
      success: true,
      count: projects.length,
      projects
    });

  } catch (error) {
    console.error('Error listing projects:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/single-reaction/projects/:projectId
 * 
 * Get a single project by ID
 */
router.get('/projects/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const project = await projectMetadataService.getProject(projectId);

    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    res.json({
      success: true,
      project
    });

  } catch (error) {
    console.error('Error getting project:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/single-reaction/projects/:projectId
 * 
 * Delete a project from the metadata
 * Note: This doesn't delete the actual video file from R2
 */
router.delete('/projects/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    const deleted = await projectMetadataService.deleteProject(projectId);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    res.json({
      success: true,
      message: 'Project deleted',
      project: deleted
    });

  } catch (error) {
    console.error('Error deleting project:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/single-reaction/projects/cleanup
 * 
 * Clean up expired projects from metadata
 */
router.post('/projects/cleanup', async (req, res) => {
  try {
    const removed = await projectMetadataService.cleanupExpired();

    res.json({
      success: true,
      message: `Cleaned up ${removed} expired projects`
    });

  } catch (error) {
    console.error('Error cleaning up projects:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================
// VIDEO CREATION ENDPOINTS
// ============================================================

/**
 * POST /api/single-reaction/from-url
 * 
 * Create single reaction video from URL (main video) + uploaded reaction
 * 
 * Body (multipart/form-data):
 * - videoUrl: URL of main video
 * - reactionVideo: Uploaded reaction video file
 * - layoutMode: 'watchReact' (default) | 'faceCam'
 * - pipPosition: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'random'
 * - pipScale: PiP size percentage (default 35)
 * - title: Optional project title
 */
router.post('/from-url', upload.single('reactionVideo'), async (req, res) => {
  let mainVideoPath = null;
  
  try {
    // DEBUG: Log raw body
    console.log('\n=== DEBUG: Raw req.body (from-url) ===');
    console.log(JSON.stringify(req.body, null, 2));
    
    const { 
      videoUrl, 
      layoutMode = 'watchReact',
      pipPosition = 'top-right', 
      pipScale = 35,
      title = ''
    } = req.body;
    const reactionVideoPath = req.file?.path;

    console.log('layoutMode received:', layoutMode);

    // Validate inputs
    if (!videoUrl) {
      return res.status(400).json({
        success: false,
        error: 'videoUrl is required'
      });
    }

    if (!reactionVideoPath) {
      return res.status(400).json({
        success: false,
        error: 'reactionVideo file is required'
      });
    }

    // Validate layoutMode
    if (!['watchReact', 'faceCam'].includes(layoutMode)) {
      return res.status(400).json({
        success: false,
        error: 'layoutMode must be "watchReact" or "faceCam"'
      });
    }

    const modeName = layoutMode === 'watchReact' ? '👀 Watch & React' : '🤳 Face Cam';
    console.log(`\n=== SINGLE REACTION FROM URL ===`);
    console.log(`Mode: ${modeName}`);
    console.log(`URL: ${videoUrl}`);
    console.log(`Position: ${pipPosition}, Scale: ${pipScale}%`);

    // Download main video
    console.log('Downloading main video...');
    const downloadResult = await downloadService.downloadVideo(videoUrl);
    
    // Handle different possible return formats from downloadService
    mainVideoPath = downloadResult.filePath || downloadResult.path || downloadResult.outputPath || downloadResult.videoPath;
    
    if (!mainVideoPath) {
      throw new Error(`Download succeeded but no file path returned. Result: ${JSON.stringify(downloadResult)}`);
    }
    
    // Verify file exists
    const fileExists = await fs.pathExists(mainVideoPath);
    if (!fileExists) {
      throw new Error(`Downloaded file not found at path: ${mainVideoPath}`);
    }
    
    console.log(`✓ Downloaded: ${mainVideoPath}`);

    // Create single reaction video
    const result = await singleReactionService.createSingleReactionVideo(
      mainVideoPath,
      reactionVideoPath,
      {
        layoutMode,
        pipPosition,
        pipScale: parseInt(pipScale, 10)
      }
    );

    // Upload to R2 for persistent storage
    console.log('Uploading to R2...');
    const r2Key = `single-reaction/${result.jobId}/final.mp4`;
    const r2Result = await r2Service.uploadFile(result.outputPath, r2Key);
    console.log(`✓ Uploaded to R2: ${r2Key}`);

    // Generate download URL
    const downloadUrl = r2Result.url || `https://pub-f59b46a864a6463ea4d6747002fd515d.r2.dev/${r2Key}`;

    // Save project metadata
    console.log('Saving project metadata...');
    const projectTitle = title || extractTitleFromUrl(videoUrl) || `Project_${Date.now()}`;
    const savedProject = await projectMetadataService.addProject({
      ...result,
      title: projectTitle,
      r2Key,
      downloadUrl
    });
    console.log(`✓ Project saved: ${savedProject.id}`);

    // Cleanup temp files
    await fs.remove(mainVideoPath).catch(() => {});
    await fs.remove(reactionVideoPath).catch(() => {});

    res.json({
      success: true,
      data: {
        ...result,
        r2Key,
        r2Url: downloadUrl,
        downloadUrl,
        project: savedProject
      }
    });

  } catch (error) {
    console.error('Single reaction from URL error:', error);
    
    // Cleanup on error
    if (mainVideoPath) await fs.remove(mainVideoPath).catch(() => {});
    if (req.file?.path) await fs.remove(req.file.path).catch(() => {});
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/single-reaction/from-upload
 * 
 * Create single reaction video from two uploaded videos
 * 
 * Body (multipart/form-data):
 * - mainVideo: Uploaded main video file
 * - reactionVideo: Uploaded reaction video file
 * - layoutMode: 'watchReact' (default) | 'faceCam'
 * - pipPosition: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'random'
 * - pipScale: PiP size percentage (default 35)
 * - title: Optional project title
 */
router.post('/from-upload', upload.fields([
  { name: 'mainVideo', maxCount: 1 },
  { name: 'reactionVideo', maxCount: 1 }
]), async (req, res) => {
  try {
    // DEBUG: Log raw body to see what's received
    console.log('\n=== DEBUG: Raw req.body (from-upload) ===');
    console.log(JSON.stringify(req.body, null, 2));
    console.log('layoutMode from body:', req.body.layoutMode);
    console.log('Type of layoutMode:', typeof req.body.layoutMode);
    
    const { 
      layoutMode = 'watchReact',
      pipPosition = 'top-right', 
      pipScale = 35,
      title = ''
    } = req.body;
    
    console.log('layoutMode after destructure:', layoutMode);
    
    const mainVideoPath = req.files?.mainVideo?.[0]?.path;
    const reactionVideoPath = req.files?.reactionVideo?.[0]?.path;
    const mainVideoName = req.files?.mainVideo?.[0]?.originalname || '';

    // Validate inputs
    if (!mainVideoPath) {
      return res.status(400).json({
        success: false,
        error: 'mainVideo file is required'
      });
    }

    if (!reactionVideoPath) {
      return res.status(400).json({
        success: false,
        error: 'reactionVideo file is required'
      });
    }

    // Validate layoutMode
    if (!['watchReact', 'faceCam'].includes(layoutMode)) {
      return res.status(400).json({
        success: false,
        error: 'layoutMode must be "watchReact" or "faceCam"'
      });
    }

    const modeName = layoutMode === 'watchReact' ? '👀 Watch & React' : '🤳 Face Cam';
    console.log(`\n=== SINGLE REACTION FROM UPLOAD ===`);
    console.log(`Mode: ${modeName}`);
    console.log(`Main video: ${mainVideoPath}`);
    console.log(`Reaction video: ${reactionVideoPath}`);
    console.log(`Position: ${pipPosition}, Scale: ${pipScale}%`);

    // Create single reaction video
    const result = await singleReactionService.createSingleReactionVideo(
      mainVideoPath,
      reactionVideoPath,
      {
        layoutMode,
        pipPosition,
        pipScale: parseInt(pipScale, 10)
      }
    );

    // Upload to R2 for persistent storage
    console.log('Uploading to R2...');
    const r2Key = `single-reaction/${result.jobId}/final.mp4`;
    const r2Result = await r2Service.uploadFile(result.outputPath, r2Key);
    console.log(`✓ Uploaded to R2: ${r2Key}`);

    // Generate download URL
    const downloadUrl = r2Result.url || `https://pub-f59b46a864a6463ea4d6747002fd515d.r2.dev/${r2Key}`;

    // Save project metadata
    console.log('Saving project metadata...');
    const projectTitle = title || mainVideoName.replace(/\.[^.]+$/, '').substring(0, 30) || `Project_${Date.now()}`;
    const savedProject = await projectMetadataService.addProject({
      ...result,
      title: projectTitle,
      r2Key,
      downloadUrl
    });
    console.log(`✓ Project saved: ${savedProject.id}`);

    // Cleanup temp files
    await fs.remove(mainVideoPath).catch(() => {});
    await fs.remove(reactionVideoPath).catch(() => {});

    res.json({
      success: true,
      data: {
        ...result,
        r2Key,
        r2Url: downloadUrl,
        downloadUrl,
        project: savedProject
      }
    });

  } catch (error) {
    console.error('Single reaction from upload error:', error);
    
    // Cleanup on error
    if (req.files?.mainVideo?.[0]?.path) {
      await fs.remove(req.files.mainVideo[0].path).catch(() => {});
    }
    if (req.files?.reactionVideo?.[0]?.path) {
      await fs.remove(req.files.reactionVideo[0].path).catch(() => {});
    }
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================
// DOWNLOAD & STATUS ENDPOINTS
// ============================================================

/**
 * GET /api/single-reaction/:jobId/download
 * 
 * Download the final video from temp storage
 */
router.get('/:jobId/download', async (req, res) => {
  try {
    const { jobId } = req.params;
    const outputPath = singleReactionService.getOutputPath(jobId);

    if (!await fs.pathExists(outputPath)) {
      return res.status(404).json({
        success: false,
        error: 'Video not found. It may have been cleaned up.'
      });
    }

    const stats = await fs.stat(outputPath);
    
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="single_reaction_${jobId}.mp4"`);

    const readStream = fs.createReadStream(outputPath);
    readStream.pipe(res);

  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/single-reaction/:jobId/status
 * 
 * Check if a job's output exists
 */
router.get('/:jobId/status', async (req, res) => {
  try {
    const { jobId } = req.params;
    const outputPath = singleReactionService.getOutputPath(jobId);
    const exists = await fs.pathExists(outputPath);

    if (exists) {
      const stats = await fs.stat(outputPath);
      res.json({
        success: true,
        status: 'ready',
        fileSize: stats.size,
        fileSizeMB: (stats.size / 1024 / 1024).toFixed(2)
      });
    } else {
      res.json({
        success: true,
        status: 'not_found'
      });
    }

  } catch (error) {
    console.error('Status check error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/single-reaction/:jobId
 * 
 * Cleanup job files
 */
router.delete('/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    await singleReactionService.cleanup(jobId);
    
    res.json({
      success: true,
      message: `Job ${jobId} cleaned up`
    });

  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Extract a title from a video URL
 */
function extractTitleFromUrl(url) {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    
    // Try to get filename from path
    const parts = pathname.split('/').filter(p => p);
    if (parts.length > 0) {
      const lastPart = parts[parts.length - 1];
      // Remove extension and clean up
      return lastPart.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ').substring(0, 30);
    }
    
    // Fallback to hostname
    return urlObj.hostname.replace('www.', '').split('.')[0];
  } catch {
    return null;
  }
}

module.exports = router;
