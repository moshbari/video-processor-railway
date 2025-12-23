const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const { exec } = require('child_process');

class RenderService {
  constructor() {
    this.outputDir = process.env.OUTPUT_DIR || '/app/outputs';
    this.tempDir = process.env.TEMP_DIR || '/app/temp';
  }

  /**
   * Main render function - creates reaction video
   */
  async renderVideo(config) {
    const {
      videoPath,
      transcript,
      reactions = [],
      cuts = [],
      outputFilename = null,
      renderStyle = 'pause-and-react' // 'pause-and-react' or 'simple-overlay'
    } = config;

    const jobId = uuidv4();
    const workDir = path.join(this.tempDir, jobId);
    await fs.ensureDir(workDir);

    try {
      console.log(`Starting render job: ${jobId}`);
      console.log(`Render style: ${renderStyle}`);

      // Step 1: Process cuts if specified
      let processedVideo = videoPath;
      if (cuts && cuts.length > 0) {
        console.log(`Applying ${cuts.length} cuts...`);
        processedVideo = await this.applyCuts(videoPath, cuts, workDir);
      }

      // Step 2: Add reactions
      if (reactions && reactions.length > 0) {
        console.log(`Adding ${reactions.length} reactions...`);
        
        if (renderStyle === 'pause-and-react') {
          processedVideo = await this.addReactionsPauseAndReact(processedVideo, reactions, workDir);
        } else {
          processedVideo = await this.addReactionsSimple(processedVideo, reactions, workDir);
        }
      }

      // Step 3: Move to output directory
      const outputFilePath = path.join(
        this.outputDir, 
        outputFilename || `rendered_${jobId}.mp4`
      );
      await fs.move(processedVideo, outputFilePath, { overwrite: true });

      console.log(`Render complete: ${outputFilePath}`);

      return {
        jobId,
        outputPath: outputFilePath,
        filename: path.basename(outputFilePath),
        success: true
      };

    } catch (error) {
      console.error('Render error:', error);
      throw new Error(`Render failed: ${error.message}`);
    } finally {
      // Cleanup work directory
      setTimeout(() => {
        fs.remove(workDir).catch(console.error);
      }, 5000);
    }
  }

  /**
   * Apply cuts to video
   */
  async applyCuts(videoPath, cuts, workDir) {
    return new Promise((resolve, reject) => {
      const outputPath = path.join(workDir, 'cut_video.mp4');
      
      const sortedCuts = cuts.sort((a, b) => a.start - b.start);

      let filterComplex = '';
      let concatInputs = '';

      sortedCuts.forEach((cut, index) => {
        filterComplex += `[0:v]trim=${cut.start}:${cut.end},setpts=PTS-STARTPTS[v${index}];`;
        filterComplex += `[0:a]atrim=${cut.start}:${cut.end},asetpts=PTS-STARTPTS[a${index}];`;
        concatInputs += `[v${index}][a${index}]`;
      });

      filterComplex += `${concatInputs}concat=n=${sortedCuts.length}:v=1:a=1[outv][outa]`;

      ffmpeg(videoPath)
        .complexFilter(filterComplex)
        .map('[outv]')
        .map('[outa]')
        .outputOptions([
          '-c:v libx264',
          '-preset medium',
          '-crf 23',
          '-c:a aac',
          '-b:a 128k'
        ])
        .on('start', cmd => console.log('FFmpeg command:', cmd))
        .on('progress', progress => {
          if (progress.percent) {
            console.log(`Cutting progress: ${progress.percent.toFixed(1)}%`);
          }
        })
        .on('end', () => resolve(outputPath))
        .on('error', reject)
        .save(outputPath);
    });
  }

