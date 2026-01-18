const ffmpeg = require('fluent-ffmpeg');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

const TEMP_DIR = '/app/temp';

// ============================================
// HELPER FUNCTIONS
// ============================================

async function ensureTempDir() {
  await fs.ensureDir(TEMP_DIR);
}

function updateProgress(renderProgress, jobId, status, progress) {
  if (renderProgress && jobId) {
    renderProgress[jobId] = { status, progress: Math.round(progress) };
    console.log(`[Progress] Job ${jobId}: ${status} - ${Math.round(progress)}%`);
  }
}

async function getVideoDimensions(videoPath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        console.error('Probe error:', err.message);
        resolve({ width: 1080, height: 1920 });
        return;
      }
      const videoStream = metadata.streams.find(s => s.codec_type === 'video');
      if (videoStream) {
        resolve({
          width: videoStream.width || 1080,
          height: videoStream.height || 1920
        });
      } else {
        resolve({ width: 1080, height: 1920 });
      }
    });
  });
}

async function getVideoDuration(videoPath) {
  return new Promise((resolve) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        console.error('Probe error:', err.message);
        resolve(0);
        return;
      }
      const duration = metadata.format?.duration || 0;
      resolve(parseFloat(duration));
    });
  });
}

function getPipCoordinates(targetWidth, targetHeight, pipPosition) {
  const pipWidth = Math.floor(targetWidth * 0.25);
  const pipHeight = Math.floor(targetHeight * 0.25);
  const padding = 20;

  const positions = {
    'top-right': { x: targetWidth - pipWidth - padding, y: padding },
    'top-left': { x: padding, y: padding },
    'bottom-right': { x: targetWidth - pipWidth - padding, y: targetHeight - pipHeight - padding },
    'bottom-left': { x: padding, y: targetHeight - pipHeight - padding }
  };

  if (pipPosition === 'random') {
    const keys = Object.keys(positions);
    const randomKey = keys[Math.floor(Math.random() * keys.length)];
    console.log(`  Random position selected: ${randomKey}`);
    return positions[randomKey];
  }

  return positions[pipPosition] || positions['top-right'];
}

// ============================================
// KEY FIX: Standardize reaction clips to 30fps
// Handles Variable Frame Rate (VFR) videos from phones!
// ============================================
async function standardizeClipTo30fps(inputPath, outputPath) {
  return new Promise(async (resolve, reject) => {
    console.log(`  Standardizing VFR video: ${path.basename(inputPath)}`);
    
    // First, analyze the input video
    try {
      const inputInfo = await getVideoInfo(inputPath);
      console.log(`  INPUT: fps=${inputInfo.fps}, duration=${inputInfo.duration}s, frames=${inputInfo.frames}`);
    } catch (e) {
      console.log(`  INPUT: Could not analyze (${e.message})`);
    }
    
    // Simple approach: just re-encode at 30fps with standard settings
    const cmd = `ffmpeg -y -i "${inputPath}" -c:v libx264 -preset fast -crf 23 -r 30 -pix_fmt yuv420p -c:a aac -ar 44100 -b:a 128k -movflags +faststart "${outputPath}"`;
    
    console.log(`  Running simple re-encode at 30fps...`);
    
    exec(cmd, async (error, stdout, stderr) => {
      if (error) {
        console.error(`  ✗ Standardize failed:`, error.message);
        reject(error);
      } else {
        // Analyze output
        try {
          const outputInfo = await getVideoInfo(outputPath);
          console.log(`  OUTPUT: fps=${outputInfo.fps}, duration=${outputInfo.duration}s, frames=${outputInfo.frames}`);
        } catch (e) {
          console.log(`  OUTPUT: Could not analyze (${e.message})`);
        }
        console.log(`  ✓ Standardized to 30fps: ${path.basename(outputPath)}`);
        resolve(outputPath);
      }
    });
  });
}

// Get video info using ffprobe
async function getVideoInfo(videoPath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate,duration,nb_frames -of json "${videoPath}"`;
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        const data = JSON.parse(stdout);
        const stream = data.streams[0];
        const fpsRaw = stream.r_frame_rate || '30/1';
        const fpsParts = fpsRaw.split('/');
        const fps = (parseInt(fpsParts[0]) / parseInt(fpsParts[1] || 1)).toFixed(2);
        resolve({
          fps: fps,
          duration: stream.duration || 'unknown',
          frames: stream.nb_frames || 'unknown'
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ============================================
// THREE-PASS PiP CREATION (Reliable method)
// ============================================
async function extractLastFrame(videoPath, outputPath) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -y -sseof -1 -i "${videoPath}" -vframes 1 -q:v 2 "${outputPath}"`;
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error('Extract frame error:', stderr);
        reject(error);
      } else {
        console.log('  ✓ Last frame extracted');
        resolve(outputPath);
      }
    });
  });
}

