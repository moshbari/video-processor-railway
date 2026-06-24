/**
 * 🎬 DOC FACTORY routes (RANT Squad)
 *
 * Phase 1 — brain:
 *   POST /api/doc-factory/generate         { idea, minutes? }  -> { jobId }
 *   GET  /api/doc-factory/job/:id?after=N                      -> { status, events, result? }
 * Phase 2 — images:
 *   GET  /api/doc-factory/project/:id                          -> full project (memory or R2)
 *   GET  /api/doc-factory/project/:id/prompt-sheet             -> text/plain doodle prompts
 *   POST /api/doc-factory/project/:id/text-cards               -> render all text-card panels
 *   POST /api/doc-factory/project/:id/images   (multipart)     -> upload numbered images
 *   POST /api/doc-factory/project/:id/generate-images { mode } -> api fill (+ text-cards)
 * Phase 3 — assemble:
 *   POST /api/doc-factory/project/:id/render   { provider, voice, bgmUrl } -> { renderId }
 *   GET  /api/doc-factory/render/:renderId?after=N            -> { status, events, video? }
 *
 * Generation runs on the creator's Claude subscription (CLAUDE_CODE_OAUTH_TOKEN)
 * with an ANTHROPIC_API_KEY fallback. Projects persist to R2 so they survive the
 * in-memory job TTL and restarts.
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const engine = require('../services/docFactory/engine');
const store = require('../services/docFactory/store');
const imageProvider = require('../services/docFactory/imageProvider');
const assembleService = require('../services/docFactory/assembleService');

router.use((req, res, next) => {
  req.setTimeout(20 * 60 * 1000);
  res.setTimeout(20 * 60 * 1000);
  next();
});

// jobId -> { status, events, result, error, created }  (generation jobs)
const JOBS = new Map();
// renderId -> { status, events, video, error, created, projectId }  (assembly jobs)
const RENDERS = new Map();
const TTL_MS = 60 * 60 * 1000;

function pushEvent(job, ev) { job.events.push({ ...ev, at: Date.now() }); }
function prune(map) { const now = Date.now(); for (const [k, j] of map) if (now - j.created > TTL_MS) map.delete(k); }
setInterval(() => { prune(JOBS); prune(RENDERS); }, 10 * 60 * 1000).unref();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 300 } });

async function getProject(id) {
  const job = JOBS.get(id);
  if (job && job.result) return job.result;
  return store.loadProject(id);
}

// ===================== Phase 1: generate =====================
router.post('/generate', (req, res) => {
  const idea = String((req.body && req.body.idea) || '').trim();
  const minutes = req.body && req.body.minutes;
  if (!idea) return res.status(400).json({ success: false, error: 'Give me an idea or keyword to start from.' });

  const oauthToken = engine.sanitizeClaudeToken((req.body && req.body.oauthToken) || process.env.CLAUDE_CODE_OAUTH_TOKEN || '');
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!oauthToken && !apiKey) {
    return res.status(400).json({ success: false, error: 'No Claude connected. Set CLAUDE_CODE_OAUTH_TOKEN (your subscription) or ANTHROPIC_API_KEY on the server.' });
  }

  const jobId = uuidv4();
  const job = { status: 'running', events: [], result: null, error: null, created: Date.now() };
  JOBS.set(jobId, job);

  engine.runDocFactory({
    idea, minutes,
    oauthToken: oauthToken || undefined,
    apiKey: oauthToken ? undefined : apiKey,
    subModel: process.env.DOC_FACTORY_SUB_MODEL || 'sonnet',
    apiModel: process.env.DOC_FACTORY_API_MODEL || 'claude-opus-4-8',
    emit: (ev) => pushEvent(job, ev),
  })
    .then(async (result) => {
      result.id = jobId;
      result.video = null;
      job.result = result;
      store.cacheProject(result);
      try { await store.saveProject(result); } catch (_) { /* R2 optional */ }
      job.status = 'done';
    })
    .catch((err) => {
      job.error = (err && err.message) || 'Generation failed.';
      job.status = 'error';
      pushEvent(job, { type: 'error', text: job.error });
    });

  res.json({ success: true, jobId });
});

