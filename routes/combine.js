const express = require('express');
const router = express.Router();
const combineService = require('../services/combineService');
const splitService = require('../services/splitService');
const r2Service = require('../services/r2Service');
const path = require('path');
const fs = require('fs-extra');
const https = require('https');
const http = require('http');

/**
 * Download a file from URL to local path
 */
async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    
    protocol.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        // Handle redirect
        downloadFile(response.headers.location, destPath)
          .then(resolve)
          .catch(reject);
        return;
      }
      
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed: ${response.statusCode}`));
        return;
      }
      
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve(destPath);
      });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

/**
 * Ensure split clips are available locally
 * If not found locally, try to restore from R2
 */
async function ensureSplitClipsAvailable(splitJobId, clipCount) {
  const clipsDir = path.join(splitService.tempDir, splitJobId, 'clips');
  
  // Check if clips exist locally
  if (await fs.pathExists(clipsDir)) {
    const files = await fs.readdir(clipsDir);
    const clipFiles = files.filter(f => f.startsWith('clip_') && f.endsWith('.mp4'));
    if (clipFiles.length >= clipCount) {
      console.log(`Local clips found: ${clipFiles.length} clips`);
      return true;
    }
  }

  console.log('Local clips not found, attempting to restore from R2...');

  // Try to restore from R2
  if (!r2Service.isConfigured()) {
    throw new Error('Split job not found and R2 not configured for restore');
  }

  // Build R2 public URL base
  const r2PublicUrl = process.env.R2_PUBLIC_URL || 
    `https://pub-${process.env.R2_ACCOUNT_ID}.r2.dev`;

  // Try to download manifest from R2
  // IMPORTANT: Manifest is at {jobId}/manifest.json (same folder as clips)
  const manifestUrl = `${r2PublicUrl}/${splitJobId}/manifest.json`;
  console.log(`Downloading split job ${splitJobId} from R2...`);
  console.log(`Downloading manifest from R2: ${manifestUrl}`);

  await fs.ensureDir(clipsDir);
  const manifestPath = path.join(clipsDir, 'manifest.json');

  try {
    await downloadFile(manifestUrl, manifestPath);
  } catch (err) {
    console.error('Failed to download manifest:', err.message);
    throw new Error('Split job not found. Clips may have been cleaned up. Please re-split the video.');
  }

  const manifest = await fs.readJson(manifestPath);
  console.log(`Manifest loaded: ${manifest.totalClips} clips`);

  // Download each clip from R2
  for (const clip of manifest.clips) {
    const clipUrl = clip.r2Link || `${r2PublicUrl}/${splitJobId}/clip_${clip.number}.mp4`;
    const clipPath = path.join(clipsDir, `clip_${clip.number}.mp4`);
    
    console.log(`Downloading clip ${clip.number}: ${clipUrl}`);
    
    try {
      await downloadFile(clipUrl, clipPath);
      console.log(`✓ Clip ${clip.number} restored`);
    } catch (err) {
      console.error(`Failed to download clip ${clip.number}:`, err.message);
      throw new Error(`Failed to restore clip ${clip.number} from R2`);
    }
  }

  console.log('All clips restored from R2');
  return true;
}

/**
 * POST /api/combine - Combine clips with reactions
 */
router.post('/', async (req, res) => {
  try {
    const { originalClips, reactionClips, mode, pipPosition } = req.body;

    if (!originalClips || !Array.isArray(originalClips) || originalClips.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'originalClips array is required'
      });
    }

    console.log('\n' + '='.repeat(60));
    console.log('COMBINE REQUEST');
    console.log('='.repeat(60));
    console.log(`Mode: ${mode || 'sequential'}`);
    console.log(`PiP Position: ${pipPosition || 'top-right'}`);
    console.log(`Original clips: ${originalClips.length}`);
    console.log(`Reaction clips: ${reactionClips?.length || 0}`);

    const result = await combineService.combineClipsWithReactions(
      originalClips,
      reactionClips || [],
      null,
      { mode: mode || 'sequential', pipPosition: pipPosition || 'top-right' }
    );

    // Upload to R2 if configured
    if (r2Service.isConfigured()) {
      console.log('\nUploading final video to R2...');
      const r2Result = await r2Service.uploadFile(
        result.outputPath,
        `combined/${result.jobId}/final.mp4`,
        'video/mp4'
      );
      
      if (r2Result.success) {
        result.r2Link = r2Result.downloadUrl;
        console.log(`Uploaded to R2: ${r2Result.downloadUrl}`);
      }
    }

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
 * POST /api/combine/from-split/:splitJobId - Combine using existing split job
 */
router.post('/from-split/:splitJobId', async (req, res) => {
  try {
    const { splitJobId } = req.params;
    const { reactions, mode, pipPosition } = req.body;

    if (!reactions || !Array.isArray(reactions)) {
      return res.status(400).json({
        success: false,
        error: 'reactions array is required'
      });
    }

    console.log('\n' + '='.repeat(60));
    console.log('COMBINE FROM SPLIT');
    console.log('='.repeat(60));
    console.log(`Split Job ID: ${splitJobId}`);
    console.log(`Mode: ${mode || 'sequential'}`);
    console.log(`PiP Position: ${pipPosition || 'top-right'}`);
    console.log(`First reaction text: ${reactions[0]?.text?.substring(0, 80) || 'N/A'}...`);
    console.log(`R2 Storage: ${r2Service.isConfigured() ? 'ENABLED' : 'DISABLED'}`);

    // Count how many clips we expect
    const expectedClips = reactions.length;
    
    // Ensure clips are available (restore from R2 if needed)
    await ensureSplitClipsAvailable(splitJobId, expectedClips);

    // Build original clips paths
    const clipsDir = path.join(splitService.tempDir, splitJobId, 'clips');
    const files = await fs.readdir(clipsDir);
    const clipFiles = files
      .filter(f => f.startsWith('clip_') && f.endsWith('.mp4'))
      .sort((a, b) => {
        const numA = parseInt(a.match(/clip_(\d+)/)[1]);
        const numB = parseInt(b.match(/clip_(\d+)/)[1]);
        return numA - numB;
      });

    const originalClips = clipFiles.map(f => path.join(clipsDir, f));
    console.log(`Found ${originalClips.length} original clips`);

    // Build reaction clips array (some may be null if not uploaded)
    const reactionClips = reactions.map(r => r.path || null);
    console.log(`Reaction clips: ${reactionClips.filter(r => r).length} uploaded`);

    // Combine
    const result = await combineService.combineClipsWithReactions(
      originalClips,
      reactionClips,
      null,
      { mode: mode || 'sequential', pipPosition: pipPosition || 'top-right' }
    );

    // Upload to R2 if configured
    if (r2Service.isConfigured()) {
      console.log('\nUploading final video to R2...');
      const r2Result = await r2Service.uploadFile(
        result.outputPath,
        `combined/${result.jobId}/final.mp4`,
        'video/mp4'
      );
      
      if (r2Result.success) {
        result.r2Link = r2Result.downloadUrl;
        console.log(`Uploaded to R2: ${r2Result.downloadUrl}`);
      }
    }

    res.json({
      success: true,
      data: {
        ...result,
        splitJobId,
        storage: r2Service.isConfigured() ? 'r2' : 'local'
      }
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
 * GET /api/combine/:jobId/download - Download combined video
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
