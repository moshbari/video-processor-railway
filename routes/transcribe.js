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

module.exports = router;
