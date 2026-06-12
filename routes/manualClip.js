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
const manualVideoLibraryService = require('../services/manualVideoLibraryService');

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
    input.userId = req.headers['x-user-id'] || null;
    if (url) {
      input.url = url;
    } else if (req.file) {
      input.videoPath = req.file.path;
      input.originalFilename = req.file.originalname;
    }

    // Start preparation (synchronous — returns when ready). Note: YouTube-
    // timestamp matching is NOT done here anymore — for uploaded files the
    // frontend triggers the background normalize after import (so the request
    // never times out on a long re-encode), and URL imports already use
    // YouTube's own copy so they need no matching.
    const result = await manualClipService.prepareVideo(input);

    res.json(result);

  } catch (error) {
    console.error('[ManualClip] Prepare error:', error);

    let friendlyMessage = 'Something went wrong while preparing your video. Please try again.';

    if (error.message.includes('Tella')) {
      // Tella's own messages are already user-friendly — surface them directly,
      // minus the internal "Tella download failed:" wrapper.
      friendlyMessage = error.message.replace(/^Tella download failed:\s*/i, '');
    } else if (error.message.includes('Unsupported')) {
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
      addCaptions: addCaptions !== false,
      userId: req.headers['x-user-id'] || null
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
// source video into ONE 16:9 file, no transitions. Any Danger Zone "cuts"
// are removed from the full video at the end before stitching.
// Body: { hooks: [{ startTime, endTime, order }], cuts: [{ startTime, endTime }], title }
// ============================================================
router.post('/render-sequence/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { hooks, cuts, disguise, title, levelAudio, removeSilences } = req.body;

    const hookList = Array.isArray(hooks) ? hooks : [];
    const cutList = Array.isArray(cuts) ? cuts : [];
    const disguiseList = Array.isArray(disguise) ? disguise : [];

    if (hookList.length === 0 && cutList.length === 0 && disguiseList.length === 0 && !removeSilences) {
      return res.status(400).json({
        success: false,
        error: 'Add at least one hook, a section to remove, or a voice to disguise, first.'
      });
    }

    for (let i = 0; i < hookList.length; i++) {
      const h = hookList[i];
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

    for (let i = 0; i < cutList.length; i++) {
      const c = cutList[i];
      if (c.startTime === undefined || c.endTime === undefined) {
        return res.status(400).json({
          success: false,
          error: `Section ${i + 1} to remove is missing a start or end time.`
        });
      }
      if (parseFloat(c.endTime) <= parseFloat(c.startTime)) {
        return res.status(400).json({
          success: false,
          error: `Section ${i + 1} to remove: end time must be after start time.`
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
    console.log(`  Hooks: ${hookList.length} + full video at end (${cutList.length} section(s) removed) -> single 16:9 file`);

    // Return immediately, render in background (frontend polls /status/:jobId).
    res.json({
      success: true,
      jobId,
      message: `Building your video! Use the status endpoint to track progress.`
    });

    manualClipService.renderPodcastSequence(jobId, hookList, { title, cuts: cutList, disguise: disguiseList, levelAudio: !!levelAudio, removeSilences: !!removeSilences, userId: req.headers['x-user-id'] || null })
      .catch(error => {
        // Free the heavy intermediates a failed render left behind (don't fill the disk).
        manualClipService.cleanupRenderTemp(jobId).catch(() => {});
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
// POST /api/manual-clip/remove-silence/:jobId
// 🔇 One-click silence remover: cut every quiet gap out of the WHOLE prepared
// video and stitch the loud parts back into one continuous file.
// Body (all optional): { thresholdDb, minSilenceSec, paddingSec, title }
// ============================================================
router.post('/remove-silence/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { thresholdDb, minSilenceSec, paddingSec, title } = req.body || {};

    const jobStatus = manualClipService.getJobStatus(jobId);
    // Allow when the in-memory job is gone (restored later from the library
    // inside removeSilence -> ensureSourceAvailable), but if it IS present it
    // must be ready/complete, not mid-process.
    if (jobStatus && jobStatus.status !== 'ready' && jobStatus.status !== 'complete') {
      return res.status(400).json({
        success: false,
        error: 'Video is not ready yet. Please wait for preparation to complete.'
      });
    }

    console.log(`\n[ManualClip] Remove-silence request for job ${jobId}`);

    // Return immediately, process in background (frontend polls /status/:jobId).
    res.json({
      success: true,
      jobId,
      message: 'Removing silences! Use the status endpoint to track progress.'
    });

    manualClipService.removeSilence(jobId, {
      userId: req.headers['x-user-id'] || null,
      thresholdDb: thresholdDb !== undefined ? parseFloat(thresholdDb) : undefined,
      minSilenceSec: minSilenceSec !== undefined ? parseFloat(minSilenceSec) : undefined,
      paddingSec: paddingSec !== undefined ? parseFloat(paddingSec) : undefined,
      title
    }).catch(error => {
      console.error(`[ManualClip] Silence removal failed:`, error.message);
      manualClipService.updateJob(jobId, {
        status: 'error',
        error: 'Removing the silences failed. Please try again.'
      });
    });

  } catch (error) {
    console.error('[ManualClip] Remove-silence error:', error);
    res.status(500).json({
      success: false,
      error: 'Could not start removing silences. Please try again.'
    });
  }
});

// ============================================================
// POST /api/manual-clip/voice-preview/:jobId
// 🎭 Render a short audio preview of one segment with a disguise preset applied,
// so the user can hear it and choose a voice before rendering.
// Body: { startTime, endTime, preset }
// ============================================================
router.post('/voice-preview/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { startTime, endTime, preset, level } = req.body || {};
    const result = await manualClipService.voicePreview(jobId, {
      startTime, endTime, preset, level: !!level,
      userId: req.headers['x-user-id'] || null,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[ManualClip] Voice preview error:', error.message);
    res.status(500).json({ success: false, error: 'Could not build that voice preview. Please try again.' });
  }
});

// ============================================================
// POST /api/manual-clip/detect-speakers/:jobId
// 🗣️ Auto-detect "who spoke when" (AssemblyAI). Runs in the background; the
// frontend polls /status (done when step === 'speakers_ready', speakers on the
// status payload).
// ============================================================
router.post('/detect-speakers/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.headers['x-user-id'] || null;

    manualClipService.updateJob(jobId, {
      status: 'generating', step: 'detecting_speakers', progress: 1,
      currentClip: 'Starting…', speakers: null, error: null,
    });

    res.json({ success: true, jobId, message: 'Detecting speakers! Track progress via the status endpoint.' });

    manualClipService.detectSpeakers(jobId, { userId }).catch(error => {
      console.error('[ManualClip] Speaker detection failed:', error.message);
      manualClipService.updateJob(jobId, {
        status: 'error',
        error: error.message && /assemblyai/i.test(error.message)
          ? "Speaker detection isn't set up yet. Please add the AssemblyAI key."
          : 'Could not detect speakers for this video. Please try again.',
      });
    });
  } catch (error) {
    console.error('[ManualClip] Detect-speakers route error:', error);
    res.status(500).json({ success: false, error: 'Could not start speaker detection. Please try again.' });
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

    // Direct-from-server download for the finished render, available before the
    // R2 cloud copy is ready (see GET /download/:jobId below).
    if (status.serverDownloadUrl) response.serverDownloadUrl = status.serverDownloadUrl;

    // Include waveform if ready
    if (status.waveform) response.waveform = status.waveform;

    // Include generation progress
    if (status.totalClips !== undefined) response.totalClips = status.totalClips;
    if (status.completedClips !== undefined) response.completedClips = status.completedClips;
    if (status.currentClip) response.currentClip = status.currentClip;

    // Include generated clips when complete
    if (status.generatedClips) response.generatedClips = status.generatedClips;

    // Include detected speakers when ready
    if (status.speakers) response.speakers = status.speakers;

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
// GET /api/manual-clip/library
// List the user's saved videos (reopen without re-uploading)
// ============================================================
router.get('/library', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] || null;
    const videos = await manualVideoLibraryService.list(userId);
    // Keep the list light — don't ship the full waveform arrays here.
    const slim = videos.map(v => ({
      jobId: v.jobId,
      title: v.title,
      duration: v.duration,
      durationFormatted: v.durationFormatted,
      fileSize: v.fileSize,
      createdAt: v.createdAt,
      normalized: !!v.normalized,
    }));
    res.json({ success: true, videos: slim });
  } catch (error) {
    console.error('[ManualClip] Library list error:', error);
    res.status(500).json({ success: false, error: 'Could not load your videos.' });
  }
});

// ============================================================
// POST /api/manual-clip/restore/:jobId
// Reopen a saved video in the editor without re-uploading. Lightweight —
// returns playback URL + waveform; the source MP4 is re-fetched from R2
// lazily only when the user actually renders.
// ============================================================
router.post('/restore/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.headers['x-user-id'] || null;
    const record = (await manualVideoLibraryService.get(userId, jobId))
      || (await manualVideoLibraryService.get(null, jobId));
    if (!record) {
      return res.status(404).json({ success: false, error: 'That video is no longer available.' });
    }

    // Seed a lightweight in-memory job so status/generate/render recognise it.
    manualClipService.updateJob(jobId, {
      status: 'ready',
      step: 'ready',
      progress: 100,
      videoTitle: record.title,
      videoDuration: record.duration,
      userId,
      sourceKey: record.sourceKey,
      playbackUrl: record.playbackUrl,
      waveform: { peaks: record.waveformPeaks || [] },
    });

    res.json({
      success: true,
      jobId,
      videoTitle: record.title,
      videoDuration: record.duration,
      videoDurationFormatted: record.durationFormatted,
      playbackUrl: record.playbackUrl,
      waveform: { peaks: record.waveformPeaks || [] },
      hooks: record.hooks || [],
      cuts: record.cuts || [],
      disguise: record.disguise || [],
    });
  } catch (error) {
    console.error('[ManualClip] Restore error:', error);
    res.status(500).json({ success: false, error: 'Could not reopen that video.' });
  }
});

// ============================================================
// PUT /api/manual-clip/library/:jobId/hooks
// Auto-save the user's marked hooks for a saved video
// Body: { hooks: [{ title, startTime, endTime, order }] }
// ============================================================
router.put('/library/:jobId/hooks', async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.headers['x-user-id'] || null;
    const { hooks } = req.body;
    await manualVideoLibraryService.updateHooks(userId, jobId, hooks || []);
    res.json({ success: true });
  } catch (error) {
    console.error('[ManualClip] Save hooks error:', error);
    res.status(500).json({ success: false, error: 'Could not save your hooks.' });
  }
});

// ============================================================
// PUT /api/manual-clip/library/:jobId/cuts
// Auto-save the user's Danger Zone removal sections for a saved video
// Body: { cuts: [{ title, startTime, endTime }] }
// ============================================================
router.put('/library/:jobId/cuts', async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.headers['x-user-id'] || null;
    const { cuts } = req.body;
    await manualVideoLibraryService.updateCuts(userId, jobId, cuts || []);
    res.json({ success: true });
  } catch (error) {
    console.error('[ManualClip] Save cuts error:', error);
    res.status(500).json({ success: false, error: 'Could not save your removal sections.' });
  }
});

