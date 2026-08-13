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
const ctaLibraryService = require('../services/ctaLibraryService');
const voiceService = require('../services/voiceService');
const podcastBrain = require('../services/podcastBrain');
const podcastBrainJobs = require('../services/podcastBrain/jobs');
const podcastBrainPush = require('../services/podcastBrain/push');
const podcastSelfTranscribe = require('../services/podcastBrain/selfTranscribe');
const { buildTranscriptForModel, parseTranscript } = require('../services/podcastBrain/speakers');

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
    const { hooks, cuts, disguise, title, levelAudio, removeSilences, inserts, lowerThirds, introUrl, backgroundSections } = req.body;
    // 🎬 Intro clip that plays at the very start (before the hooks).
    const introClipUrl = (introUrl && String(introUrl).trim()) ? String(introUrl).trim() : null;

    const hookList = Array.isArray(hooks) ? hooks : [];
    const cutList = Array.isArray(cuts) ? cuts : [];
    const disguiseList = Array.isArray(disguise) ? disguise : [];
    // ➕ Outside clips (CTAs) lined up in the editor to splice into the final video.
    const insertList = (Array.isArray(inserts) ? inserts : [])
      .filter(p => p && Array.isArray(p.clipUrls) && p.clipUrls.filter(Boolean).length > 0);
    // 📺 Animated lower-third text CTAs to burn onto the full video.
    const lowerThirdList = (Array.isArray(lowerThirds) ? lowerThirds : [])
      .filter(lt => lt && (String(lt.line1 || '').trim() || String(lt.line2 || '').trim()))
      .map(lt => ({
        style: String(lt.style || 'bar'),
        line1: String(lt.line1 || '').slice(0, 120),
        line2: String(lt.line2 || '').slice(0, 120),
        startSec: Math.max(0, Number(lt.startSec ?? lt.startTime) || 0),
        endSec: Number(lt.endSec ?? lt.endTime),
        stay: !!lt.stay,
      }));
    // 🖼️ Per-section background images: during [startSec,endSec] on the FINAL
    // video, show the uploaded image full-frame and shrink the video into a
    // draggable overlay (position/size in canvas fractions).
    const clamp01 = (n, d) => {
      const x = Number(n);
      return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : d;
    };
    const backgroundList = (Array.isArray(backgroundSections) ? backgroundSections : [])
      .filter(b => b && b.imageUrl && Number(b.endSec ?? b.endTime) > Number(b.startSec ?? b.startTime))
      .map(b => ({
        startSec: Math.max(0, Number(b.startSec ?? b.startTime) || 0),
        endSec: Number(b.endSec ?? b.endTime) || 0,
        imageUrl: String(b.imageUrl),
        fitMode: b.fitMode === 'original' ? 'original' : 'fit',
        pip: {
          xPct: clamp01(b.pip?.xPct, 0.62),
          yPct: clamp01(b.pip?.yPct, 0.6),
          wPct: clamp01(b.pip?.wPct, 0.34),
        },
      }));

    if (hookList.length === 0 && cutList.length === 0 && disguiseList.length === 0 && !removeSilences && insertList.length === 0 && lowerThirdList.length === 0 && !introClipUrl && backgroundList.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Add at least one hook, an intro, a section to remove, a voice to disguise, a clip to insert, or a CTA overlay, first.'
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

    manualClipService.renderPodcastSequence(jobId, hookList, { title, cuts: cutList, disguise: disguiseList, levelAudio: !!levelAudio, removeSilences: !!removeSilences, inserts: insertList, lowerThirds: lowerThirdList, introUrl: introClipUrl, backgroundSections: backgroundList, userId: req.headers['x-user-id'] || null })
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
// POST /api/manual-clip/revoice-audio/:jobId
// 🎙️ Upload ONE recorded voice clip for a section. Parks it on R2 and returns
// its public URL + measured duration (the editor compares the duration to the
// selected section to drive the short/long handling). Accepts: audio upload.
// ============================================================
router.post('/revoice-audio/:jobId', upload.single('audio'), async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Please attach a recorded audio clip.' });
    }
    const result = await manualClipService.saveReVoiceAudio(jobId, req.file.path, req.file.originalname);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[ManualClip] ReVoice audio upload error:', error.message);
    res.status(500).json({ success: false, error: 'Could not save that recording. Please try again.' });
  }
});

// ============================================================
// GET /api/manual-clip/tts-voices
// ✨ List the AI text-to-voice providers that are usable right now (key set)
// and the voices each offers. Drives the ReVoice "AI Voice" picker.
// ============================================================
router.get('/tts-voices', async (req, res) => {
  try {
    const catalog = await voiceService.getTtsCatalog();
    res.json({ success: true, ...catalog });
  } catch (error) {
    console.error('[ManualClip] TTS voices error:', error.message);
    res.status(500).json({ success: false, error: 'Could not load the AI voices. Please try again.' });
  }
});

