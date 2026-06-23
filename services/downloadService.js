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
let cookiesWritten = false;
function ytdlpExtra() {
  const args = ['--no-playlist', '--no-warnings'];
  if (process.env.YTDLP_COOKIES_B64) {
    try {
      if (!cookiesWritten) {
        fs.writeFileSync('/tmp/yt-cookies.txt', Buffer.from(process.env.YTDLP_COOKIES_B64, 'base64').toString('utf8'));
        cookiesWritten = true;
      }
      args.push('--cookies', '/tmp/yt-cookies.txt');
    } catch (e) {
      console.error('cookie write failed:', e.message);
    }
  }
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

      // Download the video
      console.log(`Downloading video: ${info.title || 'Unknown'}`);
      const downloadCommand = `yt-dlp ${ytdlpExtra()} -f "best[ext=mp4]/best" --merge-output-format mp4 -o "${outputFile}" "${url}"`;
      
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
