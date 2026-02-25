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

          // Get video duration for timestamp fixing
          const videoDuration = await this.getVideoDuration(videoPath);
          console.log(`Video duration: ${videoDuration}s`);

          // Fix timestamps - preserve original order (don't sort!)
          // AI generators like RantSquad use timestamp=0 for intro (first) and summary (last).
          // Sorting would lump them together. Instead, process in order and fix in-place.
          const fixedReactions = reactions.map(r => ({ ...r })); // clone to avoid mutating input

          // Pass 1: Fix out-of-order/zero timestamps
          // Walk through in order; any reaction whose timestamp <= the running max
          // (except the very first at 0) needs a new timestamp assigned.
          let maxSoFar = -1;
          const needsFix = []; // indices that need new timestamps

          for (let i = 0; i < fixedReactions.length; i++) {
              const ts = fixedReactions[i].timestamp;
              if (ts <= maxSoFar || (i === 0 && ts === 0)) {
                  needsFix.push(i);
              } else {
                  maxSoFar = ts;
              }
          }

          if (needsFix.length > 0) {
              console.log(`Fixing ${needsFix.length} reaction timestamp(s) that would produce zero-duration clips`);

              // Evenly divide the ENTIRE video among ALL reactions.
              // This is the most reliable approach when AI-generated timestamps are broken,
              // since partial fixes (only adjusting broken ones) can create uneven or
              // zero-duration clips when broken timestamps cluster at boundaries.
              const totalReactions = fixedReactions.length;
              const segmentDuration = videoDuration / totalReactions;

              for (let i = 0; i < totalReactions; i++) {
                  const newTs = parseFloat((segmentDuration * (i + 1)).toFixed(2));
                  if (fixedReactions[i].timestamp !== newTs) {
                      console.log(`  Reaction ${i + 1}: ${fixedReactions[i].timestamp}s → ${newTs}s`);
                      fixedReactions[i].timestamp = newTs;
                  }
              }
          }

          const clips = [];
              const reactionGuide = [];
              let currentTime = 0;

          // Create exactly N clips for N reactions
          // Each clip goes from currentTime to the reaction timestamp
          let clipNumber = 0;
          for (let i = 0; i < fixedReactions.length; i++) {
                    const reaction = fixedReactions[i];
                    const clipEndTime = reaction.timestamp;
                    const duration = clipEndTime - currentTime;

                // Skip clips with zero or negative duration (safety check after redistribution)
                if (duration <= 0) {
                    console.log(`Skipping clip for reaction ${i + 1}: ${currentTime}s to ${clipEndTime}s (${duration.toFixed(2)}s) - zero/negative duration`);
                    // Still add the reaction guide entry (reaction happens before any video)
                    reactionGuide.push({
                                afterClip: clipNumber, // 0 means before any clip
                                timestamp: reaction.timestamp,
                                text: reaction.text,
                                sentiment: reaction.sentiment || 'NEUTRAL'
                    });
                    currentTime = clipEndTime;
                    continue;
                }

                clipNumber++;
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

                                 // ALWAYS set duration to prevent extracting to end of file
                                 if (duration !== null && duration > 0) {
                                           command.duration(duration);
                                 } else {
                                           // Safety: if duration is 0 or missing, use minimal duration (1 frame)
                                           console.warn(`  WARNING: duration is ${duration}, using 0.033s (1 frame) as safety`);
                                           command.duration(0.033);
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
     * Get video duration using ffprobe
     */
  getVideoDuration(videoPath) {
        return new Promise((resolve, reject) => {
            ffmpeg.ffprobe(videoPath, (err, metadata) => {
                if (err) return reject(err);
                resolve(parseFloat(metadata.format.duration));
            });
        });
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