// ============================================================
// POST /api/manual-clip/revoice-tts/:jobId
// ✨ Turn typed text into an AI voiceover for a section. Generates the audio,
// parks it on R2 (same store as a recording) and returns its URL + measured
// duration — so the editor treats it exactly like a recorded clip.
// Body: { text, provider, voice }
// ============================================================
router.post('/revoice-tts/:jobId', async (req, res) => {
  let tmpPath = null;
  try {
    const { jobId } = req.params;
    const { text, provider, voice } = req.body || {};
    if (!text || !text.trim()) {
      return res.status(400).json({ success: false, error: 'Please type some text to turn into a voice.' });
    }

    const { buffer, ext } = await voiceService.generateTTS({ provider, text, voice });

    // Park the generated audio on disk so saveReVoiceAudio can upload + probe it
    // (same uploadDir + cleanup contract as the recorded-clip path).
    fs.ensureDirSync(uploadDir);
    tmpPath = path.join(uploadDir, require('crypto').randomBytes(16).toString('hex') + ext);
    await fs.writeFile(tmpPath, buffer);

    const result = await manualClipService.saveReVoiceAudio(jobId, tmpPath, `tts${ext}`);
    tmpPath = null; // saveReVoiceAudio removes the temp file on success
    res.json({ success: true, ...result });
  } catch (error) {
    if (tmpPath) await fs.remove(tmpPath).catch(() => {});
    console.error('[ManualClip] ReVoice TTS error:', error.message);
    // Surface the friendly message from generateTTS (bad voice, too long, key missing…)
    res.status(500).json({ success: false, error: error.message || 'Could not generate that voice. Please try again.' });
  }
});

// ============================================================
// POST /api/manual-clip/revoice-render/:jobId
// 🎙️ Render the final video with the recorded clips dropped into their marked
// sections. Returns immediately; the frontend polls /status/:jobId.
// Body: { segments: [{ startTime, endTime, audioUrl, align, mode, fitMode,
//         audioDuration }], title }
// ============================================================
router.post('/revoice-render/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { segments } = req.body || {};
    const list = Array.isArray(segments) ? segments : [];

    if (list.length === 0) {
      return res.status(400).json({ success: false, error: 'Add at least one section with a recorded voice first.' });
    }
    for (let i = 0; i < list.length; i++) {
      const s = list[i] || {};
      if (!s.audioUrl) {
        return res.status(400).json({ success: false, error: `Section ${i + 1} is missing its recorded audio.` });
      }
      if (s.startTime === undefined || s.endTime === undefined || parseFloat(s.endTime) <= parseFloat(s.startTime)) {
        return res.status(400).json({ success: false, error: `Section ${i + 1}: end time must be after start time.` });
      }
    }

    const jobStatus = manualClipService.getJobStatus(jobId);
    // Allow when the in-memory job is gone (restored inside reVoiceRender ->
    // ensureSourceAvailable), but if present it must be ready/complete.
    if (jobStatus && jobStatus.status !== 'ready' && jobStatus.status !== 'complete') {
      return res.status(400).json({ success: false, error: 'Video is not ready yet. Please wait for preparation to complete.' });
    }

    console.log(`\n[ManualClip] ReVoice render request for job ${jobId} — ${list.length} section(s)`);

    res.json({ success: true, jobId, message: 'Replacing your audio! Use the status endpoint to track progress.' });

    manualClipService.reVoiceRender(jobId, list, { userId: req.headers['x-user-id'] || null })
      .catch(error => {
        manualClipService.cleanupRenderTemp?.(jobId)?.catch?.(() => {});
        console.error('[ManualClip] ReVoice render failed:', error.message);
        manualClipService.updateJob(jobId, {
          status: 'error',
          error: error.message && /not found|no longer/i.test(error.message)
            ? 'That video session expired. Please re-open the video and try again.'
            : 'Replacing the audio failed. Please try again.',
        });
      });
  } catch (error) {
    console.error('[ManualClip] ReVoice render route error:', error);
    res.status(500).json({ success: false, error: 'Could not start replacing the audio. Please try again.' });
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
// POST /api/manual-clip/fetch-clip
// ➕ Fetch ONE clip to insert into a finished render, from ANY source —
// a URL (Tella / YouTube / TikTok / Instagram / Drive link, etc.) OR an
// uploaded file — and park it on R2. Returns a jobId immediately; the frontend
// polls /status/:jobId and reads generatedClips[0] (downloadUrl + duration)
// once status === 'complete'. Async because Tella exports can take minutes.
// Accepts: video file upload OR { url } in body.
// ============================================================
router.post('/fetch-clip', upload.single('video'), async (req, res) => {
  try {
    const { url } = req.body;

    if (!url && !req.file) {
      return res.status(400).json({
        success: false,
        error: 'Please provide a clip URL or upload a clip file.'
      });
    }

    const jobId = require('crypto').randomUUID();

    // Seed status BEFORE responding so the first poll can't 404.
    manualClipService.updateJob(jobId, {
      status: 'generating', step: 'queued', progress: 1,
      currentClip: 'Starting…', generatedClips: [], error: null,
    });

    console.log(`\n[ManualClip] Fetch-clip request (${url ? 'URL' : 'upload'}) -> job ${jobId}`);

    res.json({
      success: true,
      jobId,
      message: 'Fetching your clip! Use the status endpoint to track progress.'
    });

    const input = {};
    if (url) {
      input.url = url;
    } else {
      input.videoPath = req.file.path;
      input.originalFilename = req.file.originalname;
    }

    manualClipService.fetchInsertClip(jobId, input).catch(error => {
      console.error('[ManualClip] Fetch-clip failed:', error.message);
      let friendly = 'Could not fetch that clip. Please try again.';
      if (/Tella/i.test(error.message)) {
        friendly = error.message.replace(/^Tella download failed:\s*/i, '');
      } else if (/Unsupported/i.test(error.message)) {
        friendly = 'This link is not supported. Try a YouTube, TikTok, Instagram, Tella, or other supported link.';
      } else if (/too large|too long|not found/i.test(error.message)) {
        friendly = error.message;
      }
      manualClipService.updateJob(jobId, { status: 'error', error: friendly });
    });

  } catch (error) {
    console.error('[ManualClip] Fetch-clip route error:', error);
    res.status(500).json({ success: false, error: 'Could not start fetching the clip. Please try again.' });
  }
});

// ============================================================
// POST /api/manual-clip/insert/:renderId
// ➕ Add clips to a FINISHED render: splice already-fetched clips into the
// rendered video at chosen time points, then stitch into ONE new 16:9 file.
// Saved as a NEW render — the original is untouched. Returns a fresh jobId;
// the frontend polls /status/:jobId (and can download from /download/:jobId).
// Body: { points: [{ atTime: Number|null, clipUrls: [String] }], title }
//   atTime = seconds into the finished video (null/past-the-end = at the end).
// ============================================================
router.post('/insert/:renderId', async (req, res) => {
  try {
    const { renderId } = req.params;
    const { points, title } = req.body || {};

    const list = Array.isArray(points) ? points : [];
    const hasClips = list.some(p =>
      p && Array.isArray(p.clipUrls) && p.clipUrls.filter(Boolean).length > 0
    );
    if (!hasClips) {
      return res.status(400).json({
        success: false,
        error: 'Add at least one clip to insert first.'
      });
    }

    const jobId = require('crypto').randomUUID();

    // Seed status BEFORE responding so the first poll can't 404.
    manualClipService.updateJob(jobId, {
      status: 'generating', step: 'queued', progress: 1,
      totalClips: 1, completedClips: 0,
      currentClip: 'Starting…', generatedClips: [], error: null,
    });

    console.log(`\n[ManualClip] Insert-clips request for render ${renderId} -> job ${jobId} (${list.length} point(s))`);

    res.json({
      success: true,
      jobId,
      message: 'Adding your clips! Use the status endpoint to track progress.'
    });

    manualClipService.insertClipsIntoRender(jobId, renderId, list, {
      title,
      userId: req.headers['x-user-id'] || null,
    }).catch(error => {
      // Free the heavy intermediates a failed render left behind.
      manualClipService.cleanupRenderTemp(jobId).catch(() => {});
      console.error('[ManualClip] Insert clips failed:', error.message);
      manualClipService.updateJob(jobId, {
        status: 'error',
        error: (error.message && error.message.length < 140)
          ? error.message
          : 'Adding your clips failed. Please try again.'
      });
    });

  } catch (error) {
    console.error('[ManualClip] Insert route error:', error);
    res.status(500).json({ success: false, error: 'Could not start adding your clips. Please try again.' });
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
      // 🎙️ Ship the Podcast Brain's social post with the list so the library can
      // offer "Copy Social Post" without opening the project first.
      socialPost: typeof v.socialPost === 'string' ? v.socialPost : '',
      // 📺 And where the episode lives on YouTube, so anything showing this list
      // can fetch its captions without opening the project either.
      youtubeUrl: v.youtubeUrl || '',
    }));
    res.json({ success: true, videos: slim });
  } catch (error) {
    console.error('[ManualClip] Library list error:', error);
    res.status(500).json({ success: false, error: 'Could not load your videos.' });
  }
});

