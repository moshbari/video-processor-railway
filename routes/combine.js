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
  // Get first 3 letters from first reaction (capitalize first letter)
  let prefix = 'Vid';
  if (firstReactionText && firstReactionText.length >= 3) {
    prefix = firstReactionText.substring(0, 3);
    prefix = prefix.charAt(0).toUpperCase() + prefix.slice(1, 3).toLowerCase();
  }
  
  // Mode: PIP or SEQ
  const modePrefix = mode === 'pip' ? 'PIP' : 'SEQ';
  
  // Get current time in GMT+4
  const now = new Date();
  // Add 4 hours for GMT+4
  const gmt4 = new Date(now.getTime() + (4 * 60 * 60 * 1000));
  
  // Month abbreviation
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 
                  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[gmt4.getUTCMonth()];
  
  // Year (2 digits)
  const year = gmt4.getUTCFullYear().toString().slice(-2);
  
  // Time components
  let hours = gmt4.getUTCHours();
  const minutes = gmt4.getUTCMinutes().toString().padStart(2, '0');
  const seconds = gmt4.getUTCSeconds().toString().padStart(2, '0');
  
  // AM/PM
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12; // 0 should be 12
  const hoursStr = hours.toString().padStart(2, '0');
  
  // Final format: PIP-Wha-Dec25-083045PM.mp4
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
 * POST /api/combine/from-split/:splitJobId
 */
router.post('/from-split/:splitJobId', upload.array('reactionClips', 20), async (req, res) => {
  try {
    const { splitJobId } = req.params;
    const mode = req.body.mode || 'sequential';
    const firstReactionText = req.body.firstReactionText || ''; // Get from frontend
    
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
    
    const splitDir = path.join(process.env.TEMP_DIR || '/app/temp', splitJobId, 'clips');
    
    if (!await fs.pathExists(splitDir)) {
      return res.status(404).json({
        success: false,
        error: 'Split job not found. Clips may have been cleaned up.'
      });
    }

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
 * GET /api/combine/:jobId/download - Fallback local download
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
