/**
 * 🎬 DOC FACTORY routes (RANT Squad)
 *
 * Phase 1 — the brain:
 *   POST /api/doc-factory/generate   { idea, minutes? }  -> { jobId }
 *   GET  /api/doc-factory/job/:id?after=N                -> { status, events, result? }
 *
 * Runs the multi-agent pipeline on the creator's Claude subscription
 * (CLAUDE_CODE_OAUTH_TOKEN) with an ANTHROPIC_API_KEY fallback. Progress is an
 * append-only event log the frontend polls — same pattern as the other RANT
 * Squad render routes (in-memory job map, pruned on a timer).
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const engine = require('../services/docFactory/engine');

// Generation can take a few minutes (research + act-by-act script).
router.use((req, res, next) => {
  req.setTimeout(15 * 60 * 1000);
  res.setTimeout(15 * 60 * 1000);
  next();
});

// jobId -> { status, events:[], result, error, created }
const JOBS = new Map();
const JOB_TTL_MS = 60 * 60 * 1000; // keep finished jobs for an hour

function pushEvent(job, ev) {
  job.events.push({ ...ev, at: Date.now() });
}

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of JOBS) {
    if (now - job.created > JOB_TTL_MS) JOBS.delete(id);
  }
}
setInterval(pruneJobs, 10 * 60 * 1000).unref();

// ---- Start a generation ----
router.post('/generate', (req, res) => {
  const idea = String((req.body && req.body.idea) || '').trim();
  const minutes = req.body && req.body.minutes;
  if (!idea) return res.status(400).json({ success: false, error: 'Give me an idea or keyword to start from.' });

  // Subscription token: per-request override, else the server's own.
  const oauthToken = engine.sanitizeClaudeToken(
    (req.body && req.body.oauthToken) || process.env.CLAUDE_CODE_OAUTH_TOKEN || ''
  );
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!oauthToken && !apiKey) {
    return res.status(400).json({
      success: false,
      error: 'No Claude connected. Set CLAUDE_CODE_OAUTH_TOKEN (your subscription) or ANTHROPIC_API_KEY on the server.',
    });
  }

  const jobId = uuidv4();
  const job = { status: 'running', events: [], result: null, error: null, created: Date.now() };
  JOBS.set(jobId, job);

  engine
    .runDocFactory({
      idea,
      minutes,
      oauthToken: oauthToken || undefined,
      apiKey: oauthToken ? undefined : apiKey,
      subModel: process.env.DOC_FACTORY_SUB_MODEL || 'sonnet',
      apiModel: process.env.DOC_FACTORY_API_MODEL || 'claude-opus-4-8',
      emit: (ev) => pushEvent(job, ev),
    })
    .then((result) => {
      job.result = result;
      job.status = 'done';
      pushEvent(job, { type: 'phase', key: 'done' });
    })
    .catch((err) => {
      job.error = (err && err.message) || 'Generation failed.';
      job.status = 'error';
      pushEvent(job, { type: 'error', text: job.error });
    });

  res.json({ success: true, jobId });
});

// ---- Poll a generation (events since ?after=N, plus result when finished) ----
router.get('/job/:id', (req, res) => {
  const job = JOBS.get(req.params.id);
  if (!job) return res.status(404).json({ success: false, error: 'Job not found or expired.' });
  const after = Math.max(0, parseInt(req.query.after, 10) || 0);
  res.json({
    success: true,
    status: job.status,
    nextCursor: job.events.length,
    events: job.events.slice(after),
    result: job.status === 'done' ? job.result : null,
    error: job.error || null,
  });
});

// Exported so the image/render phases can reuse the same job store later.
module.exports = router;
module.exports.JOBS = JOBS;
