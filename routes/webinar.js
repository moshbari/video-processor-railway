const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const webinarService = require('../services/webinarService');
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
    const ext = path.extname(file.originalname);
    if (file.fieldname === 'video1') {
      cb(null, `video1_input${ext}`);
    } else if (file.fieldname === 'video2') {
      cb(null, `video2_input${ext}`);
    } else if (file.fieldname === 'image') {
      cb(null, `overlay_image${ext}`);
    } else {
      cb(null, file.originalname);
    }
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 * 1024 }, // 10GB max per file
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'video1' || file.fieldname === 'video2') {
      const videoTypes = /mp4|mov|avi|webm|mkv/i;
      const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
      if (videoTypes.test(ext)) {
        cb(null, true);
      } else {
        cb(new Error('Only video files (MP4, MOV, AVI, WEBM, MKV) are allowed'));
      }
    } else if (file.fieldname === 'image') {
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
 * POST /api/webinar
 * Upload video1, video2, and image - starts background processing
 * Returns immediately with jobId
 */
router.post('/', upload.fields([
  { name: 'video1', maxCount: 1 },
  { name: 'video2', maxCount: 1 },
  { name: 'image', maxCount: 1 }
]), async (req, res) => {
  const jobId = req.jobId || uuidv4();
  console.log(`[${jobId}] Webinar render request received`);

  try {
    // Validate files
    if (!req.files || !req.files.video1 || !req.files.video2 || !req.files.image) {
      return res.status(400).json({
        success: false,
        error: 'All three files are required: video1, video2, and image'
      });
    }

    const video1File = req.files.video1[0];
    const video2File = req.files.video2[0];
    const imageFile = req.files.image[0];

    console.log(`[${jobId}] Video 1: ${video1File.originalname} (${(video1File.size / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`[${jobId}] Video 2: ${video2File.originalname} (${(video2File.size / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`[${jobId}] Image: ${imageFile.originalname} (${(imageFile.size / 1024).toFixed(2)} KB)`);

    // Initialize job status
    webinarService.updateJobStatus(jobId, {
      status: 'queued',
      progress: 0,
      step: 'Queued',
      createdAt: new Date().toISOString(),
      video1Name: video1File.originalname,
      video2Name: video2File.originalname,
      imageName: imageFile.originalname,
      downloadUrl: null,
      filename: null
    });

    // Respond immediately - processing happens in background
    res.json({
      success: true,
      jobId,
      message: 'Processing started. Check status at /api/webinar/status/' + jobId
    });

    // Start background processing (don't await)
    processInBackground(jobId, video1File.path, video2File.path, imageFile.path);

  } catch (error) {
    console.error(`[${jobId}] Error:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to start processing'
    });
  }
});

/**
 * Background processing function
 */
async function processInBackground(jobId, video1Path, video2Path, imagePath) {
  try {
    console.log(`[${jobId}] Starting background processing...`);

    // Process the webinar
    const result = await webinarService.processWebinar(video1Path, video2Path, imagePath, jobId);

    // Generate filename with date
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = now.toISOString().slice(11, 16).replace(':', '');
    const outputFilename = `WEBINAR_${dateStr}_${timeStr}.mp4`;

    // Upload to R2
    const r2Key = `webinar/${jobId}/${outputFilename}`;
    console.log(`[${jobId}] Uploading to R2: ${r2Key}`);
    
    const uploadResult = await r2Service.uploadFile(result.outputPath, r2Key, 'video/mp4');

    // Update job status with download URL
    webinarService.updateJobStatus(jobId, {
      status: 'complete',
      progress: 100,
      step: 'Complete',
      downloadUrl: uploadResult.downloadUrl,
      filename: outputFilename,
      completedAt: new Date().toISOString()
    });

    // Clean up local files
    await webinarService.cleanup(jobId);

    console.log(`[${jobId}] Background processing complete!`);

  } catch (error) {
    console.error(`[${jobId}] Background processing failed:`, error.message);
    
    webinarService.updateJobStatus(jobId, {
      status: 'failed',
      progress: 0,
      step: 'Failed',
      error: error.message
    });

    // Clean up on error
    try {
      await webinarService.cleanup(jobId);
    } catch (cleanupError) {
      console.error(`[${jobId}] Cleanup error:`, cleanupError.message);
    }
  }
}

/**
 * GET /api/webinar/status/:jobId
 * Get status of a specific job
 */
router.get('/status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const status = webinarService.getJobStatus(jobId);

  if (!status) {
    return res.status(404).json({
      success: false,
      error: 'Job not found'
    });
  }

  res.json({
    success: true,
    jobId,
    ...status
  });
});

/**
 * GET /api/webinar/jobs
 * Get all jobs (for queue display)
 */
router.get('/jobs', (req, res) => {
  const jobs = webinarService.getAllJobs();
  
  res.json({
    success: true,
    jobs
  });
});

/**
 * GET /api/webinar/health
 * Health check endpoint
 */
router.get('/health', (req, res) => {
  res.json({
    success: true,
    service: 'webinar',
    status: 'operational'
  });
});

module.exports = router;
