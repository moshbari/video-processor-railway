const { exec } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

const execAsync = promisify(exec);

const tellaService = require('./tellaService');

const isTikTok = (url) => /tiktok\.com|vm\.tiktok|vt\.tiktok/i.test(url);

// Login cookies (Instagram/Facebook + YouTube bot-check) come from YTDLP_COOKIES_B64
// — a base64 of a Netscape cookies.txt. Written once to /tmp and passed to yt-dlp.

/**
 * Does this text actually look like a Netscape cookies.txt?
 *
 * Netscape format is tab-separated with seven fields per row:
 *   domain  includeSubdomains  path  secure  expiry  name  value
 *
 * Worth checking, because whatever is in that variable gets handed to yt-dlp as
 * the browser session for every download. When it was once replaced with the
 * wrong file entirely, yt-dlp did not refuse it — it warned "skipping cookie
 * file entry due to invalid length" on every single line and carried on
 * logged-out, so the only symptom was downloads mysteriously failing the
 * bot check. Better to notice here, say so once, and run without cookies.
 */
function looksLikeCookieJar(text) {
  let rows = 0;
  for (const line of String(text).split('\n')) {
    if (!line || line.startsWith('#')) continue;
    if (line.split('\t').length >= 7) rows++;
    if (rows >= 3) return true;
  }
  return false;
}

let cookieState = null; // null = not decided yet, then 'ok' | 'unusable' | 'none'
function ytdlpExtra() {
  const args = ['--no-playlist', '--no-warnings'];
  const raw = process.env.YTDLP_COOKIES_B64;

  if (cookieState === null) {
    if (!raw) {
      cookieState = 'none';
    } else {
      try {
        const text = Buffer.from(raw, 'base64').toString('utf8');
        if (!looksLikeCookieJar(text)) {
          console.error(
            '⚠️  YTDLP_COOKIES_B64 does not contain a Netscape cookies.txt (no tab-separated cookie rows). ' +
            'Ignoring it and downloading without cookies — export a fresh cookies.txt and set it again.'
          );
          cookieState = 'unusable';
        } else {
          fs.writeFileSync('/tmp/yt-cookies.txt', text);
          cookieState = 'ok';
        }
      } catch (e) {
        console.error('cookie write failed:', e.message);
        cookieState = 'unusable';
      }
    }
  }

  if (cookieState === 'ok') args.push('--cookies', '/tmp/yt-cookies.txt');
  return args.join(' ');
}

class DownloadService {
  constructor() {
    this.tempDir = process.env.TEMP_DIR || '/app/temp';
    this.maxSizeMB = parseInt(process.env.MAX_VIDEO_SIZE_MB) || 4096;
    // Allow long-form videos (up to ~4h). Importing a YouTube link downloads
    // YouTube's own copy, so transcript timestamps line up exactly — that's the
    // reliable way to match YouTube, so we don't want a short cap blocking it.
    this.maxDuration = parseInt(process.env.MAX_DURATION_SECONDS) || 14400;
    this.allowedPlatforms = (process.env.ALLOWED_PLATFORMS || '').split(',');
  }

  /**
   * Download video from URL using yt-dlp
   */
  async downloadVideo(url, jobId = null) {
    const id = jobId || uuidv4();
    const outputPath = path.join(this.tempDir, id);
    await fs.ensureDir(outputPath);

    // --- Tella account videos: use the official Tella API (yt-dlp can't) ---
    if (tellaService.isTellaUrl(url)) {
      try {
        console.log(`Fetching from Tella: ${url}`);
        const { videoPath, title } = await tellaService.downloadTellaVideo(url, outputPath);
        const stats = await fs.stat(videoPath);
        return {
          jobId: id,
          videoPath,
          filename: path.basename(videoPath),
          title: title || 'Tella video',
          duration: 0, // filled in downstream via ffprobe
          fileSize: stats.size,
          thumbnail: null,
          platform: 'tella',
          uploadDate: null,
          uploader: null,
          description: null,
          url
        };
      } catch (error) {
        await fs.remove(outputPath).catch(() => {});
        throw new Error(`Tella download failed: ${error.message}`);
      }
    }

    // --- TikTok: yt-dlp is IP-blocked from datacenter, resolve via tikwm CDN ---
    if (isTikTok(url)) {
      try {
        return await this.downloadTikTok(url, outputPath, id);
      } catch (e) {
        console.error('TikTok resolver failed, falling back to yt-dlp:', e.message);
        // fall through to yt-dlp
      }
    }

    const outputFile = path.join(outputPath, 'video.%(ext)s');

    try {
      // Get video info first
      console.log(`Getting info for: ${url}`);
      const infoCommand = `yt-dlp ${ytdlpExtra()} --dump-json "${url}"`;
      const { stdout: infoJson } = await execAsync(infoCommand);
      const info = JSON.parse(infoJson);

      // Validate duration
      if (info.duration && info.duration > this.maxDuration) {
        throw new Error(`Video too long. Max ${this.maxDuration}s, got ${info.duration}s`);
      }

      // Validate file size (if available)
      if (info.filesize && info.filesize > this.maxSizeMB * 1024 * 1024) {
        throw new Error(`Video too large. Max ${this.maxSizeMB}MB`);
      }

      // Download the video.
      // Prefer the highest quality UP TO 1080p. `best[ext=mp4]` alone only ever
      // returns YouTube's single-file progressive stream, which caps at 360p —
      // every resolution above that (720p/1080p/4K) is DASH (separate video+audio
      // that must be merged). This selector grabs the best <=1080p video + best
      // audio and merges to mp4, so a 1080p source arrives as 1080p (capped at
      // 1080p so 4K sources don't balloon), with graceful fallbacks for odd sites.
      console.log(`Downloading video: ${info.title || 'Unknown'}`);
      const fmt = 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best[height<=1080][ext=mp4]/best[ext=mp4]/best';
      const downloadCommand = `yt-dlp ${ytdlpExtra()} -f "${fmt}" --merge-output-format mp4 -o "${outputFile}" "${url}"`;
      
      await execAsync(downloadCommand, {
        maxBuffer: 1024 * 1024 * 100 // 100MB buffer
      });

      // Find the downloaded file
      const files = await fs.readdir(outputPath);
      const videoFile = files.find(f => f.startsWith('video.'));
      
      if (!videoFile) {
        throw new Error('Downloaded video file not found');
      }

      const videoPath = path.join(outputPath, videoFile);
      const stats = await fs.stat(videoPath);

      return {
        jobId: id,
        videoPath,
        filename: videoFile,
        title: info.title || 'Unknown',
        duration: info.duration || 0,
        fileSize: stats.size,
        thumbnail: info.thumbnail || null,
        platform: info.extractor || 'unknown',
        uploadDate: info.upload_date || null,
        uploader: info.uploader || null,
        description: info.description || null,
        url: info.webpage_url || url
      };

    } catch (error) {
      // Cleanup on error
      await fs.remove(outputPath).catch(console.error);
      
      if (error.message.includes('Unsupported URL')) {
        throw new Error('Unsupported platform or invalid URL');
      }
      
      throw new Error(`Download failed: ${error.message}`);
    }
  }

