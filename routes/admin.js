const express = require('express');
const router = express.Router();
const cleanupService = require('../services/cleanupService');

/**
 * GET /api/admin/status - Get storage status and job list
 */
router.get('/status', async (req, res) => {
  try {
    const status = await cleanupService.getStatus();
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    console.error('Status error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/admin/cleanup - Manually trigger cleanup
 */
router.post('/cleanup', async (req, res) => {
  try {
    const result = await cleanupService.forceCleanup();
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Manual cleanup error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
