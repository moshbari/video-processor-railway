/**
 * Single Reaction Routes
 * 
 * API endpoints for full-length reaction videos with TWO layout modes:
 * 
 * 1. "Watch & React" (watchReact): Main video full screen, reaction in PiP corner
 * 2. "Face Cam" (faceCam): Reaction full screen, main video in PiP corner
 * 
 * Endpoints:
 * - POST /api/single-reaction/fetch-main - Fetch main video from URL (pre-load)
 * - POST /api/single-reaction/from-url - Create from video URL + uploaded reaction
 * - POST /api/single-reaction/from-upload - Create from two uploaded videos
 * - POST /api/single-reaction/from-fetched - Create from pre-fetched video + uploaded reaction
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

// Store for pre-fetched videos (in-memory, cleared on restart)
// Key: fetchId, Value: { filePath, originalUrl, fetchedAt, title }
const fetchedVideos = new Map();

// Cleanup old fetched videos every 30 minutes
setInterval(() => {
  const now = Date.now();
  const maxAge = 60 * 60 * 1000; // 1 hour
  
  for (const [fetchId, data] of fetchedVideos.entries()) {
    if (now - data.fetchedAt > maxAge) {
      console.log(`Cleaning up old fetched video: ${fetchId}`);
      fs.remove(data.filePath).catch(() => {});
      fetchedVideos.delete(fetchId);
    }
  }
}, 30 * 60 * 1000);

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
// PRE-FETCH ENDPOINT (NEW!)
// ============================================================

/**
 * POST /api/single-reaction/fetch-main
 * 
 * Pre-fetch main video from URL before creating reaction
 * This validates AND fetches the video so it's ready to use
 * 
 * Body (JSON):
 * - videoUrl: URL of main video
 * 
 * Returns:
 * - fetchId: ID to use when creating reaction
 * - title: Video title (if available)
 * - duration: Video duration (if available)
 */
router.post('/fetch-main', async (req, res) => {
  try {
    const { videoUrl } = req.body;

    if (!videoUrl) {
      return res.status(400).json({
        success: false,
        error: 'videoUrl is required'
      });
    }

    console.log(`\n=== FETCHING MAIN VIDEO ===`);
    console.log(`URL: ${videoUrl}`);

    // Generate unique ID for this fetch
    const fetchId = uuidv4();

    // Fetch the video
    console.log('Fetching video...');
    const fetchResult = await downloadService.downloadVideo(videoUrl);
    
    // Handle different possible return formats from downloadService
    const filePath = fetchResult.filePath || fetchResult.path || fetchResult.outputPath || fetchResult.videoPath;
    
    if (!filePath) {
      throw new Error('Fetch failed - no file path returned');
    }
    
    // Verify file exists
    const fileExists = await fs.pathExists(filePath);
    if (!fileExists) {
      throw new Error('Fetch failed - file not found');
    }

    // Get file size
    const stats = await fs.stat(filePath);
    const fileSizeMB = (stats.size / 1024 / 1024).toFixed(2);

    // Extract title from URL or result
    const title = fetchResult.title || extractTitleFromUrl(videoUrl) || 'Main Video';

    // Store in memory for later use
    fetchedVideos.set(fetchId, {
      filePath,
      originalUrl: videoUrl,
      fetchedAt: Date.now(),
      title,
      fileSize: stats.size,
      fileSizeMB
    });

    console.log(`✓ Video fetched successfully`);
    console.log(`  Fetch ID: ${fetchId}`);
    console.log(`  File: ${filePath}`);
    console.log(`  Size: ${fileSizeMB} MB`);

    res.json({
      success: true,
      data: {
        fetchId,
        title,
        fileSizeMB,
        message: 'Video ready! Now upload your reaction video.'
      }
    });

  } catch (error) {
    console.error('Fetch main video error:', error);
    
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch video. Please check the URL and try again.'
    });
  }
});

/**
 * GET /api/single-reaction/fetch-status/:fetchId
 * 
 * Check if a fetched video is still available
 */
