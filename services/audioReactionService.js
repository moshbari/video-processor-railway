/**
 * 🎙️ AUDIO REACTION SERVICE
 * 
 * Creates "faceless" reaction videos where:
 * - Original video plays normally
 * - At reaction points, video FREEZES on last frame
 * - Audio reaction plays over the frozen frame
 * - Video continues after audio ends
 * 
 * Audio normalization ensures consistent volume levels
 */

const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const r2Service = require('./r2Service');

// Store render progress for polling
const renderProgress = {};

class AudioReactionService {
  
  constructor() {
    this.tempDir = process.env.TEMP_DIR || '/app/temp';
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
  updateProgress(progressStore, jobId, status, progress, message = '') {
    progressStore[jobId] = { 
      status, 
      progress: Math.round(progress), 
      message,
      updatedAt: Date.now()
    };
    console.log(`[AudioReaction] Job ${jobId}: ${status} - ${Math.round(progress)}% ${message}`);
  }

  /**
   * Get video duration using ffprobe
   */
  async getMediaDuration(filePath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          console.error('Error getting duration:', err);
          reject(err);
        } else {
          resolve(metadata.format.duration);
        }
      });
    });
  }

  /**
   * Get audio duration
   */
  async getAudioDuration(audioPath) {
    return this.getMediaDuration(audioPath);
  }

  /**
   * Extract the last frame from a video clip as JPG image
   */
  async extractLastFrame(videoPath, outputPath) {
    return new Promise(async (resolve, reject) => {
      try {
        // Get video duration first
        const duration = await this.getMediaDuration(videoPath);
        // Get frame slightly before end to avoid black frames
        const frameTime = Math.max(0, duration - 0.1);
        
        console.log(`[AudioReaction] Extracting last frame at ${frameTime}s from ${path.basename(videoPath)}`);
        
        ffmpeg(videoPath)
          .seekInput(frameTime)
          .outputOptions([
            '-vframes', '1',
            '-q:v', '2'  // High quality JPG
          ])
          .output(outputPath)
          .on('end', () => {
            console.log(`[AudioReaction] ✅ Last frame extracted: ${path.basename(outputPath)}`);
            resolve(outputPath);
          })
          .on('error', (err) => {
            console.error(`[AudioReaction] ❌ Frame extraction failed:`, err);
            reject(err);
          })
          .run();
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Create a video from a still image with specific duration
   * The frozen frame video that plays during audio reaction
   */
  async createFrozenFrameVideo(imagePath, duration, outputPath, width = 1080, height = 1920) {
    return new Promise((resolve, reject) => {
      console.log(`[AudioReaction] Creating ${duration}s frozen frame video...`);
      
      ffmpeg()
        .input(imagePath)
        .inputOptions([
          '-loop', '1',  // Loop the image
          '-framerate', '30'  // 30fps
        ])
        .outputOptions([
          '-t', String(duration),  // Duration matches audio length
          '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-pix_fmt', 'yuv420p',
          '-r', '30'
        ])
        .output(outputPath)
        .on('end', () => {
          console.log(`[AudioReaction] ✅ Frozen frame video created: ${duration}s`);
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error(`[AudioReaction] ❌ Frozen frame creation failed:`, err);
          reject(err);
        })
        .run();
    });
  }

  /**
   * Add audio to frozen frame video with normalization
   */
  async addAudioToFrozenFrame(videoPath, audioPath, outputPath) {
    return new Promise((resolve, reject) => {
      console.log(`[AudioReaction] Adding normalized audio to frozen frame...`);
      
      ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .outputOptions([
          '-c:v', 'copy',  // Copy video stream (already encoded)
          '-c:a', 'aac',
          '-b:a', '192k',
          '-ar', '44100',
          // Audio normalization - same as your video reactions
          '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
          '-shortest'  // End when shortest stream ends
        ])
        .output(outputPath)
        .on('end', () => {
          console.log(`[AudioReaction] ✅ Audio added and normalized`);
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error(`[AudioReaction] ❌ Audio addition failed:`, err);
          reject(err);
        })
        .run();
    });
  }

  /**
   * Normalize audio in original video clips for consistent levels
   */
  async normalizeVideoClipAudio(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      console.log(`[AudioReaction] Normalizing clip audio: ${path.basename(inputPath)}`);
      
      ffmpeg(inputPath)
        .outputOptions([
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-ar', '44100',
          '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
          '-r', '30',
          '-vsync', 'cfr'
        ])
        .output(outputPath)
        .on('end', () => {
          console.log(`[AudioReaction] ✅ Clip audio normalized`);
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error(`[AudioReaction] ❌ Normalization failed:`, err);
          reject(err);
        })
        .run();
    });
  }

  /**
   * Concatenate all video segments (clips + frozen frames)
   */
  async concatenateSegments(segments, outputPath, jobId) {
    return new Promise((resolve, reject) => {
      const workDir = path.dirname(outputPath);
      const listFile = path.join(workDir, 'concat_list.txt');
      
      // Create concat list file
      const listContent = segments.map(s => `file '${s}'`).join('\n');
      fs.writeFileSync(listFile, listContent);
      
      console.log(`[AudioReaction] Concatenating ${segments.length} segments...`);
      console.log(`[AudioReaction] Segments: ${segments.map(s => path.basename(s)).join(' → ')}`);
      
      const ffmpegCmd = ffmpeg()
        .input(listFile)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions([
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-c:a', 'aac',
          '-b:a', '192k',
          '-r', '30',
          '-vsync', 'cfr',
          // Final audio normalization pass
          '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'
        ])
        .output(outputPath);
      
      ffmpegCmd
        .on('progress', (progress) => {
          if (progress.percent) {
            const percent = Math.min(95, 70 + (progress.percent * 0.25));
            this.updateProgress(renderProgress, jobId, 'rendering', percent, 'Concatenating final video...');
          }
        })
        .on('end', () => {
          // Clean up concat list
          fs.removeSync(listFile);
          console.log(`[AudioReaction] ✅ Final video created!`);
          resolve(outputPath);
        })
        .on('error', (err) => {
          fs.removeSync(listFile);
          console.error(`[AudioReaction] ❌ Concatenation failed:`, err);
          reject(err);
        })
        .run();
    });
  }

  /**
   * MAIN FUNCTION: Combine clips with audio reactions
   * 
   * @param {string} jobId - The split job ID
   * @param {Array} audioReactions - Array of {clipIndex, audioPath} 
   *                                 (clipIndex is which clip to add reaction AFTER)
   */
  async combineClipsWithAudioReactions(jobId, audioReactions) {
    const workDir = path.join(this.tempDir, jobId);
    await fs.ensureDir(workDir);
    
    console.log(`\n${'='.repeat(60)}`);
    console.log(`[AudioReaction] 🎙️ Starting Audio-Only RANT render`);
    console.log(`[AudioReaction] Job ID: ${jobId}`);
    console.log(`[AudioReaction] Audio reactions: ${audioReactions.length}`);
    console.log(`${'='.repeat(60)}\n`);
    
    this.updateProgress(renderProgress, jobId, 'starting', 0, 'Initializing...');
    
    try {
      // Step 1: Get manifest from R2
      this.updateProgress(renderProgress, jobId, 'loading', 5, 'Loading split data...');
      
      const manifestKey = `splits/${jobId}/manifest.json`;
      let manifest;
      
      try {
        const manifestData = await r2Service.downloadFile(manifestKey);
        manifest = JSON.parse(manifestData.toString());
        console.log(`[AudioReaction] ✅ Manifest loaded: ${manifest.clips.length} clips`);
      } catch (err) {
        throw new Error('Split job not found. Please re-split the video first.');
      }
      
      // Step 2: Download all clips from R2
      this.updateProgress(renderProgress, jobId, 'downloading', 10, 'Downloading clips...');
      
      const clipPaths = [];
      for (let i = 0; i < manifest.clips.length; i++) {
        const clipKey = `${jobId}/clip_${i + 1}.mp4`;
        const localPath = path.join(workDir, `clip_${i + 1}.mp4`);
        
        try {
          const clipData = await r2Service.downloadFile(clipKey);
          await fs.writeFile(localPath, clipData);
          clipPaths.push(localPath);
          console.log(`[AudioReaction] ✅ Downloaded clip ${i + 1}/${manifest.clips.length}`);
        } catch (err) {
          console.error(`[AudioReaction] ❌ Failed to download clip ${i + 1}:`, err);
          throw new Error(`Failed to download clip ${i + 1}. Clips may have expired.`);
        }
        
        const progress = 10 + ((i + 1) / manifest.clips.length) * 20;
        this.updateProgress(renderProgress, jobId, 'downloading', progress, `Downloaded clip ${i + 1}/${manifest.clips.length}`);
      }
      
      // Step 3: Create map of which clips have audio reactions
      const reactionMap = {};
      for (const reaction of audioReactions) {
        reactionMap[reaction.clipIndex] = reaction.audioPath;
      }
      
      // Step 4: Build all segments
      this.updateProgress(renderProgress, jobId, 'processing', 35, 'Processing clips and audio...');
      
      const allSegments = [];
      const totalClips = clipPaths.length;
      
      for (let i = 0; i < totalClips; i++) {
        const clipPath = clipPaths[i];
        const clipIndex = i + 1;
        
        console.log(`\n[AudioReaction] Processing clip ${clipIndex}/${totalClips}...`);
        
        // Normalize the original clip's audio
        const normalizedClipPath = path.join(workDir, `clip_${clipIndex}_normalized.mp4`);
        await this.normalizeVideoClipAudio(clipPath, normalizedClipPath);
        allSegments.push(normalizedClipPath);
        
        // Check if this clip has an audio reaction
        if (reactionMap[clipIndex]) {
          const audioPath = reactionMap[clipIndex];
          console.log(`[AudioReaction] 🎙️ Adding audio reaction after clip ${clipIndex}`);
          
          // Get audio duration
          const audioDuration = await this.getAudioDuration(audioPath);
          console.log(`[AudioReaction] Audio duration: ${audioDuration}s`);
          
          // Extract last frame of this clip
          const framePath = path.join(workDir, `frame_${clipIndex}.jpg`);
          await this.extractLastFrame(normalizedClipPath, framePath);
          
          // Create frozen frame video matching audio duration
          const frozenPath = path.join(workDir, `frozen_${clipIndex}.mp4`);
          await this.createFrozenFrameVideo(framePath, audioDuration, frozenPath);
          
          // Add audio to frozen frame (with normalization)
          const frozenWithAudioPath = path.join(workDir, `frozen_audio_${clipIndex}.mp4`);
          await this.addAudioToFrozenFrame(frozenPath, audioPath, frozenWithAudioPath);
          
          allSegments.push(frozenWithAudioPath);
          
          // Clean up intermediate files
          await fs.remove(framePath);
          await fs.remove(frozenPath);
        }
        
        const progress = 35 + ((i + 1) / totalClips) * 35;
        this.updateProgress(renderProgress, jobId, 'processing', progress, `Processed clip ${clipIndex}/${totalClips}`);
      }
      
      // Step 5: Concatenate all segments
      this.updateProgress(renderProgress, jobId, 'rendering', 70, 'Creating final video...');
      
      // Generate output filename
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const firstReactionText = audioReactions[0]?.text || 'audio';
      const shortText = firstReactionText.substring(0, 3).replace(/[^a-zA-Z0-9]/g, '').toUpperCase() || 'AUD';
      const outputFilename = `AUDIO_${shortText}_${timestamp}.mp4`;
      const outputPath = path.join(workDir, outputFilename);
      
      await this.concatenateSegments(allSegments, outputPath, jobId);
      
      // Step 6: Upload to R2
      this.updateProgress(renderProgress, jobId, 'uploading', 95, 'Uploading to cloud...');
      
      const r2Key = `renders/${jobId}/${outputFilename}`;
      const videoBuffer = await fs.readFile(outputPath);
      await r2Service.uploadFile(r2Key, videoBuffer, 'video/mp4');
      
      const downloadUrl = await r2Service.getSignedUrl(r2Key, 7 * 24 * 60 * 60); // 7 days
      
      // Step 7: Cleanup local files
      console.log(`[AudioReaction] Cleaning up temp files...`);
      await fs.remove(workDir);
      
      // Done!
      this.updateProgress(renderProgress, jobId, 'complete', 100, 'Done!');
      
      console.log(`\n${'='.repeat(60)}`);
      console.log(`[AudioReaction] 🎉 AUDIO-ONLY RANT COMPLETE!`);
      console.log(`[AudioReaction] Download URL ready`);
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
      this.updateProgress(renderProgress, jobId, 'error', 0, error.message);
      
      // Cleanup on error
      try {
        await fs.remove(workDir);
      } catch (e) {}
      
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