// ============================================================
// PUT /api/manual-clip/library/:jobId/disguise
// Auto-save the user's voice-disguise segments for a saved video
// Body: { disguise: [{ title, startTime, endTime, preset }] }
// ============================================================
router.put('/library/:jobId/disguise', async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.headers['x-user-id'] || null;
    const { disguise } = req.body;
    await manualVideoLibraryService.updateDisguise(userId, jobId, disguise || []);
    res.json({ success: true });
  } catch (error) {
    console.error('[ManualClip] Save disguise error:', error);
    res.status(500).json({ success: false, error: 'Could not save your voice-disguise settings.' });
  }
});

// ============================================================
// POST /api/manual-clip/library/:jobId/normalize
// ⏱️ Match YouTube timestamps for an ALREADY-saved video, in place (no
// re-upload). Re-encodes the stored source to constant frame rate and points
// the library record at the matched copy. Runs in the background; the frontend
// polls GET /status/:jobId (done when step === 'normalized', error on failure).
// ============================================================
router.post('/library/:jobId/normalize', async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.headers['x-user-id'] || null;

    // Seed an initial status so polling doesn't 404 in the gap before work starts.
    manualClipService.updateJob(jobId, {
      status: 'generating', step: 'normalizing_saved', progress: 1,
      currentClip: 'Starting…', generatedClips: [], error: null,
    });

    // Return immediately; convert in the background.
    res.json({
      success: true,
      jobId,
      message: 'Matching YouTube timestamps! Track progress via the status endpoint.'
    });

    manualClipService.normalizeSavedVideo(jobId, { userId }).catch(error => {
      console.error('[ManualClip] Normalize saved video failed:', error.message);
      manualClipService.updateJob(jobId, {
        status: 'error',
        error: 'Could not match YouTube timestamps for this video. Please try again.'
      });
    });

  } catch (error) {
    console.error('[ManualClip] Normalize route error:', error);
    res.status(500).json({ success: false, error: 'Could not start matching. Please try again.' });
  }
});

