const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const r2Service = require('./r2Service');

const TEMP_DIR = '/app/temp';

async function ensureTempDir() {
  try {
    await fs.mkdir(TEMP_DIR, { recursive: true });
  } catch (error) {
    console.error('Error creating temp directory:', error);
  }
}

async function getPipCoordinates(targetWidth, targetHeight, pipPosition) {
  const pipWidth = Math.floor(targetWidth * 0.25);
  const pipHeight = Math.floor(targetHeight * 0.25);
  const padding = 20;

  const positions = {
    'top-right': { x: targetWidth - pipWidth - padding, y: padding },
    'bottom-right': { x: targetWidth - pipWidth - padding, y: targetHeight - pipHeight - padding },
    'bottom-left': { x: padding, y: targetHeight - pipHeight - padding },
    'top-left': { x: padding, y: padding }
  };

  if (pipPosition === 'random') {
    const positionKeys = Object.keys(positions);
    const randomKey = positionKeys[Math.floor(Math.random() * positionKeys.length)];
    return positions[randomKey];
  }

  return positions[pipPosition] || positions['top-right'];
}

async function combineReactions(jobId, reactions, mode = 'sequential', pipPosition = 'top-right') {
  await ensureTempDir();

  const jobDir = path.join(TEMP_DIR, jobId);
  const manifestPath = path.join(jobDir, 'manifest.json');

  let manifest;
  try {
    const manifestData = await fs.readFile(manifestPath, 'utf-8');
    manifest = JSON.parse(manifestData);
  } catch (error) {
    throw new Error('Split job not found or manifest missing');
  }

  const clips = manifest.clips;
  if (clips.length !== reactions.length) {
    throw new Error(`Clip count mismatch: ${clips.length} clips but ${reactions.length} reactions`);
  }

  const reactionDir = path.join(jobDir, 'reactions');
  await fs.mkdir(reactionDir, { recursive: true });

  // Save reaction files
  for (let i = 0; i < reactions.length; i++) {
    const reactionPath = path.join(reactionDir, `reaction_${i + 1}.mp4`);
    const base64Data = reactions[i].split(',')[1] || reactions[i];
    await fs.writeFile(reactionPath, Buffer.from(base64Data, 'base64'));
  }

  if (mode === 'sequential') {
    return await createSequentialVideo(jobId, clips, reactionDir);
  } else if (mode === 'pip') {
    return await createPipVideo(jobId, clips, reactionDir, pipPosition);
  } else {
    throw new Error('Invalid mode. Use "sequential" or "pip"');
  }
}

async function createSequentialVideo(jobId, clips, reactionDir) {
  const jobDir = path.join(TEMP_DIR, jobId);
  const concatListPath = path.join(jobDir, 'concat_list.txt');
  const outputPath = path.join(jobDir, 'final_sequential.mp4');

  // Build concat list
  let concatContent = '';
  for (let i = 0; i < clips.length; i++) {
    const clipPath = path.join(jobDir, clips[i]);
    const reactionPath = path.join(reactionDir, `reaction_${i + 1}.mp4`);
    
    concatContent += `file '${clipPath}'\n`;
    concatContent += `file '${reactionPath}'\n`;
  }

  await fs.writeFile(concatListPath, concatContent);

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(concatListPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions([
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        // AUDIO NORMALIZATION - Makes all audio the same volume
        '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'
      ])
      .output(outputPath)
      .on('end', async () => {
        try {
          const fileName = `SEQ_${jobId}_${new Date().toISOString()}.mp4`;
          const r2Key = `${jobId}/${fileName}`;
          const result = await r2Service.uploadFile(outputPath, r2Key);
          const downloadUrl = result.downloadUrl || result.url;
          resolve({ 
            downloadUrl, 
            fileName,
            r2Link: downloadUrl,
            mode: 'sequential'
          });
        } catch (error) {
          reject(error);
        }
      })
      .on('error', (error) => {
        reject(error);
      })
      .run();
  });
}

