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
   * Returns individual clips that user can download separately (faster!)
   */
  async splitVideoForReactions(videoPath, reactions) {
    const jobId = uuidv4();
    const workDir = path.join(this.tempDir, jobId);
    const clipsDir = path.join(workDir, 'clips');
    await fs.ensureDir(clipsDir);

    try {
      console.log(`Splitting video into ${reactions.length + 1} clips...`);

      // Sort reactions by timestamp
      const sortedReactions = reactions.sort((a, b) => a.timestamp - b.timestamp);

      const clips = [];
      const reactionGuide = [];
      let currentTime = 0;

      // Create clips between reactions
      for (let i = 0; i < sortedReactions.length; i++) {
        const reaction = sortedReactions[i];
        
        // Create video clip before this reaction
        const clipNumber = i + 1;
        const clipFilename = `clip_${clipNumber}.mp4`;
        const clipPath = path.join(clipsDir, clipFilename);
        
        console.log(`Creating clip ${clipNumber}: ${currentTime}s to ${reaction.timestamp}s`);
        
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
          duration: reaction.timestamp - currentTime
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
      const finalClipNumber = sortedReactions.length + 1;
      const finalClipFilename = `clip_${finalClipNumber}.mp4`;
      const finalClipPath = path.join(clipsDir, finalClipFilename);
      
      console.log(`Creating final clip ${finalClipNumber}: ${currentTime}s to end`);
      
      await this.extractClip(
        videoPath,
        currentTime,
        999999, // to end
        finalClipPath
      );

      clips.push({
        number: finalClipNumber,
        path: finalClipPath,
        filename: finalClipFilename,
        startTime: currentTime,
        endTime: null,
        duration: null
      });

      console.log(`✓ Created ${clips.length} clips`);

      // Create reactions guide text file
      const guideText = this.createReactionsGuide(reactionGuide);
      const guideFilename = 'reactions_guide.txt';
      const guidePath = path.join(clipsDir, guideFilename);
      await fs.writeFile(guidePath, guideText);

      // Move clips to output directory for individual download
      const outputClips = [];
      for (const clip of clips) {
        const outputPath = path.join(this.outputDir, `${jobId}_${clip.filename}`);
        await fs.move(clip.path, outputPath);
        outputClips.push({
          number: clip.number,
          filename: clip.filename,
          startTime: clip.startTime,
          endTime: clip.endTime,
          duration: clip.duration,
          downloadUrl: `/api/split/${jobId}/clip/${clip.number}`
        });
      }

      // Move guide to output
      const outputGuidePath = path.join(this.outputDir, `${jobId}_${guideFilename}`);
      await fs.move(guidePath, outputGuidePath);

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
      throw error;
    } finally {
      // Cleanup work directory after 10 seconds
      setTimeout(() => {
        fs.remove(workDir).catch(console.error);
      }, 10000);
    }
  }

  /**
   * Extract a single clip from video - FAST VERSION with copy codec
   */
  extractClip(videoPath, startTime, endTime, outputPath) {
    return new Promise((resolve, reject) => {
      const duration = endTime === 999999 ? undefined : endTime - startTime;

      // Skip very short clips
      if (duration && duration < 0.5) {
        console.log(`Skipping very short clip: ${duration}s`);
        return resolve(outputPath);
      }

      const command = ffmpeg(videoPath)
        .setStartTime(startTime);

      if (duration) {
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
   */
  getClipPath(jobId, clipNumber) {
    return path.join(this.outputDir, `${jobId}_clip_${clipNumber}.mp4`);
  }

  /**
   * Get guide file path by job ID
   */
  getGuidePath(jobId) {
    return path.join(this.outputDir, `${jobId}_reactions_guide.txt`);
  }
}

module.exports = new SplitService();
