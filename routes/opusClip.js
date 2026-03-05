/**
 * 🎬 OPUS CLIP ROUTES
 * 
 * API endpoints for AI-powered viral clip extraction
 * 
 * POST /api/opus-clip/analyze         - Analyze video (URL or upload) → get clip suggestions
 * POST /api/opus-clip/generate/:jobId  - Generate selected clips with reframe + captions
 * GET  /api/opus-clip/status/:jobId    - Check job progress
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

const opusClipService = require('../services/opusClipService');

// Upload directory
const opusUploadDir = path.join(process.env.TEMP_DIR || '/app/temp', 'opus-uploads');
fs.ensureDirSync(opusUploadDir);

// Use custom DiskStorage to ensure directory exists before every upload
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    fs.ensureDirSync(opusUploadDir);
    cb(null, opusUploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueName = require('crypto').randomBytes(16).toString('hex') + path.extname(file.originalname);
    cb(null, uniqueName);
  }
});

// Configure multer for video uploads (max 5GB)
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 } // 5GB
});

// ============================================================
// POST /api/opus-clip/analyze
// Analyze a video and find viral moments
// Accepts: video file upload OR URL in body
// ============================================================
router.post('/analyze', upload.single('video'), async (req, res) => {
  try {
    const { url, clipCount, minLength, maxLength, contentType } = req.body;

    // Must provide either a URL or file upload
    if (!url && !req.file) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a video URL or upload a video file.'
      });
    }

    console.log('\n' + '🎬'.repeat(30));
    console.log('[OpusClip] New analysis request');
    if (url) console.log(`  URL: ${url}`);
    if (req.file) console.log(`  File: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)}MB)`);
    console.log('🎬'.repeat(30));

    // Build input object
    const input = {
      clipCount: parseInt(clipCount) || 10,
      clipLength: {
        min: parseInt(minLength) || 15,
        max: parseInt(maxLength) || 60
      },
      contentType: contentType || 'general'
    };

    if (url) {
      input.url = url;
    } else if (req.file) {
      input.videoPath = req.file.path;
    }

    // Start analysis (this runs synchronously but returns suggestions)
    // For very long videos this could take a few minutes
    const result = await opusClipService.analyzeVideo(input);

    res.json(result);

  } catch (error) {
    console.error('[OpusClip] Analysis error:', error);

    // Friendly error messages
    let friendlyMessage = 'Something went wrong while analyzing your video. Please try again.';

    if (error.message.includes('Unsupported')) {
      friendlyMessage = 'This URL is not supported. Please try a YouTube, TikTok, Instagram, or other supported platform link.';
    } else if (error.message.includes('too long')) {
      friendlyMessage = error.message;
    } else if (error.message.includes('too large')) {
      friendlyMessage = error.message;
    } else if (error.message.includes('not found')) {
      friendlyMessage = 'The video could not be found at this URL. Please check the link and try again.';
    } else if (error.message.includes('AI could not')) {
      friendlyMessage = error.message;
    }

    res.status(500).json({
      success: false,
      error: friendlyMessage
    });
  }
});

// ============================================================
// POST /api/opus-clip/analyze-async
// Same as analyze, but returns jobId immediately and processes in background
// Better for long videos
// ============================================================
router.post('/analyze-async', upload.single('video'), async (req, res) => {
  try {
    const { url, clipCount, minLength, maxLength, contentType } = req.body;

    if (!url && !req.file) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a video URL or upload a video file.'
      });
    }

    // Generate job ID and return immediately
    const jobId = uuidv4();

    console.log('\n' + '🎬'.repeat(30));
    console.log(`[OpusClip] Async analysis started: ${jobId}`);
    console.log('🎬'.repeat(30));

    // Return job ID immediately
    res.json({
      success: true,
      jobId,
      message: 'Analysis started! Use the status endpoint to check progress.'
    });

    // Build input and run in background
    const input = {
      clipCount: parseInt(clipCount) || 10,
      clipLength: {
        min: parseInt(minLength) || 15,
        max: parseInt(maxLength) || 60
      },
      contentType: contentType || 'general'
    };

    if (url) {
      input.url = url;
    } else if (req.file) {
      input.videoPath = req.file.path;
    }

    // Run analysis in background (don't await)
    opusClipService.analyzeVideo(input)
      .then(result => {
        // Store result in the job
        opusClipService.updateJob(result.jobId, {
          analysisResult: result
        });
        console.log(`[OpusClip] Async analysis complete: ${result.jobId}`);
      })
      .catch(error => {
        console.error(`[OpusClip] Async analysis failed:`, error.message);
      });

  } catch (error) {
    console.error('[OpusClip] Async setup error:', error);
    res.status(500).json({
      success: false,
      error: 'Could not start analysis. Please try again.'
    });
  }
});

// ============================================================
// POST /api/opus-clip/generate/:jobId
// Generate selected clips with vertical reframe + captions
// Body: { selectedClips: [0, 1, 3], format: "vertical", captionStyle: "bold_white", addCaptions: true }
// ============================================================
router.post('/generate/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { selectedClips, format, captionStyle, addCaptions } = req.body;

    console.log(`\n[OpusClip] Generate request for job ${jobId}`);
    console.log(`  Selected clips: ${selectedClips ? selectedClips.join(', ') : 'ALL'}`);
    console.log(`  Format: ${format || 'vertical'}`);
    console.log(`  Captions: ${addCaptions !== false ? 'YES' : 'NO'}`);

    // Return jobId immediately, process in background
    res.json({
      success: true,
      jobId,
      message: 'Clip generation started! Use the status endpoint to track progress.'
    });

    // Generate in background
    opusClipService.generateClips(jobId, selectedClips, {
      format: format || 'vertical',
      captionStyle: captionStyle || 'bold_white',
      addCaptions: addCaptions !== false
    }).catch(error => {
      console.error(`[OpusClip] Generation failed:`, error.message);
      opusClipService.updateJob(jobId, {
        status: 'error',
        error: 'Clip generation failed. Please try again.'
      });
    });

  } catch (error) {
    console.error('[OpusClip] Generate error:', error);
    res.status(500).json({
      success: false,
      error: 'Could not start clip generation. Please try again.'
    });
  }
});

// ============================================================
// GET /api/opus-clip/status/:jobId
// Check progress of analysis or generation
// ============================================================
router.get('/status/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const status = opusClipService.getJobStatus(jobId);

    if (!status) {
      return res.status(404).json({
        success: false,
        error: 'Job not found. It may have expired.'
      });
    }

    res.json({
      success: true,
      jobId,
      ...status
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Could not check job status.'
    });
  }
});

// ============================================================
// GET /api/opus-clip/caption-styles
// Return available caption styles for the frontend
// ============================================================
router.get('/caption-styles', (req, res) => {
  res.json({
    success: true,
    styles: [
      {
        id: 'bold_white',
        name: 'Bold White',
        description: 'Clean white text with black outline - most popular style',
        preview: '⬜ Bold white on dark outline'
      },
      {
        id: 'yellow_outline',
        name: 'Yellow Pop',
        description: 'Bright yellow text that pops on any background',
        preview: '🟨 Yellow with black outline'
      },
      {
        id: 'neon_green',
        name: 'Neon Green',
        description: 'Eye-catching green for high-energy content',
        preview: '🟩 Neon green with dark outline'
      },
      {
        id: 'clean_minimal',
        name: 'Clean Minimal',
        description: 'Subtle, professional look with thinner text',
        preview: '⬜ Clean white, minimal outline'
      }
    ]
  });
});

// ============================================================
// GET /api/opus-clip/content-types
// Return content type options for the frontend
// ============================================================
router.get('/content-types', (req, res) => {
  res.json({
    success: true,
    types: [
      { id: 'general', name: 'General', description: 'Auto-detect the best moments' },
      { id: 'podcast', name: 'Podcast / Interview', description: 'Find compelling quotes and debates' },
      { id: 'educational', name: 'Educational / Tutorial', description: 'Find key lessons and tips' },
      { id: 'motivational', name: 'Motivational / Speech', description: 'Find inspiring moments' },
      { id: 'entertainment', name: 'Entertainment / Vlog', description: 'Find funny or dramatic moments' },
      { id: 'business', name: 'Business / Webinar', description: 'Find actionable insights' },
      { id: 'reaction', name: 'Reaction Content', description: 'Find the best reactions and takes' }
    ]
  });
});

module.exports = router;
