const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');

class SplitService {
  constructor() {
    this.outputDir = process.env.OUTPUT_DIR || '/app/outputs';
    this.tempDir = process.env.TEMP_DIR || '/app/temp';
  }

  /**
   * Split video at reaction timestamps
   * Returns individual clips that user can edit in CapCut
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
        const clipPath = path.join(clipsDir, `clip_${clipNumber}.mp4`);
        
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
          filename: `clip_${clipNumber}.mp4`,
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
      const finalClipPath = path.join(clipsDir, `clip_${finalClipNumber}.mp4`);
      
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
        filename: `clip_${finalClipNumber}.mp4`,
        startTime: currentTime,
        endTime: null,
        duration: null
      });

      // Create reactions guide text file
      const guideText = this.createReactionsGuide(reactionGuide);
      const guidePath = path.join(clipsDir, 'reactions_guide.txt');
      await fs.writeFile(guidePath, guideText);

      console.log(`✓ Created ${clips.length} clips`);

      // Create ZIP file with all clips + guide
      const zipPath = path.join(this.outputDir, `split_video_${jobId}.zip`);
      await this.createZipFile(clipsDir, zipPath);

      return {
        jobId,
        totalClips: clips.length,
        clips,
        reactionGuide,
        guidePath,
        zipPath,
        zipFilename: `split_video_${jobId}.zip`,
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
   * Extract a single clip from video
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
          '-c:v libx264',
          '-preset ultrafast',
          '-c:a aac'
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
   * Create ZIP file containing all clips and guide
   */
  createZipFile(sourceDir, outputPath) {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outputPath);
      const archive = archiver('zip', {
        zlib: { level: 9 }
      });

      output.on('close', () => {
        console.log(`✓ ZIP created: ${archive.pointer()} bytes`);
        resolve(outputPath);
      });

      archive.on('error', (err) => {
        reject(err);
      });

      archive.pipe(output);
      archive.directory(sourceDir, false);
      archive.finalize();
    });
  }
}

module.exports = new SplitService();
