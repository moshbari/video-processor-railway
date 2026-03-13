/**
 * ⚡ SPLIT REACT Routes ⚡
 * 
 * API endpoints for "watch + react" style reaction videos with TWO separate clips:
 * 1. Watch Clip - User watching the original video (auto-trimmed to match original)
 * 2. React Clip - User's reaction after watching
 * 
 * Supports two layout modes:
 * - watchReact: Original video full screen, user clips in PiP corner
 * - faceCam: User clips full screen, original video in PiP corner
 * 
 * Endpoints:
 * - POST /api/split-react/fetch-main - Fetch main video from URL (pre-load)
 * - POST /api/split-react/from-url - Create from video URL + two uploaded clips
 * - POST /api/split-react/from-upload - Create from three uploaded videos
 * - POST /api/split-react/from-fetched - Create from pre-fetched video + two uploaded clips
 * - POST /api/split-react/from-clip-maker - Create from Manual Clip Maker clip (R2 URL) + two uploaded clips
 * - GET /api/split-react/projects - List all saved projects
 * - GET /api/split-react/projects/:projectId - Get single project
 * - DELETE /api/split-react/projects/:projectId - Delete project
 * - GET /api/split-react/:jobId/download - Download final video
 * - GET /api/split-react/:jobId/force-download - Force download for mobile
 * - GET /api/split-react/:jobId/status - Check job status
 * - DELETE /api/split-react/:jobId - Cleanup job
 * 
 * Part of RANT Squad Video Editor
 */

const express = require('express');
const router = express.Router();

// Increase timeout for video processing (15 minutes)
router.use((req, res, next) => {
  req.setTimeout(15 * 60 * 1000);
  res.setTimeout(15 * 60 * 1000);
  next();
});
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

const splitReactService = require('../services/splitReactService');
const downloadService = require('../services/downloadService');
const r2Service = require('../services/r2Service');
const projectMetadataService = require('../services/projectMetadataService');

// Store for pre-fetched videos (in-memory, cleared on restart)
// Key: fetchId, Value: { filePath, originalUrl, fetchedAt, title, duration }
const fetchedVideos = new Map();

