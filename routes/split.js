const express = require('express');
const router = express.Router();
const splitService = require('../services/splitService');
const driveService = require('../services/driveService');
const path = require('path');
const fs = require('fs-extra');

/**
 * POST /api/split - Split video based on reaction timestamps
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
    console.log(`Google Drive enabled: ${driveService.isConfigured()}`);

    // Split the video
    const result = await splitService.splitVideoForReactions(videoPath, reactions);

    // If Google Drive is configured, upload clips
    if (driveService.isConfigured()) {
      console.log('\nUploading clips to Google Drive...');
      
      const clipFiles = [];
      
      // Build clip file list with verified paths
      for (const clip of result.clips) {
        const clipPath = splitService.getClipPath(result.jobId, clip.number);
        console.log(`Clip ${clip.number} path: ${clipPath}`);
        
        if (await fs.pathExists(clipPath)) {
          clipFiles.push({
            localPath: clipPath,
            fileName: `${result.jobId}_clip_${clip.number}.mp4`,
            mimeType: 'video/mp4'
          });
        } else {
          console.error(`Clip file not found: ${clipPath}`);
        }
      }

      // Upload guide too
      const guidePath = splitService.getGuidePath(result.jobId);
      console.log(`Guide path: ${guidePath}`);
      
      if (await fs.pathExists(guidePath)) {
        clipFiles.push({
          localPath: guidePath,
          fileName: `${result.jobId}_reactions_guide.txt`,
          mimeType: 'text/plain'
        });
      }

      console.log(`Files to upload: ${clipFiles.length}`);

      const uploadResults = await driveService.uploadFiles(clipFiles);

      // Map upload results back to clips
      const clipsWithDriveLinks = result.clips.map((clip, index) => {
        const uploadResult = uploadResults[index];
        return {
          ...clip,
          driveLink: uploadResult?.success ? uploadResult.directLink : null,
          driveViewLink: uploadResult?.success ? uploadResult.webViewLink : null
        };
      });

      // Get guide upload result
      const guideUpload = uploadResults.find(r => r.fileName.endsWith('.txt'));

      console.log(`\nUpload complete: ${uploadResults.filter(r => r.success).length}/${uploadResults.length} files`);

      res.json({
        success: true,
        data: {
          jobId: result.jobId,
          totalClips: result.totalClips,
          clips: clipsWithDriveLinks,
          reactionGuide: result.reactionGuide,
          guide: {
            downloadUrl: result.guideDownloadUrl,
            driveLink: guideUpload?.success ? guideUpload.directLink : null
          },
          storage: 'google_drive'
        }
      });
    } else {
      // No Google Drive - return local download URLs only
      console.log('\nGoogle Drive not configured, using local downloads');
      
      res.json({
        success: true,
        data: {
          jobId: result.jobId,
          totalClips: result.totalClips,
          clips: result.clips,
          reactionGuide: result.reactionGuide,
          guide: {
            downloadUrl: result.guideDownloadUrl
          },
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
    const clipPath = splitService.getClipPath(jobId, parseInt(clipNumber));

    if (!await fs.pathExists(clipPath)) {
      return res.status(404).json({
        success: false,
        error: 'Clip not found'
      });
    }

    const stats = await fs.stat(clipPath);
    const fileName = `clip_${clipNumber}.mp4`;

    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    const readStream = fs.createReadStream(clipPath);
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

    res.download(guidePath, 'reactions_guide.txt');

  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/split/:jobId/status - Check job status
 */
router.get('/:jobId/status', async (req, res) => {
  try {
    const { jobId } = req.params;
    const clipsDir = path.join(process.env.TEMP_DIR || '/app/temp', jobId, 'clips');

    if (!await fs.pathExists(clipsDir)) {
      return res.status(404).json({
        success: false,
        error: 'Job not found'
      });
    }

    const files = await fs.readdir(clipsDir);
    const clips = files.filter(f => f.startsWith('clip_') && f.endsWith('.mp4'));

    res.json({
      success: true,
      data: {
        jobId,
        clipCount: clips.length,
        clips: clips.sort()
      }
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
 * DELETE /api/split/:jobId - Cleanup job files
 */
router.delete('/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const jobDir = path.join(process.env.TEMP_DIR || '/app/temp', jobId);
    await fs.remove(jobDir);

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
