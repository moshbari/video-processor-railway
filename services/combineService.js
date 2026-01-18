const ffmpeg = require('fluent-ffmpeg');
const { exec, spawn } = require('child_process');
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
// Standardize reaction clips for concatenation
// Simple re-encode to ensure consistent format
// ============================================
async function standardizeClipTo30fps(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    console.log(`  Standardizing: ${path.basename(inputPath)}`);
    
    // Simple re-encode with fixed parameters
    // The concat FILTER will handle the rest, but this ensures clean input
    const cmd = `ffmpeg -y -i "${inputPath}" -c:v libx264 -preset fast -crf 23 -r 30 -c:a aac -ar 44100 -b:a 128k -pix_fmt yuv420p "${outputPath}"`;
    
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error(`  ✗ Standardize failed:`, error.message);
        reject(error);
      } else {
        console.log(`  ✓ Standardized: ${path.basename(outputPath)}`);
        resolve(outputPath);
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
  console.log('\n=== PiP Creation (Original=Background, Reaction=Overlay) ===');
  const workDir = path.dirname(outputPath);

  const originalDuration = await getVideoDuration(originalPath);
  const reactionDuration = await getVideoDuration(reactionPath);
  console.log(`Original duration: ${originalDuration}s`);
  console.log(`Reaction duration: ${reactionDuration}s`);

  if (!originalDuration || originalDuration <= 0) {
    console.log('WARNING: Invalid original duration, copying reaction as fallback...');
    await fs.copy(reactionPath, outputPath);
    return outputPath;
  }

  // Get PiP coordinates
  const coords = getPipCoordinates(targetWidth, targetHeight, pipPosition);
  console.log(`PiP position: ${pipPosition} (${coords.x}, ${coords.y})`);

  // PiP size (25% of screen)
  const pipWidth = Math.floor(targetWidth * 0.25);
  const pipHeight = Math.floor(targetHeight * 0.25);

  // Simple overlay: Original as background, Reaction as small PiP
  // Use -shortest to end when original ends (in case reaction is longer)
  // Use original's audio (stream 0:a)
  const filterComplex = [
    // Scale original to target size
    `[0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,fps=30[bg]`,
    // Scale reaction to PiP size
    `[1:v]scale=${pipWidth}:${pipHeight}[pip]`,
    // Overlay reaction on original
    `[bg][pip]overlay=${coords.x}:${coords.y}:shortest=1[outv]`
  ].join(';');

  const cmd = `ffmpeg -y -i "${originalPath}" -i "${reactionPath}" -filter_complex "${filterComplex}" -map "[outv]" -map 0:a -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -t ${originalDuration} "${outputPath}"`;

  console.log(`Running PiP overlay...`);
  
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        console.error('PiP overlay error:', stderr ? stderr.substring(stderr.length - 500) : error.message);
        reject(error);
      } else {
        console.log('  ✓ PiP overlay complete');
        resolve(outputPath);
      }
    });
  });
}

// ============================================
// CONCATENATION WITH PROPER FRAME RATE HANDLING
// ============================================
async function concatenateClips(clipPaths, outputPath) {
  return new Promise((resolve, reject) => {
    console.log(`  Running concatenation with concat FILTER + audio normalization...`);
    console.log(`  Clips to concat: ${clipPaths.length}`);
    
    // Log the clips being concatenated
    clipPaths.forEach((p, i) => console.log(`    [${i}] ${path.basename(p)}`));
    
    const numClips = clipPaths.length;
    
    // Build input arguments: -i clip1 -i clip2 -i clip3 ...
    const inputArgs = clipPaths.flatMap(p => ['-i', p]);
    
    // Build filter_complex with scale normalization AND audio normalization
    // Each input gets scaled to 1080x1920 and fps set to 30, then concatenated
    // Audio gets normalized with loudnorm for consistent volume
    let filterParts = [];
    let concatInputs = '';
    
    for (let i = 0; i < numClips; i++) {
      // Scale each video to same size and fps
      filterParts.push(`[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p[v${i}]`);
      // Normalize audio format
      filterParts.push(`[${i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${i}]`);
      concatInputs += `[v${i}][a${i}]`;
    }
    
    // Add concat filter, then apply loudnorm to the combined audio
    filterParts.push(`${concatInputs}concat=n=${numClips}:v=1:a=1[outv][preAudio]`);
    // Apply loudnorm to normalize volume across all clips
    filterParts.push(`[preAudio]loudnorm=I=-16:TP=-1.5:LRA=11[outa]`);
    
    const filterComplex = filterParts.join(';');
    
    // Build full FFmpeg command
    const args = [
      '-y',
      ...inputArgs,
      '-filter_complex', filterComplex,
      '-map', '[outv]',
      '-map', '[outa]',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      outputPath
    ];
    
    console.log(`  Filter has ${filterParts.length} parts, normalizing all to 1080x1920@30fps + loudnorm`);
    
    const ffmpegProcess = spawn('ffmpeg', args);
    
    let stderrOutput = '';
    let lastProgress = '';
    
    ffmpegProcess.stderr.on('data', (data) => {
      const str = data.toString();
      stderrOutput += str;
      const timeMatch = str.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
      if (timeMatch && timeMatch[1] !== lastProgress) {
        lastProgress = timeMatch[1];
        console.log(`  Concat progress: ${timeMatch[1]}`);
      }
    });
    
    ffmpegProcess.on('close', (code) => {
      if (code === 0) {
        console.log('  ✓ Concatenation complete (with audio normalization)');
        resolve(outputPath);
      } else {
        // Log last part of stderr for debugging
        const lastLines = stderrOutput.split('\n').slice(-20).join('\n');
        console.error(`  FFmpeg concat stderr (last 20 lines):\n${lastLines}`);
        reject(new Error(`FFmpeg concat failed with code ${code}`));
      }
    });
    
    ffmpegProcess.on('error', (err) => {
      console.error('Concat spawn error:', err.message);
      reject(err);
    });
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

    // Pass the clip paths directly to concatenateClips (uses concat FILTER now)
    const outputPath = path.join(workDir, 'final_combined.mp4');
    await concatenateClips(processedClips, outputPath);

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