// ============================================================
// GET /api/manual-clip/library/podcast-status
// 🎙️ "Which of my episodes are still being analysed?" — the whole library in
// one answer, so the video list can show a live badge on every row without
// asking about each episode separately (fifty videos = fifty requests).
//
// Same stages as /podcast-summary/:jobId, and just as light: one read of the
// library index plus the in-memory run log. Never returns the post or report.
// ============================================================
router.get('/library/podcast-status', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] || req.query.userId || null;
    const videos = await manualVideoLibraryService.list(userId);

    const episodes = videos.map(v => {
      const run = podcastBrainJobs.read(v.jobId, 0);
      const hooks = (v.hooks || []).length;
      const cuts = (v.cuts || []).length;
      const hasSocialPost = !!v.socialPost;

      let stage = 'editable';                        // in the library, never analysed
      if (run?.status === 'running') stage = 'analysing';
      else if (hooks || cuts || hasSocialPost) stage = 'ready';
      else if (run?.status === 'error') stage = 'failed';

      return {
        jobId: v.jobId,
        stage,
        hooks,
        cuts,
        hasSocialPost,
        youtubeUrl: v.youtubeUrl || '',
        startedAt: run?.startedAt || null,
        finishedAt: run?.finishedAt || null,
        error: run?.status === 'error' ? run.error : null,
        // Newest progress line, so a row can say what the brain is working on.
        message: run?.events?.length ? run.events[run.events.length - 1].message : null,
      };
    });

    res.json({ success: true, episodes });
  } catch (error) {
    console.error('[PodcastBrain] Library status error:', error);
    res.status(500).json({ success: false, error: 'Could not check your episodes.' });
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
      inserts: record.inserts || [],
      lowerThirds: record.lowerThirds || [],
      introUrl: record.introUrl || null,
      introLabel: record.introLabel || '',
      revoice: record.revoice || [],
      backgroundSections: record.backgroundSections || [],
      removeSilences: !!record.removeSilences,
      levelAudio: !!record.levelAudio,
      // 🎙️ Podcast Brain output, when this episode has been analysed.
      socialPost: record.socialPost || '',
      brainReport: record.brainReport || '',
      // 📺 Where this episode lives on YouTube — the editor asks the extension
      // for THIS video's captions when the transcript is fetched again.
      youtubeUrl: record.youtubeUrl || '',
    });
  } catch (error) {
    console.error('[ManualClip] Restore error:', error);
    res.status(500).json({ success: false, error: 'Could not reopen that video.' });
  }
});

