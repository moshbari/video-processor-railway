const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

class SplitService {
  constructor() {
    this.outputDir = process.env.OUTPUT_DIR || '/app/outputs';
    this.tempDir = process.env.TEMP_DIR || '/app/temp';
  }

  async splitVideoForReactions(videoPath, reactions) {
    const jobId = uuidv4();
    const workDir = path.join(this.tempDir, jobId);
    const clipsDir = path.join(workDir, 'clips');
    await fs.ensureDir(clipsDir);

    try {
      console.log(`Splitting video into clips...`);
      console.log(`Job ID: ${jobId}`);
      console.log(`Clips directory: ${clipsDir}`);
      console.log(`Using PRECISE CUTS (re-encode mode)`);

      const sortedReactions = reactions.sort((a, b) => a.timestamp - b.timestamp);

      const clips = [];
      const reactionGuide = [];
      let currentTime = 0;
      let clipNumber = 0;

      for (let i = 0; i < sortedReactions.length; i++) {
        const reaction = sortedReactions[i];
        const duration = reaction.timestamp - currentTime;
        
        if (duration <= 0.5) {
          console.log(`Skipping empty/tiny segment: ${currentTime}s to ${reaction.timestamp}s (${duration}s)`);
          currentTime = reaction.timestamp;
          
          reactionGuide.push({
            afterClip: clipNumber > 0 ? clipNumber : 1,
            timestamp: reaction.timestamp,
            text: reaction.text,
            sentiment: reaction.sentiment || 'NEUTRAL'
          });
          continue;
        }
        
        clipNumber++;
        const clipFilename = `clip_${clipNumber}.mp4`;
        const clipPath = path.join(clipsDir, clipFilename);
        
        console.log(`Creating clip ${clipNumber}: ${currentTime}s to ${reaction.timestamp}s (${duration}s)`);
        
        await this.extractClipPrecise(videoPath, currentTime, duration, clipPath);
        
        clips.push({
          number: clipNumber,
          path: clipPath,
          filename: clipFilename,
          startTime: currentTime,
          endTime: reaction.timestamp,
          duration: duration
        });

        reactionGuide.push({
          afterClip: clipNumber,
          timestamp: reaction.timestamp,
          text: reaction.text,
          sentiment: reaction.sentiment || 'NEUTRAL'
        });

        currentTime = reaction.timestamp;
      }

      clipNumber++;
      const finalClipFilename = `clip_${clipNumber}.mp4`;
      const finalClipPath = path.join(clipsDir, finalClipFilename);
      
      console.log(`Creating final clip ${clipNumber}: ${currentTime}s to end`);
      
      await this.extractClipPrecise(videoPath, currentTime, null, finalClipPath);

      clips.push({
        number: clipNumber,
        path: finalClipPath,
        filename: finalClipFilename,
        startTime: currentTime,
        endTime: null,
        duration: null
      });

      console.log(`✓ Created ${clips.length} clips in ${clipsDir}`);

      const guideText = this.createReactionsGuide(reactionGuide);
      const guideFilename = 'reactions_guide.txt';
      const guidePath = path.join(clipsDir, guideFilename);
      await fs.writeFile(guidePath, guideText);

      const outputClips = clips.map(clip => ({
        number: clip.number,
        filename: clip.filename,
        startTime: clip.startTime,
        endTime: clip.endTime,
        duration: clip.duration,
        downloadUrl: `/api/split/${jobId}/clip/${clip.number}`
      }));

      console.log(`Split job ${jobId} complete. Clips available for 24 hours.`);

      return {
        jobId,
        totalClips: clips.length,
        clips: outputClips,
        reactionGuide,
        guideDownloadUrl: `/api/split/${jobId}/guide`,
        success: true
      };

    } catch (error) {
      console.error('Split video error:', error);
      await fs.remove(workDir).catch(() => {});
      throw error;
    }
  }

  /**
   * Extract clip with PRECISE cuts using re-encoding
   * This ensures no overlap between clips
   */
  extractClipPrecise(videoPath, startTime, duration, outputPath) {
    return new Promise((resolve, reject) => {
      if (duration !== null && duration <= 0.5) {
        console.log(`Skipping very short clip: ${duration}s`);
        return resolve(outputPath);
      }

      // Use -ss before -i for fast seeking, then re-encode for precision
      const command = ffmpeg(videoPath)
        .seekInput(startTime);  // Fast seek before input

      if (duration !== null && duration > 0) {
        command.duration(duration);
      }

      // Re-encode for precise frame-accurate cuts
      command
        .outputOptions([
          '-c:v', 'libx264',      // Re-encode video
          '-preset', 'fast',      // Fast encoding
          '-crf', '23',           // Good quality
          '-c:a', 'aac',          // Re-encode audio
          '-ar', '44100',         // Audio sample rate
          '-ac', '2',             // Stereo
          '-b:a', '128k',         // Audio bitrate
          '-avoid_negative_ts', 'make_zero',
          '-y'
        ])
        .on('start', cmd => {
          const endStr = duration ? `${startTime + duration}s` : 'end';
          console.log(`Extracting clip: ${startTime}s to ${endStr}`);
        })
        .on('end', () => {
          console.log(`✓ Clip created: ${outputPath}`);
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error(`Clip extraction error:`, err);
          reject(err);
        })
        .save(outputPath);
    });
  }

  createReactionsGuide(reactionGuide) {
    let guide = '='.repeat(60) + '\n';
    guide += 'REACTIONS GUIDE FOR CAPCUT\n';
    guide += '='.repeat(60) + '\n\n';
    guide += 'Instructions:\n';
    guide += '1. Import all clips into CapCut in order (clip_1, clip_2, etc.)\n';
    guide += '2. Record your reaction after each clip using the text below\n';
    guide += '3. Insert your reaction video between the clips\n';
    guide += '4. Export your final reaction video!\n\n';
    guide += '='.repeat(60) + '\n\n';

    reactionGuide.forEach((reaction, index) => {
      guide += `AFTER CLIP ${reaction.afterClip}:\n`;
      guide += `Timestamp: ${this.formatTimestamp(reaction.timestamp)}\n`;
      guide += `Sentiment: ${reaction.sentiment}\n`;
      guide += `\nWhat to say:\n`;
      guide += `"${reaction.text}"\n\n`;
      guide += '-'.repeat(60) + '\n\n';
    });

    guide += '\nTIPS:\n';
    guide += '• Keep reactions 2-5 seconds for best pacing\n';
    guide += '• Match your energy to the sentiment (POSITIVE = excited, NEGATIVE = critical)\n';
    guide += '• Feel free to improvise and add your own personality!\n';
    guide += '• Use CapCut\'s text overlay feature to add captions if needed\n';

    return guide;
  }

  formatTimestamp(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  getClipPath(jobId, clipNumber) {
    return path.join(this.tempDir, jobId, 'clips', `clip_${clipNumber}.mp4`);
  }

  getGuidePath(jobId) {
    return path.join(this.tempDir, jobId, 'clips', 'reactions_guide.txt');
  }
}

module.exports = new SplitService();
