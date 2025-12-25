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
   * Combine original clips with reaction clips in "watch then react" format
   * Sequence: clip1 → reaction1 → clip2 → reaction2 → ...
   */
  async combineClipsWithReactions(originalClips, reactionClips, jobId = null) {
    jobId = jobId || uuidv4();
    const workDir = path.join(this.tempDir, jobId);
    await fs.ensureDir(workDir);

    try {
      console.log(`Combining ${originalClips.length} clips with ${reactionClips.length} reactions...`);

      // Build the sequence of clips
      const clipSequence = [];
      
      for (let i = 0; i < originalClips.length; i++) {
        // Add original clip
        clipSequence.push(originalClips[i]);
        
        // Add reaction clip if exists for this position
        if (reactionClips[i]) {
          clipSequence.push(reactionClips[i]);
        }
      }

      console.log(`Total clips in sequence: ${clipSequence.length}`);

      // Create concat file for FFmpeg
      const concatFilePath = path.join(workDir, 'concat.txt');
      const concatContent = clipSequence
        .map(clipPath => `file '${clipPath}'`)
        .join('\n');
      
      await fs.writeFile(concatFilePath, concatContent);
      console.log('Concat file created:', concatFilePath);

      // First, we need to normalize all clips to same format
      const normalizedClips = [];
      
      for (let i = 0; i < clipSequence.length; i++) {
        const inputPath = clipSequence[i];
        const normalizedPath = path.join(workDir, `normalized_${i}.mp4`);
        
        console.log(`Normalizing clip ${i + 1}/${clipSequence.length}...`);
        
        await this.normalizeClip(inputPath, normalizedPath);
        normalizedClips.push(normalizedPath);
      }

      // Create new concat file with normalized clips
      const normalizedConcatPath = path.join(workDir, 'concat_normalized.txt');
      const normalizedConcatContent = normalizedClips
        .map(clipPath => `file '${clipPath}'`)
        .join('\n');
      
      await fs.writeFile(normalizedConcatPath, normalizedConcatContent);

      // Combine all normalized clips
      const outputPath = path.join(workDir, 'final_combined.mp4');
      
      await this.concatenateClips(normalizedConcatPath, outputPath);

      // Get file info
      const stats = await fs.stat(outputPath);

      return {
        jobId,
        outputPath,
        clipCount: clipSequence.length,
        originalCount: originalClips.length,
        reactionCount: reactionClips.filter(c => c).length,
        fileSize: stats.size,
        downloadUrl: `/api/combine/${jobId}/download`
      };

    } catch (error) {
      console.error('Combine error:', error);
      // Cleanup on error
      await fs.remove(workDir).catch(() => {});
      throw error;
    }
  }

  /**
   * Normalize a clip to consistent format for concatenation
   * - 1080p resolution (or scale down if larger)
   * - 30fps
   * - AAC audio
   * - H.264 video
   */
  async normalizeClip(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions([
          '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black,setsar=1',
          '-r', '30',
          '-c:v', 'libx264',
          '-preset', 'fast',
          '-crf', '23',
          '-c:a', 'aac',
          '-ar', '44100',
          '-ac', '2',
          '-b:a', '128k',
          '-movflags', '+faststart'
        ])
        .on('start', (cmd) => {
          console.log('Normalizing with command:', cmd);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            console.log(`  Normalizing: ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => {
          console.log('Clip normalized successfully');
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error('Normalization error:', err);
          reject(err);
        })
        .save(outputPath);
    });
  }

  /**
   * Concatenate clips using FFmpeg concat demuxer
   */
  async concatenateClips(concatFilePath, outputPath) {
    return new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatFilePath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions([
          '-c', 'copy',
          '-movflags', '+faststart'
        ])
        .on('start', (cmd) => {
          console.log('Concatenating with command:', cmd);
        })
        .on('progress', (progress) => {
          if (progress.percent) {
            console.log(`  Concatenating: ${Math.round(progress.percent)}%`);
          }
        })
        .on('end', () => {
          console.log('Clips concatenated successfully');
          resolve(outputPath);
        })
        .on('error', (err) => {
          console.error('Concatenation error:', err);
          reject(err);
        })
        .save(outputPath);
    });
  }

  /**
   * Get the output path for a job
   */
  getOutputPath(jobId) {
    return path.join(this.tempDir, jobId, 'final_combined.mp4');
  }

  /**
   * Cleanup job files
   */
  async cleanup(jobId) {
    const workDir = path.join(this.tempDir, jobId);
    await fs.remove(workDir);
    console.log(`Cleaned up job: ${jobId}`);
  }
}

module.exports = new CombineService();