// ============================================================
// POST /api/manual-clip/podcast-auto/:jobId
// 🎙️ PODCAST BRAIN — hand it the episode's transcript and it fills the editor.
//
// Runs Mosh's podcast-editing instructions as five Claude passes, then writes
// the results straight onto the saved project: the hooks queue, the Danger Zone
// cuts, the Facebook post and a report of everything else it found.
//
// Async: returns immediately, progress via GET /podcast-auto/:jobId/status.
// A run can take twenty minutes, so nothing holds a request open.
//
// Body: {
//   transcript   (required) timestamped transcript, "0:08 - text" per line
//   youtubeUrl   (optional) where it came from, for the log
//   speakers     (optional) detect-speakers output; without it the passes are
//                told plainly that they cannot know who spoke, rather than
//                being left to guess
//   oauthToken   (optional) Claude subscription token; falls back to the server's
// }
// ============================================================
router.post('/podcast-auto/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.headers['x-user-id'] || null;
    const { transcript, youtubeUrl, speakers, oauthToken } = req.body || {};

    // 🛟 Re-push a previous run instead of paying for a new one.
    //
    // Checked FIRST, and deliberately before the transcript check — a re-push
    // reads the archived result from R2 and needs no transcript at all.
    //
    // Why it exists: the editor auto-saves its queues, so an empty editor left
    // open on a project that is being analysed can save its emptiness over the
    // results. Every run is archived to R2 the moment it finishes, so getting
    // the hooks back is a re-push, not a re-analysis — no Claude passes, no wait.
    if (req.body?.repush) {
      const saved = await podcastBrainPush.loadResult(jobId);
      if (!saved) {
        return res.status(404).json({ success: false, error: 'There is no earlier analysis saved for that episode.' });
      }
      const push = await podcastBrainPush.pushToLibrary({ userId, jobId, result: saved });
      return res.json({
        success: push.ok,
        jobId,
        repushed: push.ok,
        hooks: saved.hooks?.length || 0,
        cuts: saved.cuts?.length || 0,
        error: push.error,
      });
    }

    if (!transcript || !String(transcript).trim()) {
      return res.status(400).json({ success: false, error: 'No transcript was sent, so there is nothing to work from.' });
    }

    if (podcastBrainJobs.isRunning(jobId)) {
      return res.json({ success: true, jobId, alreadyRunning: true, message: 'That episode is already being worked on.' });
    }

    const token = oauthToken || process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!token && !apiKey && process.env.DOC_FACTORY_LOCAL_AUTH !== '1') {
      return res.status(400).json({
        success: false,
        error: 'No Claude is connected to this server yet, so the episode cannot be analysed.',
      });
    }

    podcastBrainJobs.start(jobId);
    res.json({ success: true, jobId, message: 'Working on the episode. Track progress via the status endpoint.' });

    const { text, hasSpeakers, cueCount } = buildTranscriptForModel(transcript, speakers);
    console.log(`[PodcastBrain] ${jobId}: ${cueCount} cues, speakers=${hasSpeakers}, from ${youtubeUrl || 'unknown source'}`);

    // Remember where the transcript came from. Whoever sent it knew the video;
    // storing it means the editor can fetch it again on its own next time.
    if (youtubeUrl) {
      manualVideoLibraryService.updateYoutubeUrl(userId, jobId, youtubeUrl).catch(() => {});
    }

    (async () => {
      try {
        const onProgress = (evt) => podcastBrainJobs.emit(jobId, evt);

        // Make sure there is somewhere to put the results BEFORE spending five
        // Claude passes. Normally instant — the video is prepared long before
        // YouTube finishes captioning. But a transcript aimed at a job id that
        // does not exist (a typo, a deleted project, a stale extension entry)
        // would otherwise produce a perfect analysis with nowhere to go.
        const record = await podcastBrainPush.waitForProject({ userId, jobId, onProgress });
        if (!record) {
          podcastBrainJobs.finish(jobId, {
            error: 'That episode is not in the editor, so there is nowhere to put the hooks and cuts. Nothing was analysed.',
          });
          return;
        }
        // Now we know what it's called — so the finish announcement can say the
        // episode's name rather than reading out a job id.
        podcastBrainJobs.describeJob(jobId, { userId, title: record.title });

        // ⛔ Does this transcript even belong to this video?
        //
        // A transcript that runs well past the end of the episode cannot be of
        // the episode — it is another recording. That happened for real: a
        // 42-minute transcript of the WRONG call was analysed against a
        // 31-minute video, and produced a flawless report full of quotes that
        // are nowhere in it. Wrong is far more expensive than late here, so this
        // stops rather than warns. (Short transcripts are NOT rejected: silence
        // and music legitimately produce no cues.)
        //
        // Uses the transcript parser rather than a regex of its own, so speaker
        // labels, H:MM:SS and every other shape it already handles keep working.
        const cues = parseTranscript(transcript).cues;
        const lastCue = cues.length ? Math.max(...cues.map(c => c.at)) : 0;
        const episodeLength = Number(record?.duration) || 0;
        if (episodeLength && lastCue > episodeLength + 120) {
          podcastBrainJobs.finish(jobId, {
            error: `This transcript is not for this episode. It runs to ${Math.round(lastCue / 60)} minutes, but "${record.title}" is only ${Math.round(episodeLength / 60)} minutes long — so it belongs to a different, longer recording. Nothing was analysed and nothing in your editor was changed. Check the YouTube link on this project.`,
          });
          return;
        }

        const result = await podcastBrain.runBrain({
          transcript: text,
          hasSpeakers,
          videoDuration: record?.duration || 0,
          videoTitle: record?.title || '',
          jobId,
          userId,
          oauthToken: token,
          apiKey,
          onProgress,
        });

        const push = await podcastBrainPush.deliver({ userId, jobId, result, onProgress });

        if (!push.ok) {
          // The analysis succeeded but the editor did not receive it. That must
          // be visible — a quiet failure here looks exactly like an empty episode.
          podcastBrainJobs.finish(jobId, {
            error: `The episode was analysed but could not be saved to the editor: ${push.error}`,
          });
          return;
        }

        podcastBrainJobs.finish(jobId, {
          result: {
            hooks: result.hooks.length,
            cuts: result.cuts.length,
            hasSocialPost: !!result.socialPost,
            failedPasses: result.failures.map(f => f.pass),
          },
        });
      } catch (error) {
        console.error('[PodcastBrain] Run failed:', error);
        podcastBrainJobs.finish(jobId, { error: error.message || 'The episode could not be analysed.' });
      }
    })();
  } catch (error) {
    console.error('[PodcastBrain] Route error:', error);
    res.status(500).json({ success: false, error: 'Could not start analysing that episode.' });
  }
});

