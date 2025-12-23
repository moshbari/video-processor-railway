const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

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
      outputFilename = null
    } = config;

    const jobId = uuidv4();
    const workDir = path.join(this.tempDir, jobId);
    await fs.ensureDir(workDir);

    try {
      console.log(`Starting render job: ${jobId}`);

      // Step 1: Process cuts if specified
      let processedVideo = videoPath;
      if (cuts && cuts.length > 0) {
        console.log(`Applying ${cuts.length} cuts...`);
        processedVideo = await this.applyCuts(videoPath, cuts, workDir);
      }

      // Step 2: Add reactions with pause-and-react style
      if (reactions && reactions.length > 0) {
        console.log(`Adding ${reactions.length} reactions with pause-and-react style...`);
        processedVideo = await this.addReactionsPauseAndReact(processedVideo, reactions, workDir);
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
      
      // Sort cuts by start time
      const sortedCuts = cuts.sort((a, b) => a.start - b.start);

      // Create filter complex for cuts
      let filterComplex = '';
      let concatInputs = '';

      sortedCuts.forEach((cut, index) => {
        const duration = cut.end - cut.start;
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
    return new Promise((resolve, reject) => {
      const outputPath = path.join(workDir, 'with_reactions.mp4');

      // Sort reactions by timestamp
      const sortedReactions = reactions.sort((a, b) => a.timestamp - b.timestamp);

      // Build video segments
      const segments = [];
      let currentTime = 0;

      sortedReactions.forEach((reaction, index) => {
        // Add video segment before this reaction
        if (reaction.timestamp > currentTime) {
          segments.push({
            type: 'video',
            start: currentTime,
            end: reaction.timestamp
          });
        }

        // Add reaction segment (freeze frame + text + audio)
        segments.push({
          type: 'reaction',
          freezeAt: reaction.timestamp,
          text: reaction.text,
          audioUrl: reaction.audioUrl,
          duration: reaction.duration || 3
        });

        currentTime = reaction.timestamp + (reaction.duration || 3);
      });

      // Add final video segment (from last reaction to end)
      segments.push({
        type: 'video',
        start: currentTime,
        end: 999999 // To end
      });

      console.log('Segments to create:', JSON.stringify(segments, null, 2));

      // Build FFmpeg filter_complex
      let filterComplex = '';
      let concatInputs = '';
      let segmentIndex = 0;

      segments.forEach((segment) => {
        if (segment.type === 'video') {
          // Video segment: trim and pass through
          filterComplex += `[0:v]trim=${segment.start}:${segment.end},setpts=PTS-STARTPTS[v${segmentIndex}];`;
          filterComplex += `[0:a]atrim=${segment.start}:${segment.end},asetpts=PTS-STARTPTS[a${segmentIndex}];`;
          concatInputs += `[v${segmentIndex}][a${segmentIndex}]`;
          segmentIndex++;

        } else if (segment.type === 'reaction') {
          // Reaction segment: freeze frame + darken + text overlay
          const freezeTime = segment.freezeAt;
          const duration = segment.duration;
          const text = this.escapeText(segment.text);
          const fps = 30;
          const numFrames = Math.ceil(duration * fps);

          // Extract freeze frame, loop it, darken it, add text
          filterComplex += `[0:v]trim=${freezeTime}:${freezeTime + 0.1},setpts=PTS-STARTPTS,`;
          filterComplex += `loop=loop=${numFrames}:size=1,setpts=N/(${fps}*TB),`;
          
          // Darken the frame (reduce brightness)
          filterComplex += `eq=brightness=-0.2,`;
          
          // Add text overlay with word wrapping
          filterComplex += `drawtext=text='${text}':`;
          filterComplex += `fontsize=40:fontcolor=white:bordercolor=black:borderw=4:`;
          filterComplex += `x=(w-text_w)/2:y=(h-text_h)/2:`;
          filterComplex += `line_spacing=10,`;
          filterComplex += `trim=duration=${duration}[v${segmentIndex}];`;

          // Silent audio for reaction duration
          filterComplex += `aevalsrc=0:d=${duration}[a${segmentIndex}];`;

          concatInputs += `[v${segmentIndex}][a${segmentIndex}]`;
          segmentIndex++;
        }
      });

      // Concatenate all segments
      const numSegments = segmentIndex;
      filterComplex += `${concatInputs}concat=n=${numSegments}:v=1:a=1[outv][outa]`;

      console.log('FFmpeg filter_complex:', filterComplex);

      // Execute FFmpeg
      ffmpeg(videoPath)
        .complexFilter(filterComplex)
        .map('[outv]')
        .map('[outa]')
        .outputOptions([
          '-c:v libx264',
          '-preset medium',
          '-crf 23',
          '-c:a aac',
          '-b:a 128k',
          '-movflags +faststart'
        ])
        .on('start', cmd => console.log('FFmpeg command:', cmd))
        .on('progress', progress => {
          if (progress.percent) {
            console.log(`Rendering progress: ${progress.percent.toFixed(1)}%`);
          }
        })
        .on('end', () => {
          console.log('Pause-and-react rendering complete!');
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error('FFmpeg error:', err);
          reject(err);
        })
        .save(outputPath);
    });
  }

  /**
   * Legacy addReactions for backward compatibility
   */
  async addReactions(videoPath, reactions, workDir) {
    // Use the new pause-and-react style by default
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

  /**
   * Escape text for FFmpeg drawtext filter
   */
  escapeText(text) {
    return text
      .replace(/\\/g, '\\\\\\\\')
      .replace(/'/g, "'\\\\\\\\\\\\''")
      .replace(/:/g, '\\\\:')
      .replace(/\n/g, ' ')
      .replace(/\[/g, '\\\\[')
      .replace(/\]/g, '\\\\]');
  }
}

module.exports = new RenderService();