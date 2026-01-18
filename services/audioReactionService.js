/**
 * 🎙️ AUDIO REACTION SERVICE - FIXED V2
 * 
 * Creates "faceless" reaction videos where:
 * - Original video plays normally
 * - At reaction points, video FREEZES on last frame
 * - Audio reaction plays over the frozen frame
 * - Video continues after audio ends
 * 
 * Audio normalization ensures consistent volume levels
 * 
 * FIXED: Uses same clip loading logic as combine.js (r2Service.downloadSplitJob)
 */

const ffmpeg = require('fluent-ffmpeg');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const r2Service = require('./r2Service');

// Store render progress for polling
const renderProgress = {};

const TEMP_DIR = process.env.TEMP_DIR || '/app/temp';

class AudioReactionService {
  
  constructor() {
    this.tempDir = TEMP_DIR;
  }

  /**
   * Get current render progress
   */
  getProgress(jobId) {
    return renderProgress[jobId] || { status: 'unknown', progress: 0 };
  }

  /**
   * Update render progress
   */
  updateProgress(jobId, status, progress, message = '') {
    renderProgress[jobId] = { 
      status, 
      progress: Math.round(progress), 
      message,
      updatedAt: Date.now()
    };
    console.log(`[AudioReaction] Job ${jobId}: ${status} - ${Math.round(progress)}% ${message}`);
  }