// ============================================================
// POST /api/manual-clip/podcast-analyze-self/:jobId
// 🎧 THE SELF-SERVE PATH — analyse an episode with no browser involved.
//
// Identical to podcast-auto above, except nobody has to bring us a transcript:
// the video is already in our own R2 bucket, so we listen to it ourselves.
//
// This is the path that should normally run. The transcript-in-the-body route
// above is now the fallback, kept because it still works and costs nothing when
// YouTube has already done the captioning.
//
// Why: the old route could only be reached through Mosh's browser — the upload
// page had to hand the project id to a Chrome extension, which had to survive
// up to three hours of polling YouTube with Chrome awake, then post the
// transcript back. That chain broke three times in two days and never once said
// so. Here there is no chain: prepare finishes, we transcribe, the Brain runs.
//
// Body: { oauthToken?, force?, language? }  — nothing else is needed.
//
// `language` is an optional two-letter hint ('bn', 'en') for the transcriber.
// Left out, it works the language out on its own; given, it stops it guessing
// wrongly on a call that switches between Bangla and English mid-sentence.
// ============================================================
router.post('/podcast-analyze-self/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.headers['x-user-id'] || null;
    const { oauthToken, force, language } = req.body || {};

    if (podcastBrainJobs.isRunning(jobId)) {
      return res.json({ success: true, jobId, alreadyRunning: true, message: 'That episode is already being worked on.' });
    }

    // Don't pay to analyse the same episode twice. `force` overrides, for a
    // re-run after the transcript or the instructions have changed.
    if (!force) {
      const already = await podcastBrainPush.loadResult(jobId);
      if (already) {
        const push = await podcastBrainPush.pushToLibrary({ userId, jobId, result: already });
        return res.json({
          success: push.ok, jobId, repushed: push.ok,
          hooks: already.hooks?.length || 0,
          cuts: already.cuts?.length || 0,
          message: 'This episode was already analysed — the saved results were put back in the editor.',
          error: push.error,
        });
      }
    }

    const token = oauthToken || process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!token && !apiKey && process.env.DOC_FACTORY_LOCAL_AUTH !== '1') {
      return res.status(400).json({
        success: false,
        error: 'No Claude is connected to this server yet, so the episode cannot be analysed.',
      });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({
        success: false,
        error: 'This server cannot listen to episodes yet — transcription is not configured.',
      });
    }

    podcastBrainJobs.start(jobId);
    res.json({ success: true, jobId, message: 'Listening to the episode. Track progress via the status endpoint.' });

    (async () => {
      try {
        const onProgress = (evt) => podcastBrainJobs.emit(jobId, evt);

        const record = await podcastBrainPush.waitForProject({ userId, jobId, onProgress });
        if (!record) {
          podcastBrainJobs.finish(jobId, {
            error: 'That episode is not in the editor, so there is nowhere to put the hooks and cuts. Nothing was analysed.',
          });
          return;
        }
        // Now we know what it's called — so the finish announcement can say the
        // episode's name rather than reading out a job id.
        podcastBrainJobs.describeJob(jobId, { userId, title: record.title });

        // Listen first. If this fails, nothing has been spent on Claude.
        const heard = await podcastSelfTranscribe.transcribeEpisode({
          jobId, userId, onProgress,
          language: typeof language === 'string' && language.trim() ? language.trim() : null,
        });
        const { text, hasSpeakers, cueCount } = buildTranscriptForModel(heard.transcript, null);
        console.log(`[PodcastBrain] ${jobId}: ${cueCount} cues from our own copy (${heard.language || '?'})`);

        const result = await podcastBrain.runBrain({
          transcript: text,
          hasSpeakers,
          videoDuration: record?.duration || 0,
          videoTitle: record?.title || '',
          jobId,
          userId,
          oauthToken: token,
          apiKey,
          onProgress,
        });

        const push = await podcastBrainPush.deliver({ userId, jobId, result, onProgress });
        if (!push.ok) {
          podcastBrainJobs.finish(jobId, {
            error: `The episode was analysed but could not be saved to the editor: ${push.error}`,
          });
          return;
        }

        podcastBrainJobs.finish(jobId, {
          result: {
            hooks: result.hooks.length,
            cuts: result.cuts.length,
            hasSocialPost: !!result.socialPost,
            failedPasses: result.failures.map(f => f.pass),
          },
        });
      } catch (error) {
        console.error('[PodcastBrain] Self-analysis failed:', error);
        podcastBrainJobs.finish(jobId, { error: error.message || 'The episode could not be analysed.' });
      }
    })();
  } catch (error) {
    console.error('[PodcastBrain] Self route error:', error);
    res.status(500).json({ success: false, error: 'Could not start analysing that episode.' });
  }
});

