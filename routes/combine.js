const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const combineService = require('../services/combineService');
const r2Service = require('../services/r2Service');

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
    fileSize: 100 * 1024 * 1024,
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
 * Generate filename in format: MODE-XXX-MonYY-HHMMSSAM.mp4
 * Example: PIP-Wha-Dec25-083045PM.mp4
 */
function generateFileName(mode, firstReactionText) {
  let prefix = 'Vid';
  if (firstReactionText && firstReactionText.length >= 3) {
    prefix = firstReactionText.substring(0, 3);
    prefix = prefix.charAt(0).toUpperCase() + prefix.slice(1, 3).toLowerCase();
  }
  
  const modePrefix = mode === 'pip' ? 'PIP' : 'SEQ';
  
  const now = new Date();
  const gmt4 = new Date(now.getTime() + (4 * 60 * 60 * 1000));
  
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[gmt4.getUTCMonth()];
  const year = gmt4.getUTCFullYear().toString().slice(-2);
  
  let hours = gmt4.getUTCHours();
  const minutes = gmt4.getUTCMinutes().toString().padStart(2, '0');
  const seconds = gmt4.getUTCSeconds().toString().padStart(2, '0');
  
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12;
  const hoursStr = hours.toString().padStart(2, '0');
  
  return `${modePrefix}-${prefix}-${month}${year}-${hoursStr}${minutes}${seconds}${ampm}.mp4`;
}

/**
 * Extract clip number from filename
 */
