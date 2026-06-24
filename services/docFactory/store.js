/**
 * 🎬 DOC FACTORY — project store.
 *
 * A Doc Factory "project" is the full generation result (title, fact bank,
 * panel table) plus per-panel image/audio state and the final video URL. It is
 * persisted as JSON in R2 at docfactory/{id}/project.json so it survives the
 * in-memory job TTL and server restarts. A small memory cache keeps hot
 * projects fast during a single session.
 */

const r2Service = require('../r2Service');

const cache = new Map(); // id -> project

function keyFor(id) {
  return `docfactory/${id}/project.json`;
}

async function saveProject(project) {
  if (!project || !project.id) throw new Error('Project needs an id to save.');
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
