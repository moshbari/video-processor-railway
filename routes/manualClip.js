/**
 * ✂️ MANUAL CLIP ROUTES
 * 
 * API endpoints for manual video clipping with waveform
 * 
 * POST /api/manual-clip/prepare          - Download video + generate waveform + upload to R2
 * GET  /api/manual-clip/status/:jobId    - Check preparation or generation progress
 * POST /api/manual-clip/generate/:jobId  - Generate clips from user-defined timestamps
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');

const manualClipService = require('../services/manualClipService');

// Upload directory for manual clip videos
const uploadDir = path.join(process.env.TEMP_DIR || '/app/temp', 'manual-uploads');

// Ensure it exists at startup
fs.ensureDirSync(uploadDir);

// Use custom DiskStorage so the directory is verified before EVERY upload
// (Railway's ephemeral filesystem can lose directories between requests)
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    fs.ensureDirSync(uploadDir);  // Re-ensure before each upload
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    // Use a unique ID + original extension for the temp file
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
// POST /api/manual-clip/prepare
// Download video, upload to R2 for playback, generate waveform
// Accepts: video file upload OR URL in body
// ============================================================
router.post('/prepare', upload.single('video'), async (req, res) => {
  try {
    const { url } = req.body;

    if (!url && !req.file) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a video URL or upload a video file.'
      });
    }

    console.log('\n' + '✂️'.repeat(30));
    console.log('[ManualClip] New prepare request');
    if (url) console.log(`  URL: ${url}`);
    if (req.file) console.log(`  File: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)}MB)`);
    console.log('✂️'.repeat(30));

    // Build input
    const input = {};
    if (url) {
      input.url = url;
    } else if (req.file) {
      input.videoPath = req.file.path;
      input.originalFilename = req.file.originalname;
    }

    // Start preparation (synchronous — returns when ready)
    const result = await manualClipService.prepareVideo(input);

    res.json(result);

  } catch (error) {
    console.error('[ManualClip] Prepare error:', error);

    let friendlyMessage = 'Something went wrong while preparing your video. Please try again.';

    if (error.message.includes('Unsupported')) {
      friendlyMessage = 'This URL is not supported. Please try a YouTube, TikTok, Instagram, Tella, or other supported platform link.';
    } else if (error.message.includes('too long')) {
      friendlyMessage = error.message;
    } else if (error.message.includes('too large')) {
      friendlyMessage = error.message;
    } else if (error.message.includes('not found')) {
      friendlyMessage = 'The video could not be found at this URL. Please check the link and try again.';
    }

    res.status(500).json({
      success: false,
      error: friendlyMessage
    });
  }
});

// ============================================================
// POST /api/manual-clip/prepare-async
// Same as prepare but returns jobId immediately, processes in background
// Better for long videos
// ============================================================
router.post('/prepare-async', upload.single('video'), async (req, res) => {
  try {
    const { url } = req.body;

    if (!url && !req.file) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a video URL or upload a video file.'
      });
    }

    console.log('\n' + '✂️'.repeat(30));
    console.log('[ManualClip] Async prepare request');
    console.log('✂️'.repeat(30));

    // Return immediately
    res.json({
      success: true,
      message: 'Video preparation started! Use the status endpoint to check progress.'
    });

    // Build input and run in background
    const input = {};
    if (url) {
      input.url = url;
    } else if (req.file) {
      input.videoPath = req.file.path;
      input.originalFilename = req.file.originalname;
    }

    // Run in background (don't await)
    manualClipService.prepareVideo(input)
      .then(result => {
        console.log(`[ManualClip] Async prepare complete: ${result.jobId}`);
      })
      .catch(error => {
        console.error(`[ManualClip] Async prepare failed:`, error.message);
      });

  } catch (error) {
    console.error('[ManualClip] Async prepare error:', error);
    res.status(500).json({
      success: false,
      error: 'Could not start video preparation. Please try again.'
    });
  }
});

// ============================================================
// POST /api/manual-clip/generate/:jobId
// Generate clips from user-defined timestamps
// Body: { clips: [{ title, startTime, endTime }], format, captionStyle, addCaptions }
// ============================================================
router.post('/generate/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { clips, format, captionStyle, addCaptions } = req.body;

    // Validate clips array
    if (!clips || !Array.isArray(clips) || clips.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Please provide at least one clip with start and end timestamps.'
      });
    }

    // Validate each clip has required fields
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      if (clip.startTime === undefined || clip.endTime === undefined) {
        return res.status(400).json({
          success: false,
          error: `Clip ${i + 1} is missing start or end time.`
        });
      }
      if (parseFloat(clip.endTime) <= parseFloat(clip.startTime)) {
        return res.status(400).json({
          success: false,
          error: `Clip ${i + 1} ("${clip.title || 'Untitled'}"): End time must be after start time.`
        });
      }
    }

    // Check job exists
    const jobStatus = manualClipService.getJobStatus(jobId);
    if (!jobStatus) {
      return res.status(404).json({
        success: false,
        error: 'Video session not found. Please prepare the video again.'
      });
    }

    if (jobStatus.status !== 'ready' && jobStatus.status !== 'complete') {
      return res.status(400).json({
        success: false,
        error: 'Video is not ready yet. Please wait for preparation to complete.'
      });
    }

    console.log(`\n[ManualClip] Generate request for job ${jobId}`);
    console.log(`  Clips: ${clips.length}`);
    console.log(`  Format: ${format || 'vertical'}`);
    console.log(`  Captions: ${addCaptions !== false ? 'YES' : 'NO'}`);
    console.log(`  Quality: CRF 18 + 192k (MAXIMUM)`);

    // Return jobId immediately, process in background
    res.json({
      success: true,
      jobId,
      message: `Generating ${clips.length} clips! Use the status endpoint to track progress.`
    });

    // Generate in background
    manualClipService.generateManualClips(jobId, clips, {
      format: format || 'vertical',
      captionStyle: captionStyle || 'bold_white',
      addCaptions: addCaptions !== false
    }).catch(error => {
      console.error(`[ManualClip] Generation failed:`, error.message);
      manualClipService.updateJob(jobId, {
        status: 'error',
        error: 'Clip generation failed. Please try again.'
      });
    });

  } catch (error) {
    console.error('[ManualClip] Generate error:', error);
    res.status(500).json({
      success: false,
      error: 'Could not start clip generation. Please try again.'
    });
  }
});

// ============================================================
// POST /api/manual-clip/render-sequence/:jobId
// 🎙️ Podcast multi-hook: stitch selected hooks (in order) + the FULL
// source video into ONE 16:9 file, no transitions.
// Body: { hooks: [{ startTime, endTime, order }], title }
// ============================================================
router.post('/render-sequence/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { hooks, title } = req.body;

    if (!hooks || !Array.isArray(hooks) || hooks.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Please select at least one hook section first.'
      });
    }

    for (let i = 0; i < hooks.length; i++) {
      const h = hooks[i];
      if (h.startTime === undefined || h.endTime === undefined) {
        return res.status(400).json({
          success: false,
          error: `Hook ${i + 1} is missing start or end time.`
        });
      }
      if (parseFloat(h.endTime) <= parseFloat(h.startTime)) {
        return res.status(400).json({
          success: false,
          error: `Hook ${i + 1}: end time must be after start time.`
        });
      }
    }

    const jobStatus = manualClipService.getJobStatus(jobId);
    if (!jobStatus) {
      return res.status(404).json({
        success: false,
        error: 'Video session not found. Please prepare the video again.'
      });
    }
    if (jobStatus.status !== 'ready' && jobStatus.status !== 'complete') {
      return res.status(400).json({
        success: false,
        error: 'Video is not ready yet. Please wait for preparation to complete.'
      });
    }

    console.log(`\n[ManualClip] Podcast sequence request for job ${jobId}`);
    console.log(`  Hooks: ${hooks.length} + full video at end -> single 16:9 file`);

    // Return immediately, render in background (frontend polls /status/:jobId).
    res.json({
      success: true,
      jobId,
      message: `Building your podcast video! Use the status endpoint to track progress.`
    });

    manualClipService.renderPodcastSequence(jobId, hooks, { title })
      .catch(error => {
        console.error(`[ManualClip] Podcast sequence failed:`, error.message);
        manualClipService.updateJob(jobId, {
          status: 'error',
          error: 'Building the podcast video failed. Please try again.'
        });
      });

  } catch (error) {
    console.error('[ManualClip] Render sequence error:', error);
    res.status(500).json({
      success: false,
      error: 'Could not start building the podcast video. Please try again.'
    });
  }
});

// ============================================================
// GET /api/manual-clip/status/:jobId
// Check progress of preparation or generation
// ============================================================
router.get('/status/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const status = manualClipService.getJobStatus(jobId);

    if (!status) {
      return res.status(404).json({
        success: false,
        error: 'Job not found. It may have expired.'
      });
    }

    // Build response based on current state
    const response = {
      success: true,
      jobId,
      status: status.status,
      step: status.step,
      progress: status.progress || 0
    };

    // Include video info if available
    if (status.videoTitle) response.videoTitle = status.videoTitle;
    if (status.videoDuration) response.videoDuration = status.videoDuration;
    if (status.playbackUrl) response.playbackUrl = status.playbackUrl;

    // Include waveform if ready
    if (status.waveform) response.waveform = status.waveform;

    // Include generation progress
    if (status.totalClips !== undefined) response.totalClips = status.totalClips;
    if (status.completedClips !== undefined) response.completedClips = status.completedClips;
    if (status.currentClip) response.currentClip = status.currentClip;

    // Include generated clips when complete
    if (status.generatedClips) response.generatedClips = status.generatedClips;

    // Include error
    if (status.error) response.error = status.error;

    res.json(response);

  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Could not check job status.'
    });
  }
});

// ============================================================
// GET /api/manual-clip/jobs
// List recent completed Manual Clip Maker jobs
// Used by Multi-Clip Editor to import reaction clips
// ============================================================
router.get('/jobs', async (req, res) => {
  try {
    const allJobs = manualClipService.getAllCompletedJobs();

    console.log(`[ManualClip] Jobs endpoint: returning ${allJobs.length} completed jobs`);

    res.json({
      success: true,
      jobs: allJobs
    });

  } catch (error) {
    console.error('[ManualClip] Jobs list error:', error);
    res.status(500).json({
      success: false,
      error: 'Could not retrieve clip maker jobs.'
    });
  }
});

// ============================================================
// POST /api/manual-clip/combo
// Combine selected clips into one sequential video
// Body: { clipUrls: [...], videoTitle: "..." }
// ============================================================
router.post('/combo', async (req, res) => {
  try {
    const { clipUrls, videoTitle } = req.body;

    // Validate input
    if (!clipUrls || !Array.isArray(clipUrls) || clipUrls.length < 2) {
      return res.status(400).json({
        success: false,
        error: 'Please select at least 2 clips to combine.'
      });
    }

    if (clipUrls.length > 20) {
      return res.status(400).json({
        success: false,
        error: 'You can combine up to 20 clips at a time.'
      });
    }

    console.log(`[ManualClip] Combo request: ${clipUrls.length} clips, title: "${videoTitle || 'untitled'}"`);

    const result = await manualClipService.combineClips(clipUrls, videoTitle || 'untitled');

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('[ManualClip] Combo error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Something went wrong while combining your clips. Please try again.'
    });
  }
});

module.exports = router;