// Cleanup old fetched videos every 30 minutes
setInterval(() => {
  const now = Date.now();
  const maxAge = 60 * 60 * 1000; // 1 hour
  
  for (const [fetchId, data] of fetchedVideos.entries()) {
    if (now - data.fetchedAt > maxAge) {
      console.log(`[Split React] Cleaning up old fetched video: ${fetchId}`);
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
// PRE-FETCH ENDPOINT
// ============================================================

/**
 * POST /api/split-react/fetch-main
 * 
 * Pre-fetch main video from URL before user uploads reaction clips
 * Returns fetchId to use with /from-fetched endpoint
 * Also returns video duration so frontend can validate watch clip length
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

    console.log(`\n⚡ SPLIT REACT: FETCH MAIN VIDEO ⚡`);
    console.log(`URL: ${videoUrl}`);

    // Download the video
    const downloadResult = await downloadService.downloadVideo(videoUrl);
    
    // Get video duration for frontend reference
    const duration = await splitReactService.getVideoDuration(downloadResult.filePath);
    
    // Generate fetchId and store
    const fetchId = uuidv4();
    fetchedVideos.set(fetchId, {
      filePath: downloadResult.filePath,
      originalUrl: videoUrl,
      fetchedAt: Date.now(),
      title: downloadResult.title || 'Untitled Video',
      duration: duration
    });

    console.log(`✓ Video fetched and stored with ID: ${fetchId}`);
    console.log(`  Duration: ${duration.toFixed(2)}s`);
    console.log(`  Title: ${downloadResult.title || 'Untitled'}`);

    res.json({
      success: true,
      data: {
        fetchId,
        title: downloadResult.title || 'Untitled Video',
        duration: duration,
        durationFormatted: formatDuration(duration),
        message: 'Video fetched successfully. Upload your Watch Clip (should match this duration) and React Clip.'
      }
    });

  } catch (error) {
    console.error('[Split React] Fetch main video error:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch video'
    });
  }
});

// ============================================================
// CREATE FROM URL
// ============================================================

/**
 * POST /api/split-react/from-url
 * 
 * Create Split React video from URL (main video) + two uploaded clips
 * 
 * Body (multipart/form-data):
 * - videoUrl: URL of main video
 * - watchClip: Uploaded "watching" video file
 * - reactClip: Uploaded "reaction" video file
 * - layoutMode: 'watchReact' (default) | 'faceCam'
 * - pipPosition: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'random'
 * - pipScale: PiP size percentage (default 35)
 * - title: Optional project title
 */
router.post('/from-url', upload.fields([
  { name: 'watchClip', maxCount: 1 },
  { name: 'reactClip', maxCount: 1 }
]), async (req, res) => {
  let mainVideoPath = null;
  
  try {
    const { 
      videoUrl, 
      layoutMode = 'watchReact',
      pipPosition = 'top-right', 
      pipScale = 35,
      title = '',
      captions = 'false',
      captionStyle = 'boldPop'
    } = req.body;
    
    const watchClipPath = req.files?.watchClip?.[0]?.path;
    const reactClipPath = req.files?.reactClip?.[0]?.path;
    const captionsEnabled = captions === 'true' || captions === true;

    // Validate inputs
    if (!videoUrl) {
      return res.status(400).json({
        success: false,
        error: 'videoUrl is required'
      });
    }

    if (!watchClipPath) {
      return res.status(400).json({
        success: false,
        error: 'watchClip file is required (your video watching the content)'
      });
    }

    if (!reactClipPath) {
      return res.status(400).json({
        success: false,
        error: 'reactClip file is required (your reaction video)'
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
    console.log(`\n⚡ SPLIT REACT FROM URL ⚡`);
    console.log(`Mode: ${modeName}`);
    console.log(`URL: ${videoUrl}`);
    console.log(`Position: ${pipPosition}, Scale: ${pipScale}%`);
    console.log(`Captions: ${captionsEnabled ? `ON (${captionStyle})` : 'OFF'}`);

    // Download main video
    console.log('Downloading main video...');
    const downloadResult = await downloadService.downloadVideo(videoUrl);
    mainVideoPath = downloadResult.filePath;
    console.log(`✓ Downloaded: ${mainVideoPath}`);

    // Create Split React video
    const result = await splitReactService.createTwoClipReactionVideo(
      mainVideoPath,
      watchClipPath,
      reactClipPath,
      {
        layoutMode,
        pipPosition,
        pipScale: parseInt(pipScale, 10),
        captions: captionsEnabled,
        captionStyle
      }
    );

    // Upload ALL files to R2 for persistent storage
    console.log('Uploading all files to R2...');
    
    // 1. Upload main/original video
    const mainVideoR2Key = `split-react/${result.jobId}/original.mp4`;
    await r2Service.uploadFile(mainVideoPath, mainVideoR2Key);
    console.log(`✓ Uploaded original: ${mainVideoR2Key}`);
    
    // 2. Upload watch clip
    const watchClipR2Key = `split-react/${result.jobId}/watch_clip.mp4`;
    await r2Service.uploadFile(watchClipPath, watchClipR2Key);
    console.log(`✓ Uploaded watch clip: ${watchClipR2Key}`);
    
    // 3. Upload react clip
    const reactClipR2Key = `split-react/${result.jobId}/react_clip.mp4`;
    await r2Service.uploadFile(reactClipPath, reactClipR2Key);
    console.log(`✓ Uploaded react clip: ${reactClipR2Key}`);
    
    // 4. Upload final rendered video
    const r2Key = `split-react/${result.jobId}/final.mp4`;
    const r2Result = await r2Service.uploadFile(result.outputPath, r2Key);
    console.log(`✓ Uploaded final: ${r2Key}`);

    // Generate download URLs
    const baseUrl = 'https://pub-f59b46a864a6463ea4d6747002fd515d.r2.dev';
    const downloadUrl = r2Result.url || `${baseUrl}/${r2Key}`;
    const originalVideoUrl = `${baseUrl}/${mainVideoR2Key}`;
    const watchClipUrl = `${baseUrl}/${watchClipR2Key}`;
    const reactClipUrl = `${baseUrl}/${reactClipR2Key}`;

    // Save project metadata for Recent Projects (with all file URLs)
    console.log('Saving project metadata...');
    const projectTitle = title || downloadResult.title || 'Split React Project';
    const savedProject = await projectMetadataService.addProject({
      type: 'split-react',
      title: projectTitle,
      jobId: result.jobId,
      layoutMode,
      layoutModeName: result.layoutModeName,
      pipPosition,
      pipScale: parseInt(pipScale, 10),
      sourceUrl: videoUrl,
      sourceType: 'url',
      originalDuration: result.originalDuration,
      watchClipDuration: result.watchClipDuration,
      reactClipDuration: result.reactClipDuration,
      totalDuration: result.totalDuration,
      fileSize: result.fileSize,
      fileSizeMB: result.fileSizeMB,
      // All R2 keys for file retrieval
      r2Keys: {
        original: mainVideoR2Key,
        watchClip: watchClipR2Key,
        reactClip: reactClipR2Key,
        final: r2Key
      },
      // All download URLs
      urls: {
        original: originalVideoUrl,
        watchClip: watchClipUrl,
        reactClip: reactClipUrl,
        final: downloadUrl
      },
      downloadUrl,  // Keep for backwards compatibility
      r2Key,        // Keep for backwards compatibility
      createdAt: new Date().toISOString()
    });
    console.log(`✓ Project saved: ${savedProject?.id || 'unknown'}`);

    // Cleanup temp files (they're now in R2)
    await fs.remove(mainVideoPath).catch(() => {});
    await fs.remove(watchClipPath).catch(() => {});
    await fs.remove(reactClipPath).catch(() => {});

    res.json({
      success: true,
      data: {
        ...result,
        projectId: savedProject?.id,
        projectTitle,
        downloadUrl,
        r2Key,
        // Include all URLs in response
        urls: {
          original: originalVideoUrl,
          watchClip: watchClipUrl,
          reactClip: reactClipUrl,
          final: downloadUrl
        }
      }
    });

  } catch (error) {
    console.error('[Split React] From URL error:', error);
    
    // Cleanup on error
    if (mainVideoPath) await fs.remove(mainVideoPath).catch(() => {});
    if (req.files?.watchClip?.[0]?.path) await fs.remove(req.files.watchClip[0].path).catch(() => {});
    if (req.files?.reactClip?.[0]?.path) await fs.remove(req.files.reactClip[0].path).catch(() => {});
    
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create Split React video'
    });
  }
});

// ============================================================
// CREATE FROM UPLOAD
// ============================================================

/**
 * POST /api/split-react/from-upload
 * 
 * Create Split React video from three uploaded videos
 * 
 * Body (multipart/form-data):
 * - mainVideo: Uploaded main video file
 * - watchClip: Uploaded "watching" video file
 * - reactClip: Uploaded "reaction" video file
 * - layoutMode: 'watchReact' (default) | 'faceCam'
 * - pipPosition: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'random'
 * - pipScale: PiP size percentage (default 35)
 * - title: Optional project title
 */
router.post('/from-upload', upload.fields([
  { name: 'mainVideo', maxCount: 1 },
  { name: 'watchClip', maxCount: 1 },
  { name: 'reactClip', maxCount: 1 }
]), async (req, res) => {
  try {
    console.log('\n⚡ SPLIT REACT FROM UPLOAD ⚡');
    console.log('DEBUG: Raw req.body:', JSON.stringify(req.body, null, 2));
    
    const { 
      layoutMode = 'watchReact',
      pipPosition = 'top-right', 
      pipScale = 35,
      title = '',
      captions = 'false',
      captionStyle = 'boldPop'
    } = req.body;
    
    const mainVideoPath = req.files?.mainVideo?.[0]?.path;
    const mainVideoName = req.files?.mainVideo?.[0]?.originalname || '';
    const watchClipPath = req.files?.watchClip?.[0]?.path;
    const reactClipPath = req.files?.reactClip?.[0]?.path;
    const captionsEnabled = captions === 'true' || captions === true;

    // Validate inputs
    if (!mainVideoPath) {
      return res.status(400).json({
        success: false,
        error: 'mainVideo file is required'
      });
    }

    if (!watchClipPath) {
      return res.status(400).json({
        success: false,
        error: 'watchClip file is required (your video watching the content)'
      });
    }

    if (!reactClipPath) {
      return res.status(400).json({
        success: false,
        error: 'reactClip file is required (your reaction video)'
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
    console.log(`Mode: ${modeName}`);
    console.log(`Main video: ${mainVideoPath}`);
    console.log(`Watch clip: ${watchClipPath}`);
    console.log(`React clip: ${reactClipPath}`);
    console.log(`Position: ${pipPosition}, Scale: ${pipScale}%`);
    console.log(`Captions: ${captionsEnabled ? `ON (${captionStyle})` : 'OFF'}`);

    // Create Split React video
    const result = await splitReactService.createTwoClipReactionVideo(
      mainVideoPath,
      watchClipPath,
      reactClipPath,
      {
        layoutMode,
        pipPosition,
        pipScale: parseInt(pipScale, 10),
        captions: captionsEnabled,
        captionStyle
      }
    );

    // Upload ALL files to R2 for persistent storage
    console.log('Uploading all files to R2...');
    
    // 1. Upload main/original video
    const mainVideoR2Key = `split-react/${result.jobId}/original.mp4`;
    await r2Service.uploadFile(mainVideoPath, mainVideoR2Key);
    console.log(`✓ Uploaded original: ${mainVideoR2Key}`);
    
    // 2. Upload watch clip
    const watchClipR2Key = `split-react/${result.jobId}/watch_clip.mp4`;
    await r2Service.uploadFile(watchClipPath, watchClipR2Key);
    console.log(`✓ Uploaded watch clip: ${watchClipR2Key}`);
    
    // 3. Upload react clip
    const reactClipR2Key = `split-react/${result.jobId}/react_clip.mp4`;
    await r2Service.uploadFile(reactClipPath, reactClipR2Key);
    console.log(`✓ Uploaded react clip: ${reactClipR2Key}`);
    
    // 4. Upload final rendered video
    const r2Key = `split-react/${result.jobId}/final.mp4`;
    const r2Result = await r2Service.uploadFile(result.outputPath, r2Key);
    console.log(`✓ Uploaded final: ${r2Key}`);

    // Generate download URLs
    const baseUrl = 'https://pub-f59b46a864a6463ea4d6747002fd515d.r2.dev';
    const downloadUrl = r2Result.url || `${baseUrl}/${r2Key}`;
    const originalVideoUrl = `${baseUrl}/${mainVideoR2Key}`;
    const watchClipUrl = `${baseUrl}/${watchClipR2Key}`;
    const reactClipUrl = `${baseUrl}/${reactClipR2Key}`;

    // Save project metadata for Recent Projects (with all file URLs)
    console.log('Saving project metadata...');
    const projectTitle = title || mainVideoName.replace(/\.[^.]+$/, '') || 'Split React Project';
    const savedProject = await projectMetadataService.addProject({
      type: 'split-react',
      title: projectTitle,
      jobId: result.jobId,
      layoutMode,
      layoutModeName: result.layoutModeName,
      pipPosition,
      pipScale: parseInt(pipScale, 10),
      sourceType: 'upload',
      originalDuration: result.originalDuration,
      watchClipDuration: result.watchClipDuration,
      reactClipDuration: result.reactClipDuration,
      totalDuration: result.totalDuration,
      fileSize: result.fileSize,
      fileSizeMB: result.fileSizeMB,
      // All R2 keys for file retrieval
      r2Keys: {
        original: mainVideoR2Key,
        watchClip: watchClipR2Key,
        reactClip: reactClipR2Key,
        final: r2Key
      },
      // All download URLs
      urls: {
        original: originalVideoUrl,
        watchClip: watchClipUrl,
        reactClip: reactClipUrl,
        final: downloadUrl
      },
      downloadUrl,  // Keep for backwards compatibility
      r2Key,        // Keep for backwards compatibility
      createdAt: new Date().toISOString()
    });
    console.log(`✓ Project saved: ${savedProject?.id || 'unknown'}`);

    // Cleanup temp files (they're now in R2)
    await fs.remove(mainVideoPath).catch(() => {});
    await fs.remove(watchClipPath).catch(() => {});
    await fs.remove(reactClipPath).catch(() => {});

    res.json({
      success: true,
      data: {
        ...result,
        projectId: savedProject?.id,
        projectTitle,
        downloadUrl,
        r2Key,
        // Include all URLs in response
        urls: {
          original: originalVideoUrl,
          watchClip: watchClipUrl,
          reactClip: reactClipUrl,
          final: downloadUrl
        }
      }
    });

  } catch (error) {
    console.error('[Split React] From upload error:', error);
    
    // Cleanup on error
    if (req.files?.mainVideo?.[0]?.path) await fs.remove(req.files.mainVideo[0].path).catch(() => {});
    if (req.files?.watchClip?.[0]?.path) await fs.remove(req.files.watchClip[0].path).catch(() => {});
    if (req.files?.reactClip?.[0]?.path) await fs.remove(req.files.reactClip[0].path).catch(() => {});
    
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create Split React video'
    });
  }
});

// ============================================================
// CREATE FROM PRE-FETCHED VIDEO
// ============================================================

/**
 * POST /api/split-react/from-fetched
 * 
 * Create Split React video from pre-fetched main video + two uploaded clips
 * 
 * Body (multipart/form-data):
 * - fetchId: ID from /fetch-main endpoint
 * - watchClip: Uploaded "watching" video file
 * - reactClip: Uploaded "reaction" video file
 * - layoutMode: 'watchReact' (default) | 'faceCam'
 * - pipPosition: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'random'
 * - pipScale: PiP size percentage (default 35)
 * - title: Optional project title
 */
router.post('/from-fetched', upload.fields([
  { name: 'watchClip', maxCount: 1 },
  { name: 'reactClip', maxCount: 1 }
]), async (req, res) => {
  try {
    const { 
      fetchId,
      layoutMode = 'watchReact',
      pipPosition = 'top-right', 
      pipScale = 35,
      title = '',
      captions = 'false',
      captionStyle = 'boldPop'
    } = req.body;
    
    const watchClipPath = req.files?.watchClip?.[0]?.path;
    const reactClipPath = req.files?.reactClip?.[0]?.path;
    const captionsEnabled = captions === 'true' || captions === true;

    // Validate fetchId
    if (!fetchId) {
      return res.status(400).json({
        success: false,
        error: 'fetchId is required (from /fetch-main endpoint)'
      });
    }

    const fetchedData = fetchedVideos.get(fetchId);
    if (!fetchedData) {
      return res.status(404).json({
        success: false,
        error: 'Fetched video not found or expired. Please fetch the video again.'
      });
    }

    if (!watchClipPath) {
      return res.status(400).json({
        success: false,
        error: 'watchClip file is required (your video watching the content)'
      });
    }

    if (!reactClipPath) {
      return res.status(400).json({
        success: false,
        error: 'reactClip file is required (your reaction video)'
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
    console.log(`\n⚡ SPLIT REACT FROM FETCHED ⚡`);
    console.log(`Mode: ${modeName}`);
    console.log(`Fetch ID: ${fetchId}`);
    console.log(`Main video: ${fetchedData.filePath}`);
    console.log(`Original URL: ${fetchedData.originalUrl}`);
    console.log(`Position: ${pipPosition}, Scale: ${pipScale}%`);
    console.log(`Captions: ${captionsEnabled ? `ON (${captionStyle})` : 'OFF'}`);

    // Create Split React video
    const result = await splitReactService.createTwoClipReactionVideo(
      fetchedData.filePath,
      watchClipPath,
      reactClipPath,
      {
        layoutMode,
        pipPosition,
        pipScale: parseInt(pipScale, 10),
        captions: captionsEnabled,
        captionStyle
      }
    );

    // Upload ALL files to R2 for persistent storage
    console.log('Uploading all files to R2...');
    
    // 1. Upload main/original video
    const mainVideoR2Key = `split-react/${result.jobId}/original.mp4`;
    await r2Service.uploadFile(fetchedData.filePath, mainVideoR2Key);
    console.log(`✓ Uploaded original: ${mainVideoR2Key}`);
    
    // 2. Upload watch clip
    const watchClipR2Key = `split-react/${result.jobId}/watch_clip.mp4`;
    await r2Service.uploadFile(watchClipPath, watchClipR2Key);
    console.log(`✓ Uploaded watch clip: ${watchClipR2Key}`);
    
    // 3. Upload react clip
    const reactClipR2Key = `split-react/${result.jobId}/react_clip.mp4`;
    await r2Service.uploadFile(reactClipPath, reactClipR2Key);
    console.log(`✓ Uploaded react clip: ${reactClipR2Key}`);
    
    // 4. Upload final rendered video
    const r2Key = `split-react/${result.jobId}/final.mp4`;
    const r2Result = await r2Service.uploadFile(result.outputPath, r2Key);
    console.log(`✓ Uploaded final: ${r2Key}`);

    // Generate download URLs
    const baseUrl = 'https://pub-f59b46a864a6463ea4d6747002fd515d.r2.dev';
    const downloadUrl = r2Result.url || `${baseUrl}/${r2Key}`;
    const originalVideoUrl = `${baseUrl}/${mainVideoR2Key}`;
    const watchClipUrl = `${baseUrl}/${watchClipR2Key}`;
    const reactClipUrl = `${baseUrl}/${reactClipR2Key}`;

    // Save project metadata for Recent Projects (with all file URLs)
    console.log('Saving project metadata...');
    const projectTitle = title || fetchedData.title || 'Split React Project';
    const savedProject = await projectMetadataService.addProject({
      type: 'split-react',
      title: projectTitle,
      jobId: result.jobId,
      layoutMode,
      layoutModeName: result.layoutModeName,
      pipPosition,
      pipScale: parseInt(pipScale, 10),
      sourceUrl: fetchedData.originalUrl,
      sourceType: 'fetched',
      originalDuration: result.originalDuration,
      watchClipDuration: result.watchClipDuration,
      reactClipDuration: result.reactClipDuration,
      totalDuration: result.totalDuration,
      fileSize: result.fileSize,
      fileSizeMB: result.fileSizeMB,
      // All R2 keys for file retrieval
      r2Keys: {
        original: mainVideoR2Key,
        watchClip: watchClipR2Key,
        reactClip: reactClipR2Key,
        final: r2Key
      },
      // All download URLs
      urls: {
        original: originalVideoUrl,
        watchClip: watchClipUrl,
        reactClip: reactClipUrl,
        final: downloadUrl
      },
      downloadUrl,  // Keep for backwards compatibility
      r2Key,        // Keep for backwards compatibility
      createdAt: new Date().toISOString()
    });
    console.log(`✓ Project saved: ${savedProject?.id || 'unknown'}`);

    // Cleanup fetched video from memory store (already uploaded to R2)
    fetchedVideos.delete(fetchId);
    await fs.remove(fetchedData.filePath).catch(() => {});
    
    // Cleanup uploaded clips (already uploaded to R2)
    await fs.remove(watchClipPath).catch(() => {});
    await fs.remove(reactClipPath).catch(() => {});

    res.json({
      success: true,
      data: {
        ...result,
        projectId: savedProject?.id,
        projectTitle,
        downloadUrl,
        r2Key,
        // Include all URLs in response
        urls: {
          original: originalVideoUrl,
          watchClip: watchClipUrl,
          reactClip: reactClipUrl,
          final: downloadUrl
        }
      }
    });

  } catch (error) {
    console.error('[Split React] From fetched error:', error);
    
    // Cleanup on error
    if (req.files?.watchClip?.[0]?.path) await fs.remove(req.files.watchClip[0].path).catch(() => {});
    if (req.files?.reactClip?.[0]?.path) await fs.remove(req.files.reactClip[0].path).catch(() => {});
    
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create Split React video'
    });
  }
});

// ============================================================
// PROJECT MANAGEMENT ENDPOINTS (For Recent Projects UI)
// ============================================================

/**
 * GET /api/split-react/projects
 * List all Split React projects for Recent Projects sidebar
 */
router.get('/projects', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const projects = await projectMetadataService.getProjects({ limit });
    
    // Filter to only split-react type projects
    const splitReactProjects = projects.filter(p => p.type === 'split-react');
    
    res.json({
      success: true,
      data: splitReactProjects
    });
  } catch (error) {
    console.error('[Split React] List projects error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/split-react/projects/:projectId
 * Get single project details
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
      data: project
    });
  } catch (error) {
    console.error('[Split React] Get project error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/split-react/projects/:projectId
 * Delete project and associated files from R2
 */
router.delete('/projects/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;
    
    // Get project to find r2Key for cleanup
    const project = await projectMetadataService.getProject(projectId);
    if (project && project.r2Key) {
      console.log(`Deleting R2 file: ${project.r2Key}`);
      await r2Service.deleteFile(project.r2Key).catch(() => {});
    }
    
    await projectMetadataService.deleteProject(projectId);
    
    res.json({
      success: true,
      message: `Project ${projectId} deleted`
    });
  } catch (error) {
    console.error('[Split React] Delete project error:', error);
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
 * GET /api/split-react/:jobId/download
 * Download the final video (streams from temp if available, otherwise redirects to R2)
 */
router.get('/:jobId/download', async (req, res) => {
  try {
    const { jobId } = req.params;
    const tempPath = splitReactService.getOutputPath(jobId);
    
    // Check if file exists in temp storage
    if (await fs.pathExists(tempPath)) {
      const stats = await fs.stat(tempPath);
      
      // Generate filename with timestamp (GMT+4)
      const now = new Date();
      const gmt4 = new Date(now.getTime() + (4 * 60 * 60 * 1000));
      const dateStr = gmt4.toISOString().slice(0, 10).replace(/-/g, '');
      const timeStr = gmt4.toISOString().slice(11, 16).replace(':', '');
      const filename = `SPLIT_${dateStr}_${timeStr}_${jobId.slice(0, 8)}.mp4`;
      
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      
      const readStream = fs.createReadStream(tempPath);
      readStream.pipe(res);
      return;
    }
    
    // Try to get from R2
    const r2Key = `split-react/${jobId}/final.mp4`;
    const r2Url = `https://pub-f59b46a864a6463ea4d6747002fd515d.r2.dev/${r2Key}`;
    
    // Redirect to R2 URL
    res.redirect(r2Url);
    
  } catch (error) {
    console.error('[Split React] Download error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/split-react/:jobId/force-download
 * Force download for mobile devices (iPhone compatibility)
 */
router.get('/:jobId/force-download', async (req, res) => {
  try {
    const { jobId } = req.params;
    
    // Generate filename (GMT+4)
    const now = new Date();
    const gmt4 = new Date(now.getTime() + (4 * 60 * 60 * 1000));
    const dateStr = gmt4.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = gmt4.toISOString().slice(11, 16).replace(':', '');
    const filename = `SPLIT_${dateStr}_${timeStr}_${jobId.slice(0, 8)}.mp4`;
    
    // Check temp storage first
    const tempPath = splitReactService.getOutputPath(jobId);
    
    if (await fs.pathExists(tempPath)) {
      const stats = await fs.stat(tempPath);
      
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-cache');
      
      const readStream = fs.createReadStream(tempPath);
      readStream.pipe(res);
      return;
    }
    
    // Fallback to R2
    const r2Key = `split-react/${jobId}/final.mp4`;
    
    try {
      const fileBuffer = await r2Service.getFileBuffer(r2Key);
      
      res.setHeader('Content-Length', fileBuffer.length);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-cache');
      
      res.send(fileBuffer);
    } catch (r2Error) {
      console.error('[Split React] R2 fetch error:', r2Error);
      res.status(404).json({
        success: false,
        error: 'Video not found or expired'
      });
    }
    
  } catch (error) {
    console.error('[Split React] Force download error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/split-react/:jobId/status
 * Check job status and get info
 */
router.get('/:jobId/status', async (req, res) => {
  try {
    const { jobId } = req.params;
    const outputPath = splitReactService.getOutputPath(jobId);
    
    const exists = await fs.pathExists(outputPath);
    
    if (exists) {
      const stats = await fs.stat(outputPath);
      res.json({
        success: true,
        status: 'complete',
        fileSize: stats.size,
        fileSizeMB: (stats.size / 1024 / 1024).toFixed(2),
        downloadUrl: `/api/split-react/${jobId}/download`
      });
    } else {
      // Check R2
      const r2Key = `split-react/${jobId}/final.mp4`;
      const r2Url = `https://pub-f59b46a864a6463ea4d6747002fd515d.r2.dev/${r2Key}`;
      
      res.json({
        success: true,
        status: 'available',
        storage: 'r2',
        downloadUrl: r2Url
      });
    }
    
  } catch (error) {
    console.error('[Split React] Status check error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/split-react/:jobId
 * Cleanup job files from temp storage
 */
router.delete('/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    await splitReactService.cleanup(jobId);
    
    res.json({
      success: true,
      message: `Job ${jobId} cleaned up`
    });
    
  } catch (error) {
    console.error('[Split React] Cleanup error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================================
// CREATE FROM CLIP MAKER (R2 URL)
// ============================================================

/**
 * POST /api/split-react/from-clip-maker
 * 
 * Create Split React video using a Manual Clip Maker clip as the main video.
 * Downloads the clip from R2 instead of requiring a file upload or URL download.
 * 
 * Body (multipart/form-data):
 * - clipUrl: R2 download URL of the clip from Manual Clip Maker
 * - clipTitle: Title of the selected clip (for project naming)
 * - watchClip: Uploaded "watching" video file
 * - reactClip: Uploaded "reaction" video file
 * - layoutMode: 'watchReact' (default) | 'faceCam'
 * - pipPosition: 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'random'
 * - pipScale: PiP size percentage (default 35)
 * - title: Optional project title
 * - captions: 'true' | 'false'
 * - captionStyle: caption style id
 */
router.post('/from-clip-maker', upload.fields([
  { name: 'watchClip', maxCount: 1 },
  { name: 'reactClip', maxCount: 1 }
]), async (req, res) => {
  let mainVideoPath = null;

  try {
    const {
      clipUrl,
      clipTitle = '',
      layoutMode = 'watchReact',
      pipPosition = 'top-right',
      pipScale = 35,
      title = '',
      captions = 'false',
      captionStyle = 'boldPop'
    } = req.body;

    const watchClipPath = req.files?.watchClip?.[0]?.path;
    const reactClipPath = req.files?.reactClip?.[0]?.path;
    const captionsEnabled = captions === 'true' || captions === true;

    // Validate clipUrl
    if (!clipUrl) {
      return res.status(400).json({
        success: false,
        error: 'clipUrl is required (the R2 URL of the clip from Manual Clip Maker)'
      });
    }

    if (!watchClipPath) {
      return res.status(400).json({
        success: false,
        error: 'watchClip file is required (your video watching the content)'
      });
    }

    if (!reactClipPath) {
      return res.status(400).json({
        success: false,
        error: 'reactClip file is required (your reaction video)'
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
    console.log(`\n⚡ SPLIT REACT FROM CLIP MAKER ⚡`);
    console.log(`Mode: ${modeName}`);
    console.log(`Clip URL: ${clipUrl}`);
    console.log(`Clip Title: ${clipTitle}`);
    console.log(`Position: ${pipPosition}, Scale: ${pipScale}%`);
    console.log(`Captions: ${captionsEnabled ? `ON (${captionStyle})` : 'OFF'}`);

    // Download the clip from R2 to local temp
    const tempDir = process.env.TEMP_DIR || '/app/temp';
    fs.ensureDirSync(tempDir);
    mainVideoPath = path.join(tempDir, `clipmaker_${uuidv4()}.mp4`);
    
    console.log('Downloading clip from R2...');
    await r2Service.downloadFile(clipUrl, mainVideoPath);
    console.log(`✓ Downloaded clip to: ${mainVideoPath}`);

    // Create Split React video
    const result = await splitReactService.createTwoClipReactionVideo(
      mainVideoPath,
      watchClipPath,
      reactClipPath,
      {
        layoutMode,
        pipPosition,
        pipScale: parseInt(pipScale, 10),
        captions: captionsEnabled,
        captionStyle
      }
    );

    // Upload ALL files to R2 for persistent storage
    console.log('Uploading all files to R2...');

    // 1. Upload main/original video (the clip from Clip Maker)
    const mainVideoR2Key = `split-react/${result.jobId}/original.mp4`;
    await r2Service.uploadFile(mainVideoPath, mainVideoR2Key);
    console.log(`✓ Uploaded original: ${mainVideoR2Key}`);

    // 2. Upload watch clip
    const watchClipR2Key = `split-react/${result.jobId}/watch_clip.mp4`;
    await r2Service.uploadFile(watchClipPath, watchClipR2Key);
    console.log(`✓ Uploaded watch clip: ${watchClipR2Key}`);

    // 3. Upload react clip
    const reactClipR2Key = `split-react/${result.jobId}/react_clip.mp4`;
    await r2Service.uploadFile(reactClipPath, reactClipR2Key);
    console.log(`✓ Uploaded react clip: ${reactClipR2Key}`);

    // 4. Upload final rendered video
    const r2Key = `split-react/${result.jobId}/final.mp4`;
    const r2Result = await r2Service.uploadFile(result.outputPath, r2Key);
    console.log(`✓ Uploaded final: ${r2Key}`);

    // Generate download URLs
    const baseUrl = 'https://pub-f59b46a864a6463ea4d6747002fd515d.r2.dev';
    const downloadUrl = r2Result.url || `${baseUrl}/${r2Key}`;
    const originalVideoUrl = `${baseUrl}/${mainVideoR2Key}`;
    const watchClipUrl = `${baseUrl}/${watchClipR2Key}`;
    const reactClipUrl = `${baseUrl}/${reactClipR2Key}`;

    // Save project metadata
    console.log('Saving project metadata...');
    const projectTitle = title || clipTitle || 'Split React (from Clip Maker)';
    const savedProject = await projectMetadataService.addProject({
      type: 'split-react',
      title: projectTitle,
      jobId: result.jobId,
      layoutMode,
      layoutModeName: result.layoutModeName,
      pipPosition,
      pipScale: parseInt(pipScale, 10),
      sourceUrl: clipUrl,
      sourceType: 'clip-maker',
      originalDuration: result.originalDuration,
      watchClipDuration: result.watchClipDuration,
      reactClipDuration: result.reactClipDuration,
      totalDuration: result.totalDuration,
      fileSize: result.fileSize,
      fileSizeMB: result.fileSizeMB,
      r2Keys: {
        original: mainVideoR2Key,
        watchClip: watchClipR2Key,
        reactClip: reactClipR2Key,
        final: r2Key
      },
      urls: {
        original: originalVideoUrl,
        watchClip: watchClipUrl,
        reactClip: reactClipUrl,
        final: downloadUrl
      },
      downloadUrl,
      r2Key,
      createdAt: new Date().toISOString()
    });
    console.log(`✓ Project saved: ${savedProject?.id || 'unknown'}`);

    // Cleanup temp files
    await fs.remove(mainVideoPath).catch(() => {});
    await fs.remove(watchClipPath).catch(() => {});
    await fs.remove(reactClipPath).catch(() => {});

    res.json({
      success: true,
      data: {
        ...result,
        projectId: savedProject?.id,
        projectTitle,
        downloadUrl,
        r2Key,
        urls: {
          original: originalVideoUrl,
          watchClip: watchClipUrl,
          reactClip: reactClipUrl,
          final: downloadUrl
        }
      }
    });

  } catch (error) {
    console.error('[Split React] From Clip Maker error:', error);

    // Cleanup on error
    if (mainVideoPath) await fs.remove(mainVideoPath).catch(() => {});
    if (req.files?.watchClip?.[0]?.path) await fs.remove(req.files.watchClip[0].path).catch(() => {});
    if (req.files?.reactClip?.[0]?.path) await fs.remove(req.files.reactClip[0].path).catch(() => {});

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to create Split React video from Clip Maker clip'
    });
  }
});

// ============================================================
// CAPTION STYLES ENDPOINT
// ============================================================

/**
 * GET /api/split-react/caption-styles
 * Returns available caption styles for the frontend picker
 */
router.get('/caption-styles', (req, res) => {
  const captionService = require('../services/captionService');
  
  const styles = [
    { id: 'boldPop', name: 'Bold Pop', tag: 'MRBEAST', tagColor: '#FFE500', description: 'MrBeast viral style — big, punchy, yellow highlight on active word' },
    { id: 'hormoziStack', name: 'Hormozi Stack', tag: 'COACHING', tagColor: '#22c55e', description: 'One giant word at a time, slams into center screen — maximum impact' },
    { id: 'karaokeWipe', name: 'Karaoke Wipe', tag: 'TRENDING', tagColor: '#ff6b6b', description: 'Color fills each word left-to-right as spoken — smooth and satisfying' },
    { id: 'neonGlow', name: 'Neon Glow', tag: 'RANT SQUAD', tagColor: '#00d4ff', description: 'RANT Squad signature — electric blue glow, on-brand' },
    { id: 'subtleClean', name: 'Subtle Clean', tag: 'PROFESSIONAL', tagColor: '#94a3b8', description: 'Minimal white text on dark bar — great for podcasts and interviews' },
    { id: 'boxHighlight', name: 'Box Highlight', tag: 'REELS', tagColor: '#a78bfa', description: 'Active word gets a colored box behind it — clean and readable' },
    { id: 'aliAbdaal', name: 'Ali Abdaal', tag: 'EDUCATIONAL', tagColor: '#60a5fa', description: 'Clean and modern — spoken words fade to dark, active word stays bright' },
    { id: 'emojiBurst', name: 'Emoji Burst', tag: 'VIRAL', tagColor: '#f97316', description: 'Bold captions + auto emoji on keywords — the #1 Submagic-style trend' },
  ];

  res.json({
    success: true,
    data: styles
  });
});

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Format duration to MM:SS or HH:MM:SS
 */
function formatDuration(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

module.exports = router;
