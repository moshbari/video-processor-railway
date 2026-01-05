const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

// Configure multer for video uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadsDir = path.join(process.env.TEMP_DIR || '/app/temp', 'uploads');
    await fs.ensureDir(uploadsDir);
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueId = uuidv4();
    const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
    cb(null, `${uniqueId}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska', 'video/mpeg'];
    const allowedExts = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.mpeg'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedMimes.includes(file.mimetype) || allowedExts.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type: ${file.mimetype}`), false);
    }
  }
});

/**
 * POST /api/upload
 */
router.post('/', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No video file provided' });
    }
    const videoPath = req.file.path;
    console.log(`\n${'='.repeat(50)}`);
    console.log('VIDEO UPLOAD');
    console.log(`Saved to: ${videoPath}`);
    console.log(`Size: ${(req.file.size / (1024 * 1024)).toFixed(2)} MB`);
    console.log('='.repeat(50));
    res.json({
      success: true,
      videoPath,
      originalName: req.file.originalname,
      fileSize: req.file.size
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/upload/with-reactions
 */
router.post('/with-reactions', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No video file provided' });
    }

    let reactions;
    try {
      reactions = JSON.parse(req.body.reactions || '[]');
    } catch (e) {
      return res.status(400).json({ success: false, error: 'Invalid reactions JSON' });
    }

    if (!reactions || !Array.isArray(reactions) || reactions.length === 0) {
      return res.status(400).json({ success: false, error: 'Reactions array is required' });
    }

    const videoPath = req.file.path;

    console.log(`\n${'='.repeat(50)}`);
    console.log('VIDEO UPLOAD + SPLIT');
    console.log('='.repeat(50));
    console.log(`Video path: ${videoPath}`);
    console.log(`Size: ${(req.file.size / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`Reactions count: ${reactions.length}`);
    console.log('='.repeat(50));

    const splitService = require('../services/splitService');
    const r2Service = require('../services/r2Service');

    // Split the video
    const result = await splitService.splitVideoForReactions(videoPath, reactions);

    console.log(`Split complete. Job ID: ${result.jobId}`);
    console.log(`Total clips: ${result.totalClips}`);

    // Upload to R2 if configured
    if (r2Service.isConfigured()) {
      console.log('\nUploading clips to R2...');
      
      const clipFiles = [];
      const clipR2Links = {};
      
      for (const clip of result.clips) {
        const clipPath = splitService.getClipPath(result.jobId, clip.number);
        if (await fs.pathExists(clipPath)) {
          clipFiles.push({
            localPath: clipPath,
            fileName: `${result.jobId}/clip_${clip.number}.mp4`,
            mimeType: 'video/mp4',
            clipNumber: clip.number
          });
        }
      }

      // Upload guide
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

      // Build R2 links map
      for (const uploadResult of uploadResults) {
        if (uploadResult.success && uploadResult.fileName.includes('clip_')) {
          const match = uploadResult.fileName.match(/clip_(\d+)\.mp4/);
          if (match) {
            clipR2Links[match[1]] = uploadResult.downloadUrl;
          }
        }
      }

      // *** CREATE AND UPLOAD MANIFEST ***
      const manifest = {
        jobId: result.jobId,
        totalClips: result.totalClips,
        clips: result.clips.map(clip => ({
          number: clip.number,
          filename: `clip_${clip.number}.mp4`,
          r2Link: clipR2Links[clip.number] || null
        })),
        reactionGuide: result.reactionGuide,
        createdAt: new Date().toISOString()
      };

      const manifestPath = path.join(splitService.tempDir, result.jobId, 'manifest.json');
      await fs.ensureDir(path.dirname(manifestPath));
      await fs.writeJson(manifestPath, manifest);
      await r2Service.uploadFile(manifestPath, `${result.jobId}/manifest.json`, 'application/json');
      console.log(`✓ Manifest uploaded to: ${result.jobId}/manifest.json`);

      // Build response
      const clipsWithLinks = result.clips.map(clip => ({
        ...clip,
        r2Link: clipR2Links[clip.number] || null
      }));

      const guideUpload = uploadResults.find(r => r.fileName.endsWith('.txt'));
      console.log(`Upload complete: ${uploadResults.filter(r => r.success).length}/${uploadResults.length} files`);

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
          storage: 'r2',
          source: 'upload'
        }
      });

    } else {
      // No R2
      await fs.remove(videoPath).catch(() => {});
      res.json({
        success: true,
        data: {
          jobId: result.jobId,
          totalClips: result.totalClips,
          clips: result.clips,
          reactionGuide: result.reactionGuide,
          guideDownloadUrl: result.guideDownloadUrl,
          storage: 'local',
          source: 'upload'
        }
      });
    }

  } catch (error) {
    console.error('Upload+split error:', error);
    if (req.file && req.file.path) {
      await fs.remove(req.file.path).catch(() => {});
    }
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
