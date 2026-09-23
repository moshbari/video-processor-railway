/**
 * 🎞️ PREVIEW COPY — a light twin of each editor video, for previews only
 *
 * The editor used to play the full-quality master for every preview: 1080p,
 * an hour long, 600+ MB, with a full picture ("keyframe") only every ~8
 * seconds. Every hook/cut preview is a jump, and every jump made the browser
 * decode up to 8 seconds of 1080p before it could show a frame. New laptops do
 * that in a blink; older ones sat there loading.
 *
 * So after a video is prepared we make a second copy just for previewing:
 *   - 720p at most (never upscaled)
 *   - a keyframe EVERY second → any jump needs at most 1s of decoding
 *   - ~a third of the size, so it fits Cloudflare's free-plan cache (512 MB)
 *   - timestamps passed straight through, so second 754.2 in the preview is
 *     exactly second 754.2 in the master — hooks and cuts line up perfectly
 *
 * Renders never touch it; they still cut from the master.
 *
 * Stored at manual-clip/{jobId}/preview_{sourceBase}.mp4 and remembered on the
 * library record as previewUrl + previewSourceKey. The preview only counts
 * while previewSourceKey === sourceKey — if the master is ever replaced (the
 * YouTube-timestamp re-encode), the old preview is ignored and a new one made.
 *
 * One at a time, at low priority, so it never fights a render for the CPU.
 */

const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const r2Service = require('./r2Service');
const manualVideoLibraryService = require('./manualVideoLibraryService');

const MAX_HEIGHT = 720;

class PreviewProxyService {
  constructor() {
    this.tempDir = process.env.TEMP_DIR || '/app/temp';
    this.queue = [];            // [{ jobId, userId, localPath }]
    this.state = new Map();     // jobId -> 'queued' | 'making' | 'failed'
    this.again = new Map();     // jobId -> request that arrived mid-encode
    this.running = false;
  }

  /** The usable preview URL for a library record, or null. */
  previewFor(record) {
    if (!record || !record.previewUrl) return null;
    const sourceKey = record.sourceKey || `manual-clip/${record.jobId}/source.mp4`;
    if (record.previewSourceKey !== sourceKey) return null; // made from an older master
    return r2Service.toPublicUrl(record.previewUrl);
  }

  /** 'ready' | 'queued' | 'making' | 'failed' | 'none' */
  status(record) {
    if (this.previewFor(record)) return 'ready';
    return (record && this.state.get(record.jobId)) || 'none';
  }

  /**
   * Ask for a preview copy. Returns immediately; the work happens in the
   * background. Safe to call repeatedly — a video already queued, being made,
   * or done is left alone. `localPath` (optional) is a copy of the master
   * already on this server, which saves downloading it again.
   */
  request(jobId, userId, localPath = null) {
    if (!jobId) return;
    const s = this.state.get(jobId);
    if (s === 'queued') {
      // A fresher local file (e.g. the just-normalized master) beats the old one.
      const q = this.queue.find(x => x.jobId === jobId);
      if (q && localPath) q.localPath = localPath;
      return;
    }
    if (s === 'making') {
      // The master may have just been replaced — check again once this one ends.
      this.again.set(jobId, { jobId, userId: userId || null, localPath });
      return;
    }
    this.state.set(jobId, 'queued');
    this.queue.push({ jobId, userId: userId || null, localPath });
    this._pump();
  }

  async _pump() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift();
        this.state.set(item.jobId, 'making');
        try {
          await this._make(item);
          this.state.delete(item.jobId);
        } catch (err) {
          console.error(`[Preview ${item.jobId}] ✗ ${err.message}`);
          this.state.set(item.jobId, 'failed');
        }
        const rerun = this.again.get(item.jobId);
        if (rerun) {
          this.again.delete(item.jobId);
          this.state.set(item.jobId, 'queued');
          this.queue.push(rerun);
        }
      }
    } finally {
      this.running = false;
    }
  }

  async _make({ jobId, userId, localPath }) {
    const record = (await manualVideoLibraryService.get(userId, jobId))
      || (await manualVideoLibraryService.get(null, jobId));
    if (!record) throw new Error('video is not in the library');
    if (this.previewFor(record)) return; // someone already made it

    const sourceKey = record.sourceKey || `manual-clip/${jobId}/source.mp4`;
    const workDir = path.join(this.tempDir, `preview-${jobId}`);
    await fs.ensureDir(workDir);
    const started = Date.now();

    try {
      // 1. The master: use the copy already on this server if it's still there.
      let srcPath = localPath && await fs.pathExists(localPath) ? localPath : null;
      if (!srcPath) {
        srcPath = path.join(workDir, 'master.mp4');
        console.log(`[Preview ${jobId}] Fetching master (${sourceKey})...`);
        await r2Service.downloadFile(record.playbackUrl || r2Service.getPublicUrl(sourceKey), srcPath);
      }

      // 2. The light copy.
      const outPath = path.join(workDir, 'preview.mp4');
      console.log(`[Preview ${jobId}] Making the ${MAX_HEIGHT}p preview copy...`);
      await this._encode(srcPath, outPath);

      // 3. Upload next to the master, named after it so a replaced master can
      //    never be served a stale cached preview.
      const base = path.basename(sourceKey, path.extname(sourceKey));
      const previewKey = `manual-clip/${jobId}/preview_${base}.mp4`;
      const up = await r2Service.uploadFile(outPath, previewKey, 'video/mp4');
      const size = (await fs.stat(outPath)).size;

      // 4. Only attach it if the master didn't change while we were working.
      const fresh = (await manualVideoLibraryService.get(userId, jobId))
        || (await manualVideoLibraryService.get(null, jobId));
      if (!fresh || (fresh.sourceKey || `manual-clip/${jobId}/source.mp4`) !== sourceKey) {
        console.log(`[Preview ${jobId}] Master changed while encoding — discarding this preview.`);
        r2Service.deleteFile(previewKey).catch(() => {});
        return;
      }
      await manualVideoLibraryService.updateVideo(userId, jobId, {
        previewUrl: up.downloadUrl,
        previewSourceKey: sourceKey,
        previewSize: size,
      });
      console.log(`[Preview ${jobId}] ✓ ${(size / 1048576).toFixed(0)} MB in ${Math.round((Date.now() - started) / 1000)}s`);
    } finally {
      fs.remove(workDir).catch(() => {});
    }
  }

  _encode(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
      const args = [
        '-n', '10', 'ffmpeg',   // `nice`: renders get the CPU first
        '-y',
        '-i', inputPath,
        '-map', '0:v:0',
        '-map', '0:a:0?',
        // Keep every timestamp exactly as in the master (no frame drop/dup).
        '-vsync', 'passthrough',
        '-vf', `scale=-2:'min(${MAX_HEIGHT},ih)'`,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '28',
        '-maxrate', '1500k',
        '-bufsize', '3000k',
        '-pix_fmt', 'yuv420p',
        // A full picture every second, so any jump is quick.
        '-force_key_frames', 'expr:gte(t,n_forced*1)',
        '-c:a', 'aac',
        '-b:a', '96k',
        '-ac', '2',
        '-movflags', '+faststart',
        outputPath,
      ];
      const proc = spawn('nice', args);
      let stderr = '';
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
        if (stderr.length > 20000) stderr = stderr.slice(-10000);
      });
      proc.on('close', (code) => {
        if (code === 0) resolve(outputPath);
        else { console.error(stderr.slice(-800)); reject(new Error(`ffmpeg exited ${code}`)); }
      });
      proc.on('error', reject);
    });
  }
}

module.exports = new PreviewProxyService();
