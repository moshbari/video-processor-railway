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
     *
     * Logic: N reactions = N clips
     * Each reaction marks the END of a clip (where video pauses for reaction)
     *
     * Example with reactions at [1, 5, 10]:
     * - Clip 1: 0s → 1s (watch this, then react at 1s)
     * - Clip 2: 1s → 5s (watch this, then react at 5s)
     * - Clip 3: 5s → 10s (watch this, then react at 10s)
     *
     * NO extra clip after last reaction!
     */
  async splitVideoForReactions(videoPath, reactions) {
        const jobId = uuidv4();
        const workDir = path.join(this.tempDir, jobId);
        const clipsDir = path.join(workDir, 'clips');
        await fs.ensureDir(clipsDir);

      try {
              console.log(`\n${'='.repeat(50)}`);
              console.log('SPLITTING VIDEO');
              console.log('='.repeat(50));
              console.log(`Job ID: ${jobId}`);
              console.log(`Video: ${videoPath}`);
              console.log(`Reactions: ${reactions.length}`);
              console.log(`Expected clips: ${reactions.length}`);
              console.log(`Output: ${clipsDir}`);
              console.log('Using PRECISE CUTS (re-encode mode)');
              console.log('='.repeat(50));

          // Sort reactions by timestamp
          const sortedReactions = reactions.sort((a, b) => a.timestamp - b.timestamp);

          const clips = [];
              const reactionGuide = [];
              let currentTime = 0;

          // Create exactly N clips for N reactions
          // Each clip goes from currentTime to the reaction timestamp
          for (let i = 0; i < sortedReactions.length; i++) {
                    const reaction = sortedReactions[i];
                    const clipEndTime = reaction.timestamp;
                    const duration = clipEndTime - currentTime;
                    const clipNumber = i + 1;

                const clipFilename = `clip_${clipNumber}.mp4`;
                    const clipPath = path.join(clipsDir, clipFilename);

                console.log(`Creating clip ${clipNumber}: ${currentTime}s to ${clipEndTime}s (${duration.toFixed(2)}s)`);

                await this.extractClipPrecise(videoPath, currentTime, duration, clipPath);

                clips.push({
                            number: clipNumber,
                            path: clipPath,
                            filename: clipFilename,
                            startTime: currentTime,
                            endTime: clipEndTime,
                            duration: duration
                });

                // Add reaction guide
                reactionGuide.push({
                            afterClip: clipNumber,
                            timestamp: reaction.timestamp,
                            text: reaction.text,
                            sentiment: reaction.sentiment || 'NEUTRAL'
                });

                currentTime = clipEndTime;
          }

          // NO FINAL CLIP - we stop at the last reaction timestamp
          // The user's last reaction IS the end of the video

          console.log(`\n✓ Created ${clips.length} clips in ${clipsDir}`);

          // Create reactions guide text file
          const guideText = this.createReactionsGuide(reactionGuide);
              const guideFilename = 'reactions_guide.txt';
              const guidePath = path.join(clipsDir, guideFilename);
              await fs.writeFile(guidePath, guideText);

          // Build response with download URLs
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
     * This ensures no overlap between clips and proper audio sync
     */
  extractClipPrecise(videoPath, startTime, duration, outputPath) {
        return new Promise((resolve, reject) => {
                // Use -ss before -i for fast seeking, then re-encode for precision
                                 const command = ffmpeg(videoPath)
                  .seekInput(startTime);

                                 if (duration !== null && duration > 0) {
                                           command.duration(duration);
                                 }

                                 // Re-encode for precise frame-accurate cuts
                                 command
                  .outputOptions([
                              '-c:v', 'libx264',
                              '-preset', 'fast',
                              '-crf', '23',
                              '-c:a', 'aac',
                              '-ar', '44100',
                              '-ac', '2',
                              '-b:a', '128k',
                              '-avoid_negative_ts', 'make_zero',
                              '-y'
                            ])
                  .on('start', cmd => {
                              const endStr = duration ? `${(startTime + duration).toFixed(1)}s` : 'end';
                              console.log(`  Extracting: ${startTime}s to ${endStr}`);
                  })
                  .on('end', () => {
                              console.log(`  ✓ Clip created: ${path.basename(outputPath)}`);
                              resolve(outputPath);
                  })
                  .on('error', (err) => {
                              console.error(`  ✗ Clip error:`, err.message);
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
        guide += '• Match your energy to the sentiment\n';
        guide += '• Feel free to improvise!\n';

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
        return path.join(this.tempDir, jobId, 'clips', `clip_${clipNumber}.mp4`);
  }

  /**
     * Get guide file path by job ID
     */
  getGuidePath(jobId) {
        return path.join(this.tempDir, jobId, 'clips', 'reactions_guide.txt');
  }
}

module.exports = new SplitService();