// ============================================================
// POST /api/manual-clip/library/:jobId/claim
// 📥 Adopt a video that was prepared without a user id.
//
// Anything prepared anonymously lands in the shared "public" library. It keeps
// working — every save looks there too — but it never appears in "Your Videos",
// so a perfectly good upload looks lost. This moves it, with its hooks, cuts,
// post and report intact, instead of re-uploading the file.
// ============================================================
router.post('/library/:jobId/claim', async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.headers['x-user-id'] || req.body?.userId || null;
    if (!userId) {
      return res.status(400).json({ success: false, error: 'No user was given, so there is nobody to give the video to.' });
    }

    const outcome = await manualVideoLibraryService.claim(userId, jobId);
    if (outcome === 'not-found') {
      return res.status(404).json({ success: false, error: 'That video is not in the shared library.' });
    }
    res.json({ success: true, outcome, alreadyYours: outcome === 'already-yours' });
  } catch (error) {
    console.error('[ManualClip] Claim error:', error);
    res.status(500).json({ success: false, error: 'Could not move that video into your library.' });
  }
});

// ============================================================
// GET /api/manual-clip/podcast-summary/:jobId
// 🎙️ "Is this episode ready?" in one small answer.
//
// Deliberately light and public-ish — it's polled from the tellatotube page so
// Mosh can see, from where he pasted the link, whether an episode is still
// waiting on YouTube's captions, being analysed, or done. Returns counts only,
// never the post or the report.
// ============================================================
router.get('/podcast-summary/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.headers['x-user-id'] || req.query.userId || null;
    const record = await manualVideoLibraryService.getAnywhere(userId, jobId);

    if (!record) {
      return res.json({ success: true, exists: false, stage: 'missing' });
    }

    const run = podcastBrainJobs.read(jobId, 0);
    const hooks = (record.hooks || []).length;
    const cuts = (record.cuts || []).length;
    const hasSocialPost = !!record.socialPost;
    const youtubeUrl = record.youtubeUrl || '';

    // What stage is this episode at, in the order Mosh experiences it?
    let stage = 'editable';                       // video is in, nothing analysed yet
    if (run?.status === 'running') stage = 'analysing';
    else if (hooks || cuts || hasSocialPost) stage = 'ready';
    else if (run?.status === 'error') stage = 'failed';

    res.json({
      success: true,
      exists: true,
      stage,
      title: record.title || '',
      durationFormatted: record.durationFormatted || '',
      hooks,
      cuts,
      hasSocialPost,
      // 📺 So a control page can offer "fetch this episode's captions" without
      // anyone going to look the video up.
      youtubeUrl,
      error: run?.status === 'error' ? run.error : null,
      // The newest progress line, so the page can say what it's working on.
      message: run?.events?.length ? run.events[run.events.length - 1].message : null,
    });
  } catch (error) {
    console.error('[PodcastBrain] Summary error:', error);
    res.status(500).json({ success: false, error: 'Could not check that episode.' });
  }
});

// ============================================================
// GET /api/manual-clip/podcast-auto/:jobId/status?after=N
// Poll a Podcast Brain run. `after` is how many events you have already seen,
// so each call returns only what is new (same pattern as Pro-Rant renders).
// ============================================================
router.get('/podcast-auto/:jobId/status', async (req, res) => {
  try {
    const { jobId } = req.params;
    const state = podcastBrainJobs.read(jobId, req.query.after);

    if (!state) {
      // Not in memory. Either it never ran, or the server restarted — in which
      // case the finished work is still in R2, so say so rather than "unknown".
      const saved = await podcastBrainPush.loadResult(jobId);
      if (saved) {
        return res.json({
          success: true, status: 'complete', events: [], nextCursor: 0,
          result: { hooks: saved.hooks?.length || 0, cuts: saved.cuts?.length || 0, hasSocialPost: !!saved.socialPost },
          note: 'This finished earlier — reopen the project to see it.',
        });
      }
      return res.status(404).json({ success: false, error: 'No analysis has been run for that episode.' });
    }

    res.json({ success: true, ...state });
  } catch (error) {
    console.error('[PodcastBrain] Status error:', error);
    res.status(500).json({ success: false, error: 'Could not check on that episode.' });
  }
});

// ============================================================
// PUT /api/manual-clip/library/:jobId/socialpost
// Save the Facebook post for a saved video (Bengali, ~3,000 words).
// Body: { socialPost: string }
// ============================================================
router.put('/library/:jobId/socialpost', async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.headers['x-user-id'] || null;
    const stored = await manualVideoLibraryService.updateSocialPost(userId, jobId, req.body?.socialPost || '');
    if (!stored) return res.status(404).json({ success: false, error: 'That video is no longer available.' });
    res.json({ success: true });
  } catch (error) {
    console.error('[ManualClip] Save social post error:', error);
    res.status(500).json({ success: false, error: 'Could not save your post.' });
  }
});

