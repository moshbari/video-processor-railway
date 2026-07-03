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
const library = require('../services/docFactory/library');
const voiceService = require('../services/voiceService');
const { normalizeOrientation } = require('../services/docFactory/dims');

router.use((req, res, next) => {
  req.setTimeout(20 * 60 * 1000);
  res.setTimeout(20 * 60 * 1000);
  next();
});

// jobId -> { status, events, result, error, created }  (generation jobs)
const JOBS = new Map();
// renderId -> { status, events, video, error, created, projectId }  (assembly jobs)
const RENDERS = new Map();
// projectId -> renderId, ONLY while a render is running. Lets any tab discover
// an in-flight render and attach to it instead of starting a duplicate.
const ACTIVE_RENDERS = new Map();
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

// Claude credentials for any pass (generation OR a manual-mode revision).
function claudeCreds(req) {
  const oauthToken = engine.sanitizeClaudeToken((req.body && req.body.oauthToken) || process.env.CLAUDE_CODE_OAUTH_TOKEN || '');
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  return { oauthToken: oauthToken || undefined, apiKey: oauthToken ? undefined : apiKey };
}

// Turn the creator's voice choice into a stored preference used at render time.
// Accepts either a direct {provider, voice} or a plain {gender, accent}.
function parseVoicePref(body = {}) {
  const speed = Math.max(0.7, Math.min(1.4, Number(body.speed) || 1));
  if (body.provider && body.voice) return { provider: body.provider, voice: body.voice, speed };
  if (body.gender || body.accent) {
    const r = voiceService.resolveDocFactoryVoice({ gender: body.gender, accent: body.accent });
    return { provider: r.provider, voice: r.voice, label: r.label, gender: body.gender || null, accent: body.accent || null, speed };
  }
  return { speed };
}

// Run an async AI revision as a tracked job so the frontend can poll /job/:id
// and show the live "✍️ reworking…" feed, exactly like generation. The job's
// result is the updated project (frontend reads result.panels).
function startAiJob(work) {
  const jobId = uuidv4();
  const job = { status: 'running', events: [], result: null, error: null, created: Date.now() };
  JOBS.set(jobId, job);
  Promise.resolve()
    .then(() => work((ev) => pushEvent(job, ev)))
    .then((result) => { job.result = result; job.status = 'done'; pushEvent(job, { type: 'phase', key: 'done' }); })
    .catch((err) => { job.error = (err && err.message) || 'That change failed — please try again.'; job.status = 'error'; pushEvent(job, { type: 'error', text: job.error }); });
  return jobId;
}

const SUB_MODEL = process.env.DOC_FACTORY_SUB_MODEL || 'sonnet';
const API_MODEL = process.env.DOC_FACTORY_API_MODEL || 'claude-opus-4-8';

// Re-tally the stats card after a manual script change.
function recomputeStats(panels) {
  const words = panels.reduce((s, p) => s + (p.narration ? p.narration.split(/\s+/).length : 0), 0);
  const textCards = panels.filter((p) => p.panelType === 'text-card').length;
  return { panels: panels.length, text_cards: textCards, illustrations: panels.length - textCards, words, est_minutes: +(words / 150).toFixed(1) };
}

