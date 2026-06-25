/**
 * 🎬 DOC FACTORY — per-user project library.
 *
 * Every video a user makes costs money (Claude tokens + image API), so nothing
 * should ever be lost. The full project (script, image URLs, video) already
 * persists in R2 via store.js under docfactory/{id}/. This adds the missing
 * piece: a per-USER index so a user can come back later and find everything
 * they have made — the same pattern Clip Maker uses (manual-clip-library).
 *
 * The index lives at docfactory-library/{userId}.json and holds a light record
 * per project (no panel images inline — just enough to list + reopen them).
 * Open a project itself with GET /project/:id, which reads the full R2 copy.
 */

const r2Service = require('../r2Service');

// userId -> { userId, projects: [...] }  (hot cache for a single session)
const cache = new Map();

function keyFor(userId) {
  return `docfactory-library/${userId}.json`;
}

// A small, list-friendly record — never store the big panel array here.
function toRecord(project) {
  return {
    id: project.id,
    title: project.title || project.idea || 'Untitled',
    idea: project.idea || '',
    thumbnail_idea: project.thumbnail_idea || '',
    video: project.video || null,
    panels: Array.isArray(project.panels) ? project.panels.length : 0,
    est_minutes: (project.stats && project.stats.est_minutes) || project.target_minutes || null,
    createdAt: project.createdAt || null,
  };
}

async function _load(userId) {
  if (cache.has(userId)) return cache.get(userId);
  let data = { userId, projects: [] };
  if (r2Service.isConfigured && r2Service.isConfigured()) {
    const buf = await r2Service.getFile(keyFor(userId)).catch(() => null);
    if (buf) {
      try {
        const parsed = JSON.parse(buf.toString('utf8'));
        if (parsed && Array.isArray(parsed.projects)) data = parsed;
      } catch (_) { /* corrupt index -> start fresh */ }
    }
  }
  cache.set(userId, data);
  return data;
}

async function _save(userId, data) {
  cache.set(userId, data);
  if (r2Service.isConfigured && r2Service.isConfigured()) {
    await r2Service.uploadBuffer(
      Buffer.from(JSON.stringify(data)),
      keyFor(userId),
      'application/json'
    );
  }
  return data;
}

// Upsert a project into the user's library (newest first, deduped by id).
async function add(userId, project) {
  if (!userId || !project || !project.id) return null; // anonymous => nothing to index
  const data = await _load(userId);
  const rec = toRecord(project);
  data.projects = [rec, ...data.projects.filter((p) => p.id !== project.id)];
  await _save(userId, data);
  return rec;
}

// Update just the video URL once a render finishes.
async function setVideo(userId, id, videoUrl) {
  if (!userId || !id) return null;
  const data = await _load(userId);
  const rec = data.projects.find((p) => p.id === id);
  if (rec) { rec.video = videoUrl || rec.video; await _save(userId, data); }
  return rec || null;
}

// List a user's projects (newest first).
async function list(userId) {
  if (!userId) return [];
  const data = await _load(userId);
  return data.projects;
}

// Drop a project from the user's library (the R2 assets are left in place).
async function remove(userId, id) {
  if (!userId || !id) return false;
  const data = await _load(userId);
  const before = data.projects.length;
  data.projects = data.projects.filter((p) => p.id !== id);
  if (data.projects.length !== before) { await _save(userId, data); return true; }
  return false;
}

module.exports = { add, setVideo, list, remove, keyFor, toRecord };