async function createBackgroundVideo(framePath, outputPath, duration, width, height, audioSource) {
  return new Promise((resolve, reject) => {
    const cmd = `ffmpeg -y -loop 1 -i "${framePath}" -i "${audioSource}" -t ${duration} -vf "scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,fps=30" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -shortest "${outputPath}"`;
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error('Background video error:', stderr);
        reject(error);
      } else {
        console.log(`  ✓ Background video created (${duration}s)`);
        resolve(outputPath);
      }
    });
  });
}

async function overlayPip(bgPath, pipPath, outputPath, coords, targetWidth, targetHeight) {
  return new Promise((resolve, reject) => {
    const pipWidth = Math.floor(targetWidth * 0.25);
    const pipHeight = Math.floor(targetHeight * 0.25);

    const filterComplex = `[1:v]scale=${pipWidth}:${pipHeight}[pip];[0:v][pip]overlay=${coords.x}:${coords.y}[outv]`;
    const cmd = `ffmpeg -y -i "${bgPath}" -i "${pipPath}" -filter_complex "${filterComplex}" -map "[outv]" -map 0:a -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k "${outputPath}"`;

    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error('Overlay error:', stderr);
        reject(error);
      } else {
        console.log('  ✓ PiP overlay complete');
        resolve(outputPath);
      }
    });
  });
}

