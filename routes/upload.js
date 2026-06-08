const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

// Configure multer for video uploads - save to a dedicated uploads folder
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    // Save uploads to a dedicated uploads subfolder
    const uploadsDir = path.join(process.env.TEMP_DIR || '/app/temp', 'uploads');
    await fs.ensureDir(uploadsDir);
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename to avoid conflicts
    const uniqueId = uuidv4();
    const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
    cb(null, `${uniqueId}${ext}`);
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
 * Returns videoPath that can be used with the standard /api/split endpoint
 */
router.post('/', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No video file provided'
      });
    }

    const videoPath = req.file.path;
    const originalName = req.file.originalname;
    const fileSize = req.file.size;

    console.log(`\n${'='.repeat(50)}`);
    console.log('VIDEO UPLOAD');
    console.log('='.repeat(50));
    console.log(`Original name: ${originalName}`);
    console.log(`Saved to: ${videoPath}`);
    console.log(`Size: ${(fileSize / (1024 * 1024)).toFixed(2)} MB`);
    console.log('='.repeat(50));

    // Return the videoPath - user can then call /api/split with this path
    res.json({
      success: true,
      videoPath,
      originalName,
      fileSize,
      fileSizeMB: (fileSize / (1024 * 1024)).toFixed(2),
      message: 'Video uploaded successfully. Use this videoPath with /api/split endpoint.'
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
 * This is the main endpoint for the frontend upload feature
 */
router.post('/with-reactions', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: 'No video file provided'
      });
    }

    // Parse reactions from form data
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

    const videoPath = req.file.path;
    const originalName = req.file.originalname;
    const fileSize = req.file.size;

    console.log(`\n${'='.repeat(50)}`);
    console.log('VIDEO UPLOAD + SPLIT');
    console.log('='.repeat(50));
    console.log(`Original name: ${originalName}`);
    console.log(`Video path: ${videoPath}`);
    console.log(`Size: ${(fileSize / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`Reactions count: ${reactions.length}`);
    console.log('='.repeat(50));

    // Import services
    const splitService = require('../services/splitService');
    const r2Service = require('../services/r2Service');

    // Call the EXISTING splitVideoForReactions function
    // It will create its own jobId and work directory
    const result = await splitService.splitVideoForReactions(videoPath, reactions);

    console.log(`Split complete. Job ID: ${result.jobId}`);
    console.log(`Total clips: ${result.totalClips}`);

    // If R2 is configured, upload clips (same logic as split.js route)
    if (r2Service.isConfigured()) {
      console.log('\nUploading clips to R2...');
      
      const clipFiles = [];
      
      for (const clip of result.clips) {
        const clipPath = splitService.getClipPath(result.jobId, clip.number);
        
        if (await fs.pathExists(clipPath)) {
          clipFiles.push({
            localPath: clipPath,
            fileName: `${result.jobId}/clip_${clip.number}.mp4`,
            mimeType: 'video/mp4'
          });
        } else {
          console.error(`Clip file not found: ${clipPath}`);
        }
      }

      // Upload the tail clip too (original video after the last reaction).
      // It is not part of result.clips; the render service appends it as plain
      // video. It also stays on local disk, so render finds it there too.
      if (result.tailClip) {
        const tailPath = splitService.getClipPath(result.jobId, result.tailClip.number);
        if (await fs.pathExists(tailPath)) {
          clipFiles.push({
            localPath: tailPath,
            fileName: `${result.jobId}/clip_${result.tailClip.number}.mp4`,
            mimeType: 'video/mp4'
          });
        }
      }

      // Upload guide too
      const guidePath = splitService.getGuidePath(result.jobId);
      if (await fs.pathExists(guidePath)) {
        clipFiles.push({
          localPath: guidePath,
          fileName: `${result.jobId}/reactions_guide.txt`,
          mimeType: 'text/plain'
        });
      }

      console.log(`Files to upload: ${clipFiles.length}`);

      const uploadResults = await r2Service.uploadFiles(clipFiles);

      // Map upload results back to clips
      const clipsWithLinks = result.clips.map((clip, index) => {
        const uploadResult = uploadResults[index];
        return {
          ...clip,
          r2Link: uploadResult?.success ? uploadResult.downloadUrl : null
        };
      });

      const guideUpload = uploadResults.find(r => r.fileName.endsWith('.txt'));

      console.log(`Upload complete: ${uploadResults.filter(r => r.success).length}/${uploadResults.length} files`);

      // Clean up the uploaded source video (clips are now in R2)
      await fs.remove(videoPath).catch(() => {});

      res.json({
        success: true,
        data: {
          jobId: result.jobId,
          totalClips: result.totalClips,
          clips: clipsWithLinks,
          reactionGuide: result.reactionGuide,
          guide: {
            downloadUrl: result.guideDownloadUrl,
            r2Link: guideUpload?.success ? guideUpload.downloadUrl : null
          },
          source: 'upload'
        }
      });

    } else {
      // No R2 - return local download URLs
      // Clean up uploaded source video
      await fs.remove(videoPath).catch(() => {});

      res.json({
        success: true,
        data: {
          jobId: result.jobId,
          totalClips: result.totalClips,
          clips: result.clips,
          reactionGuide: result.reactionGuide,
          guideDownloadUrl: result.guideDownloadUrl,
          source: 'upload'
        }
      });
    }

  } catch (error) {
    console.error('Upload+split error:', error);
    
    // Clean up uploaded file on error
    if (req.file && req.file.path) {
      await fs.remove(req.file.path).catch(() => {});
    }
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
