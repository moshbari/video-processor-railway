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
      for (const clip of result.clips) {
        const clipPath = splitService.getClipPath(result.jobId, clip.number);
        
        if (await fs.pathExists(clipPath)) {
          clipFiles.push({
            localPath: clipPath,
            fileName: `splits/${result.jobId}/clip_${clip.number}.mp4`,
            mimeType: 'video/mp4',
            clipNumber: clip.number
          });
        } else {
          console.error(`Clip file not found: ${clipPath}`);
        }
      }

      // Upload the tail clip too (original video after the last reaction).
      // It is NOT part of result.clips, so it must be added explicitly. The
      // render service finds it on disk/R2 by filename and appends it.
      if (result.tailClip) {
        const tailPath = splitService.getClipPath(result.jobId, result.tailClip.number);
        if (await fs.pathExists(tailPath)) {
          clipFiles.push({
            localPath: tailPath,
            fileName: `splits/${result.jobId}/clip_${result.tailClip.number}.mp4`,
            mimeType: 'video/mp4',
            clipNumber: result.tailClip.number
          });
        } else {
          console.error(`Tail clip file not found: ${tailPath}`);
        }
      }

      // Upload guide too
      const guidePath = splitService.getGuidePath(result.jobId);
      
      if (await fs.pathExists(guidePath)) {
        clipFiles.push({
          localPath: guidePath,
          fileName: `splits/${result.jobId}/reactions_guide.txt`,
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

      // Create and upload manifest for later retrieval.
      // Include the tail clip so the render service restores it from R2 and
      // appends the original footage after the last reaction.
      const manifestClips = result.clips.map(clip => ({
        number: clip.number,
        r2Link: clipR2Links[clip.number] || null
      }));
      if (result.tailClip) {
        manifestClips.push({
          number: result.tailClip.number,
          r2Link: clipR2Links[result.tailClip.number] || null
        });
      }
      const manifest = {
        jobId: result.jobId,
        totalClips: manifestClips.length,
        clips: manifestClips,
        createdAt: new Date().toISOString()
      };

      // Save manifest to R2
      const manifestPath = path.join(splitService.tempDir, result.jobId, 'manifest.json');
      await fs.writeJson(manifestPath, manifest);
      await r2Service.uploadFile(manifestPath, `splits/${result.jobId}/manifest.json`, 'application/json');

      // Map upload results back to clips
      const clipsWithLinks = result.clips.map((clip, index) => {
        const uploadResult = uploadResults[index];
        return {
          ...clip,
          r2Link: uploadResult?.success ? uploadResult.downloadUrl : null
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
      // No R2 - return local download URLs only
      console.log('\nR2 not configured, using local downloads');
      
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
 * Generate nice error page HTML for expired clips
 */
function getExpiredPageHtml(type = 'clip') {
  const title = type === 'clip' ? 'Clip Link Expired' : 'File Link Expired';
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(10px);
      border-radius: 20px;
      padding: 50px 40px;
      max-width: 500px;
      text-align: center;
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 25px 50px rgba(0, 0, 0, 0.3);
    }
    .icon {
      font-size: 80px;
      margin-bottom: 20px;
    }
    h1 {
      color: #fff;
      font-size: 28px;
      margin-bottom: 15px;
      font-weight: 600;
    }
    .message {
      color: rgba(255, 255, 255, 0.7);
      font-size: 16px;
      line-height: 1.6;
      margin-bottom: 30px;
    }
    .info-box {
      background: rgba(0, 200, 150, 0.1);
      border: 1px solid rgba(0, 200, 150, 0.3);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 30px;
    }
    .info-box p {
      color: rgba(0, 200, 150, 0.9);
      font-size: 14px;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
    }
    .btn {
      display: inline-block;
      background: linear-gradient(135deg, #00c896 0%, #00a67d 100%);
      color: #fff;
      text-decoration: none;
      padding: 15px 40px;
      border-radius: 30px;
      font-size: 16px;
      font-weight: 600;
      transition: transform 0.2s, box-shadow 0.2s;
      box-shadow: 0 10px 30px rgba(0, 200, 150, 0.3);
    }
    .btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 15px 40px rgba(0, 200, 150, 0.4);
    }
    .footer {
      margin-top: 30px;
      color: rgba(255, 255, 255, 0.4);
      font-size: 13px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">⏰</div>
    <h1>${title}</h1>
    <p class="message">
      The file you're trying to download is no longer available. 
      Our system automatically removes files after a short period to manage storage.
    </p>
    <div class="info-box">
      <p>💡 Files are automatically deleted to manage storage</p>
    </div>
    <a href="https://rantsquad.99dfy.com/video-editor" class="btn">← Go Back & Try Again</a>
    <p class="footer">Your file link has expired. Please split your video again.</p>
  </div>
</body>
</html>
  `;
}

/**
 * GET /api/split/:jobId/clip/:clipNumber - Download individual clip (fallback)
 */
router.get('/:jobId/clip/:clipNumber', async (req, res) => {
  try {
    const { jobId, clipNumber } = req.params;
    const clipPath = splitService.getClipPath(jobId, parseInt(clipNumber));

    if (!await fs.pathExists(clipPath)) {
      res.status(404).send(getExpiredPageHtml('clip'));
      return;
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
    res.status(500).send(getExpiredPageHtml('clip'));
  }
});

/**
 * GET /api/split/:jobId/guide - Download reactions guide (fallback)
 */
router.get('/:jobId/guide', async (req, res) => {
  try {
    const { jobId } = req.params;
    const guidePath = splitService.getGuidePath(jobId);

    if (!await fs.pathExists(guidePath)) {
      res.status(404).send(getExpiredPageHtml('guide'));
      return;
    }

    res.download(guidePath, 'reactions_guide.txt');

  } catch (error) {
    console.error('Download error:', error);
    res.status(500).send(getExpiredPageHtml('guide'));
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
