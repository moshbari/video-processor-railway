const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

// Configure multer for video uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const jobId = uuidv4();
    req.jobId = jobId;
    const uploadDir = path.join(process.env.TEMP_DIR || '/app/temp', jobId);
    await fs.ensureDir(uploadDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Keep original extension, standardize name
    const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
    cb(null, `video${ext}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB max
  },
  fileFilter: (req, file, cb) => {
    // Accept video files
    const allowedMimes = [
      'video/mp4',
      'video/webm',
      'video/quicktime',
      'video/x-msvideo',
      'video/x-matroska',
      'video/mpeg'
    ];
    const allowedExts = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.mpeg'];
    
    const ext = path.extname(file.originalname).toLowerCase();
    
    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}. Please upload a video file.`), false);
    }
  }
});

/**
 * POST /api/upload
 * Upload a video file directly (fallback when yt-dlp fails)
 * Returns videoPath compatible with existing split workflow
 */
router.post('/', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No video file provided'
      });
    }

    const jobId = req.jobId;
    const videoPath = req.file.path;
    const originalName = req.file.originalname;
    const fileSize = req.file.size;

    console.log(`\n${'='.repeat(50)}`);
    console.log('VIDEO UPLOAD');
    console.log('='.repeat(50));
    console.log(`Job ID: ${jobId}`);
    console.log(`Original name: ${originalName}`);
    console.log(`Saved to: ${videoPath}`);
    console.log(`Size: ${(fileSize / (1024 * 1024)).toFixed(2)} MB`);
    console.log('='.repeat(50));

    res.json({
      success: true,
      jobId,
      videoPath,
      originalName,
      fileSize,
      fileSizeMB: (fileSize / (1024 * 1024)).toFixed(2),
      message: 'Video uploaded successfully. Ready for splitting.'
    });

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/upload/with-reactions
 * Upload video AND immediately split with reactions in one step
 * Combines upload + split into single operation
 */
router.post('/with-reactions', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No video file provided'
      });
    }

    let reactions;
    try {
      reactions = JSON.parse(req.body.reactions || '[]');
    } catch (e) {
      return res.status(400).json({
        success: false,
        error: 'Invalid reactions JSON'
      });
    }

    if (!reactions || !Array.isArray(reactions) || reactions.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Reactions array is required'
      });
    }

    const jobId = req.jobId;
    const videoPath = req.file.path;

    console.log(`\n${'='.repeat(50)}`);
    console.log('VIDEO UPLOAD + SPLIT');
    console.log('='.repeat(50));
    console.log(`Job ID: ${jobId}`);
    console.log(`Video: ${videoPath}`);
    console.log(`Reactions: ${reactions.length}`);
    console.log('='.repeat(50));

    // Import and use splitService
    const splitService = require('../services/splitService');
    
    const result = await splitService.splitVideoForReactions(videoPath, reactions, jobId);

    res.json({
      success: true,
      jobId,
      ...result,
      message: 'Video uploaded and split successfully'
    });

  } catch (error) {
    console.error('Upload+split error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
