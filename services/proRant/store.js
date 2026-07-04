/**
 * 🎬 PRO-RANT — project store.
 *
 * A Pro-Rant "project" is the whole editing session: the main video (source +
 * its R2 playback copy + dimensions/duration) and an ordered list of sections,
 * each with an in/out time, an optional reaction clip, and the reaction's
 * picture-in-picture box (position + size). It is persisted as JSON in R2 at
 * pro-rant/{id}/project.json so the user's work is NEVER lost — it survives the
 * in-memory TTL, a page refresh, and server restarts. A small memory cache
 * keeps the hot project fast during a session. (Same pattern as docFactory.)
 */

const r2Service = require('../r2Service');

const cache = new Map(); // id -> project

function keyFor(id) {
  return `pro-rant/${id}/project.json`;
}

async function saveProject(project) {
  if (!project || !project.id) throw new Error('Project needs an id to save.');
  project.updatedAt = Date.now();
  cache.set(project.id, project);
  if (r2Service.isConfigured && r2Service.isConfigured()) {
    await r2Service.uploadBuffer(
      Buffer.from(JSON.stringify(project)),
      keyFor(project.id),
      'application/json'
    );
  }
  return project;
}

async function loadProject(id) {
  if (cache.has(id)) return cache.get(id);
  if (r2Service.isConfigured && r2Service.isConfigured()) {
    const buf = await r2Service.getFile(keyFor(id)).catch(() => null);
    if (buf) {
      try {
        const project = JSON.parse(buf.toString('utf8'));
        cache.set(id, project);
        return project;
      } catch (_) { /* fall through */ }
    }
  }
  return null;
}

function cacheProject(project) {
  if (project && project.id) cache.set(project.id, project);
  return project;
}

module.exports = { saveProject, loadProject, cacheProject, keyFor };
