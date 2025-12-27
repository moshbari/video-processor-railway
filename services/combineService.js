const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

class CombineService {
  constructor() {
    this.outputDir = process.env.OUTPUT_DIR || '/app/outputs';
    this.tempDir = process.env.TEMP_DIR || '/app/temp';
  }

  /**
   * Get video metadata using ffprobe
   */
  async getVideoMetadata(videoPath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) {
          reject(err);
          return;
        }
        
        const streams = metadata.streams || [];
        const videoStream = streams.find(s => s.codec_type === 'video');
        const audioStream = streams.find(s => s.codec_type === 'audio');
        
        const parseValidDuration = (val) => {
          const num = parseFloat(val);
          return (isNaN(num) || num <= 0) ? 0 : num;
        };
        
        const formatDuration = parseValidDuration(metadata.format?.duration);
        const videoDuration = videoStream ? parseValidDuration(videoStream.duration) || formatDuration : 0;
        const audioDuration = audioStream ? parseValidDuration(audioStream.duration) || formatDuration : 0;
        
        let maxDuration = Math.max(videoDuration, audioDuration, formatDuration);
        if (maxDuration <= 0) {
          maxDuration = formatDuration || 1;
        }
        
        const width = videoStream?.width || 0;
        const height = videoStream?.height || 0;
        