// Re-shape panels the creator edited by hand into the canonical panel shape.
function normalizeEditedPanels(project, rawPanels) {
  const style = project.style_bible || engine.STYLE_BIBLE;
  const out = [];
  for (const p of (rawPanels || [])) {
    const narration = String(p.narration || '').trim();
    if (!narration && !p.callout) continue;
    out.push(engine.buildPanel(p, style, out.length + 1, p.beat || 1));
  }
  return out;
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

  // Mode: 'auto' (full auto, the original), 'semi' (up-front directions then
  // auto) or 'manual' (review/approve the script + image prompts by hand).
  const body = req.body || {};
  const mode = ['auto', 'semi', 'manual'].includes(body.mode) ? body.mode : 'auto';
  // The word-for-word CTA is business-critical, so it's accepted in EVERY mode.
  const cta = String(body.cta || '').trim();
  // Other up-front directions (hook, freeform notes, style) stay Semi-only.
  const semiCfg = mode === 'semi'
    ? {
        hook: String(body.hook || '').trim(),
        directives: String(body.directives || '').trim(),
        styleOverride: String(body.imageStyle || body.styleOverride || '').trim(),
      }
    : {};
  // Voice/speed the creator picked up-front (semi) — applied at render time.
  const voicePref = parseVoicePref(body);
  // Portrait (9:16 Shorts/Reels) or landscape (16:9). Locked on the project so
  // the text-cards, doodles and final video all share the shape. Works for all
  // three modes (auto / semi / manual). Defaults to landscape (unchanged).
  const orientation = normalizeOrientation(body.orientation);
  const imageFill = body.imageFill === 'manual' ? 'manual' : (body.imageFill === 'api' ? 'api' : null);

  const userId = req.headers['x-user-id'] || null;
  const jobId = uuidv4();
  const job = { status: 'running', events: [], result: null, error: null, created: Date.now() };
  JOBS.set(jobId, job);

  engine.runDocFactory({
    idea, minutes, mode, cta, ...semiCfg,
    oauthToken: oauthToken || undefined,
    apiKey: oauthToken ? undefined : apiKey,
    subModel: process.env.DOC_FACTORY_SUB_MODEL || 'sonnet',
    apiModel: process.env.DOC_FACTORY_API_MODEL || 'claude-opus-4-8',
    emit: (ev) => pushEvent(job, ev),
  })
    .then(async (result) => {
      result.id = jobId;
      result.userId = userId;            // so the render step can update the library
      result.createdAt = Date.now();
      result.video = null;
      // Where the frontend should land: manual mode pauses on the script for review.
      result.stage = mode === 'manual' ? 'script-review' : 'ready';
      result.voicePref = voicePref;
      result.orientation = orientation;
      if (imageFill) result.imageFill = imageFill;
      job.result = result;
      store.cacheProject(result);
      try { await store.saveProject(result); } catch (_) { /* R2 optional */ }
      try { await library.add(userId, result); } catch (_) { /* library optional */ }
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

// A user's saved videos — so paid work is never lost. Scoped by X-User-Id.
router.get('/projects', async (req, res) => {
  const userId = req.headers['x-user-id'] || null;
  try {
    const projects = await library.list(userId);
    res.json({ success: true, projects });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/project/:id', async (req, res) => {
  const project = await getProject(req.params.id).catch(() => null);
  if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });
  res.json({ success: true, project });
});

// Remove a project from the user's library list (R2 assets are left in place).
router.delete('/project/:id', async (req, res) => {
  const userId = req.headers['x-user-id'] || null;
  try {
    const removed = await library.remove(userId, req.params.id);
    res.json({ success: true, removed });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
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

// ===================== Manual mode: review gates =====================
// The creator reviews the finished script, edits it (by hand or by asking the
// AI), approves it, then does the same for the doodle image prompts.

// What voice options + image-AI are usable right now (drives the semi-auto UI).
router.get('/capabilities', (req, res) => {
  res.json({ success: true, voices: voiceService.docFactoryVoiceOptions(), imageApi: !!process.env.OPENAI_API_KEY });
});

// Revise the SCRIPT. Either { panels: [...] } (the creator's own edits, applied
// instantly) or { instruction: "..." } (the AI reworks it — returns a jobId you
// poll at /job/:id, whose result is the updated project).
router.post('/project/:id/revise-script', async (req, res) => {
  const project = await getProject(req.params.id).catch(() => null);
  if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });
  const body = req.body || {};

  if (Array.isArray(body.panels)) {
    project.panels = normalizeEditedPanels(project, body.panels);
    project.stats = recomputeStats(project.panels);
    project.stage = 'script-review';
    await store.saveProject(project).catch(() => {});
    return res.json({ success: true, project });
  }

  const instruction = String(body.instruction || '').trim();
  if (!instruction) return res.status(400).json({ success: false, error: 'Tell the AI what to change, or send your own edits.' });
  const creds = claudeCreds(req);
  if (!creds.oauthToken && !creds.apiKey) return res.status(400).json({ success: false, error: 'No Claude connected.' });

  const jobId = startAiJob(async (emit) => {
    const panels = await engine.reviseScript({ project, instruction, ...creds, subModel: SUB_MODEL, apiModel: API_MODEL, emit });
    project.panels = panels;
    project.stats = recomputeStats(panels);
    project.stage = 'script-review';
    await store.saveProject(project).catch(() => {});
    return project;
  });
  res.json({ success: true, jobId });
});

// Approve the script -> move on to the image-prompt review.
router.post('/project/:id/approve-script', async (req, res) => {
  const project = await getProject(req.params.id).catch(() => null);
  if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });
  project.stage = 'image-review';
  await store.saveProject(project).catch(() => {});
  res.json({ success: true, project });
});

// Revise the IMAGE (doodle) PROMPTS. Either { prompts: [{n, doodlePrompt, callout}] }
// (instant manual edits) or { instruction: "..." } (AI refine -> jobId).
router.post('/project/:id/revise-image-prompts', async (req, res) => {
  const project = await getProject(req.params.id).catch(() => null);
  if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });
  const body = req.body || {};
  const style = project.style_bible || engine.STYLE_BIBLE;

  if (Array.isArray(body.prompts)) {
    const byN = new Map(body.prompts.map((x) => [Number(x.n), x]));
    for (const panel of project.panels) {
      const upd = byN.get(panel.n);
      if (!upd) continue;
      const scene = engine.rawScene(upd.doodlePrompt);
      if (scene) { panel.doodlePrompt = `${style} Scene: ${scene}`; panel.image = null; panel.imageSource = undefined; }
      if (typeof upd.callout === 'string') panel.callout = upd.callout.trim();
    }
    await store.saveProject(project).catch(() => {});
    return res.json({ success: true, project });
  }

  const instruction = String(body.instruction || '').trim();
  if (!instruction) return res.status(400).json({ success: false, error: 'Tell the AI what to change, or send your own edits.' });
  const creds = claudeCreds(req);
  if (!creds.oauthToken && !creds.apiKey) return res.status(400).json({ success: false, error: 'No Claude connected.' });

  const jobId = startAiJob(async (emit) => {
    await engine.reviseImagePrompts({ project, instruction, ...creds, subModel: SUB_MODEL, apiModel: API_MODEL, emit });
    await store.saveProject(project).catch(() => {});
    return project;
  });
  res.json({ success: true, jobId });
});