  /**
   * Get video/audio duration using ffprobe
   */
  async getMediaDuration(filePath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          console.error('Error getting duration:', err);
          reject(err);
        } else {
          resolve(metadata.format.duration || 0);
        }
      });
    });
  }

  /**
   * Get video dimensions
   */
  async getVideoDimensions(videoPath) {
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

  /**
   * EXACT SAME LOGIC AS combine.js - Ensure split clips are available
   * Checks local first, then restores from R2 if needed
   */
  async ensureSplitClipsAvailable(splitJobId) {
    const splitDir = path.join(this.tempDir, splitJobId, 'clips');
    
    console.log(`[AudioReaction] Checking local clips at: ${splitDir}`);
    
    // Check if clips exist locally
    if (await fs.pathExists(splitDir)) {
      const files = await fs.readdir(splitDir);
      const clips = files.filter(f => f.startsWith('clip_') && f.endsWith('.mp4'));
      if (clips.length > 0) {
        console.log(`[AudioReaction] ✅ Found ${clips.length} local clips`);
        return splitDir;
      }
    }
    
    console.log('[AudioReaction] Local clips not found, attempting to restore from R2...');
    
    // Check if R2 is configured
    if (!r2Service.isConfigured()) {
      throw new Error('Split job not found locally and R2 is not configured');
    }
    
    // Create job directory and download from R2
    const jobDir = path.join(this.tempDir, splitJobId);
    await fs.ensureDir(jobDir);
    
    try {
      await r2Service.downloadSplitJob(splitJobId, jobDir);
      console.log(`[AudioReaction] ✅ Restored clips from R2`);
      return path.join(jobDir, 'clips');
    } catch (err) {
      console.error(`[AudioReaction] ❌ R2 restore failed:`, err.message);
      throw new Error(`Split job not found. Clips may have been cleaned up. Please re-split the video.`);
    }
  }

  /**
   * Extract clip number from filename
   */
  extractClipNumber(filename) {
    const match = filename.match(/(\d+)/);
    if (match) {
      return parseInt(match[1], 10);
    }
    return null;
  }

  /**
   * Extract the last frame from a video clip as JPG image
   */
  async extractLastFrame(videoPath, outputPath) {
    return new Promise((resolve, reject) => {
      const cmd = `ffmpeg -y -sseof -0.5 -i "${videoPath}" -vframes 1 -q:v 2 "${outputPath}"`;
      exec(cmd, (error, stdout, stderr) => {
        if (error) {
          console.error('[AudioReaction] Extract frame error:', stderr);
          reject(error);
        } else {
          console.log('[AudioReaction] ✓ Last frame extracted');
          resolve(outputPath);
        }
      });
    });
  }

  /**
   * Create a frozen frame video with audio
   * The frozen frame that plays during audio reaction
   */
  async createFrozenFrameWithAudio(framePath, audioPath, outputPath, targetWidth, targetHeight) {
    return new Promise(async (resolve, reject) => {
      try {
        const audioDuration = await this.getMediaDuration(audioPath);
        console.log(`[AudioReaction] Creating frozen frame video (${audioDuration.toFixed(2)}s) with normalized audio...`);
        
        // Create frozen video from image + add audio with normalization
        const cmd = `ffmpeg -y -loop 1 -i "${framePath}" -i "${audioPath}" -t ${audioDuration} -vf "scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2,fps=30" -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 192k -ar 44100 -af "loudnorm=I=-16:TP=-1.5:LRA=11" -shortest -pix_fmt yuv420p "${outputPath}"`;
        
        exec(cmd, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
          if (error) {
            console.error('[AudioReaction] Frozen frame creation error:', stderr ? stderr.substring(stderr.length - 500) : error.message);
            reject(error);
          } else {
            console.log(`[AudioReaction] ✓ Frozen frame with audio created (${audioDuration.toFixed(2)}s)`);
            resolve(outputPath);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Normalize audio in original video clips for consistent levels
   */
  async normalizeVideoClip(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      console.log(`[AudioReaction] Normalizing clip: ${path.basename(inputPath)}`);
      
      const cmd = `ffmpeg -y -i "${inputPath}" -c:v libx264 -preset fast -crf 23 -r 30 -c:a aac -b:a 192k -ar 44100 -af "loudnorm=I=-16:TP=-1.5:LRA=11" -pix_fmt yuv420p "${outputPath}"`;
      
      exec(cmd, { maxBuffer: 50 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          console.error('[AudioReaction] Normalization error:', stderr ? stderr.substring(stderr.length - 300) : error.message);
          reject(error);
        } else {
          console.log(`[AudioReaction] ✓ Clip normalized`);
          resolve(outputPath);
        }
      });
    });
  }

  /**
   * Concatenate all video segments using concat filter
   */
  async concatenateSegments(segments, outputPath, jobId) {
    return new Promise((resolve, reject) => {
      console.log(`[AudioReaction] Concatenating ${segments.length} segments...`);
      segments.forEach((s, i) => console.log(`  [${i}] ${path.basename(s)}`));
      
      const numClips = segments.length;
      
      // Build input arguments
      const inputArgs = segments.flatMap(p => ['-i', p]);
      
      // Build filter_complex - scale all to same size
      let filterParts = [];
      let concatInputs = '';
      
      for (let i = 0; i < numClips; i++) {
        filterParts.push(`[${i}:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p[v${i}]`);
        filterParts.push(`[${i}:a]aformat=sample_fmts=fltp:sample_rates=44100:channel_layouts=stereo[a${i}]`);
        concatInputs += `[v${i}][a${i}]`;
      }
      
      // Concat and final audio normalization
      filterParts.push(`${concatInputs}concat=n=${numClips}:v=1:a=1[outv][outa]`);
      
      const filterComplex = filterParts.join(';');
      
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
        '-b:a', '192k',
        '-movflags', '+faststart',
        outputPath
      ];
      
      const ffmpegProcess = spawn('ffmpeg', args);
      
      let stderrOutput = '';
      
      ffmpegProcess.stderr.on('data', (data) => {
        const str = data.toString();
        stderrOutput += str;
        const timeMatch = str.match(/time=(\d{2}:\d{2}:\d{2}\.\d{2})/);
        if (timeMatch) {
          this.updateProgress(jobId, 'rendering', 80, `Concatenating: ${timeMatch[1]}`);
        }
      });
      
      ffmpegProcess.on('close', (code) => {
        if (code === 0) {
          console.log('[AudioReaction] ✓ Concatenation complete');
          resolve(outputPath);
        } else {
          const lastLines = stderrOutput.split('\n').slice(-15).join('\n');
          console.error(`[AudioReaction] FFmpeg concat failed:\n${lastLines}`);
          reject(new Error(`FFmpeg concat failed with code ${code}`));
        }
      });
      
      ffmpegProcess.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * MAIN FUNCTION: Combine clips with audio reactions
   */
  async combineClipsWithAudioReactions(jobId, audioReactions) {
    const workDir = path.join(this.tempDir, jobId, 'audio_render');
    await fs.ensureDir(workDir);
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[AudioReaction] 🎙️ Starting Audio-Only RANT render`);
    console.log(`[AudioReaction] Job ID: ${jobId}`);
    console.log(`[AudioReaction] Audio reactions: ${audioReactions.length}`);
    console.log(`${'='.repeat(60)}\n`);
    
    this.updateProgress(jobId, 'starting', 0, 'Initializing...');
    
    try {
      // Step 1: Load clips using SAME LOGIC as combine.js
      this.updateProgress(jobId, 'loading', 5, 'Loading split clips...');
      
      const splitDir = await this.ensureSplitClipsAvailable(jobId);
      
      // Get clip files sorted by number
      const files = await fs.readdir(splitDir);
      const clipFiles = files
        .filter(f => f.startsWith('clip_') && f.endsWith('.mp4'))
        .sort((a, b) => {
          const numA = this.extractClipNumber(a) || 0;
          const numB = this.extractClipNumber(b) || 0;
          return numA - numB;
        });
      
      if (clipFiles.length === 0) {
        throw new Error('No clips found in split job');
      }
      
      const clipPaths = clipFiles.map(f => path.join(splitDir, f));
      console.log(`[AudioReaction] ✅ Found ${clipPaths.length} clips`);
      
      this.updateProgress(jobId, 'loading', 20, `Found ${clipPaths.length} clips`);
      
      // Get dimensions from first clip
      const dimensions = await this.getVideoDimensions(clipPaths[0]);
      const targetWidth = dimensions.width;
      const targetHeight = dimensions.height;
      console.log(`[AudioReaction] Target dimensions: ${targetWidth}x${targetHeight}`);
      
      // Step 2: Create map of which clips have audio reactions
      const reactionMap = {};
      for (const reaction of audioReactions) {
        reactionMap[reaction.clipIndex] = reaction.audioPath;
        console.log(`[AudioReaction] Reaction mapped: clip ${reaction.clipIndex} → ${path.basename(reaction.audioPath)}`);
      }
      
      // Step 3: Build all segments
      this.updateProgress(jobId, 'processing', 25, 'Processing clips...');
      
      const allSegments = [];
      const totalClips = clipPaths.length;
      
      for (let i = 0; i < totalClips; i++) {
        const clipPath = clipPaths[i];
        const clipIndex = i + 1;  // 1-based index
        
        console.log(`\n[AudioReaction] Processing clip ${clipIndex}/${totalClips}...`);
        
        // Normalize the original clip's audio
        const normalizedClipPath = path.join(workDir, `clip_${clipIndex}_normalized.mp4`);
        await this.normalizeVideoClip(clipPath, normalizedClipPath);
        allSegments.push(normalizedClipPath);
        
        // Check if this clip has an audio reaction
        if (reactionMap[clipIndex]) {
          const audioPath = reactionMap[clipIndex];
          console.log(`[AudioReaction] 🎙️ Adding audio reaction after clip ${clipIndex}`);
          
          // Extract last frame of this clip
          const framePath = path.join(workDir, `frame_${clipIndex}.jpg`);
          await this.extractLastFrame(normalizedClipPath, framePath);
          
          // Create frozen frame video with audio (duration auto-matched to audio)
          const frozenWithAudioPath = path.join(workDir, `frozen_audio_${clipIndex}.mp4`);
          await this.createFrozenFrameWithAudio(framePath, audioPath, frozenWithAudioPath, targetWidth, targetHeight);
          
          allSegments.push(frozenWithAudioPath);
          
          // Clean up frame image
          await fs.remove(framePath).catch(() => {});
        }
        
        const progress = 25 + ((i + 1) / totalClips) * 45;
        this.updateProgress(jobId, 'processing', progress, `Processed clip ${clipIndex}/${totalClips}`);
      }
      
      // Step 4: Concatenate all segments
      this.updateProgress(jobId, 'rendering', 70, 'Creating final video...');
      
      // Generate output filename
      const now = new Date();
      const gmt4Offset = 4 * 60 * 60 * 1000;
      const gmt4Date = new Date(now.getTime() + gmt4Offset);
      const timestamp = gmt4Date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
      
      const firstReactionText = audioReactions[0]?.text || 'audio';
      const shortText = firstReactionText.substring(0, 3).replace(/[^a-zA-Z0-9]/g, '').toUpperCase() || 'AUD';
      const outputFilename = `AUDIO_${shortText}_${timestamp}.mp4`;
      const outputPath = path.join(workDir, outputFilename);
      
      await this.concatenateSegments(allSegments, outputPath, jobId);
      
      // Step 5: Upload to R2
      this.updateProgress(jobId, 'uploading', 90, 'Uploading to cloud...');
      
      const r2Key = `renders/${jobId}/${outputFilename}`;
      
      // IMPORTANT: r2Service.uploadFile expects (localFilePath, r2Key, contentType)
      const uploadResult = await r2Service.uploadFile(outputPath, r2Key, 'video/mp4');
      
      const downloadUrl = uploadResult.downloadUrl || await r2Service.getSignedUrl(r2Key, 7 * 24 * 60 * 60);
      
      console.log(`[AudioReaction] ✅ Uploaded to R2: ${r2Key}`);
      
      // Done!
      this.updateProgress(jobId, 'complete', 100, 'Done!');
      
      // Store download URL in progress for frontend to access
      renderProgress[jobId].downloadUrl = downloadUrl;
      renderProgress[jobId].filename = outputFilename;
      
      console.log(`\n${'='.repeat(60)}`);
      console.log(`[AudioReaction] 🎉 AUDIO-ONLY RANT COMPLETE!`);
      console.log(`[AudioReaction] Filename: ${outputFilename}`);
      console.log(`${'='.repeat(60)}\n`);
      
      return {
        success: true,
        jobId,
        filename: outputFilename,
        downloadUrl,
        segments: allSegments.length
      };
      
    } catch (error) {
      console.error(`[AudioReaction] ❌ Render failed:`, error);
      this.updateProgress(jobId, 'error', 0, error.message);
      throw error;
    }
  }

  /**
   * Upload audio reaction file to server
   */
  async uploadAudioReaction(jobId, clipIndex, audioBuffer, originalFilename) {
    const workDir = path.join(this.tempDir, jobId, 'audio_reactions');
    await fs.ensureDir(workDir);
    
    const ext = path.extname(originalFilename) || '.mp3';
    const audioPath = path.join(workDir, `reaction_${clipIndex}${ext}`);
    
    await fs.writeFile(audioPath, audioBuffer);
    console.log(`[AudioReaction] ✅ Audio reaction ${clipIndex} saved: ${audioPath}`);
    
    return audioPath;
  }
}

module.exports = new AudioReactionService();