        resolve({
          duration: maxDuration,
          videoDuration,
          audioDuration,
          formatDuration,
          width,
          height,
          hasVideo: !!videoStream && width > 0 && height > 0,
          hasAudio: !!audioStream
        });
      });
    });
  }

  async getVideoDuration(videoPath) {
    const metadata = await this.getVideoMetadata(videoPath);
    return metadata.duration;
  }

  /**
   * Extract the last frame from a video as an image
   */
  async extractLastFrame(videoPath, outputPath) {
    console.log(`Extracting last frame from: ${videoPath}`);
    
    const duration = await this.getVideoDuration(videoPath);
    let seekTime = duration < 1 ? Math.max(0, duration * 0.8) : Math.max(0, duration - 0.1);
    
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .seekInput(seekTime)
        .frames(1)
        .outputOptions(['-q:v', '2', '-y'])
        .on('end', async () => {
          if (await fs.pathExists(outputPath)) {
            console.log(`✓ Frame extracted`);
            resolve(outputPath);
          } else {
            reject(new Error('Frame file not found'));
          }
        })
        .on('error', reject)
        .save(outputPath);
    });
  }

  /**
   * Create reaction segment: Frozen frame background with reaction video overlay
   * Audio comes from REACTION only
   */
  async createReactionSegment(lastFramePath, reactionPath, outputPath, targetWidth = 1080, targetHeight = 1920) {
    console.log('\n=== Creating Reaction Segment (Frozen Frame + Reaction) ===');
    
    const reactionMeta = await this.getVideoMetadata(reactionPath);
    console.log(`Reaction duration: ${reactionMeta.duration.toFixed(2)}s`);
    
    // Calculate PiP dimensions (35% of width)
    const pipWidth = Math.round(targetWidth * 0.35);
    const pipHeight = Math.round(pipWidth * (reactionMeta.height / reactionMeta.width));
    const pipX = targetWidth - pipWidth - 20;  // Top-right with padding
    const pipY = 20;
    
    console.log(`PiP size: ${pipWidth}x${pipHeight} at position (${pipX}, ${pipY})`);
    
    return new Promise((resolve, reject) => {
      // Filter: 
      // - Create video from frozen image (looped for duration of reaction)
      // - Scale reaction for PiP
      // - Overlay reaction on frozen frame
      const filterComplex = [
        // Scale and pad the frozen frame to target dimensions
        `[0:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,loop=loop=-1:size=1:start=0[bg]`,
        // Scale reaction for PiP corner
        `[1:v]scale=${pipWidth}:${pipHeight}:force_original_aspect_ratio=decrease,setsar=1[pip]`,
        // Overlay PiP on background
        `[bg][pip]overlay=${pipX}:${pipY}:shortest=1[outv]`
      ].join(';');
      
      const command = ffmpeg()
        .input(lastFramePath)
        .inputOptions(['-loop', '1'])  // Loop the image
        .input(reactionPath);
      
      const outputOptions = [
        '-filter_complex', filterComplex,
        '-map', '[outv]',
        '-t', String(reactionMeta.duration),  // Duration matches reaction
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
        '-r', '30'
      ];
      
      // Audio from reaction
      if (reactionMeta.hasAudio) {
        outputOptions.push('-map', '1:a', '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k');
      }
      
      outputOptions.push('-movflags', '+faststart', '-y');
      
      command
        .outputOptions(outputOptions)
        .on('start', cmd => console.log('Reaction segment command:', cmd))
        .on('progress', p => {
          if (p.percent) console.log(`  Progress: ${Math.round(p.percent)}%`);
        })
        .on('end', async () => {
          if (await fs.pathExists(outputPath)) {
            const stats = await fs.stat(outputPath);
            console.log(`✓ Reaction segment created: ${(stats.size/1024/1024).toFixed(2)} MB`);
            resolve(outputPath);
          } else {
            reject(new Error('Reaction segment not created'));
          }
        })
        .on('error', reject)
        .save(outputPath);
    });
  }

  /**
   * Normalize a clip to consistent format
   */
  async normalizeClip(inputPath, outputPath, targetWidth = 1080, targetHeight = 1920) {
    const metadata = await this.getVideoMetadata(inputPath);
    const videoFilter = `scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=decrease,pad=${targetWidth}:${targetHeight}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`;
    
    if (metadata.hasAudio) {
      return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .outputOptions([
            '-vf', videoFilter,
            '-r', '30',
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '23',
            '-c:a', 'aac',
            '-ar', '44100',
            '-ac', '2',
            '-b:a', '128k',
            '-movflags', '+faststart',
            '-y'
          ])
          .on('start', cmd => console.log('Normalize:', cmd))
          .on('progress', p => {
            if (p.percent) console.log(`  Normalizing: ${Math.round(p.percent)}%`);
          })
          .on('end', () => {
            console.log('Normalized successfully');
            resolve(outputPath);
          })
          .on('error', reject)
          .save(outputPath);
      });
    } else {
      // Add silent audio
      console.log('Adding silent audio track');
      const filterComplex = `[0:v]${videoFilter}[v];anullsrc=r=44100:cl=stereo[a]`;
      
      return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .outputOptions([
            '-filter_complex', filterComplex,
            '-map', '[v]',
            '-map', '[a]',
            '-r', '30',
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '23',
            '-c:a', 'aac',
            '-ar', '44100',
            '-ac', '2',
            '-b:a', '128k',
            '-shortest',
            '-movflags', '+faststart',
            '-y'
          ])
          .on('start', cmd => console.log('Normalize (add audio):', cmd))
          .on('progress', p => {
            if (p.percent) console.log(`  Normalizing: ${Math.round(p.percent)}%`);
          })
          .on('end', () => {
            console.log('Normalized successfully (silent audio added)');
            resolve(outputPath);
          })
          .on('error', reject)
          .save(outputPath);
      });
    }
  }

  /**
   * Combine clips with reactions
   * 
   * SEQUENTIAL MODE: Clip 1 → Reaction 1 (full screen) → Clip 2 → Reaction 2 → ...
   * PIP MODE (Watch then React): Clip 1 → [Frozen Frame + Reaction 1 in corner] → Clip 2 → [Frozen Frame + Reaction 2 in corner] → ...
   */
  async combineClipsWithReactions(originalClips, reactionClips, jobId = null, options = {}) {
    jobId = jobId || uuidv4();
    const workDir = path.join(this.tempDir, jobId);
    await fs.ensureDir(workDir);

    const mode = options.mode || 'sequential';
    const targetWidth = options.targetWidth || 1080;
    const targetHeight = options.targetHeight || 1920;

    console.log(`\n${'='.repeat(50)}`);
    console.log(`COMBINE MODE: ${mode.toUpperCase()}`);
    console.log(`${'='.repeat(50)}\n`);

    try {
      if (!Array.isArray(originalClips) || originalClips.length === 0) {
        throw new Error('No original clips provided');
      }
      
      const reactions = Array.isArray(reactionClips) ? reactionClips : [];
      console.log(`Processing ${originalClips.length} clips with ${reactions.filter(r => r).length} reactions`);

      const processedClips = [];
      
      for (let i = 0; i < originalClips.length; i++) {
        const originalPath = originalClips[i];
        const reactionPath = reactions[i] || null;
        
        console.log(`\n${'─'.repeat(40)}`);
        console.log(`CLIP ${i + 1}/${originalClips.length}`);
        console.log(`${'─'.repeat(40)}`);
        console.log(`Original: ${originalPath}`);
        console.log(`Reaction: ${reactionPath || 'none'}`);
        
        // Verify original exists
        if (!await fs.pathExists(originalPath)) {
          console.error(`Original not found, skipping`);
          continue;
        }
        
        // Step 1: Normalize and add original clip (WATCH phase)
        const normalizedOriginalPath = path.join(workDir, `clip_${i}.mp4`);
        console.log('\n[WATCH] Normalizing original clip...');
        await this.normalizeClip(originalPath, normalizedOriginalPath, targetWidth, targetHeight);
        
        if (!await fs.pathExists(normalizedOriginalPath)) {
          console.error('Failed to normalize original, skipping');
          continue;
        }
        processedClips.push(normalizedOriginalPath);
        console.log(`✓ Added clip ${i + 1} (WATCH phase)`);
        
        // Step 2: If there's a reaction, create REACT phase
        const hasReaction = reactionPath && typeof reactionPath === 'string' && await fs.pathExists(reactionPath);
        
        if (hasReaction) {
          console.log('\n[REACT] Processing reaction...');
          
          // Normalize reaction first
          const normalizedReactionPath = path.join(workDir, `reaction_${i}.mp4`);
          
          try {
            await this.normalizeClip(reactionPath, normalizedReactionPath, targetWidth, targetHeight);
            
            if (!await fs.pathExists(normalizedReactionPath)) {
              throw new Error('Normalized reaction not created');
            }
            
            if (mode === 'pip') {
              // PIP MODE: Frozen frame + reaction overlay in corner
              const lastFramePath = path.join(workDir, `frame_${i}.jpg`);
              const reactSegmentPath = path.join(workDir, `react_segment_${i}.mp4`);
              
              // Extract last frame of the clip we just watched
              await this.extractLastFrame(normalizedOriginalPath, lastFramePath);
              
              // Create reaction segment (frozen frame + reaction in corner)
              await this.createReactionSegment(
                lastFramePath,
                normalizedReactionPath,
                reactSegmentPath,
                targetWidth,
                targetHeight
              );
              
              if (await fs.pathExists(reactSegmentPath)) {
                const stats = await fs.stat(reactSegmentPath);
                if (stats.size > 1000) {
                  processedClips.push(reactSegmentPath);
                  console.log(`✓ Added reaction ${i + 1} (REACT phase - PiP)`);
                } else {
                  throw new Error('Reaction segment too small');
                }
              } else {
                throw new Error('Reaction segment not created');
              }
              
              // Cleanup frame
              await fs.remove(lastFramePath).catch(() => {});
              
            } else {
              // SEQUENTIAL MODE: Full screen reaction
              processedClips.push(normalizedReactionPath);
              console.log(`✓ Added reaction ${i + 1} (REACT phase - full screen)`);
            }
          } catch (err) {
            console.error(`Reaction processing failed: ${err.message}`);
          }
        }
      }

      if (processedClips.length === 0) {
        throw new Error('No clips processed successfully');
      }

      console.log(`\n${'─'.repeat(40)}`);
      console.log(`FINAL SEQUENCE (${processedClips.length} segments):`);
      console.log(`${'─'.repeat(40)}`);
      processedClips.forEach((p, i) => {
        console.log(`  ${i + 1}. ${path.basename(p)}`);
      });

      // Create concat file
      const concatPath = path.join(workDir, 'concat.txt');
      const concatContent = processedClips.map(p => `file '${p}'`).join('\n');
      await fs.writeFile(concatPath, concatContent);

      // Concatenate
      const outputPath = path.join(workDir, 'final_combined.mp4');
      await this.concatenateClips(concatPath, outputPath);

      if (!await fs.pathExists(outputPath)) {
        throw new Error('Final video not created');
      }
      
      const stats = await fs.stat(outputPath);
      console.log(`\n✓ FINAL VIDEO: ${(stats.size/1024/1024).toFixed(2)} MB`);

      return {
        jobId,
        mode,
        outputPath,
        segmentCount: processedClips.length,
        originalCount: originalClips.length,
        reactionCount: reactions.filter(c => c).length,
        fileSize: stats.size,
        downloadUrl: `/api/combine/${jobId}/download`
      };

    } catch (error) {
      console.error('Combine error:', error);
      await fs.remove(workDir).catch(() => {});
      throw error;
    }
  }

  async concatenateClips(concatFilePath, outputPath) {
    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatFilePath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-c', 'copy', '-movflags', '+faststart', '-y'])
        .on('start', cmd => console.log('Concat:', cmd))
        .on('progress', p => {
          if (p.percent) console.log(`  Concat: ${Math.round(p.percent)}%`);
        })
        .on('end', () => {
          console.log('Concatenation complete');
          resolve(outputPath);
        })
        .on('error', reject)
        .save(outputPath);
    });
  }

  getOutputPath(jobId) {
    return path.join(this.tempDir, jobId, 'final_combined.mp4');
  }

  async cleanup(jobId) {
    const workDir = path.join(this.tempDir, jobId);
    await fs.remove(workDir);
    console.log(`Cleaned up job: ${jobId}`);
  }
}

module.exports = new CombineService();