async function createPipVideo(jobId, clips, reactionDir, pipPosition) {
  const jobDir = path.join(TEMP_DIR, jobId);
  
  // THREE-PASS METHOD for perfect audio sync
  
  // PASS 1: Extract last frame from first reaction video
  const firstReactionPath = path.join(reactionDir, 'reaction_1.mp4');
  const lastFramePath = path.join(jobDir, 'last_frame.jpg');
  
  await new Promise((resolve, reject) => {
    ffmpeg(firstReactionPath)
      .outputOptions([
        '-vf', 'select=eq(n\\,0)',
        '-frames:v', '1'
      ])
      .output(lastFramePath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  // PASS 2: Create proper background video with exact duration
  const bgVideoPath = path.join(jobDir, 'background.mp4');
  const totalDuration = await getTotalDuration(clips.map((clip, i) => 
    i === 0 ? path.join(jobDir, clip) : path.join(reactionDir, `reaction_${i}.mp4`)
  ));

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(lastFramePath)
      .inputOptions(['-loop', '1'])
      .input(firstReactionPath)
      .outputOptions([
        '-t', totalDuration.toString(),
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-tune', 'stillimage',
        '-pix_fmt', 'yuv420p',
        '-r', '30',
        '-c:a', 'aac',
        '-shortest'
      ])
      .output(bgVideoPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });

  // PASS 3: Overlay reaction clips on background
  const overlayOutputPath = path.join(jobDir, 'pip_overlay.mp4');
  const targetWidth = 1080;
  const targetHeight = 1920;
  const pipCoords = await getPipCoordinates(targetWidth, targetHeight, pipPosition);

  // Prepare all inputs
  const allInputs = [bgVideoPath];
  for (let i = 0; i < clips.length; i++) {
    allInputs.push(path.join(jobDir, clips[i]));
    if (i < clips.length - 1) {
      allInputs.push(path.join(reactionDir, `reaction_${i + 1}.mp4`));
    }
  }

  // Build filter complex for overlays
  let filterComplex = '';
  let currentOverlay = '[0:v]';
  let audioInputs = '[0:a]';
  let inputIndex = 1;
  let offset = 0;

  for (let i = 0; i < clips.length; i++) {
    const clipDuration = await getVideoDuration(path.join(jobDir, clips[i]));
    
    // Main clip overlay
    filterComplex += `[${inputIndex}:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,crop=${targetWidth}:${targetHeight}[clip${i}];`;
    filterComplex += `${currentOverlay}[clip${i}]overlay=0:0:enable='between(t,${offset},${offset + clipDuration})'[ov${i}a];`;
    audioInputs += `[${inputIndex}:a]`;
    currentOverlay = `[ov${i}a]`;
    offset += clipDuration;
    inputIndex++;

    // Reaction overlay (if not last clip)
    if (i < clips.length - 1) {
      const reactionDuration = await getVideoDuration(path.join(reactionDir, `reaction_${i + 1}.mp4`));
      filterComplex += `[${inputIndex}:v]scale=${Math.floor(targetWidth * 0.25)}:${Math.floor(targetHeight * 0.25)}:force_original_aspect_ratio=increase,crop=${Math.floor(targetWidth * 0.25)}:${Math.floor(targetHeight * 0.25)}[reaction${i}];`;
      filterComplex += `${currentOverlay}[reaction${i}]overlay=${pipCoords.x}:${pipCoords.y}:enable='between(t,${offset},${offset + reactionDuration})'[ov${i}b];`;
      audioInputs += `[${inputIndex}:a]`;
      currentOverlay = `[ov${i}b]`;
      offset += reactionDuration;
      inputIndex++;
    }
  }

  // AUDIO NORMALIZATION - Mix all audio and normalize to same volume
  filterComplex += `${audioInputs}amix=inputs=${inputIndex}:duration=longest,loudnorm=I=-16:TP=-1.5:LRA=11[aout]`;

  return new Promise((resolve, reject) => {
    const ffmpegCommand = ffmpeg();
    
    allInputs.forEach(input => {
      ffmpegCommand.input(input);
    });

    ffmpegCommand
      .complexFilter(filterComplex)
      .outputOptions([
        '-map', currentOverlay,
        '-map', '[aout]',
        '-c:v', 'libx264',
        '-preset', 'medium',
        '-crf', '23',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-movflags', '+faststart'
      ])
      .output(overlayOutputPath)
      .on('end', async () => {
        try {
          const fileName = `PIP_${jobId}_${new Date().toISOString()}.mp4`;
          const r2Key = `${jobId}/${fileName}`;
          const result = await r2Service.uploadFile(overlayOutputPath, r2Key);
          const downloadUrl = result.downloadUrl || result.url;
          resolve({ 
            downloadUrl, 
            fileName,
            r2Link: downloadUrl,
            mode: 'pip'
          });
        } catch (error) {
          reject(error);
        }
      })
      .on('error', (error) => {
        reject(error);
      })
      .run();
  });
}

async function getTotalDuration(filePaths) {
  let total = 0;
  for (const filePath of filePaths) {
    const duration = await getVideoDuration(filePath);
    total += duration;
  }
  return total;
}

function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(err);
      } else {
        resolve(metadata.format.duration);
      }
    });
  });
}

module.exports = {
  combineReactions
};
