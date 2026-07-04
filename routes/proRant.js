/**
 * 🎬 PRO-RANT routes (RANT Squad)
 *
 * A new rant type: fetch a main video, pick precise start/end sections, attach a
 * reaction (Tella link / upload / webcam) to each as a movable, resizable box,
 * then render everything joined into one video. Work autosaves; renders are
 * server-owned and survive a page refresh.
 *
 *   POST /api/pro-rant/ingest        {url} | file 'video'  -> main video (R2 url + dims + duration)
 *   POST /api/pro-rant/reaction      {tellaUrl} | file 'video' -> reaction clip (R2 url + duration)
 *   POST /api/pro-rant/project       {project}             -> save/autosave (returns project w/ id)
 *   GET  /api/pro-rant/project/:id                         -> load a saved project
 *   GET  /api/pro-rant/projects                            -> list this user's projects
 *   DELETE /api/pro-rant/project/:id                       -> drop from library
 *   POST /api/pro-rant/project/:id/render                  -> start (idempotent) -> { renderId }
 *   GET  /api/pro-rant/render/:renderId?after=N            -> poll { status, events, video }
 *   GET  /api/pro-rant/project/:id/active-render           -> reconnect after refresh
 *
 * X-User-Id (Supabase id) scopes the library. Runs on the same infra as the
 * other tools (yt-dlp / Tella / FFmpeg / Cloudflare R2).
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const downloadService = require('../services/downloadService');
const r2Service = require('../services/r2Service');
const store = require('../services/proRant/store');
const library = require('../services/proRant/library');
const renderService = require('../services/proRant/renderService');
const usageService = require('../services/usageService');

// Large videos go to disk (FFmpeg reads them locally).
const uploadDir = path.join(process.env.TEMP_DIR || os.tmpdir(), 'pro-rant-uploads');
fs.ensureDirSync(uploadDir);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => cb(null, `${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname) || '.mp4'}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 * 1024 }, // 5GB
});

// --- server-owned render jobs (survive client refresh) --------------------
const RENDERS = new Map();          // renderId -> { status, events[], video, error, created, projectId }
const ACTIVE_RENDERS = new Map();   // projectId -> renderId (only while running)
const TTL_MS = 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of RENDERS) if (now - j.created > TTL_MS) RENDERS.delete(id);
}, 10 * 60 * 1000).unref();

const pushEvent = (job, ev) => job.events.push({ ...ev, at: Date.now() });
const uid = (req) => req.headers['x-user-id'] || null;

// ===================== Ingest the MAIN video =====================
router.post('/ingest', upload.single('video'), async (req, res) => {
  try {
    const url = (req.body && req.body.url || '').trim();
    if (!url && !req.file) {
      return res.status(400).json({ success: false, error: 'Paste a video link or upload a file.' });
    }
    const id = uuidv4();
    let localPath, meta = {};
    if (url) {
      const r = await downloadService.downloadVideo(url, `prorant-main-${id}`);
      localPath = r.videoPath;
      meta = { title: r.title || null, thumbnail: r.thumbnail || null, sourceUrl: url, platform: r.platform || null };
    } else {
      localPath = req.file.path;
      meta = { title: req.file.originalname || 'Uploaded video', thumbnail: null, sourceUrl: null };
    }

    const [duration, dims] = await Promise.all([
      renderService.probeDuration(localPath),
      renderService.probeDimensions(localPath),
    ]);

    // Upload to R2 so the browser can play it back for scrubbing, and so render
    // can re-fetch it later even after a restart.
    const key = `pro-rant/${id}/main${path.extname(localPath) || '.mp4'}`;
    const up = await r2Service.uploadFile(localPath, key, 'video/mp4');
    const r2Url = up.downloadUrl || r2Service.getPublicUrl(key);

    // Quality guardrail: the final render matches the main video's real pixels,
    // so if the source came in below 1080p the export can't be 1080p. Surface a
    // clear warning (esp. for YouTube/link fetches, where the available quality
    // is out of the user's hands) so they can swap in a higher-res source.
    const height = dims.height || 0;
    const isHD = height >= 1080;
    const warning = isHD ? null
      : `This video is only ${dims.width}×${height} — smaller than 1080p. Your final video will be this size too. For the best quality, download a 1080p file from the source, then upload it here.`;

    res.json({
      success: true,
      warning,
      main: { id, r2Key: key, r2Url, url: r2Url, width: dims.width, height, duration, isHD, ...meta },
    });
  } catch (err) {
    console.error('[ProRant] ingest error:', err.message);
    res.status(500).json({ success: false, error: friendly(err.message, "Couldn't load that video. Check the link or try another file.") });
  }
});

// ===================== Add a REACTION clip =====================
// Reaction from a Tella link, an uploaded file, or a webcam recording (blob upload).
router.post('/reaction', upload.single('video'), async (req, res) => {
  try {
    const tellaUrl = (req.body && (req.body.tellaUrl || req.body.url) || '').trim();
    const type = (req.body && req.body.type) || (tellaUrl ? 'tella' : (req.file ? 'upload' : null));
    if (!tellaUrl && !req.file) {
      return res.status(400).json({ success: false, error: 'Add a reaction: a Tella link, a file, or a webcam recording.' });
    }
    const id = uuidv4();
    let localPath;
    if (tellaUrl) {
      const r = await downloadService.downloadVideo(tellaUrl, `prorant-react-${id}`); // routes Tella -> tellaService
      localPath = r.videoPath;
    } else {
      localPath = req.file.path;
    }

    // Re-encode to a browser-SAFE MP4 (H.264/AAC + faststart) before storing, so
    // the reaction preview actually PLAYS. A raw webcam .webm / phone H.265 clip /
    // non-faststart mp4 would otherwise load its duration but refuse to play in the
    // <video> element. Falls back to the original file if the transcode ever fails,
    // so a user is never fully blocked from attaching a reaction.
    let uploadPath = localPath;
    let ext = path.extname(localPath) || '.mp4';
    try {
      const safePath = path.join(uploadDir, `${id}-web.mp4`);
      await renderService.webSafe(localPath, safePath);
      uploadPath = safePath;
      ext = '.mp4';
    } catch (e) {
      console.warn('[ProRant] reaction web-safe transcode failed, uploading original:', e.message);
    }

    const duration = await renderService.probeDuration(uploadPath);
    const key = `pro-rant/reactions/${id}${ext}`;
    const up = await r2Service.uploadFile(uploadPath, key, 'video/mp4');
    const r2Url = up.downloadUrl || r2Service.getPublicUrl(key);

    res.json({ success: true, reaction: { id, type: type || 'upload', r2Key: key, r2Url, url: r2Url, duration } });
  } catch (err) {
    console.error('[ProRant] reaction error:', err.message);
    res.status(500).json({ success: false, error: friendly(err.message, "Couldn't add that reaction. Try again or use a different clip.") });
  }
});

// ===================== Remove silence from a reaction =====================
// One click: trim the silent pauses out of a reaction clip and return a new one.
router.post('/reaction/desilence', async (req, res) => {
  try {
    const url = (req.body && (req.body.url || req.body.r2Url) || '').trim();
    const type = (req.body && req.body.type) || 'upload';
    if (!url) return res.status(400).json({ success: false, error: 'No reaction to process.' });
    const id = uuidv4();
    const workDir = path.join(process.env.TEMP_DIR || os.tmpdir(), 'pro-rant', 'desilence', id);
    await fs.ensureDir(workDir);
    const inPath = path.join(workDir, 'in.mp4');
    await r2Service.downloadFile(url, inPath);
    const outPath = path.join(workDir, 'out.mp4');
    const result = await renderService.removeSilence(inPath, outPath);
    const key = `pro-rant/reactions/${id}-desilenced.mp4`;
    const up = await r2Service.uploadFile(outPath, key, 'video/mp4');
    const r2Url = up.downloadUrl || r2Service.getPublicUrl(key);
    try { await fs.remove(workDir); } catch (_) {}
    res.json({ success: true, reaction: { id, type, r2Key: key, r2Url, url: r2Url, duration: result.after }, removed: result.removed, before: result.before, after: result.after });
  } catch (err) {
    console.error('[ProRant] desilence error:', err.message);
    res.status(500).json({ success: false, error: friendly(err.message, "Couldn't remove the silence. Please try again.") });
  }
});

// ===================== Save / autosave a project =====================
router.post('/project', async (req, res) => {
  try {
    const userId = uid(req);
    const incoming = (req.body && req.body.project) || req.body || {};
    if (!incoming || typeof incoming !== 'object') return res.status(400).json({ success: false, error: 'Nothing to save.' });
    const project = {
      ...incoming,
      id: incoming.id || uuidv4(),
      userId: userId || incoming.userId || null,
      createdAt: incoming.createdAt || Date.now(),
    };
    await store.saveProject(project);
    try { await library.add(userId, project); } catch (_) { /* library optional */ }
    res.json({ success: true, project });
  } catch (err) {
    console.error('[ProRant] save error:', err.message);
    res.status(500).json({ success: false, error: 'Could not save your work. Please try again.' });
  }
});