// ============================================================
// PUT /api/manual-clip/library/:jobId/youtube
// 📺 Attach the YouTube video this episode became, so the editor can ask the
// Chrome extension for its captions later without anyone hunting for the link.
// Called by the uploader the moment the upload finishes.
// Body: { youtubeUrl: string }
// ============================================================
router.put('/library/:jobId/youtube', async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.headers['x-user-id'] || null;
    // An empty string means "forget the link" — the way a wrong one gets undone.
    // Only a MISSING field is an error, because that is a caller bug.
    if (typeof req.body?.youtubeUrl !== 'string') {
      return res.status(400).json({ success: false, error: 'No YouTube link was given.' });
    }
    const youtubeUrl = req.body.youtubeUrl.trim();
    const stored = await manualVideoLibraryService.updateYoutubeUrl(userId, jobId, youtubeUrl);
    if (!stored) return res.status(404).json({ success: false, error: 'That video is no longer available.' });
    console.log(youtubeUrl
      ? `[ManualClip] ${jobId} is on YouTube at ${youtubeUrl}`
      : `[ManualClip] ${jobId} no longer has a YouTube link`);
    res.json({ success: true, youtubeUrl });
  } catch (error) {
    console.error('[ManualClip] Save YouTube link error:', error);
    res.status(500).json({ success: false, error: 'Could not save the YouTube link.' });
  }
});

// ============================================================
// PUT /api/manual-clip/library/:jobId/brainreport
// Save the Podcast Brain report (markdown) for a saved video.
// Body: { brainReport: string }
// ============================================================
router.put('/library/:jobId/brainreport', async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.headers['x-user-id'] || null;
    const stored = await manualVideoLibraryService.updateBrainReport(userId, jobId, req.body?.brainReport || '');
    if (!stored) return res.status(404).json({ success: false, error: 'That video is no longer available.' });
    res.json({ success: true });
  } catch (error) {
    console.error('[ManualClip] Save brain report error:', error);
    res.status(500).json({ success: false, error: 'Could not save the report.' });
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
// PUT /api/manual-clip/library/:jobId/settings
// Auto-save the editor's on/off toggles (removeSilences, levelAudio) for a
// saved video, so reopening the project brings them back. Send only the
// toggle(s) that changed.
// Body: { removeSilences?: boolean, levelAudio?: boolean }
// ============================================================
router.put('/library/:jobId/settings', async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.headers['x-user-id'] || null;
    const { removeSilences, levelAudio } = req.body || {};
    const settings = {};
    if (removeSilences !== undefined) settings.removeSilences = !!removeSilences;
    if (levelAudio !== undefined) settings.levelAudio = !!levelAudio;
    await manualVideoLibraryService.updateSettings(userId, jobId, settings);
    res.json({ success: true });
  } catch (error) {
    console.error('[ManualClip] Save settings error:', error);
    res.status(500).json({ success: false, error: 'Could not save your settings.' });
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
// PUT /api/manual-clip/library/:jobId/revoice
// 🎙️ Auto-save the user's ReVoice sections (+ their recorded clip URLs) for a
// saved video, so a refresh/reopen brings the whole ReVoice project back.
// Body: { revoice: [{ title, startTime, endTime, audioUrl, audioDuration,
//         align, mode, fitMode }] }
// ============================================================
router.put('/library/:jobId/revoice', async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.headers['x-user-id'] || null;
    const { revoice } = req.body;
    await manualVideoLibraryService.updateRevoice(userId, jobId, revoice || []);
    res.json({ success: true });
  } catch (error) {
    console.error('[ManualClip] Save revoice error:', error);
    res.status(500).json({ success: false, error: 'Could not save your ReVoice sections.' });
  }
});

// ============================================================
// PUT /api/manual-clip/library/:jobId/inserts
// Auto-save the user's added clips / CTAs for a saved video, so reopening the
// project brings them back like hooks/cuts.
// Body: { inserts: [{ atTime: Number|null, clipUrls: [String] }] }
// ============================================================
router.put('/library/:jobId/inserts', async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.headers['x-user-id'] || null;
    const { inserts } = req.body;
    await manualVideoLibraryService.updateInserts(userId, jobId, inserts || []);
    res.json({ success: true });
  } catch (error) {
    console.error('[ManualClip] Save inserts error:', error);
    res.status(500).json({ success: false, error: 'Could not save your added clips.' });
  }
});

// ============================================================
// PUT /api/manual-clip/library/:jobId/intro
// Auto-save the intro clip (a fetched R2 url) for a saved video, so reopening
// the project brings it back. Body: { introUrl: String|null, introLabel?: String }
// ============================================================
router.put('/library/:jobId/intro', async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.headers['x-user-id'] || null;
    const { introUrl, introLabel } = req.body;
    await manualVideoLibraryService.updateIntro(userId, jobId, introUrl || null, introLabel || '');
    res.json({ success: true });
  } catch (error) {
    console.error('[ManualClip] Save intro error:', error);
    res.status(500).json({ success: false, error: 'Could not save your intro clip.' });
  }
});