  /**
   * Add reactions with PAUSE-AND-REACT style
   * Video pauses, shows darkened frame with text, then resumes
   */
  async addReactionsPauseAndReact(videoPath, reactions, workDir) {
    return new Promise(async (resolve, reject) => {
      try {
        const outputPath = path.join(workDir, 'with_reactions.mp4');
        const segmentsDir = path.join(workDir, 'segments');
        await fs.ensureDir(segmentsDir);

        const sortedReactions = reactions.sort((a, b) => a.timestamp - b.timestamp);
        
        console.log('Creating pause-and-react video with segment approach');
        console.log(`Processing ${sortedReactions.length} reactions`);

        const segmentFiles = [];
        let currentTime = 0;

        for (let i = 0; i < sortedReactions.length; i++) {
          const reaction = sortedReactions[i];
          const reactionDuration = reaction.duration || 3;

          // Create video segment before this reaction
          if (reaction.timestamp > currentTime) {
            const videoSegmentPath = path.join(segmentsDir, `video_${i}.mp4`);
            console.log(`Creating video segment ${i}: ${currentTime}s to ${reaction.timestamp}s`);
            
            await this.createVideoSegment(
              videoPath,
              currentTime,
              reaction.timestamp,
              videoSegmentPath
            );
            
            segmentFiles.push(videoSegmentPath);
          }

          // Create reaction segment (freeze frame with text)
          const reactionSegmentPath = path.join(segmentsDir, `reaction_${i}.mp4`);
          console.log(`Creating reaction segment ${i}: ${reactionDuration}s at ${reaction.timestamp}s`);
          
          await this.createReactionSegment(
            videoPath,
            reaction.timestamp,
            reaction.text,
            reactionDuration,
            reactionSegmentPath
          );
          
          segmentFiles.push(reactionSegmentPath);
          currentTime = reaction.timestamp;
        }

        // Create final video segment (after last reaction to end)
        const finalSegmentPath = path.join(segmentsDir, `video_final.mp4`);
        console.log(`Creating final video segment from ${currentTime}s to end`);
        
        await this.createVideoSegment(
          videoPath,
          currentTime,
          999999,
          finalSegmentPath
        );
        
        segmentFiles.push(finalSegmentPath);

        // Concatenate all segments
        console.log(`Concatenating ${segmentFiles.length} segments...`);
        await this.concatenateSegments(segmentFiles, outputPath);

        console.log('Pause-and-react video complete!');
        resolve(outputPath);

      } catch (error) {
        console.error('Pause-and-react error:', error);
        reject(error);
      }
    });
  }

  /**
   * Create a video segment (trim from start to end)
   */
  createVideoSegment(videoPath, startTime, endTime, outputPath) {
    return new Promise((resolve, reject) => {
      const duration = endTime - startTime;
      
      // Skip if duration is too short
      if (duration < 0.1) {
        console.log(`Skipping very short segment: ${duration}s`);
        return resolve(outputPath);
      }

      ffmpeg(videoPath)
        .setStartTime(startTime)
        .setDuration(duration)
        .outputOptions([
          '-c:v libx264',
          '-preset ultrafast',
          '-c:a aac'
        ])
        .on('start', cmd => console.log(`Video segment FFmpeg started`))
        .on('end', () => {
          console.log(`Video segment created: ${outputPath}`);
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error(`Video segment error:`, err);
          reject(err);
        })
        .save(outputPath);
    });
  }

