const express = require('express');
const router = express.Router();
const transcriptionService = require('../services/transcriptionService');
const fs = require('fs-extra');

/**
 * POST /api/transcribe
 * Transcribe video audio
 */
router.post('/', async (req, res) => {
  try {
    const { videoPath, jobId, options = {} } = req.body;

    if (!videoPath) {
      return res.status(400).json({
        error: 'videoPath is required'
      });
    }

    // Check if file exists
    const exists = await fs.pathExists(videoPath);
    if (!exists) {
      return res.status(404).json({
        error: 'Video file not found'
      });
    }

    console.log(`Transcribing: ${videoPath}`);

    // Transcribe using OpenAI Whisper
    const transcription = await transcriptionService.transcribe(videoPath, {
      response_format: 'verbose_json',
      language: options.language,
      prompt: options.prompt,
      temperature: options.temperature
    });

    res.json({
      success: true,
      data: {
        jobId,
        transcription
      }
    });

  } catch (error) {
    console.error('Transcription error:', error);
    res.status(500).json({
      error: error.message
    });
  }
});

/**
 * POST /api/transcribe/railway
 * Use your existing Railway transcription service
 */
router.post('/railway', async (req, res) => {
  try {
    const { videoPath, endpoint } = req.body;

    if (!videoPath || !endpoint) {
      return res.status(400).json({
        error: 'videoPath and endpoint are required'
      });
    }

    console.log(`Transcribing with Railway: ${videoPath}`);

    const result = await transcriptionService.transcribeWithRailway(videoPath, endpoint);

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

/**
 * POST /api/transcribe/format
 * Format transcription to different formats
 */
router.post('/format', async (req, res) => {
  try {
    const { transcription, format = 'srt' } = req.body;

    if (!transcription) {
      return res.status(400).json({
        error: 'transcription is required'
      });
    }

    const formatted = transcriptionService.formatTranscript(transcription, format);

    res.json({
      success: true,
      data: {
        format,
        content: formatted
      }
    });

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

// ===================================================================
// POST /api/transcribe/audio-blob
// ===================================================================
// Accepts a raw audio recording (browser MediaRecorder blob) as a
// multipart upload, runs OpenAI Whisper, returns the transcribed text.
// Used by the speech-to-text mic buttons in the frontend forms.
// ===================================================================

const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const TEMP_DIR = process.env.TEMP_DIR || '/app/temp';

// Use disk storage (creates dir lazily inside destination function)
// Memory storage works too but disk is safer for larger blobs and reuses
// the existing transcribe() interface that takes a file path.
const blobStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(TEMP_DIR, 'transcribe-blobs');
    fs.ensureDirSync(dir);
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '.webm') || '.webm';
    cb(null, `${uuidv4()}${ext}`);
  }
});

const blobUpload = multer({
  storage: blobStorage,
  limits: {
    fileSize: 25 * 1024 * 1024 // 25 MB — Whisper's own limit
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/wave', 'audio/x-wav',
      'audio/aac', 'audio/mp4', 'audio/m4a', 'audio/x-m4a',
      'audio/ogg', 'audio/webm', 'video/webm'
    ];
    const allowedExts = ['.mp3', '.wav', '.aac', '.m4a', '.ogg', '.webm', '.mp4'];
    const ext = path.extname(file.originalname || '').toLowerCase();

    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported audio format'));
    }
  }
});

router.post('/audio-blob', blobUpload.single('audio'), async (req, res) => {
  let savedPath = null;
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No audio file uploaded. Please attach the recording as the "audio" form field.'
      });
    }

    savedPath = req.file.path;
    const language = req.body.language || undefined; // auto-detect if not given

    console.log(`[Transcribe Blob] Received: ${req.file.originalname || 'blob'} (${(req.file.size / 1024).toFixed(1)} KB) → ${savedPath}`);

    // Use the same transcribe() method captions and other features rely on
    const result = await transcriptionService.transcribe(savedPath, {
      response_format: 'json', // we only need .text — skip verbose segments
      language
    });

    const text = (result && result.text) ? result.text.trim() : '';

    console.log(`[Transcribe Blob] ✓ Transcribed ${text.length} chars`);

    res.json({
      success: true,
      text
    });

  } catch (error) {
    console.error('[Transcribe Blob] Error:', error.message);
    // Friendly user-facing error — never leak Whisper / FFmpeg internals
    res.status(500).json({
      success: false,
      error: 'Could not transcribe your recording. Please try again or type the script.'
    });
  } finally {
    // Always clean up the uploaded blob from disk
    if (savedPath) {
      fs.remove(savedPath).catch(() => {});
    }
  }
});

module.exports = router;
