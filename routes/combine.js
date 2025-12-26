const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const combineService = require('../services/combineService');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(process.env.TEMP_DIR || '/app/temp', 'uploads');
    await fs.ensureDir(uploadDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB per file
    files: 20
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'), false);
    }
  }
});

/**
 * POST /api/combine - Combine original clips with reaction clips
 * 
 * Supports two modes:
 * - 'sequential' (default): clip → full reaction → clip → full reaction
 * - 'pip': clip → frozen frame + reaction PiP overlay → clip → ...
 * 
 * Body:
 * - originalClips[]: Array of original clip files (uploaded)
 * - reactionClips[]: Array of reaction clip files (uploaded)
 * - mode: 'sequential' or 'pip' (optional, defaults to 'sequential')
 * 
 * Or JSON body:
 * - originalClipPaths: Array of paths to original clips
 * - reactionClipPaths: Array of paths to reaction clips
 * - mode: 'sequential' or 'pip'
 */
router.post('/', upload.fields([
  { name: 'originalClips', maxCount: 20 },
  { name: 'reactionClips', maxCount: 20 }
]), async (req, res) => {
  try {
    let originalClipPaths = [];
    let reactionClipPaths = [];
    
    // Get mode from form data or JSON body
    const mode = req.body.mode || 'sequential';
    
    // Validate mode
    if (!['sequential', 'pip'].includes(mode)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid mode. Use "sequential" or "pip".'
      });
    }

    // Get files from multipart upload
    if (req.files && req.files.originalClips) {
      originalClipPaths = req.files.originalClips.map(f => f.path);
      reactionClipPaths = req.files.reactionClips 
        ? req.files.reactionClips.map(f => f.path)
        : [];
    } 
    // Or use paths from JSON body
    else if (req.body.originalClipPaths) {
      originalClipPaths = JSON.parse(req.body.originalClipPaths);
      reactionClipPaths = req.body.reactionClipPaths 
        ? JSON.parse(req.body.reactionClipPaths)
        : [];
    }
    else {
      return res.status(400).json({
        success: false,
        error: 'No clips provided. Upload originalClips[] and reactionClips[] files, or provide originalClipPaths and reactionClipPaths arrays.'
      });
    }

    if (originalClipPaths.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one original clip is required'
      });
    }

    console.log(`Combining ${originalClipPaths.length} original clips with ${reactionClipPaths.length} reactions (mode: ${mode})`);

    const result = await combineService.combineClipsWithReactions(
      originalClipPaths,
      reactionClipPaths,
      null,
      { mode }
    );

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Combine error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/combine/from-split/:splitJobId - Combine using clips from a previous split job
 * 
 * Body:
 * - reactionClips[]: Array of reaction clip files (uploaded)
 * - mode: 'sequential' or 'pip' (optional, defaults to 'sequential')
 */
router.post('/from-split/:splitJobId', upload.array('reactionClips', 20), async (req, res) => {
  try {
    const { splitJobId } = req.params;
    
    // Get mode from form data
    const mode = req.body.mode || 'sequential';
    
    // Validate mode
    if (!['sequential', 'pip'].includes(mode)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid mode. Use "sequential" or "pip".'
      });
    }
    
    // Get original clips from split job directory
    const splitDir = path.join(process.env.TEMP_DIR || '/app/temp', splitJobId, 'clips');
    
    if (!await fs.pathExists(splitDir)) {
      return res.status(404).json({
        success: false,
        error: 'Split job not found. Clips may have been cleaned up.'
      });
    }

    // Get all clip files sorted by number
    const clipFiles = await fs.readdir(splitDir);
    const originalClipPaths = clipFiles
      .filter(f => f.startsWith('clip_') && f.endsWith('.mp4'))
      .sort((a, b) => {
        const numA = parseInt(a.match(/clip_(\d+)/)[1]);
        const numB = parseInt(b.match(/clip_(\d+)/)[1]);
        return numA - numB;
      })
      .map(f => path.join(splitDir, f));

    if (originalClipPaths.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No clips found in split job directory'
      });
    }

    // Get uploaded reaction clips
    const reactionClipPaths = req.files ? 
      req.files.map(f => f.path) : [];

    console.log(`Combining ${originalClipPaths.length} clips from split job ${splitJobId} with ${reactionClipPaths.length} reactions (mode: ${mode})`);

    const result = await combineService.combineClipsWithReactions(
      originalClipPaths,
      reactionClipPaths,
      null,
      { mode }
    );

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('Combine from split error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/combine/:jobId/download - Download the combined video
 */
router.get('/:jobId/download', async (req, res) => {
  try {
    const { jobId } = req.params;
    const outputPath = combineService.getOutputPath(jobId);

    if (!await fs.pathExists(outputPath)) {
      return res.status(404).json({
        success: false,
        error: 'Combined video not found'
      });
    }

    const stats = await fs.stat(outputPath);
    
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="reaction_video_${jobId}.mp4"`);

    const readStream = fs.createReadStream(outputPath);
    readStream.pipe(res);

  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/combine/:jobId - Cleanup job files
 */
router.delete('/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    await combineService.cleanup(jobId);
    
    res.json({
      success: true,
      message: `Job ${jobId} cleaned up`
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