  /**
   * Create a reaction segment (freeze frame with text overlay)
   * Using direct exec to avoid fluent-ffmpeg audio filter bugs
   */
  createReactionSegment(videoPath, freezeTime, text, duration, outputPath) {
    return new Promise((resolve, reject) => {
      const cleanText = text
        .replace(/['"\\]/g, '')
        .replace(/:/g, ' ')
        .replace(/\n/g, ' ')
        .substring(0, 120);

      const tempImagePath = outputPath.replace('.mp4', '.jpg');

      console.log(`Extracting frame at ${freezeTime}s for reaction segment...`);
      
      // Step 1: Extract frame
      ffmpeg(videoPath)
        .seekInput(freezeTime)
        .frames(1)
        .outputOptions(['-vf', 'eq=brightness=-0.15'])
        .on('start', cmd => console.log(`Frame extraction: ${cmd.substring(0, 150)}...`))
        .on('end', () => {
          // Verify temp image was created
          if (!fs.existsSync(tempImagePath)) {
            console.error(`Temp image not created: ${tempImagePath}`);
            return reject(new Error('Failed to extract frame - image not created'));
          }
          
          console.log(`Frame extracted successfully: ${tempImagePath}`);
          
          // Step 2: Create video with text and audio using direct FFmpeg command
          const ffmpegCmd = `ffmpeg -loop 1 -i "${tempImagePath}" ` +
            `-f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 ` +
            `-vf "drawtext=text='${cleanText}':fontsize=48:fontcolor=white:bordercolor=black:borderw=4:x=(w-text_w)/2:y=(h-text_h)/2" ` +
            `-t ${duration} ` +
            `-c:v libx264 -preset ultrafast -pix_fmt yuv420p ` +
            `-c:a aac -shortest ` +
            `-y "${outputPath}"`;
          
          console.log('Creating reaction video segment with FFmpeg...');
          
          exec(ffmpegCmd, (error, stdout, stderr) => {
            // Cleanup temp image
            fs.remove(tempImagePath).catch(err => console.error('Cleanup error:', err));
            
            if (error) {
              console.error('FFmpeg exec error:', stderr.substring(0, 500));
              return reject(new Error(`FFmpeg failed: ${stderr.substring(0, 200)}`));
            }
            
            // Verify output was created
            if (!fs.existsSync(outputPath)) {
              console.error(`Output not created: ${outputPath}`);
              return reject(new Error('Failed to create reaction segment - output not found'));
            }
            
            console.log(`Reaction segment created successfully: ${outputPath}`);
            resolve(outputPath);
          });
        })
        .on('error', (err) => {
          console.error(`Frame extraction failed at ${freezeTime}s:`, err.message);
          fs.remove(tempImagePath).catch(console.error);
          reject(new Error(`Frame extraction failed at ${freezeTime}s: ${err.message}`));
        })
        .save(tempImagePath);
    });
  }

  /**
   * Concatenate multiple video segments
   */
  concatenateSegments(segmentFiles, outputPath) {
    return new Promise((resolve, reject) => {
      const concatListPath = path.join(path.dirname(outputPath), 'concat_list.txt');
      const concatContent = segmentFiles
        .map(file => `file '${file}'`)
        .join('\n');
      
      fs.writeFileSync(concatListPath, concatContent);
      console.log(`Concat list created with ${segmentFiles.length} files`);

      ffmpeg()
        .input(concatListPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions([
          '-c', 'copy',
          '-movflags', '+faststart'
        ])
        .on('start', cmd => console.log('Concatenating segments...'))
        .on('progress', progress => {
          if (progress.percent) {
            console.log(`Concatenation progress: ${progress.percent.toFixed(1)}%`);
          }
        })
        .on('end', () => {
          fs.remove(concatListPath).catch(console.error);
          console.log('Concatenation complete');
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error('Concatenation error:', err);
          fs.remove(concatListPath).catch(console.error);
          reject(err);
        })
        .save(outputPath);
    });
  }

  /**
   * Simple text overlay (no pause) - for backward compatibility
   */
  async addReactionsSimple(videoPath, reactions, workDir) {
    return new Promise((resolve, reject) => {
      const outputPath = path.join(workDir, 'with_reactions.mp4');

      const sortedReactions = reactions.sort((a, b) => a.timestamp - b.timestamp);

      console.log('Using simple text overlay rendering');

      const textOverlays = sortedReactions.map((reaction) => {
        const cleanText = reaction.text
          .replace(/['"]/g, '')
          .replace(/:/g, ' ')
          .replace(/\\/g, '')
          .substring(0, 100);

        const start = reaction.timestamp;
        const duration = reaction.duration || 3;
        const end = start + duration;
        
        return `drawtext=text='${cleanText}':fontsize=32:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=5:x=(w-text_w)/2:y=h-100:enable='between(t,${start},${end})'`;
      }).join(',');

      ffmpeg(videoPath)
        .videoFilters(textOverlays)
        .outputOptions([
          '-c:v libx264',
          '-preset medium',
          '-crf 23',
          '-c:a copy',
          '-movflags +faststart'
        ])
        .on('progress', progress => {
          if (progress.percent) {
            console.log(`Rendering progress: ${progress.percent.toFixed(1)}%`);
          }
        })
        .on('end', () => resolve(outputPath))
        .on('error', reject)
        .save(outputPath);
    });
  }

  /**
   * Legacy addReactions function
   */
  async addReactions(videoPath, reactions, workDir) {
    return this.addReactionsPauseAndReact(videoPath, reactions, workDir);
  }

  /**
   * Mix audio with video
   */
  async mixAudio(videoPath, audioPath, workDir, startTime = 0) {
    return new Promise((resolve, reject) => {
      const outputPath = path.join(workDir, `mixed_${Date.now()}.mp4`);

      ffmpeg()
        .input(videoPath)
        .input(audioPath)
        .complexFilter([
          `[1:a]adelay=${startTime * 1000}|${startTime * 1000}[delayed]`,
          '[0:a][delayed]amix=inputs=2:duration=first[aout]'
        ])
        .outputOptions([
          '-map 0:v',
          '-map [aout]',
          '-c:v copy',
          '-c:a aac',
          '-b:a 128k'
        ])
        .on('end', () => resolve(outputPath))
        .on('error', reject)
        .save(outputPath);
    });
  }

  /**
   * Get video metadata
   */
  async getVideoInfo(videoPath) {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) return reject(err);
        
        const videoStream = metadata.streams.find(s => s.codec_type === 'video');
        const audioStream = metadata.streams.find(s => s.codec_type === 'audio');

        resolve({
          duration: metadata.format.duration,
          size: metadata.format.size,
          bitrate: metadata.format.bit_rate,
          format: metadata.format.format_name,
          video: videoStream ? {
            codec: videoStream.codec_name,
            width: videoStream.width,
            height: videoStream.height,
            fps: eval(videoStream.r_frame_rate)
          } : null,
          audio: audioStream ? {
            codec: audioStream.codec_name,
            sampleRate: audioStream.sample_rate,
            channels: audioStream.channels
          } : null
        });
      });
    });
  }

  /**
   * Create thumbnail from video
   */
  async createThumbnail(videoPath, outputPath, timestamp = '00:00:01') {
    return new Promise((resolve, reject) => {
      ffmpeg(videoPath)
        .screenshots({
          timestamps: [timestamp],
          filename: path.basename(outputPath),
          folder: path.dirname(outputPath),
          size: '640x360'
        })
        .on('end', () => resolve(outputPath))
        .on('error', reject);
    });
  }
}

module.exports = new RenderService();