async function createPipSegment(originalPath, reactionPath, outputPath, targetWidth, targetHeight, pipPosition) {
  console.log('\n=== THREE-PASS PiP Creation ===');
  const workDir = path.dirname(outputPath);

  const originalDuration = await getVideoDuration(originalPath);
  const reactionDuration = await getVideoDuration(reactionPath);
  console.log(`Original duration: ${originalDuration}s`);
  console.log(`Reaction duration: ${reactionDuration}s`);

  if (!originalDuration || originalDuration <= 0 || !reactionDuration || reactionDuration <= 0) {
    console.log('WARNING: Invalid duration detected, using fallback...');
    await fs.copy(reactionPath, outputPath);
    return outputPath;
  }

  // Pass 1: Extract last frame from reaction
  console.log('--- Pass 1: Extract frame ---');
  const lastFramePath = path.join(workDir, `last_frame_${Date.now()}.jpg`);
  await extractLastFrame(reactionPath, lastFramePath);

  // Pass 2: Create background video
  console.log('--- Pass 2: Create background video ---');
  const bgPath = path.join(workDir, `bg_${Date.now()}.mp4`);
  const bgDuration = originalDuration + 0.5;
  await createBackgroundVideo(lastFramePath, bgPath, bgDuration, targetWidth, targetHeight, reactionPath);

  // Pass 3: Overlay original on background
  console.log('--- Pass 3: Overlay PiP ---');
  const coords = getPipCoordinates(targetWidth, targetHeight, pipPosition);
  await overlayPip(bgPath, originalPath, outputPath, coords, targetWidth, targetHeight);

  // Cleanup temp files
  await fs.remove(lastFramePath).catch(() => {});
  await fs.remove(bgPath).catch(() => {});

  console.log('=== THREE-PASS Complete ===\n');
  const stats = await fs.stat(outputPath);
  console.log(`✓ Pass 3 complete - Final video: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

  return outputPath;
}

// ============================================
// CONCATENATION WITH PROPER FRAME RATE HANDLING
// ============================================
async function concatenateClips(concatFilePath, outputPath) {
  return new Promise((resolve, reject) => {
    console.log(`  Running concatenation with fps normalization...`);
    
    // Simple approach: re-encode with fixed frame rate
    // Don't use complexFilter with concat demuxer - it doesn't work!
    ffmpeg()
      .input(concatFilePath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions([
        '-r', '30',              // Force 30fps output
        '-vsync', 'cfr',         // Constant frame rate - KEY FIX!
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-c:a', 'aac',
        '-ar', '44100',
        '-b:a', '128k',
        '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',  // Audio normalization
        '-movflags', '+faststart',
        '-y'
      ])
      .on('start', cmd => console.log(`  Concat started...`))
      .on('progress', p => {
        if (p.timemark) {
          console.log(`  Concat progress: ${p.timemark}`);
        }
      })
      .on('end', () => {
        console.log('  ✓ Concatenation complete');
        resolve(outputPath);
      })
      .on('error', (err) => {
        console.error('Concat error:', err.message);
        reject(err);
      })
      .save(outputPath);
  });
}

// ============================================
// MAIN FUNCTION: combineClipsWithReactions
// This is what combine.js route calls!
// ============================================
async function combineClipsWithReactions(originalClipPaths, reactionClipPaths, workDir, options = {}) {
  const { mode = 'sequential', pipPosition = 'top-right', renderProgress, jobId } = options;
  
  await ensureTempDir();
  
  // Create work directory if not provided
  if (!workDir) {
    workDir = path.join(TEMP_DIR, uuidv4());
  }
  await fs.ensureDir(workDir);

  console.log(`\n========================================`);
  console.log(`COMBINE CLIPS WITH REACTIONS`);
  console.log(`========================================`);
  console.log(`Mode: ${mode}`);
  console.log(`PiP Position: ${pipPosition}`);
  console.log(`Original clips: ${originalClipPaths.length}`);
  console.log(`Reaction clips: ${reactionClipPaths.filter(r => r).length}`);
  console.log(`Work dir: ${workDir}`);

  try {
    updateProgress(renderProgress, jobId, 'processing', 10);

    const processedClips = [];
    const totalPairs = originalClipPaths.length;
    let completedPairs = 0;

    // Get target dimensions from first original clip
    const dimensions = await getVideoDimensions(originalClipPaths[0]);
    const targetWidth = dimensions.width || 1080;
    const targetHeight = dimensions.height || 1920;
    console.log(`\nTarget dimensions: ${targetWidth}x${targetHeight}`);

    // Process each pair
    for (let i = 0; i < originalClipPaths.length; i++) {
      const originalPath = originalClipPaths[i];
      const reactionPath = reactionClipPaths[i];

      console.log(`\n--- Processing pair ${i + 1}/${totalPairs} ---`);
      console.log(`  Original: ${path.basename(originalPath)}`);
      console.log(`  Reaction: ${reactionPath ? path.basename(reactionPath) : 'NONE'}`);

      // Add original clip (already 30fps from split)
      processedClips.push(originalPath);

      if (reactionPath) {
        if (mode === 'pip') {
          // PiP mode: create overlay segment using THREE-PASS method
          const pipOutputPath = path.join(workDir, `pip_${i}.mp4`);
          await createPipSegment(originalPath, reactionPath, pipOutputPath, targetWidth, targetHeight, pipPosition);
          processedClips.push(pipOutputPath);
        } else {
          // SEQUENTIAL MODE: Standardize reaction clip to 30fps BEFORE concatenation
          // This is the KEY FIX for the fast-forward issue!
          const standardizedPath = path.join(workDir, `std_reaction_${i}.mp4`);
          await standardizeClipTo30fps(reactionPath, standardizedPath);
          processedClips.push(standardizedPath);
        }
      }

      completedPairs++;
      const progressPercent = 10 + (completedPairs / totalPairs) * 70;
      updateProgress(renderProgress, jobId, 'rendering', progressPercent);
    }

    // Concatenate all clips
    console.log(`\n--- Final Concatenation ---`);
    console.log(`Total clips to concatenate: ${processedClips.length}`);
    updateProgress(renderProgress, jobId, 'concatenating', 85);

    const concatFilePath = path.join(workDir, 'concat_list.txt');
    const concatContent = processedClips.map(p => `file '${p}'`).join('\n');
    await fs.writeFile(concatFilePath, concatContent);

    const outputPath = path.join(workDir, 'final_combined.mp4');
    await concatenateClips(concatFilePath, outputPath);

    // Get final file stats
    const stats = await fs.stat(outputPath);
    console.log(`\n✓ FINAL VIDEO: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);

    updateProgress(renderProgress, jobId, 'complete', 100);

    return {
      outputPath,
      segmentCount: processedClips.length,
      originalCount: originalClipPaths.length,
      reactionCount: reactionClipPaths.filter(r => r).length,
      fileSize: stats.size,
      downloadUrl: `/api/combine/download/${path.basename(workDir)}`
    };

  } catch (error) {
    console.error('Combine error:', error);
    throw error;
  }
}

// ============================================
// LEGACY: combineReactions (for backward compatibility)
// ============================================
async function combineReactions(jobId, reactions, mode = 'sequential', pipPosition = 'top-right') {
  // This function exists for backward compatibility
  // It converts the old format to the new format and calls combineClipsWithReactions
  console.log('combineReactions called - delegating to combineClipsWithReactions');
  
  // Implementation depends on your specific needs
  throw new Error('combineReactions is deprecated. Use combineClipsWithReactions instead.');
}

function getOutputPath(jobId) {
  return path.join(TEMP_DIR, jobId, 'final_combined.mp4');
}

async function cleanup(jobId) {
  const workDir = path.join(TEMP_DIR, jobId);
  await fs.remove(workDir);
  console.log(`Cleaned up job: ${jobId}`);
}

// ============================================
// EXPORTS - Include ALL functions the routes need!
// ============================================
module.exports = {
  combineClipsWithReactions,  // ← Main function that combine.js calls!
  combineReactions,           // ← Legacy/backup
  getOutputPath,
  cleanup,
  // Also export helpers in case they're needed
  standardizeClipTo30fps,
  createPipSegment,
  concatenateClips
};