router.get('/fetch-status/:fetchId', async (req, res) => {
  try {
    const { fetchId } = req.params;
    const fetchedVideo = fetchedVideos.get(fetchId);

    if (!fetchedVideo) {
      return res.json({
        success: true,
        available: false,
        message: 'Video not found or expired'
      });
    }

    // Verify file still exists
    const exists = await fs.pathExists(fetchedVideo.filePath);

    res.json({
      success: true,
      available: exists,
      title: fetchedVideo.title,
      fileSizeMB: fetchedVideo.fileSizeMB,
      fetchedAt: fetchedVideo.fetchedAt
    });

  } catch (error) {
    console.error('Fetch status error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/single-reaction/fetch/:fetchId
 * 
 * Cancel/cleanup a fetched video
 */
router.delete('/fetch/:fetchId', async (req, res) => {
  try {
    const { fetchId } = req.params;
    const fetchedVideo = fetchedVideos.get(fetchId);

    if (fetchedVideo) {
      await fs.remove(fetchedVideo.filePath).catch(() => {});
      fetchedVideos.delete(fetchId);
    }

    res.json({
      success: true,
      message: 'Fetched video cleaned up'
    });

  } catch (error) {
    console.error('Fetch cleanup error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
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
 * POST /api/single-reaction/from-fetched
 * 
 * Create single reaction video using a PRE-FETCHED main video
 * This is the preferred method when using URL input
 * 
 * Body (multipart/form-data):
 * - fetchId: ID from /fetch-main endpoint
 * - reactionVideo: Uploaded reaction video file
 * - layoutMode: 'watchReact' (default) | 'faceCam'
 * - pipPosition: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'random'
 * - pipScale: PiP size percentage (default 35)
 * - title: Optional project title
 */
router.post('/from-fetched', upload.single('reactionVideo'), async (req, res) => {
  try {
    // DEBUG: Log raw body
    console.log('\n=== DEBUG: Raw req.body (from-fetched) ===');
    console.log(JSON.stringify(req.body, null, 2));
    
    const { 
      fetchId,
      layoutMode = 'watchReact',
      pipPosition = 'top-right', 
      pipScale = 35,
      title = ''
    } = req.body;
    const reactionVideoPath = req.file?.path;

    console.log('fetchId:', fetchId);
    console.log('layoutMode:', layoutMode);

    // Validate fetchId
    if (!fetchId) {
      return res.status(400).json({
        success: false,
        error: 'fetchId is required. Please fetch the main video first.'
      });
    }

    // Get the fetched video
    const fetchedVideo = fetchedVideos.get(fetchId);
    if (!fetchedVideo) {
      return res.status(400).json({
        success: false,
        error: 'Fetched video not found or expired. Please fetch the video again.'
      });
    }

    // Verify file still exists
    const mainVideoExists = await fs.pathExists(fetchedVideo.filePath);
    if (!mainVideoExists) {
      fetchedVideos.delete(fetchId);
      return res.status(400).json({
        success: false,
        error: 'Fetched video file not found. Please fetch the video again.'
      });
    }

    const mainVideoPath = fetchedVideo.filePath;

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
    console.log(`\n=== SINGLE REACTION FROM FETCHED ===`);
    console.log(`Mode: ${modeName}`);
    console.log(`Fetch ID: ${fetchId}`);
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
    const projectTitle = title || fetchedVideo.title || `Project_${Date.now()}`;
    const savedProject = await projectMetadataService.addProject({
      ...result,
      title: projectTitle,
      r2Key,
      downloadUrl
    });
    console.log(`✓ Project saved: ${savedProject.id}`);

    // Cleanup fetched video (it's been used)
    fetchedVideos.delete(fetchId);
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
    console.error('Single reaction from fetched error:', error);
    
    // Cleanup on error
    if (req.file?.path) await fs.remove(req.file.path).catch(() => {});
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/single-reaction/from-url
 * 
 * Create single reaction video from URL (main video) + uploaded reaction
 * NOTE: Consider using /fetch-main + /from-fetched for better UX
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

    // Fetch main video
    console.log('Fetching main video...');
    const fetchResult = await downloadService.downloadVideo(videoUrl);
    
    // Handle different possible return formats from downloadService
    mainVideoPath = fetchResult.filePath || fetchResult.path || fetchResult.outputPath || fetchResult.videoPath;
    
    if (!mainVideoPath) {
      throw new Error(`Fetch succeeded but no file path returned. Result: ${JSON.stringify(fetchResult)}`);
    }
    
    // Verify file exists
    const fileExists = await fs.pathExists(mainVideoPath);
    if (!fileExists) {
      throw new Error(`Fetched file not found at path: ${mainVideoPath}`);
    }
    
    console.log(`✓ Fetched: ${mainVideoPath}`);

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
 * GET /api/single-reaction/force-download/:projectId
 * 
 * Force download a video file (works on mobile!)
 * Fetches from R2 and streams with download headers
 */
router.get('/force-download/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    
    console.log(`\n=== FORCE DOWNLOAD: ${projectId} ===`);
    
    // Get project metadata
    const project = await projectMetadataService.getProject(projectId);
    
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found'
      });
    }

    if (project.expired) {
      return res.status(410).json({
        success: false,
        error: 'This video has expired'
      });
    }

    // Get the R2 key
    const r2Key = project.r2Key;
    if (!r2Key) {
      return res.status(404).json({
        success: false,
        error: 'Video file not found'
      });
    }

    console.log(`Fetching from R2: ${r2Key}`);

    // Fetch file from R2
    const fileBuffer = await r2Service.getFile(r2Key);
    
    if (!fileBuffer) {
      return res.status(404).json({
        success: false,
        error: 'Video file not found in storage'
      });
    }

    // Generate filename
    const safeTitle = (project.title || 'reaction_video')
      .replace(/[^a-zA-Z0-9]/g, '_')
      .substring(0, 50);
    const filename = `${safeTitle}_${projectId.substring(0, 8)}.mp4`;

    console.log(`Sending file: ${filename} (${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB)`);

    // Set headers to FORCE download (not play in browser)
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', fileBuffer.length);
    res.setHeader('Cache-Control', 'no-cache');
    
    // Send the file
    res.send(fileBuffer);

    console.log(`✓ Force download complete: ${filename}`);

  } catch (error) {
    console.error('Force download error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

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
