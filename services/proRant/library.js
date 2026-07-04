/**
 * 🎬 PRO-RANT — per-user project library.
 *
 * Every Pro-Rant a user builds costs their time (and some AI/compute), so
 * nothing should ever be lost. The full project persists in R2 via store.js
 * under pro-rant/{id}/. This adds the per-USER index so a user can come back
 * and find everything they've made — same pattern as docFactory/library.js.
 *
 * The index lives at prorant-library/{userId}.json and holds a light record
 * per project (no sections inline — just enough to list + reopen them).
 */

const r2Service = require('../r2Service');

const cache = new Map(); // userId -> { userId, projects: [...] }

function keyFor(userId) {
  return `prorant-library/${userId}.json`;
}

function toRecord(project) {
  return {
    id: project.id,
    title: project.title || (project.main && project.main.title) || 'Untitled Pro-Rant',
    thumbnail: (project.main && (project.main.thumbnail || null)) || null,
    sections: Array.isArray(project.sections) ? project.sections.length : 0,
    video: project.video || null,
    createdAt: project.createdAt || null,
    updatedAt: project.updatedAt || null,
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

// Update just the final video URL once a render finishes.
async function setVideo(userId, id, videoUrl) {
  if (!userId || !id) return null;
  const data = await _load(userId);
  const rec = data.projects.find((p) => p.id === id);
  if (rec) { rec.video = videoUrl || rec.video; rec.updatedAt = Date.now(); await _save(userId, data); }
  return rec || null;
}

async function list(userId) {
  if (!userId) return [];
  const data = await _load(userId);
  return data.projects;
}

async function remove(userId, id) {
  if (!userId || !id) return false;
  const data = await _load(userId);
  const before = data.projects.length;
  data.projects = data.projects.filter((p) => p.id !== id);
  if (data.projects.length !== before) { await _save(userId, data); return true; }
  return false;
}

module.exports = { add, setVideo, list, remove, keyFor, toRecord };