// Approve the image prompts -> ready to generate/upload images.
router.post('/project/:id/approve-image-prompts', async (req, res) => {
  const project = await getProject(req.params.id).catch(() => null);
  if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });
  project.stage = 'images';
  await store.saveProject(project).catch(() => {});
  res.json({ success: true, project });
});

// ===================== Phase 3: assemble =====================
router.post('/project/:id/render', async (req, res) => {
  const project = await getProject(req.params.id).catch(() => null);
  if (!project) return res.status(404).json({ success: false, error: 'Project not found.' });

  // Already rendering this project? Attach to that job — never start a second
  // render (double-clicks / multiple tabs would otherwise clog the server).
  const existingId = ACTIVE_RENDERS.get(project.id);
  if (existingId) {
    const existing = RENDERS.get(existingId);
    if (existing && existing.status === 'running') {
      return res.json({ success: true, renderId: existingId, attached: true });
    }
    ACTIVE_RENDERS.delete(project.id);
  }

  const renderId = uuidv4();
  const job = { status: 'running', events: [], video: null, error: null, created: Date.now(), projectId: project.id };
  RENDERS.set(renderId, job);
  ACTIVE_RENDERS.set(project.id, renderId);
  pushEvent(job, { type: 'phase', key: 'assembling' });

  // Fall back to the voice/speed the creator chose up-front (semi mode) if the
  // render request doesn't override it.
  const pref = project.voicePref || {};
  const body = req.body || {};
  // Orientation override at render time (rare — normally locked on the project
  // so the images match). If overridden here, remember it on the project too.
  if (body.orientation) project.orientation = normalizeOrientation(body.orientation);
  assembleService.assemble(project, {
    provider: body.provider || pref.provider || process.env.DOC_FACTORY_TTS_PROVIDER || 'openai',
    voice: body.voice || pref.voice,
    speed: body.speed || pref.speed || 1,
    orientation: project.orientation,
    bgmUrl: body.bgmUrl,
    onProgress: (m) => {
      // Include structured done/of so the frontend can show a real progress bar.
      if (m && m.done) pushEvent(job, { type: 'activity', text: `Panel ${m.done}/${m.of} (${m.dur}s)`, done: m.done, of: m.of });
      else if (m && m.warn) pushEvent(job, { type: 'activity', text: `⚠️ ${m.warn}` });
    },
  })
    .then(async (out) => {
      project.video = out.url; project.video_meta = out;
      try { await store.saveProject(project); } catch (_) {}
      // Record the finished video in the owner's library so they can find it later.
      try { await library.setVideo(project.userId || req.headers['x-user-id'] || null, project.id, out.url); } catch (_) {}
      job.video = out; job.status = 'done';
      pushEvent(job, { type: 'phase', key: 'done' });
    })
    .catch((err) => {
      job.error = (err && err.message) || 'Render failed.';
      job.status = 'error';
      pushEvent(job, { type: 'error', text: job.error });
    })
    .finally(() => { if (ACTIVE_RENDERS.get(project.id) === renderId) ACTIVE_RENDERS.delete(project.id); });

  res.json({ success: true, renderId });
});

// Is this project currently rendering? Lets any tab (or a reloaded one) re-attach
// to a live render and show its progress instead of starting a fresh one.
router.get('/project/:id/active-render', (req, res) => {
  const renderId = ACTIVE_RENDERS.get(req.params.id);
  const job = renderId ? RENDERS.get(renderId) : null;
  if (!job || job.status !== 'running') return res.json({ success: true, rendering: false });
  const last = [...job.events].reverse().find((e) => e.done);
  res.json({ success: true, rendering: true, renderId, done: (last && last.done) || 0, of: (last && last.of) || 0 });
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