  /**
   * Download a TikTok video via the tikwm resolver (no-watermark MP4 from a CDN
   * that serves cloud IPs), since yt-dlp is IP-blocked for TikTok on the server.
   */
  async downloadTikTok(url, outputPath, id) {
    const videoPath = path.join(outputPath, 'video.mp4');
    let data = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const resp = await fetch('https://www.tikwm.com/api/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Mozilla/5.0' },
        body: `url=${encodeURIComponent(url)}&hd=1`,
      });
      const j = await resp.json().catch(() => ({}));
      if (j.code === 0 && j.data && (j.data.hdplay || j.data.play)) { data = j.data; break; }
      if (j.msg && /limit/i.test(j.msg)) { await new Promise((r) => setTimeout(r, 1200)); continue; }
      throw new Error(`tikwm: ${j.msg || 'resolve failed'}`);
    }
    if (!data) throw new Error('tikwm rate limited');

    const playUrl = data.hdplay || data.play;
    const vresp = await fetch(playUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!vresp.ok) throw new Error(`TikTok CDN download failed: HTTP ${vresp.status}`);
    await fs.writeFile(videoPath, Buffer.from(await vresp.arrayBuffer()));
    const stats = await fs.stat(videoPath);

    return {
      jobId: id,
      videoPath,
      filename: 'video.mp4',
      title: data.title || 'TikTok video',
      duration: data.duration || 0,
      fileSize: stats.size,
      thumbnail: data.cover || data.origin_cover || null,
      platform: 'tiktok',
      uploadDate: null,
      uploader: (data.author && data.author.unique_id) || null,
      description: data.title || null,
      url,
    };
  }

  /**
   * Get supported platforms info
   */
  async getSupportedPlatforms() {
    try {
      const { stdout } = await execAsync('yt-dlp --list-extractors');
      const extractors = stdout.split('\n').filter(e => e.trim());
      
      return {
        total: extractors.length,
        popular: [
          'youtube', 'instagram', 'tiktok', 'facebook', 
          'twitter', 'vimeo', 'dailymotion', 'reddit',
          'linkedin', 'twitch'
        ],
        all: extractors.slice(0, 100) // Return first 100
      };
    } catch (error) {
      return {
        error: error.message,
        fallback: ['youtube', 'instagram', 'tiktok', 'facebook']
      };
    }
  }

  /**
   * Validate URL before download
   */
  async validateUrl(url) {
    try {
      const command = `yt-dlp ${ytdlpExtra()} --dump-json --skip-download "${url}"`;
      const { stdout } = await execAsync(command, { timeout: 10000 });
      const info = JSON.parse(stdout);
      
      return {
        valid: true,
        title: info.title,
        duration: info.duration,
        platform: info.extractor
      };
    } catch (error) {
      return {
        valid: false,
        error: error.message
      };
    }
  }

  /**
   * Check if yt-dlp is installed
   */
  async checkInstallation() {
    try {
      const { stdout } = await execAsync('yt-dlp --version');
      return {
        installed: true,
        version: stdout.trim()
      };
    } catch (error) {
      return {
        installed: false,
        error: 'yt-dlp not found'
      };
    }
  }
}

module.exports = new DownloadService();