// ============================================================
// PUT /api/manual-clip/library/:jobId/lowerthirds
// Auto-save the user's animated lower-third CTA overlays for a saved video,
// so reopening the project brings them back like hooks/cuts.
// Body: { lowerThirds: [{ style, line1, line2, startSec, endSec, stay }] }
// ============================================================
router.put('/library/:jobId/lowerthirds', async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.headers['x-user-id'] || null;
    const { lowerThirds } = req.body;
    await manualVideoLibraryService.updateLowerThirds(userId, jobId, lowerThirds || []);
    res.json({ success: true });
  } catch (error) {
    console.error('[ManualClip] Save lower thirds error:', error);
    res.status(500).json({ success: false, error: 'Could not save your CTA overlays.' });
  }
});

// ============================================================
// POST /api/manual-clip/background-image/:jobId
// 🖼️ Upload one background image for a section. Parked in R2 under the same
// project prefix as the source video (manual-clip/{jobId}/backgrounds/…), so it
// shares the project's lifespan and is swept away with it. Returns a public URL
// the editor keeps in the section and auto-saves.
// Field: image (multipart)
// ============================================================
router.post('/background-image/:jobId', upload.single('image'), async (req, res) => {
  try {
    const { jobId } = req.params;
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'Please choose an image to upload.' });
    }
    const result = await manualClipService.saveBackgroundImage(jobId, req.file.path, req.file.originalname);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[ManualClip] Background image upload error:', error);
    res.status(500).json({ success: false, error: 'Could not upload that image. Please try again.' });
  }
});

// ============================================================
// POST /api/manual-clip/background-image-url/:jobId
// 🔗 Same as above, but from a LINK instead of a file — a GoHighLevel media
// storage URL, any CDN/image URL, a Google Drive or Dropbox share link. The
// server fetches it and copies it into R2 (links expire; the render happens
// later), so the section keeps working. Body: { url }
// ============================================================
router.post('/background-image-url/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { url } = req.body || {};
    if (!url || !String(url).trim()) {
      return res.status(400).json({ success: false, error: 'Please paste an image link.' });
    }
    const result = await manualClipService.fetchBackgroundImageFromUrl(jobId, String(url).trim());
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('[ManualClip] Background image link error:', error.message);
    // These messages are written for the user — pass them straight through.
    res.status(400).json({ success: false, error: error.message || 'Could not fetch that image link.' });
  }
});

// ============================================================
// PUT /api/manual-clip/library/:jobId/backgrounds
// Auto-save the user's background-image sections for a saved video, so reopening
// the project brings them back like hooks/cuts/CTAs.
// Body: { backgroundSections: [{ title, startSec, endSec, imageUrl, imageKey,
//         fitMode, pip: { xPct, yPct, wPct } }] }
// ============================================================
router.put('/library/:jobId/backgrounds', async (req, res) => {
  try {
    const { jobId } = req.params;
    const userId = req.headers['x-user-id'] || null;
    const { backgroundSections } = req.body;
    await manualVideoLibraryService.updateBackgroundSections(userId, jobId, backgroundSections || []);
    res.json({ success: true });
  } catch (error) {
    console.error('[ManualClip] Save background sections error:', error);
    res.status(500).json({ success: false, error: 'Could not save your background sections.' });
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

// ============================================================
// ⭐ SAVED CTA LINKS — a per-user address book of the CTA clips they re-use in
// every podcast (GoHighLevel media link, Tella link, any supported link). Only
// LINKS are stored, never video files; picking one just feeds its link into the
// normal /fetch-clip flow. Unlimited entries per user.
//
//   GET    /api/manual-clip/cta-library          → { ctas: [...] }
//   POST   /api/manual-clip/cta-library          { name, url, note? }
//   PUT    /api/manual-clip/cta-library/:id      { name?, url?, note? }
//   POST   /api/manual-clip/cta-library/:id/used (bump usage stats)
//   DELETE /api/manual-clip/cta-library/:id
// ============================================================
router.get('/cta-library', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] || null;
    const ctas = await ctaLibraryService.list(userId);
    res.json({ success: true, ctas });
  } catch (error) {
    console.error('[ManualClip] CTA library list error:', error);
    res.json({ success: true, ctas: [] }); // never block the editor over this
  }
});

router.post('/cta-library', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] || null;
    const { name, url, note, durationFormatted } = req.body || {};
    const cta = await ctaLibraryService.add(userId, { name, url, note, durationFormatted });
    res.json({ success: true, cta });
  } catch (error) {
    console.error('[ManualClip] CTA library save error:', error.message);
    res.status(400).json({ success: false, error: error.message || 'Could not save that CTA link.' });
  }
});

router.put('/cta-library/:id', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] || null;
    const { name, url, note } = req.body || {};
    const cta = await ctaLibraryService.update(userId, req.params.id, { name, url, note });
    res.json({ success: true, cta });
  } catch (error) {
    console.error('[ManualClip] CTA library update error:', error.message);
    res.status(400).json({ success: false, error: error.message || 'Could not update that CTA link.' });
  }
});

router.post('/cta-library/:id/used', async (req, res) => {
  const userId = req.headers['x-user-id'] || null;
  await ctaLibraryService.touch(userId, req.params.id);
  res.json({ success: true });
});

router.delete('/cta-library/:id', async (req, res) => {
  try {
    const userId = req.headers['x-user-id'] || null;
    const removed = await ctaLibraryService.remove(userId, req.params.id);
    res.json({ success: true, removed });
  } catch (error) {
    console.error('[ManualClip] CTA library delete error:', error.message);
    res.status(500).json({ success: false, error: 'Could not remove that CTA link.' });
  }
});

module.exports = router;
