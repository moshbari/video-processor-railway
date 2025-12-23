const express = require('express');
const router = express.Router();
const voiceService = require('../services/voiceService');

/**
 * GET /api/voices - Get all available 11Labs voices
 */
router.get('/', async (req, res) => {
  try {
    console.log('Fetching available voices...');
    const voices = await voiceService.getAvailableVoices();
    
    res.json({
      success: true,
      data: voices
    });

  } catch (error) {
    console.error('Error fetching voices:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/voices/generate - Generate voices for reactions
 * Body: {
 *   reactions: [{ text: "...", timestamp: 0 }],
 *   voiceId: "xxx" or voiceName: "Josh"
 * }
 */
router.post('/generate', async (req, res) => {
  try {
    const { reactions, voiceId, voiceName } = req.body;

    if (!reactions || !Array.isArray(reactions) || reactions.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'reactions array is required'
      });
    }

    console.log(`Generating voices for ${reactions.length} reactions...`);

    // Get voice ID (either from voiceId or voiceName)
    let selectedVoiceId = voiceId;
    
    if (!selectedVoiceId && voiceName) {
      selectedVoiceId = await voiceService.getVoiceIdByName(voiceName);
    }
    
    // Default to Josh if no voice specified
    if (!selectedVoiceId) {
      selectedVoiceId = await voiceService.getVoiceIdByName('Josh');
    }

    console.log(`Using voice ID: ${selectedVoiceId}`);

    // Generate voices
    const result = await voiceService.generateVoicesForReactions(
      reactions,
      selectedVoiceId
    );

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Error generating voices:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/voices/test - Test voice generation with sample text
 */
router.post('/test', async (req, res) => {
  try {
    const { text, voiceId, voiceName } = req.body;

    if (!text) {
      return res.status(400).json({
        success: false,
        error: 'text is required'
      });
    }

    // Get voice ID
    let selectedVoiceId = voiceId;
    if (!selectedVoiceId && voiceName) {
      selectedVoiceId = await voiceService.getVoiceIdByName(voiceName);
    }
    if (!selectedVoiceId) {
      selectedVoiceId = await voiceService.getVoiceIdByName('Josh');
    }

    console.log(`Testing voice generation with voice ${selectedVoiceId}`);

    const audioBuffer = await voiceService.generateVoiceForReaction(
      text,
      selectedVoiceId
    );

    // Return audio file
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', 'attachment; filename="test_voice.mp3"');
    res.send(audioBuffer);

  } catch (error) {
    console.error('Error testing voice:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
