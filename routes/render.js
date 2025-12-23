const express = require('express');
const router = express.Router();
const renderService = require('../services/renderService');
const fs = require('fs-extra');

/**
 * POST /api/render
 * Render final video with reactions
 */
router.post('/', async (req, res) => {
  try {
    const { 
      videoPath, 
      transcript, 
      reactions = [], 
      cuts = [],
      outputFilename 
    } = req.body;

    if (!videoPath) {
      return res.status(400).json({
        error: 'videoPath is required'
      });
    }

    // Check if video file exists
    const exists = await fs.pathExists(videoPath);
    if (!exists) {
      return res.status(404).json({
        error: 'Video file not found'
      });
    }

    console.log(`Rendering video: ${videoPath}`);
    console.log(`Reactions: ${reactions.length}, Cuts: ${cuts.length}`);

    // Render video
    const result = await renderService.renderVideo({
      videoPath,
      transcript,
      reactions,
      cuts,
      outputFilename
    });

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Render error:', error);
    res.status(500).json({
      error: error.message
    });
  }
});

/**
 * GET /api/render/info
 * Get video information
 */
router.post('/info', async (req, res) => {
  try {
    const { videoPath } = req.body;

    if (!videoPath) {
      return res.status(400).json({
        error: 'videoPath is required'
      });
    }

    const info = await renderService.getVideoInfo(videoPath);

    res.json({
      success: true,
      data: info
    });

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

/**
 * POST /api/render/thumbnail
 * Create thumbnail from video
 */
router.post('/thumbnail', async (req, res) => {
  try {
    const { videoPath, timestamp = '00:00:01' } = req.body;

    if (!videoPath) {
      return res.status(400).json({
        error: 'videoPath is required'
      });
    }

    const outputDir = process.env.TEMP_DIR || '/app/temp';
    const outputPath = `${outputDir}/thumb_${Date.now()}.jpg`;

    await renderService.createThumbnail(videoPath, outputPath, timestamp);

    res.json({
      success: true,
      data: {
        thumbnailPath: outputPath
      }
    });

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

module.exports = router;
