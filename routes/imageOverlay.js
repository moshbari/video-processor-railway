const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const imageOverlayService = require('../services/imageOverlayService');
const r2Service = require('../services/r2Service');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const jobId = req.jobId || uuidv4();
    req.jobId = jobId;
    const uploadDir = path.join(process.env.TEMP_DIR || '/app/temp', jobId);
    await fs.ensureDir(uploadDir);
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Keep original extension
    const ext = path.extname(file.originalname);
    if (file.fieldname === 'video') {
      cb(null, `input_video${ext}`);
    } else if (file.fieldname === 'image') {
      cb(null, `overlay_image${ext}`);
    } else {
      cb(null, file.originalname);
    }
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 }, // 10GB max
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'video') {
      // Allow common video formats
      const videoTypes = /mp4|mov|avi|webm|mkv/i;
      const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
      if (videoTypes.test(ext)) {
        cb(null, true);
      } else {
        cb(new Error('Only video files (MP4, MOV, AVI, WEBM, MKV) are allowed'));
      }
    } else if (file.fieldname === 'image') {
      // Allow common image formats
      const imageTypes = /png|jpg|jpeg|gif|webp/i;
      const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
      if (imageTypes.test(ext)) {
        cb(null, true);
      } else {
        cb(new Error('Only image files (PNG, JPG, GIF, WEBP) are allowed'));
      }
    } else {
      cb(null, true);
    }
  }
});

/**
 * POST /api/image-overlay
 * Upload video and image, apply full-frame overlay, return download link
 */
router.post('/', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'image', maxCount: 1 }
]), async (req, res) => {
  const jobId = req.jobId || uuidv4();
  console.log(`[${jobId}] Image overlay request received`);

  try {
    // Validate files
    if (!req.files || !req.files.video || !req.files.image) {
      return res.status(400).json({
        success: false,
        error: 'Both video and image files are required'
      });
    }

    const videoFile = req.files.video[0];
    const imageFile = req.files.image[0];

    console.log(`[${jobId}] Video: ${videoFile.originalname} (${(videoFile.size / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`[${jobId}] Image: ${imageFile.originalname} (${(imageFile.size / 1024).toFixed(2)} KB)`);

    // Apply overlay
    const result = await imageOverlayService.applyFullOverlay(
      videoFile.path,
      imageFile.path,
      jobId
    );

    // Generate filename with date
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = now.toISOString().slice(11, 16).replace(':', '');
    const outputFilename = `OVERLAY_${dateStr}_${timeStr}.mp4`;

    // Upload to R2
    const r2Key = `image-overlay/${jobId}/${outputFilename}`;
    console.log(`[${jobId}] Uploading to R2: ${r2Key}`);
    
    const uploadResult = await r2Service.uploadFile(result.outputPath, r2Key, 'video/mp4');

    // Clean up local files
    await imageOverlayService.cleanup(jobId);

    console.log(`[${jobId}] Complete! Download URL: ${uploadResult.downloadUrl}`);

    res.json({
      success: true,
      jobId,
      downloadUrl: uploadResult.downloadUrl,
      filename: outputFilename,
      message: 'Overlay applied successfully. Download link valid for 7 days.'
    });

  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);
    
    // Clean up on error
    try {
      await imageOverlayService.cleanup(jobId);
    } catch (cleanupError) {
      console.error(`[${jobId}] Cleanup error:`, cleanupError.message);
    }

    res.status(500).json({
      success: false,
      error: error.message || 'Failed to process overlay'
    });
  }
});

/**
 * GET /api/image-overlay/health
 * Health check endpoint
 */
router.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'image-overlay',
    status: 'operational'
  });
});

module.exports = router;