function extractClipNumber(filename) {
  const match = filename.match(/(\d+)/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Upload result to R2 with custom filename
 */
async function uploadToR2(result, mode, firstReactionText) {
  if (!r2Service.isConfigured()) {
    return { r2Link: null, fileName: null };
  }

  const fileName = generateFileName(mode, firstReactionText);
  console.log(`\nGenerated filename: ${fileName}`);
  console.log('Uploading combined video to R2...');
  
  try {
    const uploadResult = await r2Service.uploadFile(
      result.outputPath,
      `combined/${fileName}`,
      'video/mp4'
    );
    console.log(`✓ Uploaded to R2: ${uploadResult.downloadUrl}`);
    return { r2Link: uploadResult.downloadUrl, fileName };
  } catch (error) {
    console.error('R2 upload failed:', error.message);
    return { r2Link: null, fileName: null };
  }
}

/**
 * Ensure split clips are available - restore from R2 if needed
 */
async function ensureSplitClipsAvailable(splitJobId) {
  const tempDir = process.env.TEMP_DIR || '/app/temp';
  const splitDir = path.join(tempDir, splitJobId, 'clips');
  
  // Check if clips exist locally
  if (await fs.pathExists(splitDir)) {
    const files = await fs.readdir(splitDir);
    const clips = files.filter(f => f.startsWith('clip_') && f.endsWith('.mp4'));
    if (clips.length > 0) {
      console.log(`Found ${clips.length} local clips`);
      return splitDir;
    }
  }
  
  // Clips not found locally - try to restore from R2
  console.log('Local clips not found, attempting to restore from R2...');
  
  if (!r2Service.isConfigured()) {
    throw new Error('Split job not found locally and R2 is not configured');
  }
  
  const jobDir = path.join(tempDir, splitJobId);
  await fs.ensureDir(jobDir);
  
  try {
    await r2Service.downloadSplitJob(splitJobId, jobDir);
    return path.join(jobDir, 'clips');
  } catch (err) {
    throw new Error(`Split job not found. Clips may have been cleaned up. Please re-split the video.`);
  }
}

/**
 * Validate pipPosition parameter
 */
function validatePipPosition(position) {
  const validPositions = ['top-right', 'bottom-right', 'bottom-left', 'top-left', 'random'];
  if (!position) return 'top-right'; // default
  if (!validPositions.includes(position)) {
    console.warn(`Invalid pipPosition "${position}", defaulting to top-right`);
    return 'top-right';
  }
  return position;
}

/**
 * POST /api/combine/from-split/:splitJobId
 * 
 * Body parameters:
 * - reactionClips[]: Array of reaction video files
 * - mode: 'sequential' or 'pip' (default: 'sequential')
 * - pipPosition: 'top-right', 'bottom-right', 'bottom-left', 'top-left', 'random' (default: 'top-right')
 * - firstReactionText: Text for filename generation
 * - reactionIndices: JSON array of indices mapping reactions to clips
 */
router.post('/from-split/:splitJobId', upload.array('reactionClips', 20), async (req, res) => {
  try {
    const { splitJobId } = req.params;
    const mode = req.body.mode || 'sequential';
    const pipPosition = validatePipPosition(req.body.pipPosition);
    const firstReactionText = req.body.firstReactionText || '';
    
    console.log('\n' + '='.repeat(60));
    console.log('COMBINE FROM SPLIT');
    console.log('='.repeat(60));
    console.log(`Split Job ID: ${splitJobId}`);
    console.log(`Mode: ${mode}`);
    if (mode === 'pip') {
      console.log(`PiP Position: ${pipPosition}`);
    }
    console.log(`First reaction text: ${firstReactionText}`);
    console.log(`R2 Storage: ${r2Service.isConfigured() ? 'ENABLED' : 'DISABLED'}`);
    
    if (!['sequential', 'pip'].includes(mode)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid mode. Use "sequential" or "pip".'
      });
    }
    
    // Get original clips from split job directory (restore from R2 if needed)
    const splitDir = await ensureSplitClipsAvailable(splitJobId);
    
    // Read and sort original clips
    const files = await fs.readdir(splitDir);
    const originalClipFiles = files
      .filter(f => f.startsWith('clip_') && f.endsWith('.mp4'))
      .sort((a, b) => {
        const numA = extractClipNumber(a) || 0;
        const numB = extractClipNumber(b) || 0;
        return numA - numB;
      });
    
    if (originalClipFiles.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No clips found in split job'
      });
    }
    
    const originalClipPaths = originalClipFiles.map(f => path.join(splitDir, f));
    console.log(`Found ${originalClipPaths.length} original clips`);
    
    // Process reaction clips - map them to the correct original clips
    const reactionClipPaths = new Array(originalClipPaths.length).fill(null);
    
    if (req.files && req.files.length > 0) {
      // Check if reactionIndices was provided
      let indices = null;
      if (req.body.reactionIndices) {
        try {
          indices = JSON.parse(req.body.reactionIndices);
        } catch (e) {
          console.warn('Failed to parse reactionIndices, using sequential mapping');
        }
      }
      
      if (indices && Array.isArray(indices)) {
        // Map reactions using provided indices
        req.files.forEach((file, i) => {
          const clipIndex = indices[i];
          if (typeof clipIndex === 'number' && clipIndex >= 0 && clipIndex < originalClipPaths.length) {
            reactionClipPaths[clipIndex] = file.path;
            console.log(`Mapped reaction ${i} to clip ${clipIndex}`);
          }
        });
      } else {
        // Sequential mapping (reaction 0 -> clip 0, reaction 1 -> clip 1, etc.)
        req.files.forEach((file, i) => {
          if (i < originalClipPaths.length) {
            reactionClipPaths[i] = file.path;
          }
        });
      }
    }
    
    const reactionCount = reactionClipPaths.filter(p => p !== null).length;
    console.log(`Mapped ${reactionCount} reactions to clips`);

    // Combine clips with reactions
    const result = await combineService.combineClipsWithReactions(
      originalClipPaths,
      reactionClipPaths,
      null,
      { mode, pipPosition }
    );

    // Upload to R2
    const { r2Link, fileName } = await uploadToR2(result, mode, firstReactionText);

    res.json({
      success: true,
      data: {
        ...result,
        pipPosition: mode === 'pip' ? pipPosition : null,
        r2Link,
        fileName
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
 * POST /api/combine - Combine with direct file uploads
 */
router.post('/', upload.fields([
  { name: 'originalClips', maxCount: 20 },
  { name: 'reactionClips', maxCount: 20 }
]), async (req, res) => {
  try {
    let originalClipPaths = [];
    let reactionClipPaths = [];
    
    const mode = req.body.mode || 'sequential';
    const pipPosition = validatePipPosition(req.body.pipPosition);
    const firstReactionText = req.body.firstReactionText || '';
    
    if (!['sequential', 'pip'].includes(mode)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid mode. Use "sequential" or "pip".'
      });
    }

    if (req.files && req.files.originalClips) {
      originalClipPaths = req.files.originalClips.map(f => f.path);
      reactionClipPaths = req.files.reactionClips 
        ? req.files.reactionClips.map(f => f.path)
        : [];
    } 
    else if (req.body.originalClipPaths) {
      originalClipPaths = JSON.parse(req.body.originalClipPaths);
      reactionClipPaths = req.body.reactionClipPaths 
        ? JSON.parse(req.body.reactionClipPaths)
        : [];
    }
    else {
      return res.status(400).json({
        success: false,
        error: 'No clips provided.'
      });
    }

    if (originalClipPaths.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'At least one original clip is required'
      });
    }

    console.log(`Combining ${originalClipPaths.length} clips with ${reactionClipPaths.length} reactions (mode: ${mode}, pipPosition: ${pipPosition})`);

    const result = await combineService.combineClipsWithReactions(
      originalClipPaths,
      reactionClipPaths,
      null,
      { mode, pipPosition }
    );

    // Upload to R2
    const { r2Link, fileName } = await uploadToR2(result, mode, firstReactionText);

    res.json({
      success: true,
      data: {
        ...result,
        pipPosition: mode === 'pip' ? pipPosition : null,
        r2Link,
        fileName
      }
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
 * GET /api/combine/:jobId/download - Download the combined video
 */
router.get('/:jobId/download', async (req, res) => {
  try {
    const { jobId } = req.params;
    const outputPath = combineService.getOutputPath(jobId);

    if (!await fs.pathExists(outputPath)) {
      // Return a nice HTML error page
      return res.status(404).send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>File Not Found</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); }
            .container { text-align: center; background: white; padding: 40px 60px; border-radius: 16px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-width: 500px; }
            h1 { color: #e74c3c; margin-bottom: 10px; }
            p { color: #666; line-height: 1.6; }
            .icon { font-size: 64px; margin-bottom: 20px; }
            a { display: inline-block; margin-top: 20px; padding: 12px 30px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; text-decoration: none; border-radius: 8px; font-weight: 600; transition: transform 0.2s; }
            a:hover { transform: translateY(-2px); }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="icon">📁</div>
            <h1>File Not Found</h1>
            <p>This video has been automatically deleted after 24 hours, or the job ID is invalid.</p>
            <p>Please go back to the video editor and create a new render.</p>
            <a href="https://rantsquad.99dfy.com/video-editor">← Back to Video Editor</a>
          </div>
        </body>
        </html>
      `);
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
