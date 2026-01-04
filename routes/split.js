const express = require('express');
const router = express.Router();
const splitService = require('../services/splitService');
const r2Service = require('../services/r2Service');
const path = require('path');
const fs = require('fs-extra');

/**
 * POST /api/split - Split video based on reaction timestamps
 * Uploads clips to R2 for persistence across Railway restarts
 */
router.post('/', async (req, res) => {
  try {
    const { videoPath, reactions } = req.body;

    if (!videoPath) {
      return res.status(400).json({
        success: false,
        error: 'videoPath is required'
      });
    }

    if (!reactions || !Array.isArray(reactions) || reactions.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'reactions array is required'
      });
    }

    console.log(`\n${'='.repeat(50)}`);
    console.log('SPLIT VIDEO REQUEST');
    console.log('='.repeat(50));
    console.log(`Video: ${videoPath}`);
    console.log(`Reactions: ${reactions.length}`);
    console.log(`R2 Storage enabled: ${r2Service.isConfigured()}`);

    // Split the video
    const result = await splitService.splitVideoForReactions(videoPath, reactions);

    // If R2 is configured, upload clips for persistence
    if (r2Service.isConfigured()) {
      console.log('\nUploading clips to R2 for persistence...');
      
      const clipFiles = [];
      const clipR2Links = {};
      
      // Build clip file list with verified paths
      // IMPORTANT: Use consistent path format: {jobId}/clip_N.mp4
      for (const clip of result.clips) {
        const clipPath = splitService.getClipPath(result.jobId, clip.number);
        
        if (await fs.pathExists(clipPath)) {
          clipFiles.push({
            localPath: clipPath,
            fileName: `${result.jobId}/clip_${clip.number}.mp4`,  // Consistent path
            mimeType: 'video/mp4',
            clipNumber: clip.number
          });
        } else {
          console.error(`Clip file not found: ${clipPath}`);
        }
      }

      // Upload guide too
      const guidePath = splitService.getGuidePath(result.jobId);
      
      if (await fs.pathExists(guidePath)) {
        clipFiles.push({
          localPath: guidePath,
          fileName: `${result.jobId}/reactions_guide.txt`,  // Consistent path
          mimeType: 'text/plain'
        });
      }

      console.log(`Files to upload: ${clipFiles.length}`);

      const uploadResults = await r2Service.uploadFiles(clipFiles);

      // Build clip R2 links map
      for (const uploadResult of uploadResults) {
        if (uploadResult.success && uploadResult.fileName.includes('clip_')) {
          const match = uploadResult.fileName.match(/clip_(\d+)\.mp4/);
          if (match) {
            clipR2Links[match[1]] = uploadResult.downloadUrl;
          }
        }
      }

      // Create and upload manifest for later retrieval
      // IMPORTANT: Manifest goes to same path as clips: {jobId}/manifest.json
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

      // Save manifest locally first
      const manifestPath = path.join(splitService.tempDir, result.jobId, 'manifest.json');
      await fs.writeJson(manifestPath, manifest);
      
      // Upload manifest to R2 - same folder as clips
      await r2Service.uploadFile(manifestPath, `${result.jobId}/manifest.json`, 'application/json');
      console.log(`Manifest uploaded to: ${result.jobId}/manifest.json`);

      // Map upload results back to clips
      const clipsWithLinks = result.clips.map((clip) => {
        return {
          ...clip,
          r2Link: clipR2Links[clip.number] || null
        };
      });

      const guideUpload = uploadResults.find(r => r.fileName.endsWith('.txt'));

      console.log(`Upload complete: ${uploadResults.filter(r => r.success).length}/${uploadResults.length} files`);

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
          storage: 'r2'
        }
      });

    } else {
      // No R2 - return local download URLs
      res.json({
        success: true,
        data: {
          jobId: result.jobId,
          totalClips: result.totalClips,
          clips: result.clips,
          reactionGuide: result.reactionGuide,
          guideDownloadUrl: result.guideDownloadUrl,
          storage: 'local'
        }
      });
    }

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
        error: `Clip ${clipNumber} not found`
      });
    }

    const stats = await fs.stat(clipPath);
    
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="clip_${clipNumber}.mp4"`);

    const readStream = fs.createReadStream(clipPath);
    readStream.pipe(res);

  } catch (error) {
    console.error('Clip download error:', error);
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
        error: 'Reactions guide not found'
      });
    }

    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="reactions_guide_${jobId}.txt"`);

    const readStream = fs.createReadStream(guidePath);
    readStream.pipe(res);

  } catch (error) {
    console.error('Guide download error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/split/:jobId/download - Download all clips as individual files info
 */
router.get('/:jobId/download', async (req, res) => {
  try {
    const { jobId } = req.params;
    const clipsDir = path.join(splitService.tempDir, jobId, 'clips');

    if (!await fs.pathExists(clipsDir)) {
      return res.status(404).json({
        success: false,
        error: 'Split job not found'
      });
    }

    const files = await fs.readdir(clipsDir);
    const clips = files
      .filter(f => f.endsWith('.mp4'))
      .map(f => ({
        filename: f,
        downloadUrl: `/api/split/${jobId}/clip/${f.replace('clip_', '').replace('.mp4', '')}`
      }));

    res.json({
      success: true,
      jobId,
      clips,
      guideDownloadUrl: `/api/split/${jobId}/guide`
    });

  } catch (error) {
    console.error('Download info error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