// ============================================================
// DELETE /api/manual-clip/library/:jobId
// Remove a saved video from the library (also deletes the R2 source)
// ============================================================
router.delete('/library/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.headers['x-user-id'] || null;
    await manualVideoLibraryService.remove(userId, jobId, { deleteSource: true });
    res.json({ success: true });
  } catch (error) {
    console.error('[ManualClip] Library delete error:', error);
    res.status(500).json({ success: false, error: 'Could not remove that video.' });
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

// ============================================================
// GET /api/manual-clip/renders
// List the user's finished renders (each its own downloadable project)
// ============================================================
router.get('/renders', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] || null;
    const renders = await manualVideoLibraryService.listRenders(userId);
    res.json({ success: true, renders });
  } catch (error) {
    console.error('[ManualClip] Renders list error:', error);
    res.status(500).json({ success: false, error: 'Could not load your rendered videos.' });
  }
});

// ============================================================
// DELETE /api/manual-clip/renders/:renderId
// Remove a finished render from the library (also deletes the R2 file)
// ============================================================
router.delete('/renders/:renderId', async (req, res) => {
  try {
    const { renderId } = req.params;
    const userId = req.headers['x-user-id'] || null;
    await manualVideoLibraryService.removeRender(userId, renderId, { deleteFile: true });
    res.json({ success: true });
  } catch (error) {
    console.error('[ManualClip] Render delete error:', error);
    res.status(500).json({ success: false, error: 'Could not remove that rendered video.' });
  }
});