router.get('/projects', async (req, res) => {
  try {
    res.json({ success: true, projects: await library.list(uid(req)) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get('/project/:id', async (req, res) => {
  try {
    const project = await store.loadProject(req.params.id);
    if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });
    res.json({ success: true, project });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete('/project/:id', async (req, res) => {
  try {
    const removed = await library.remove(uid(req), req.params.id);
    res.json({ success: true, removed });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ===================== Render (server-owned, idempotent) =====================
router.post('/project/:id/render', async (req, res) => {
  try {
    const userId = uid(req);
    const project = await store.loadProject(req.params.id);
    if (!project) return res.status(404).json({ success: false, error: 'Project not found. Save your work first.' });

    // Already rendering this project? Re-attach instead of starting a second one.
    const existing = ACTIVE_RENDERS.get(project.id);
    if (existing && RENDERS.get(existing) && RENDERS.get(existing).status === 'running') {
      return res.json({ success: true, renderId: existing, attached: true });
    }

    const renderId = uuidv4();
    const job = { status: 'running', events: [], video: null, error: null, created: Date.now(), projectId: project.id };
    RENDERS.set(renderId, job);
    ACTIVE_RENDERS.set(project.id, renderId);
    pushEvent(job, { type: 'activity', text: 'Starting render…', done: 0, of: (project.sections || []).length });

    const workDir = path.join(process.env.TEMP_DIR || os.tmpdir(), 'pro-rant', project.id, renderId);
    const started = Date.now();

    renderService.render(project, { workDir, onProgress: (p) => pushEvent(job, { type: 'activity', ...p }) })
      .then(async ({ outputPath }) => {
        pushEvent(job, { type: 'activity', text: 'Uploading your video…' });
        const key = `pro-rant/${project.id}/final-${renderId}.mp4`;
        const up = await r2Service.uploadFile(outputPath, key, 'video/mp4');
        const videoUrl = up.downloadUrl || r2Service.getPublicUrl(key);
        job.video = videoUrl;
        project.video = videoUrl;
        try { await store.saveProject(project); } catch (_) {}
        try { await library.setVideo(userId, project.id, videoUrl); } catch (_) {}
        // Track compute usage (video render minutes) for the admin AI/usage view.
        try {
          usageService.record({
            userId, email: req.headers['x-user-email'] || null, feature: 'pro-rant',
            provider: 'ffmpeg', characters: 0, costUsd: 0,
            meta: { projectId: project.id, sections: (project.sections || []).length, seconds: Math.round((Date.now() - started) / 1000) },
          });
        } catch (_) {}
        job.status = 'done';
        pushEvent(job, { type: 'done', video: videoUrl });
        try { await fs.remove(workDir); } catch (_) {}
      })
      .catch((err) => {
        console.error('[ProRant] render error:', err.message);
        job.status = 'error';
        job.error = friendly(err.message, 'The render hit a snag. Please try again.');
        pushEvent(job, { type: 'error', text: job.error });
      })
      .finally(() => { ACTIVE_RENDERS.delete(project.id); });

    res.json({ success: true, renderId });
  } catch (err) {
    console.error('[ProRant] render start error:', err.message);
    res.status(500).json({ success: false, error: 'Could not start the render. Please try again.' });
  }
});

router.get('/render/:renderId', (req, res) => {
  const job = RENDERS.get(req.params.renderId);
  if (!job) return res.status(404).json({ success: false, error: 'Render not found or expired.' });
  const after = Math.max(0, parseInt(req.query.after, 10) || 0);
  res.json({
    success: true, status: job.status, nextCursor: job.events.length,
    events: job.events.slice(after), video: job.status === 'done' ? job.video : null, error: job.error || null,
  });
});

// After a refresh, a fresh tab asks: is a render still running for this project?
router.get('/project/:id/active-render', (req, res) => {
  const renderId = ACTIVE_RENDERS.get(req.params.id);
  const job = renderId && RENDERS.get(renderId);
  if (!job || job.status !== 'running') return res.json({ success: true, rendering: false });
  const last = [...job.events].reverse().find((e) => e.type === 'activity') || {};
  res.json({ success: true, rendering: true, renderId, done: last.done || 0, of: last.of || 0 });
});

// Turn a raw FFmpeg/yt-dlp error into a warm, non-technical message.
function friendly(raw, fallback) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('tella_api_key') || s.includes('tella')) return "Couldn't fetch that Tella video. Make sure the link is a shared Tella video.";
  if (s.includes('unsupported url') || s.includes('no video') || s.includes('unavailable')) return "That link couldn't be loaded. Try a different video or upload the file.";
  if (s.includes('timed out') || s.includes('timeout')) return 'That took too long. Please try again.';
  return fallback;
}

module.exports = router;
module.exports.RENDERS = RENDERS;
module.exports.ACTIVE_RENDERS = ACTIVE_RENDERS;
