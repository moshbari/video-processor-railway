/**
 * 🎥 LIVE REACT routes (Get Transcript phone apps)
 *
 * React-while-you-watch on the phone: the app grabs the main video here in
 * 1080p, the user watches it with a face camera running, pauses to talk, and
 * the render joins it all up.
 *
 *   POST /api/live-react/grab        {url}  -> { grabId }  (download runs in the background)
 *   GET  /api/live-react/grab/:id            -> { status, stage, progress, main, warning, error }
 *   POST /api/live-react/import      file 'file', field 'title' -> { grabId }  (a video from the phone's Photos/Files)
 *   POST /api/live-react/upload      file 'file', field 'project' -> { url }  (one recording)
 *   POST /api/live-react/render      {project} -> { renderId }  (runs in the background)
 *   GET  /api/live-react/render/:id           -> { status, progress, words, video, error }
 *   POST /api/live-react/ready-rant  {sourceUrl, mainUrl, duration, language} -> { jobId }
 *   GET  /api/live-react/ready-rant/:id       -> { status, rants: [{at, script, why}], ending, error }
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
const liveRender = require('../services/liveReact/renderService');
const { readyRant } = require('../services/liveReact/readyRant');
const multer = require('multer');
const os = require('os');
const crypto = require('crypto');

const uploadDir = path.join(process.env.TEMP_DIR || os.tmpdir(), 'live-react-uploads');
fs.ensureDirSync(uploadDir);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => cb(null, `${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname) || '.mov'}`),
  }),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
});

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
    // Some sites (Facebook) only give AV1 or VP9 at 1080p, which most iPhones
    // can't play (black picture, sound only). Anything but H.264 is turned into
    // H.264 at the same size; H.264 is just copied.
    const { stdout: codecOut } = await execAsync(`ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "${r.videoPath}"`).catch(() => ({ stdout: '' }));
    const codec = String(codecOut).trim();
    if (codec && codec !== 'h264') {
      job.stage = 'convert';
      console.log(`[LiveReact] converting ${codec} to h264: ${job.url}`);
      await execAsync(`ffmpeg -y -v error -i "${r.videoPath}" -map 0:v:0 -map 0:a:0? -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 160k -movflags +faststart "${ready}"`, { maxBuffer: 1024 * 1024 * 20 });
    } else {
      await execAsync(`ffmpeg -y -v error -i "${r.videoPath}" -c copy -movflags +faststart "${ready}"`, { maxBuffer: 1024 * 1024 * 20 });
    }

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
    console.log(`[LiveReact] grabbed ${dims.width}x${dims.height} ${Math.round(duration)}s ${r.viaHome ? 'via home' : r.viaProxy ? 'via proxy' : 'direct'}: ${job.url}`);
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

// ===================== A video from the phone (Photos / Files) =====================
// Same job as a grab, so the app follows it the same way. Phone videos come in
// every shape (HEVC, 4K, rotated), so they're always made into H.264 with the
// short side at most 1080, rotation applied, ready to stream.
async function runImport(job, file, title) {
  const work = path.join(process.env.TEMP_DIR || '/app/temp', `live-react-${job.id}`);
  try {
    await fs.ensureDir(work);
    job.stage = 'convert';
    job.progress = 0;
    const ready = path.join(work, 'ready.mp4');
    const fit = "scale='if(gt(iw,ih),-2,min(1080,iw))':'if(gt(iw,ih),min(1080,ih),-2)'";
    await execAsync(`ffmpeg -y -v error -i "${file}" -map 0:v:0 -map 0:a:0? -vf "${fit}" -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -r 30 -c:a aac -b:a 160k -movflags +faststart "${ready}"`, { maxBuffer: 1024 * 1024 * 20 });
    const [duration, dims] = await Promise.all([renderService.probeDuration(ready), renderService.probeDimensions(ready)]);
    if (duration > MAX_SECONDS) throw new Error('Video too long');
    job.stage = 'upload';
    const key = `live-react/${job.deviceId}/${job.id}/main.mp4`;
    const up = await r2Service.uploadFile(ready, key, 'video/mp4');
    const shortSide = Math.min(dims.width || 0, dims.height || 0);
    job.warning = shortSide >= 1080 ? null : `This video is ${dims.width}×${dims.height}, so your final video will be that size too.`;
    job.main = {
      id: job.id, r2Key: key, url: up.downloadUrl || r2Service.getPublicUrl(key),
      width: dims.width, height: dims.height, duration, isHD: shortSide >= 1080,
      title: title || 'My video', thumbnail: null, platform: 'upload', sourceUrl: null,
    };
    job.stage = 'done';
    job.progress = 100;
    job.status = 'done';
    console.log(`[LiveReact] imported ${dims.width}x${dims.height} ${Math.round(duration)}s from the phone`);
  } catch (err) {
    console.error('[LiveReact] import failed:', err.message);
    job.status = 'failed';
    job.error = /too long/i.test(err.message) ? friendly(err.message) : 'That video couldn’t be used. Try another one.';
  } finally {
    fs.remove(work).catch(() => {});
    fs.remove(file).catch(() => {});
  }
}

router.post('/import', upload.single('file'), (req, res) => {
  const deviceId = deviceOf(req);
  if (!deviceId) { if (req.file) fs.remove(req.file.path).catch(() => {}); return res.status(401).json({ success: false, error: 'Open the app and sign in with your code first.' }); }
  if (!req.file) return res.status(400).json({ success: false, error: 'No video was sent.' });
  const title = String((req.body && req.body.title) || '').trim().slice(0, 120);
  const job = { id: uuidv4(), deviceId, url: `upload:${req.file.originalname || 'video'}`, status: 'working', stage: 'convert', progress: 0, created: Date.now() };
  GRABS.set(job.id, job);
  runImport(job, req.file.path, title);
  res.json({ success: true, ...publicJob(job) });
});

// ===================== Upload one recording =====================
router.post('/upload', upload.single('file'), async (req, res) => {
  const deviceId = deviceOf(req);
  if (!deviceId) return res.status(401).json({ success: false, error: 'Open the app and sign in with your code first.' });
  if (!req.file) return res.status(400).json({ success: false, error: 'No recording was sent.' });
  try {
    const project = String((req.body && req.body.project) || 'loose').replace(/[^a-z0-9-]/gi, '').slice(0, 64) || 'loose';
    const name = String(req.file.originalname || 'clip.mov').replace(/[^a-z0-9._-]/gi, '').slice(0, 80) || 'clip.mov';
    const key = `live-react/${deviceId}/${project}/${name}`;
    const type = /\.mp4$/i.test(name) ? 'video/mp4' : 'video/quicktime';
    const up = await r2Service.uploadFile(req.file.path, key, type);
    res.json({ success: true, url: up.downloadUrl || r2Service.getPublicUrl(key) });
  } catch (err) {
    console.error('[LiveReact] upload failed:', err.message);
    res.status(500).json({ success: false, error: 'The recording didn’t upload. It will try again.' });
  } finally {
    fs.remove(req.file.path).catch(() => {});
  }
});

// ===================== Render =====================
// One render at a time on this box (they're CPU-heavy); the rest wait in line.
const RENDERS = new Map();   // renderId -> job
let line = Promise.resolve();

router.post('/render', async (req, res) => {
  const deviceId = deviceOf(req);
  if (!deviceId) return res.status(401).json({ success: false, error: 'Open the app and sign in with your code first.' });
  const project = req.body && req.body.project;
  if (!project || !project.main || !project.main.url) return res.status(400).json({ success: false, error: 'Nothing to render.' });

  const job = { id: uuidv4(), deviceId, status: 'waiting', progress: 0, words: 'Waiting for the renderer', video: null, error: null, created: Date.now() };
  RENDERS.set(job.id, job);
  line = line.then(async () => {
    job.status = 'working';
    const workDir = path.join(process.env.TEMP_DIR || '/app/temp', `live-react-render-${job.id}`);
    try {
      const r = await liveRender.render(project, workDir, (f, words) => { job.progress = Math.round(f * 100); job.words = words; });
      job.words = 'Saving your video';
      const key = `live-react/${deviceId}/${String(project.id || 'p').replace(/[^a-z0-9-]/gi, '')}/final-${job.id.slice(0, 8)}.mp4`;
      const up = await r2Service.uploadFile(r.file, key, 'video/mp4');
      job.video = { url: up.downloadUrl || r2Service.getPublicUrl(key), duration: r.duration, width: r.width, height: r.height };
      job.status = 'done';
      job.progress = 100;
      job.words = 'Done';
      console.log(`[LiveReact] rendered ${r.width}x${r.height} ${Math.round(r.duration)}s for ${deviceId.slice(0, 6)}`);
    } catch (err) {
      console.error('[LiveReact] render failed:', err.message);
      job.status = 'failed';
      job.error = 'The video didn’t render. Tap Make my RANT to try again.';
    } finally {
      fs.remove(workDir).catch(() => {});
    }
  });
  res.json({ success: true, renderId: job.id, status: job.status });
});

router.get('/render/:id', (req, res) => {
  const job = RENDERS.get(req.params.id);
  if (!job || job.deviceId !== deviceOf(req)) return res.status(404).json({ success: false, error: 'That render is no longer on the server. Tap Make my RANT again.' });
  const { id, status, progress, words, video, error } = job;
  res.json({ success: true, renderId: id, status, progress, words, video, error });
});

// ===================== Ready-made RANT =====================
// The AI reads the video's transcript and writes the RANTs at the right
// moments; the app drops them in as scripts to record.
const READY = new Map();     // jobId -> job
const READY_USE = new Map(); // deviceId -> { day, count }
const DAILY_READY = Number(process.env.READY_RANT_DAILY || 20);

router.post('/ready-rant', (req, res) => {
  const deviceId = deviceOf(req);
  if (!deviceId) return res.status(401).json({ success: false, error: 'Open the app and sign in with your code first.' });
  const { sourceUrl, mainUrl, duration, language } = req.body || {};
  if (!sourceUrl && !mainUrl) return res.status(400).json({ success: false, error: 'Download a video first.' });
  const u = READY_USE.get(deviceId);
  if (u && u.day === today() && u.count >= DAILY_READY) {
    return res.status(429).json({ success: false, error: `You’ve made ${DAILY_READY} ready-made RANTs today. Try again tomorrow.` });
  }
  if (!u || u.day !== today()) READY_USE.set(deviceId, { day: today(), count: 1 }); else u.count += 1;

  const job = { id: uuidv4(), deviceId, status: 'working', rants: null, ending: null, error: null, created: Date.now() };
  READY.set(job.id, job);
  readyRant({ sourceUrl, mainUrl, duration, language: language === 'bengali' ? 'bengali' : 'english' })
    .then((r) => { job.rants = r.rants; job.ending = r.ending; job.status = 'done'; })
    .catch((err) => {
      console.error('[ready-rant] failed:', err.message);
      job.status = 'failed';
      job.error = /not set up/.test(err.message) ? err.message
        : /transcript/i.test(err.message) ? 'We couldn’t read what this video says. Try another video.'
        : 'The RANTs didn’t come out. Tap Try again.';
    });
  res.json({ success: true, jobId: job.id, status: job.status });
});

router.get('/ready-rant/:id', (req, res) => {
  const job = READY.get(req.params.id);
  if (!job || job.deviceId !== deviceOf(req)) return res.status(404).json({ success: false, error: 'That job is no longer on the server. Tap Try again.' });
  const { id, status, rants, ending, error } = job;
  res.json({ success: true, jobId: id, status, rants, ending, error });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, j] of RENDERS) if (now - j.created > TTL_MS) RENDERS.delete(id);
  for (const [id, j] of READY) if (now - j.created > TTL_MS) READY.delete(id);
}, 15 * 60 * 1000).unref();

module.exports = router;