// ============================================================
// GET /api/manual-clip/download/:jobId
// 🎙️ Stream the finished podcast render straight from this server.
// Available the moment rendering finishes — before/while the R2 cloud copy
// uploads — so the user never waits on the cloud. Once the local copy has been
// cleaned up, transparently redirects to the durable R2 URL.
// ============================================================
router.get('/download/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const job = manualClipService.getJobStatus(jobId);
    const local = job && job.serverDownload;

    // Serve the local copy while it exists.
    if (local && local.path && await fs.pathExists(local.path)) {
      const stat = await fs.stat(local.path);
      const safeName = (local.filename || 'podcast.mp4').replace(/"/g, '');
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      const stream = fs.createReadStream(local.path);
      stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
      return stream.pipe(res);
    }

    // Local copy is gone — hand off to the durable R2 URL if we have one
    // (guard against redirecting to this same endpoint, which would loop).
    const clip = job && job.generatedClips && job.generatedClips[0];
    const r2 = clip && clip.downloadUrl;
    if (r2 && /^https?:\/\//.test(r2) && !r2.includes('/api/manual-clip/download/')) {
      return res.redirect(302, r2);
    }

    return res.status(404).json({
      success: false,
      error: 'This download is no longer available here. Please check your video library or re-render.'
    });
  } catch (error) {
    console.error('[ManualClip] Download error:', error);
    res.status(500).json({ success: false, error: 'Could not download the video.' });
  }
});

module.exports = router;
