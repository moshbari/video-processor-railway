/**
 * 🎙️ AUDIO REACTION ROUTES
 * 
 * API endpoints for Audio-Only RANT feature
 * 
 * Endpoints:
 * - POST /api/audio-reaction/upload-audio   → Upload audio reaction for a clip
 * - POST /api/audio-reaction/render         → Render final video with audio reactions
 * - GET  /api/audio-reaction/progress/:id   → Check render progress
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const audioReactionService = require('../services/audioReactionService');

// Configure multer for audio uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024  // 50MB max per audio file
  },
  fileFilter: (req, file, cb) => {
    // Accept common audio formats
    const allowedMimes = [
      'audio/mpeg',       // mp3
      'audio/mp3',
      'audio/wav',
      'audio/wave',
      'audio/x-wav',
      'audio/aac',
      'audio/mp4',
      'audio/m4a',
      'audio/x-m4a',
      'audio/ogg',
      'audio/webm',
      'video/webm'        // Some browsers record as video/webm
    ];
    
    const allowedExts = ['.mp3', '.wav', '.aac', '.m4a', '.ogg', '.webm'];
    const ext = path.extname(file.originalname).toLowerCase();
    
    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid audio format. Allowed: MP3, WAV, AAC, M4A, OGG, WEBM`));
    }
  }
});

/**
 * POST /api/audio-reaction/upload-audio
 * 
 * Upload an audio reaction for a specific clip
 * 
 * Body (multipart/form-data):
 * - jobId: string (the split job ID)
 * - clipIndex: number (which clip this reaction is for, 1-based)
 * - audio: file (the audio file)
 * - text: string (optional - reaction text for filename)
 */
