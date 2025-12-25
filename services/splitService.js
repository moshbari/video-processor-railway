const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

class SplitService {
  constructor() {
    this.outputDir = process.env.OUTPUT_DIR || '/app/outputs';
    this.tempDir = process.env.TEMP_DIR || '/app/temp';
  }

  /**
   * Split video at reaction timestamps
   * Returns individual clips that user can download separately
   * Clips stay in temp directory for combine feature to use
   */
  async splitVideoForReactions(videoPath, reactions) {
    const jobId = uuidv4();
    const workDir = path.join(this.tempDir, jobId);
    const clipsDir = path.join(workDir, 'clips');
    await fs.ensureDir(clipsDir);

    try {
      console.log(`Splitting video into clips...`);
      console.log(`Job ID: ${jobId}`);
      console.log(`Clips directory: ${clipsDir}`);

      // Sort reactions by timestamp
      const sortedReactions = reactions.sort((a, b) => a.timestamp - b.timestamp);

      const clips = [];
      const reactionGuide = [];
      let currentTime = 0;
      let clipNumber = 0;

      // Create clips between reactions
      for (let i = 0; i < sortedReactions.length; i++) {
        const reaction = sortedReactions[i];
        const duration = reaction.timestamp - currentTime;
        
        // Skip if no actual content before this reaction (duration <= 0.5s)
        if (duration <= 0.5) {
          console.log(`Skipping empty/tiny segment: ${currentTime}s to ${reaction.timestamp}s (${duration}s)`);
          currentTime = reaction.timestamp;
          
          // Still add reaction guide entry
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
        
        await this.extractClip(
          videoPath,
          currentTime,
          reaction.timestamp,
          clipPath
        );
        
        clips.push({
          number: clipNumber,
          path: clipPath,
          filename: clipFilename,
          startTime: currentTime,
          endTime: reaction.timestamp,
          duration: duration
        });

        // Add reaction guide
        reactionGuide.push({
          afterClip: clipNumber,
          timestamp: reaction.timestamp,
          text: reaction.text,
          sentiment: reaction.sentiment || 'NEUTRAL'
        });

        currentTime = reaction.timestamp;
      }

      // Create final clip (after last reaction to end)
      clipNumber++;
      const finalClipFilename = `clip_${clipNumber}.mp4`;
      const finalClipPath = path.join(clipsDir, finalClipFilename);
      
      console.log(`Creating final clip ${clipNumber}: ${currentTime}s to end`);
      
      await this.extractClip(
        videoPath,
        currentTime,
        999999, // to end
        finalClipPath
      );

      clips.push({
        number: clipNumber,
        path: finalClipPath,
        filename: finalClipFilename,
        startTime: currentTime,
        endTime: null,
        duration: null
      });

      console.log(`✓ Created ${clips.length} clips in ${clipsDir}`);

      // Create reactions guide text file
      const guideText = this.createReactionsGuide(reactionGuide);
      const guideFilename = 'reactions_guide.txt';
      const guidePath = path.join(clipsDir, guideFilename);
      await fs.writeFile(guidePath, guideText);

      // Build response with download URLs
      // Clips STAY in temp directory so combine feature can use them
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
      // Cleanup on error
      await fs.remove(workDir).catch(() => {});
      throw error;
    }
    // NO cleanup here - let cleanup service handle it after 24 hours
  }

  /**
   * Extract a single clip from video - FAST VERSION with copy codec
   */
  extractClip(videoPath, startTime, endTime, outputPath) {
    return new Promise((resolve, reject) => {
      const duration = endTime === 999999 ? undefined : endTime - startTime;

      // Skip clips with no duration or very short duration
      if (duration !== undefined && duration <= 0.5) {
        console.log(`Skipping very short clip: ${duration}s`);
        return resolve(outputPath);
      }

      const command = ffmpeg(videoPath)
        .setStartTime(startTime);

      // Only set duration if we have a valid one (not going to end of file)
      if (duration !== undefined && duration > 0) {
        command.setDuration(duration);
      }

      command
        .outputOptions([
          '-c copy',  // FAST: Just copy streams, don't re-encode!
          '-avoid_negative_ts make_zero'  // Fix timing issues
        ])
        .on('start', cmd => console.log(`Extracting clip: ${startTime}s to ${endTime === 999999 ? 'end' : endTime + 's'}`))
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

  /**
   * Create reactions guide text file
   */
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

  /**
   * Format timestamp for display
   */
  formatTimestamp(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  /**
   * Get clip file path by job ID and clip number
   * Now reads from temp directory
   */
  getClipPath(jobId, clipNumber) {
    return path.join(this.tempDir, jobId, 'clips', `clip_${clipNumber}.mp4`);
  }

  /**
   * Get guide file path by job ID
   * Now reads from temp directory
   */
  getGuidePath(jobId) {
    return path.join(this.tempDir, jobId, 'clips', 'reactions_guide.txt');
  }
}

module.exports = new SplitService();
