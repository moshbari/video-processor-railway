/**
 * 🎥 LIVE REACT routes (Get Transcript phone apps)
 *
 * React-while-you-watch on the phone: the app grabs the main video here in
 * 1080p, the user watches it with a face camera running, pauses to talk, and
 * the render joins it all up.
 *
 *   POST /api/live-react/grab        {url}  -> { grabId }  (download runs in the background)
 *   GET  /api/live-react/grab/:id            -> { status, stage, progress, main, warning, error }
 *
 * X-Device-Id is the Get Transcript code (32 hex). It scopes the daily cap, so
 * one phone can't burn the proxy budget.
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs-extra');
const { exec } = require('child_process');
const { promisify } = require('util');
const { v4: uuidv4 } = require('uuid');

const downloadService = require('../services/downloadService');
const r2Service = require('../services/r2Service');
const renderService = require('../services/proRant/renderService');

const execAsync = promisify(exec);

const DAILY_GRABS = Number(process.env.LIVE_REACT_DAILY_GRABS || 15);
const MAX_SECONDS = Number(process.env.LIVE_REACT_MAX_SECONDS || 3 * 3600);

// --- background grab jobs (in memory; the app re-sends the link if one is lost) ---
const GRABS = new Map();     // grabId -> job
const USE = new Map();       // deviceId -> { day, count }
const TTL_MS = 6 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of GRABS) if (now - j.created > TTL_MS) GRABS.delete(id);
}, 15 * 60 * 1000).unref();

const deviceOf = (req) => {
  const id = String(req.headers['x-device-id'] || '').toLowerCase();
  return /^[a-f0-9]{32}$/.test(id) ? id : null;
};
const today = () => new Date().toISOString().slice(0, 10);

function overCap(deviceId) {
  const u = USE.get(deviceId);
  return u && u.day === today() && u.count >= DAILY_GRABS;
}
function count(deviceId) {
  const u = USE.get(deviceId);
  if (!u || u.day !== today()) USE.set(deviceId, { day: today(), count: 1 });
  else u.count += 1;
}

const publicJob = (j) => ({
  grabId: j.id,
  url: j.url,
  status: j.status,          // 'working' | 'done' | 'failed'
  stage: j.stage,            // 'download' | 'prepare' | 'upload' | 'done'
  progress: j.progress,      // 0–100 for the current stage
  main: j.main || null,
  warning: j.warning || null,
  error: j.error || null,
});

function friendly(msg) {
  if (/Private video/i.test(msg)) return 'That video is private, so it can’t be downloaded.';
  if (/Video unavailable|removed|does not exist/i.test(msg)) return 'That video is no longer available.';
  if (/too long/i.test(msg)) return `That video is too long. The limit is ${Math.round(MAX_SECONDS / 60)} minutes.`;
  if (/Unsupported/i.test(msg)) return 'That link isn’t a video we can download. Try a YouTube, Instagram, Facebook or TikTok link.';
  if (/not a bot|Sign in/i.test(msg)) return 'YouTube refused this download just now. Tap Try again in a minute.';
  return 'The video didn’t download. Tap Try again.';
}

async function runGrab(job) {
  const workId = `live-react-${job.id}`;
  try {
    const r = await downloadService.downloadVideo(job.url, workId, {
      onProgress: (p) => { job.progress = p; },
    });

    job.stage = 'prepare';
    job.progress = 0;
    // Move the index to the front (faststart) so the phone starts playing the
    // video straight from the link instead of waiting for the whole file.
    const ready = path.join(path.dirname(r.videoPath), 'ready.mp4');
    await execAsync(`ffmpeg -y -v error -i "${r.videoPath}" -c copy -movflags +faststart "${ready}"`, { maxBuffer: 1024 * 1024 * 20 });

    const [duration, dims] = await Promise.all([
      renderService.probeDuration(ready),
      renderService.probeDimensions(ready),
    ]);
    if (duration > MAX_SECONDS) throw new Error('Video too long');

    job.stage = 'upload';
    const key = `live-react/${job.deviceId}/${job.id}/main.mp4`;
    const up = await r2Service.uploadFile(ready, key, 'video/mp4');
    const r2Url = up.downloadUrl || r2Service.getPublicUrl(key);

    // 1080p means the SHORT side: a vertical 1080x1920 Reel counts as 1080p.
    const shortSide = Math.min(dims.width || 0, dims.height || 0);
    job.warning = shortSide >= 1080 ? null
      : `This video only exists at ${dims.width}×${dims.height} on ${r.platform || 'the site'}, so your final video will be that size too.`;
    job.main = {
      id: job.id,
      r2Key: key,
      url: r2Url,
      width: dims.width,
      height: dims.height,
      duration,
      isHD: shortSide >= 1080,
      title: r.title || null,
      thumbnail: r.thumbnail || null,
      platform: r.platform || null,
      sourceUrl: job.url,
    };
    job.stage = 'done';
    job.progress = 100;
    job.status = 'done';
    console.log(`[LiveReact] grabbed ${dims.width}x${dims.height} ${Math.round(duration)}s ${r.viaProxy ? 'via proxy' : 'direct'}: ${job.url}`);
  } catch (err) {
    console.error('[LiveReact] grab failed:', err.message);
    job.status = 'failed';
    job.error = friendly(err.message);
  } finally {
    fs.remove(path.join(process.env.TEMP_DIR || '/app/temp', workId)).catch(() => {});
  }
}

router.post('/grab', async (req, res) => {
  const deviceId = deviceOf(req);
  if (!deviceId) return res.status(401).json({ success: false, error: 'Open the app and sign in with your code first.' });
  const url = String((req.body && req.body.url) || '').trim();
  if (!/^https?:\/\//i.test(url)) return res.status(400).json({ success: false, error: 'Paste a video link that starts with https://' });

  // Same link already downloading for this phone? Hand that job back.
  const live = [...GRABS.values()].find((j) => j.deviceId === deviceId && j.url === url && j.status !== 'failed');
  if (live) return res.json({ success: true, ...publicJob(live) });

  if (overCap(deviceId)) {
    return res.status(429).json({ success: false, error: `You’ve downloaded ${DAILY_GRABS} videos today. Try again tomorrow.` });
  }
  count(deviceId);

  const job = { id: uuidv4(), deviceId, url, status: 'working', stage: 'download', progress: 0, created: Date.now() };
  GRABS.set(job.id, job);
  runGrab(job);
  res.json({ success: true, ...publicJob(job) });
});

router.get('/grab/:id', (req, res) => {
  const deviceId = deviceOf(req);
  const job = GRABS.get(req.params.id);
  if (!job || job.deviceId !== deviceId) {
    return res.status(404).json({ success: false, error: 'That download is no longer on the server. Send the link again.' });
  }
  res.json({ success: true, ...publicJob(job) });
});

module.exports = router;
