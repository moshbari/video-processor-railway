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
    const { jobId, reactions } = req.body;
    
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
    
    console.log(`\n[AudioReaction API] 🎬 Starting render`);
    console.log(`[AudioReaction API] Job: ${jobId}`);
    console.log(`[AudioReaction API] Reactions: ${reactions.length}`);
    
    // Return immediately, render in background
    res.json({
      success: true,
      message: 'Render started',
      jobId,
      reactionCount: reactions.length
    });
    
    // Start render in background
    audioReactionService.combineClipsWithAudioReactions(jobId, reactions)
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
 * POST /api/audio-reaction/render-sync
 * 
 * Render and wait for completion (for testing)
 * Returns download URL directly
 */
router.post('/render-sync', async (req, res) => {
  try {
    const { jobId, reactions } = req.body;
    
    if (!jobId || !reactions || reactions.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Missing jobId or reactions'
      });
    }
    
    console.log(`\n[AudioReaction API] 🎬 Starting SYNC render`);
    
    const result = await audioReactionService.combineClipsWithAudioReactions(jobId, reactions);
    
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
