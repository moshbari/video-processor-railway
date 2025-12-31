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
    throw new Error(`Split job not found. Clips may have been cleaned up. Error: ${err.message}`);
  }
}

/**
 * POST /api/combine/from-split/:splitJobId
 */
router.post('/from-split/:splitJobId', upload.array('reactionClips', 20), async (req, res) => {
  try {
    const { splitJobId } = req.params;
    const mode = req.body.mode || 'sequential';
    const firstReactionText = req.body.firstReactionText || '';
    
    console.log('\n' + '='.repeat(60));
    console.log('COMBINE FROM SPLIT');
    console.log('='.repeat(60));
    console.log(`Split Job ID: ${splitJobId}`);
    console.log(`Mode: ${mode}`);
    console.log(`First reaction text: ${firstReactionText}`);
    console.log(`R2 Storage: ${r2Service.isConfigured() ? 'ENABLED' : 'DISABLED'}`);
    
    if (!['sequential', 'pip'].includes(mode)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid mode. Use "sequential" or "pip".'
      });
    }
    
    // Ensure clips are available (restore from R2 if needed)
    let splitDir;
    try {
      splitDir = await ensureSplitClipsAvailable(splitJobId);
    } catch (err) {
      return res.status(404).json({
        success: false,
        error: err.message
      });
    }

    // Get all clip files sorted by number
    const clipFiles = await fs.readdir(splitDir);
    const originalClipPaths = clipFiles
      .filter(f => f.startsWith('clip_') && f.endsWith('.mp4'))
      .sort((a, b) => {
        const numA = parseInt(a.match(/clip_(\d+)/)[1]);
        const numB = parseInt(b.match(/clip_(\d+)/)[1]);
        return numA - numB;
      })
      .map(f => path.join(splitDir, f));

    if (originalClipPaths.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No clips found in split job directory'
      });
    }

    console.log(`\nORIGINAL CLIPS (${originalClipPaths.length}):`);
    originalClipPaths.forEach((p, i) => {
      console.log(`  Index ${i} (Clip ${i + 1}): ${path.basename(p)}`);
    });

    const uploadedReactions = req.files || [];
    
    console.log(`\nUPLOADED REACTIONS (${uploadedReactions.length}):`);
    uploadedReactions.forEach((f, i) => {
      const clipNum = extractClipNumber(f.originalname);
      console.log(`  [${i}] originalname: "${f.originalname}" → extracted number: ${clipNum}`);
    });

    const extractedNumbers = uploadedReactions
      .map(f => extractClipNumber(f.originalname))
      .filter(n => n !== null);
    
    const minNumber = extractedNumbers.length > 0 ? Math.min(...extractedNumbers) : 1;
    const isZeroIndexed = minNumber === 0;
    
    console.log(`\nDETECTED INDEXING:`);
    console.log(`  Min number in filenames: ${minNumber}`);
    console.log(`  Indexing style: ${isZeroIndexed ? '0-indexed (0,1,2...)' : '1-indexed (1,2,3...)'}`);

    const reactionClipPaths = new Array(originalClipPaths.length).fill(null);

    console.log(`\nMAPPING REACTIONS TO CLIPS:`);
    
    uploadedReactions.forEach((file) => {
      const clipNum = extractClipNumber(file.originalname);
      
      if (clipNum !== null) {
        let arrayIndex;
        if (isZeroIndexed) {
          arrayIndex = clipNum;
        } else {
          arrayIndex = clipNum - 1;
        }
        
        if (arrayIndex >= 0 && arrayIndex < originalClipPaths.length) {
          reactionClipPaths[arrayIndex] = file.path;
          console.log(`  ✓ "${file.originalname}" (number ${clipNum}) → Clip ${arrayIndex + 1} (index ${arrayIndex})`);
        } else {
          console.log(`  ✗ "${file.originalname}" (number ${clipNum}) → OUT OF RANGE (index ${arrayIndex}, max: ${originalClipPaths.length - 1})`);
        }
      } else {
        console.log(`  ✗ "${file.originalname}" → NO NUMBER FOUND`);
      }
    });

    console.log(`\nFINAL MAPPING:`);
    console.log('-'.repeat(50));
    for (let i = 0; i < originalClipPaths.length; i++) {
      const origName = path.basename(originalClipPaths[i]);
      const reactName = reactionClipPaths[i] ? path.basename(reactionClipPaths[i]) : '(none)';
      console.log(`  Clip ${i + 1} [${origName}] ← Reaction: ${reactName}`);
    }
    console.log('-'.repeat(50));

    const result = await combineService.combineClipsWithReactions(
      originalClipPaths,
      reactionClipPaths,
      null,
      { mode }
    );

    // Upload to R2 with custom filename
    const { r2Link, fileName } = await uploadToR2(result, mode, firstReactionText);

    res.json({
      success: true,
      data: {
        ...result,
        r2Link,
        fileName,
        storage: r2Link ? 'r2' : 'local'
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
 * POST /api/combine - Direct combine with uploaded clips
 */
router.post('/', upload.fields([
  { name: 'originalClips', maxCount: 20 },
  { name: 'reactionClips', maxCount: 20 }
]), async (req, res) => {
  try {
    let originalClipPaths = [];
    let reactionClipPaths = [];
    
    const mode = req.body.mode || 'sequential';
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

    console.log(`Combining ${originalClipPaths.length} clips with ${reactionClipPaths.length} reactions (mode: ${mode})`);

    const result = await combineService.combineClipsWithReactions(
      originalClipPaths,
      reactionClipPaths,
      null,
      { mode }
    );

    // Upload to R2 with custom filename
    const { r2Link, fileName } = await uploadToR2(result, mode, firstReactionText);

    res.json({
      success: true,
      data: {
        ...result,
        r2Link,
        fileName,
        storage: r2Link ? 'r2' : 'local'
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
 * Generate nice error page HTML
 */
function getExpiredPageHtml() {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Video Link Expired</title>
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
    <h1>Video Link Expired</h1>
    <p class="message">
      The video you're trying to download is no longer available. 
      Our system automatically removes videos after a short period to manage storage.
    </p>
    <div class="info-box">
      <p>💡 Videos are automatically deleted after 7 days</p>
    </div>
    <a href="javascript:history.back()" class="btn">← Go Back & Create New Video</a>
    <p class="footer">Need help? Contact support or try creating your video again.</p>
  </div>
</body>
</html>
  `;
}

/**
 * GET /api/combine/:jobId/download - Fallback local download
 */
router.get('/:jobId/download', async (req, res) => {
  try {
    const { jobId } = req.params;
    const outputPath = combineService.getOutputPath(jobId);

    if (!await fs.pathExists(outputPath)) {
      res.status(404).send(getExpiredPageHtml());
      return;
    }

    const stats = await fs.stat(outputPath);
    
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="reaction_video_${jobId}.mp4"`);

    const readStream = fs.createReadStream(outputPath);
    readStream.pipe(res);

  } catch (error) {
    console.error('Download error:', error);
    res.status(500).send(getExpiredPageHtml());
  }
});

/**
 * DELETE /api/combine/:jobId
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