router.get('/job/:id', (req, res) => {
  const job = JOBS.get(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found or expired.' });
  const after = Math.max(0, parseInt(req.query.after, 10) || 0);
  res.json({
    success: true, status: job.status, nextCursor: job.events.length,
    events: job.events.slice(after), result: job.status === 'done' ? job.result : null, error: job.error || null,
  });
});

// ===================== Phase 2: project + images =====================
router.get('/project/:id', async (req, res) => {
  const project = await getProject(req.params.id).catch(() => null);
  if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });
  res.json({ success: true, project });
});

router.get('/project/:id/prompt-sheet', async (req, res) => {
  const project = await getProject(req.params.id).catch(() => null);
  if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });
  res.type('text/plain').send(imageProvider.promptSheet(project));
});

// Render all text-card panels (free, no AI).
router.post('/project/:id/text-cards', async (req, res) => {
  const project = await getProject(req.params.id).catch(() => null);
  if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });
  try {
    const result = await imageProvider.fillImages(project, { mode: 'manual' }); // text-cards only
    await store.saveProject(project).catch(() => {});
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Upload numbered images. Each file's fieldname is the panel number (e.g. "12"
// or "img_12"). Returns which panels are now filled.
router.post('/project/:id/images', upload.any(), async (req, res) => {
  const project = await getProject(req.params.id).catch(() => null);
  if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });
  try {
    const filled = [];
    for (const f of (req.files || [])) {
      const n = parseInt(String(f.fieldname).replace(/[^0-9]/g, ''), 10);
      if (!n) continue;
      await imageProvider.storeUploadedImage(project, n, f.buffer, f.mimetype);
      filled.push(n);
    }
    await store.saveProject(project).catch(() => {});
    res.json({ success: true, filled, pending: project.panels.filter((p) => !p.image).map((p) => p.n) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// API generation path (Mosh wants both API + manual). mode='api' also fills
// illustration panels; mode='manual' (default) only renders text-cards.
router.post('/project/:id/generate-images', async (req, res) => {
  const project = await getProject(req.params.id).catch(() => null);
  if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });
  const mode = (req.body && req.body.mode) === 'api' ? 'api' : 'manual';
  const limit = (req.body && Number(req.body.limit) > 0) ? Number(req.body.limit) : Infinity;
  try {
    const result = await imageProvider.fillImages(project, { mode, limit });
    await store.saveProject(project).catch(() => {});
    res.json({ success: true, mode, ...result, pending: project.panels.filter((p) => !p.image).map((p) => p.n) });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ===================== Phase 3: assemble =====================
router.post('/project/:id/render', async (req, res) => {
  const project = await getProject(req.params.id).catch(() => null);
  if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });

  const renderId = uuidv4();
  const job = { status: 'running', events: [], video: null, error: null, created: Date.now(), projectId: project.id };
  RENDERS.set(renderId, job);
  pushEvent(job, { type: 'phase', key: 'assembling' });

  assembleService.assemble(project, {
    provider: (req.body && req.body.provider) || process.env.DOC_FACTORY_TTS_PROVIDER || 'openai',
    voice: req.body && req.body.voice,
    bgmUrl: req.body && req.body.bgmUrl,
    onProgress: (m) => {
      if (m && m.done) pushEvent(job, { type: 'activity', text: `Panel ${m.done}/${m.of} (${m.dur}s)` });
      else if (m && m.warn) pushEvent(job, { type: 'activity', text: `⚠️ ${m.warn}` });
    },
  })
    .then(async (out) => {
      project.video = out.url; project.video_meta = out;
      try { await store.saveProject(project); } catch (_) {}
      job.video = out; job.status = 'done';
      pushEvent(job, { type: 'phase', key: 'done' });
    })
    .catch((err) => {
      job.error = (err && err.message) || 'Render failed.';
      job.status = 'error';
      pushEvent(job, { type: 'error', text: job.error });
    });

  res.json({ success: true, renderId });
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

module.exports = router;
module.exports.JOBS = JOBS;
module.exports.RENDERS = RENDERS;
