const express = require('express');
const router = express.Router();
const splitService = require('../services/splitService');
const path = require('path');
const fs = require('fs-extra');

/**
 * POST /api/split - Split video at reaction timestamps for manual editing
 */
router.post('/', async (req, res) => {
  try {
    const { videoPath, reactions } = req.body;

    if (!videoPath || !reactions || !Array.isArray(reactions)) {
      return res.status(400).json({
        success: false,
        error: 'videoPath and reactions array are required'
      });
    }

    console.log(`Splitting video into ${reactions.length + 1} clips...`);

    const result = await splitService.splitVideoForReactions(videoPath, reactions);

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Split error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/split/:jobId/download - Download ZIP file with all clips
 */
router.get('/:jobId/download', async (req, res) => {
  try {
    const { jobId } = req.params;
    const zipPath = path.join(
      process.env.OUTPUT_DIR || '/app/outputs',
      `split_video_${jobId}.zip`
    );

    if (!await fs.pathExists(zipPath)) {
      return res.status(404).json({
        success: false,
        error: 'ZIP file not found'
      });
    }

    res.download(zipPath, `reaction_clips_${jobId}.zip`, (err) => {
      if (err) {
        console.error('Download error:', err);
      }
      // Cleanup after download
      setTimeout(() => {
        fs.remove(zipPath).catch(console.error);
      }, 5000);
    });

  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
