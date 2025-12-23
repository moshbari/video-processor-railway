const express = require('express');
const router = express.Router();
const downloadService = require('../services/downloadService');

/**
 * POST /api/download
 * Download video from URL
 */
router.post('/', async (req, res) => {
  try {
    const { url, jobId } = req.body;

    if (!url) {
      return res.status(400).json({
        error: 'URL is required'
      });
    }

    // Validate URL format
    try {
      new URL(url);
    } catch (e) {
      return res.status(400).json({
        error: 'Invalid URL format'
      });
    }

    console.log(`Download request: ${url}`);

    // Download video
    const result = await downloadService.downloadVideo(url, jobId);

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({
      error: error.message
    });
  }
});

/**
 * POST /api/download/validate
 * Validate URL before downloading
 */
router.post('/validate', async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        error: 'URL is required'
      });
    }

    const validation = await downloadService.validateUrl(url);

    res.json({
      success: true,
      data: validation
    });

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

/**
 * GET /api/download/platforms
 * Get list of supported platforms
 */
router.get('/platforms', async (req, res) => {
  try {
    const platforms = await downloadService.getSupportedPlatforms();

    res.json({
      success: true,
      data: platforms
    });

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

/**
 * GET /api/download/status
 * Check yt-dlp installation status
 */
router.get('/status', async (req, res) => {
  try {
    const status = await downloadService.checkInstallation();

    res.json({
      success: true,
      data: status
    });

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

module.exports = router;