router.post('/upload-audio', upload.single('audio'), async (req, res) => {
  try {
    const { jobId, clipIndex, text } = req.body;
    
    // Validate inputs
    if (!jobId) {
      return res.status(400).json({
        success: false,
        error: 'Missing jobId. Please split a video first.'
      });
    }
    
    if (!clipIndex) {
      return res.status(400).json({
        success: false,
        error: 'Missing clipIndex. Specify which clip this reaction is for.'
      });
    }
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No audio file uploaded.'
      });
    }
    
    console.log(`\n[AudioReaction API] 📤 Uploading audio reaction`);
    console.log(`[AudioReaction API] Job: ${jobId}`);
    console.log(`[AudioReaction API] Clip: ${clipIndex}`);
    console.log(`[AudioReaction API] File: ${req.file.originalname} (${(req.file.size / 1024).toFixed(1)}KB)`);
    
    // Save the audio file
    const audioPath = await audioReactionService.uploadAudioReaction(
      jobId,
      parseInt(clipIndex),
      req.file.buffer,
      req.file.originalname
    );
    
    res.json({
      success: true,
      message: `Audio reaction ${clipIndex} uploaded`,
      jobId,
      clipIndex: parseInt(clipIndex),
      audioPath,
      text: text || ''
    });
    
  } catch (error) {
    console.error('[AudioReaction API] Upload error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/audio-reaction/render
 * 
 * Render the final video with all audio reactions
 * 
 * Body (JSON):
 * {
 *   "jobId": "abc123",
 *   "reactions": [
 *     { "clipIndex": 1, "audioPath": "/path/to/audio1.mp3", "text": "reaction 1" },
 *     { "clipIndex": 3, "audioPath": "/path/to/audio2.mp3", "text": "reaction 2" }
 *   ]
 * }
 */
router.post('/render', async (req, res) => {
  try {
    const { jobId, reactions, captions, captionStyle } = req.body;
    
    // Validate inputs
    if (!jobId) {
      return res.status(400).json({
        success: false,
        error: 'Missing jobId'
      });
    }
    
    if (!reactions || !Array.isArray(reactions) || reactions.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No audio reactions provided'
      });
    }
    
    // Validate each reaction has required fields
    for (const reaction of reactions) {
      if (!reaction.clipIndex || !reaction.audioPath) {
        return res.status(400).json({
          success: false,
          error: 'Each reaction must have clipIndex and audioPath'
        });
      }
    }
    
    // Normalize caption flags (frontend may send true/false or 'true'/'false')
    const captionsEnabled = captions === true || captions === 'true';
    const styleName = (typeof captionStyle === 'string' && captionStyle.length > 0) ? captionStyle : 'boldPop';
    
    console.log(`\n[AudioReaction API] 🎬 Starting render`);
    console.log(`[AudioReaction API] Job: ${jobId}`);
    console.log(`[AudioReaction API] Reactions: ${reactions.length}`);
    console.log(`[AudioReaction API] Captions: ${captionsEnabled ? `ON (${styleName})` : 'OFF'}`);
    
    // Return immediately, render in background
    res.json({
      success: true,
      message: 'Render started',
      jobId,
      reactionCount: reactions.length,
      captionsEnabled,
      captionStyle: captionsEnabled ? styleName : null
    });
    
    // Start render in background
    audioReactionService.combineClipsWithAudioReactions(jobId, reactions, {
      captions: captionsEnabled,
      captionStyle: styleName
    })
      .then(result => {
        console.log(`[AudioReaction API] ✅ Render complete: ${result.filename}`);
      })
      .catch(err => {
        console.error(`[AudioReaction API] ❌ Render failed:`, err.message);
      });
    
  } catch (error) {
    console.error('[AudioReaction API] Render error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/audio-reaction/progress/:jobId
 * 
 * Check render progress
 */
router.get('/progress/:jobId', (req, res) => {
  const { jobId } = req.params;
  
  const progress = audioReactionService.getProgress(jobId);
  
  res.json({
    success: true,
    jobId,
    ...progress
  });
});

/**
 * POST /api/audio-reaction/generate-voiceovers
 *
 * Generate AI voiceovers for all reaction scripts in one call.
 * Eliminates the manual external-audio creation step.
 *
 * Body (JSON):
 * {
 *   "jobId": "abc123",                          // the split job ID
 *   "provider": "openai" | "elevenlabs",        // optional, default "openai"
 *   "voice": "nova",                            // optional, see ALLOWED_VOICES
 *   "reactions": [
 *     { "clipIndex": 1, "text": "Hold on..." },
 *     { "clipIndex": 2, "text": "Quick teacher moment..." }
 *   ]
 * }
 *
 * ALLOWED_VOICES per provider:
 *   openai:     'nova' (default), 'onyx', 'echo', 'shimmer', 'alloy', 'fable'
 *   elevenlabs: voice IDs from 11Labs (default 'TxGEqnHWrfWFTfGW9XjX' = Josh).
 *               Frontend supplies a stable voiceId — we accept any string and
 *               let 11Labs validate (returns clear error if invalid).
 *
 * Returns immediately with the jobId; generation runs in the background.
 * Frontend should poll GET /voiceover-progress/:jobId to check status.
 */
router.post('/generate-voiceovers', async (req, res) => {
  try {
    const { jobId, provider, voice, reactions } = req.body;

    // Validate
    if (!jobId) {
      return res.status(400).json({
        success: false,
        error: 'Missing jobId. Please split a video first.'
      });
    }

    if (!reactions || !Array.isArray(reactions) || reactions.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No reactions provided. Send an array of { clipIndex, text }.'
      });
    }

    for (const reaction of reactions) {
      if (!reaction.clipIndex || !reaction.text || !reaction.text.trim()) {
        return res.status(400).json({
          success: false,
          error: 'Each reaction must have clipIndex and non-empty text.'
        });
      }
    }

    const normalizedProvider = (provider || 'openai').toLowerCase();
    if (!['openai', 'elevenlabs', '11labs'].includes(normalizedProvider)) {
      return res.status(400).json({
        success: false,
        error: `Unknown provider: ${provider}. Supported: 'openai', 'elevenlabs'.`
      });
    }

    // Validate voice (only enforced for OpenAI — 11Labs has hundreds of voice IDs)
    const OPENAI_VOICES = ['nova', 'onyx', 'echo', 'shimmer', 'alloy', 'fable'];
    let normalizedVoice = null;
    if (voice && typeof voice === 'string' && voice.trim()) {
      normalizedVoice = voice.trim();
      if (normalizedProvider === 'openai' && !OPENAI_VOICES.includes(normalizedVoice.toLowerCase())) {
        return res.status(400).json({
          success: false,
          error: `Unknown OpenAI voice: ${voice}. Supported: ${OPENAI_VOICES.join(', ')}.`
        });
      }
      if (normalizedProvider === 'openai') normalizedVoice = normalizedVoice.toLowerCase();
    }

    console.log(`\n[AudioReaction API] 🎙️ Starting voiceover generation`);
    console.log(`[AudioReaction API] Job: ${jobId}`);
    console.log(`[AudioReaction API] Provider: ${normalizedProvider}`);
    console.log(`[AudioReaction API] Voice: ${normalizedVoice || '(default)'}`);
    console.log(`[AudioReaction API] Reactions: ${reactions.length}`);

    // Mark progress as starting BEFORE we respond, so the frontend's
    // first poll always finds something.
    audioReactionService.updateVoiceoverProgress(
      jobId,
      'starting',
      0,
      `Starting voiceover generation with ${normalizedProvider}...`
    );

    // Respond immediately, generate in background
    res.json({
      success: true,
      message: 'Voiceover generation started',
      jobId,
      provider: normalizedProvider,
      voice: normalizedVoice || '(default)',
      reactionCount: reactions.length
    });

    // Run in background — poll /voiceover-progress/:jobId for results
    audioReactionService.generateVoiceoversForJob(jobId, normalizedProvider, reactions, normalizedVoice)
      .then(result => {
        console.log(`[AudioReaction API] ✅ Voiceover gen done: ${result.totalGenerated} ok, ${result.totalFailed} failed`);
      })
      .catch(err => {
        console.error(`[AudioReaction API] ❌ Voiceover gen failed:`, err.message);
        audioReactionService.updateVoiceoverProgress(
          jobId,
          'error',
          0,
          err.message
        );
      });

  } catch (error) {
    console.error('[AudioReaction API] generate-voiceovers error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/audio-reaction/voiceover-progress/:jobId
 *
 * Check voiceover-generation progress.
 *
 * Response shape (during generation):
 *   { success: true, jobId, status: 'generating', progress: 60, message: '...' }
 *
 * Response shape (when complete):
 *   {
 *     success: true,
 *     jobId,
 *     status: 'complete' | 'complete_with_errors' | 'error',
 *     progress: 100,
 *     message: '...',
 *     reactions: [{ clipIndex, text, audioPath, audioR2Url, success }, ...],
 *     totalGenerated: 3,
 *     totalFailed: 0,
 *     provider: 'openai'
 *   }
 */
router.get('/voiceover-progress/:jobId', (req, res) => {
  const { jobId } = req.params;

  const progress = audioReactionService.getVoiceoverProgress(jobId);

  res.json({
    success: true,
    jobId,
    ...progress
  });
});

/**
 * GET /api/audio-reaction/voices
 *
 * Returns the curated list of available voices per provider.
 * Used by the frontend to populate the voice picker.
 *
 * Note: 11Labs voice IDs are stable identifiers from 11Labs' platform.
 * If a voice ID changes (rare), update it here.
 */
router.get('/voices', (req, res) => {
  res.json({
    success: true,
    providers: {
      openai: {
        defaultVoice: 'nova',
        voices: [
          { id: 'nova',    label: 'Nova',    description: 'Friendly female · warm',          isDefault: true  },
          { id: 'onyx',    label: 'Onyx',    description: 'Deep male · authoritative',        isDefault: false },
          { id: 'echo',    label: 'Echo',    description: 'Neutral male · calm',              isDefault: false },
          { id: 'shimmer', label: 'Shimmer', description: 'Soft female · gentle',             isDefault: false },
          { id: 'alloy',   label: 'Alloy',   description: 'Balanced neutral · versatile',     isDefault: false },
          { id: 'fable',   label: 'Fable',   description: 'British male · warm narrator',     isDefault: false }
        ]
      },
      elevenlabs: {
        defaultVoice: 'TxGEqnHWrfWFTfGW9XjX',
        voices: [
          { id: 'TxGEqnHWrfWFTfGW9XjX', label: 'Josh',    description: 'Natural conversational male',  isDefault: true  },
          { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel',  description: 'Warm female narrator',          isDefault: false },
          { id: 'pNInz6obpgDQGcFmaJgB', label: 'Adam',    description: 'Deep male · documentary',       isDefault: false },
          { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Bella',   description: 'Bright female · energetic',     isDefault: false },
          { id: 'ErXwobaYiN019PkySvjV', label: 'Antoni',  description: 'Well-rounded male',             isDefault: false },
          { id: 'AZnzlk1XvdvUeBnXmlld', label: 'Domi',    description: 'Confident female',              isDefault: false }
        ]
      }
    }
  });
});

/**
 * POST /api/audio-reaction/render-sync
 * 
 * Render and wait for completion (for testing)
 * Returns download URL directly
 */
router.post('/render-sync', async (req, res) => {
  try {
    const { jobId, reactions, captions, captionStyle } = req.body;
    
    if (!jobId || !reactions || reactions.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing jobId or reactions'
      });
    }
    
    const captionsEnabled = captions === true || captions === 'true';
    const styleName = (typeof captionStyle === 'string' && captionStyle.length > 0) ? captionStyle : 'boldPop';
    
    console.log(`\n[AudioReaction API] 🎬 Starting SYNC render`);
    console.log(`[AudioReaction API] Captions: ${captionsEnabled ? `ON (${styleName})` : 'OFF'}`);
    
    const result = await audioReactionService.combineClipsWithAudioReactions(jobId, reactions, {
      captions: captionsEnabled,
      captionStyle: styleName
    });
    
    res.json(result);
    
  } catch (error) {
    console.error('[AudioReaction API] Sync render error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
