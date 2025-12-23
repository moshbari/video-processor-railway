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
 * GET /api/split/:jobId/clip/:clipNumber - Download individual clip
 */
router.get('/:jobId/clip/:clipNumber', async (req, res) => {
  try {
    const { jobId, clipNumber } = req.params;
    const clipPath = splitService.getClipPath(jobId, clipNumber);

    if (!await fs.pathExists(clipPath)) {
      return res.status(404).json({
        success: false,
        error: 'Clip not found'
      });
    }

    res.download(clipPath, `clip_${clipNumber}.mp4`, (err) => {
      if (err) {
        console.error('Download error:', err);
      }
    });

  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/split/:jobId/guide - Download reactions guide
 */
router.get('/:jobId/guide', async (req, res) => {
  try {
    const { jobId } = req.params;
    const guidePath = splitService.getGuidePath(jobId);

    if (!await fs.pathExists(guidePath)) {
      return res.status(404).json({
        success: false,
        error: 'Guide not found'
      });
    }

    res.download(guidePath, 'reactions_guide.txt', (err) => {
      if (err) {
        console.error('Download error:', err);
      }
    });

  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/split/:jobId - Cleanup clips after download
 */
router.delete('/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const outputDir = process.env.OUTPUT_DIR || '/app/outputs';
    
    // Find and delete all files for this job
    const files = await fs.readdir(outputDir);
    const jobFiles = files.filter(f => f.startsWith(jobId));
    
    for (const file of jobFiles) {
      await fs.remove(path.join(outputDir, file));
    }

    res.json({
      success: true,
      message: `Deleted ${jobFiles.length} files`
    });

  } catch (error) {
    console.error('Cleanup error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
