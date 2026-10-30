const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');

const execAsync = promisify(exec);

const tellaService = require('./tellaService');

const isTikTok = (url) => /tiktok\.com|vm\.tiktok|vt\.tiktok/i.test(url);
const isYouTube = (url) => /youtube\.com|youtu\.be/i.test(url);

// Residential proxy (same IPRoyal account as the Transcriber). YouTube blocks
// data-centre IPs for the video FILE, but serves a home IP like any viewer, so
// YouTube goes through the proxy first. PROXY_URL looks like
// http://USER:PASS_country-us@geo.iproyal.com:12321 — we append a sticky
// session to the password so one download (video + audio) stays on one IP.
function proxyUrl() {
  const raw = process.env.PROXY_URL;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const session = Math.random().toString(36).slice(2, 10);
    u.password = `${decodeURIComponent(u.password)}_session-${session}_lifetime-30m`;
    return u.toString();
  } catch (e) {
    console.error('PROXY_URL is not a valid URL — downloading without the proxy');
    return null;
  }
}

// Quality: the best up to 1080p measured on the SHORT side ("res"), so a
// vertical 1080x1920 Short/Reel/TikTok stays full size (a height<=1080 filter
// would shrink it to 608x1080). Then prefer H.264 + AAC: every phone plays it,
// FFmpeg cuts it fast, and it merges cleanly into mp4. Without the codec hint
// yt-dlp picks AV1 for many YouTube videos.
const FORMAT_ARGS = ['-f', 'bv*+ba/b', '-S', 'res:1080,vcodec:h264,acodec:aac'];

/**
 * Run yt-dlp without a shell (the URL never touches sh). Reports download
 * progress as 0–100 through onProgress. Rejects with yt-dlp's last error line.
 */
function runYtdlp(args, { onProgress, timeoutMs = 45 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('yt-dlp', ['--newline', ...args]);
    let out = '';
    let errTail = '';
    let lastPct = -1;
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Download took too long')); }, timeoutMs);
    const onLine = (line) => {
      const m = /\[download\]\s+([\d.]+)%/.exec(line);
      if (m && onProgress) {
        const pct = Math.floor(parseFloat(m[1]));
        if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
      }
      if (/ERROR/.test(line)) errTail = line;
    };
    let buf = '';
    child.stdout.on('data', (d) => {
      const t = d.toString(); out += t; buf += t;
      const lines = buf.split('\n'); buf = lines.pop();
      lines.forEach(onLine);
    });
    child.stderr.on('data', (d) => { const t = d.toString(); t.split('\n').forEach(onLine); if (!errTail) errTail = t.trim().slice(-300); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      // Never let the proxy password reach a log or an error message.
      else reject(new Error((errTail || `yt-dlp exited ${code}`).replace(/https?:\/\/[^@\s]+@/g, 'http://***@')));
    });
  });
}

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

// Same flags as an argv array, for runYtdlp.
function ytdlpArgs() {
  ytdlpExtra();
  const args = ['--no-playlist', '--no-warnings'];
  if (cookieState === 'ok') args.push('--cookies', '/tmp/yt-cookies.txt');
  return args;
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
  async downloadVideo(url, jobId = null, opts = {}) {
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

    // Try order. YouTube: through the proxy (3 fresh home IPs), then direct.
    // Everything else: direct first (free), then through the proxy.
    const proxied = () => proxyUrl();
    const plan = isYouTube(url)
      ? [proxied, proxied, proxied, () => null]
      : [() => null, proxied];

    let lastError = null;
    for (const pick of plan) {
      const proxy = pick();
      if (pick === proxied && !proxy) continue; // no PROXY_URL set
      const net = proxy ? ['--proxy', proxy] : [];
      try {
        console.log(`Getting info for: ${url}${proxy ? ' (via proxy)' : ''}`);
        const infoJson = await runYtdlp([...ytdlpArgs(), ...net, '--dump-json', url], { timeoutMs: 90 * 1000 });
        const info = JSON.parse(infoJson.split('\n').find((l) => l.trim().startsWith('{')));

        if (info.duration && info.duration > this.maxDuration) {
          throw Object.assign(new Error(`Video too long. Max ${this.maxDuration}s, got ${info.duration}s`), { final: true });
        }
        if (info.filesize && info.filesize > this.maxSizeMB * 1024 * 1024) {
          throw Object.assign(new Error(`Video too large. Max ${this.maxSizeMB}MB`), { final: true });
        }

        // Best <=1080p video + best audio, merged to mp4 (YouTube's single-file
        // stream caps at 360p; everything above is separate video+audio).
        console.log(`Downloading video: ${info.title || 'Unknown'}`);
        await fs.emptyDir(outputPath);
        await runYtdlp([
          ...ytdlpArgs(), ...net,
          '-N', '8', '--retries', '5', '--fragment-retries', '10',
          ...FORMAT_ARGS, '--merge-output-format', 'mp4',
          '-o', outputFile, url,
        ], { onProgress: opts.onProgress });

        const files = await fs.readdir(outputPath);
        const videoFile = files.find((f) => f.startsWith('video.') && !f.endsWith('.part'));
        if (!videoFile) throw new Error('Downloaded video file not found');

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
          url: info.webpage_url || url,
          viaProxy: !!proxy,
        };
      } catch (error) {
        lastError = error;
        console.error(`Download attempt failed${proxy ? ' (via proxy)' : ''}: ${error.message}`);
        if (error.final || /Unsupported URL|Private video|Video unavailable|removed/i.test(error.message)) break;
      }
    }

    await fs.remove(outputPath).catch(console.error);
    const msg = lastError ? lastError.message : 'unknown error';
    if (msg.includes('Unsupported URL')) throw new Error('Unsupported platform or invalid URL');
    throw new Error(`Download failed: ${msg}`);
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
