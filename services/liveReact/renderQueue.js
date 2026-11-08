/**
 * 🎬 The RANT render line, kept safe across server restarts.
 *
 * One render at a time on this box (they're CPU-heavy). A RANT made on its
 * own goes ahead of batch RANTs, so one person's batch of 20 never holds up
 * someone making a single video; batch RANTs then go one by one, in order.
 *
 * Every waiting render is written to R2 (one small queue file per Railway
 * environment), so a deploy or restart picks the line up where it stopped.
 * Every finished render is written to R2 too, so the phone can still ask
 * about it after a restart. When a render finishes, the phone gets a push
 * notification (if it sent a push token).
 *
 * 8 Nov 2026, Mosh: "I am ready to shoot like 20 videos… when I select
 * multiple and batch render… Server will do it… one by one… I will get
 * notification one by one. I do not have to keep the app open."
 */
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const r2Service = require('../r2Service');
const liveRender = require('./renderService');
const rantPost = require('./rantPost');
const push = require('./push');

const ENV = String(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || 'local').replace(/[^a-z0-9-]/gi, '') || 'local';
const QUEUE_KEY = `live-react/render-queue/${ENV}.json`;
const resultKey = (id) => `live-react/renders/${id}.json`;
const KEEP_MS = 6 * 60 * 60 * 1000;   // finished jobs stay in memory this long (R2 keeps them after)

const JOBS = new Map();    // id -> job (public state + what's needed to run it)
let waiting = [];          // ids, in the order they came
let running = null;
let loaded = false;
const MAX_TRIES = 3;          // a render that took the server down 3 times is given up

const publicState = (j) => ({
  renderId: j.id, status: j.status, progress: j.progress, words: j.words, video: j.video, error: j.error,
  said: j.said, post: j.post, postStatus: j.postStatus, batch: j.batch, place: placeOf(j),
});

/** Place in the line (1 = next), for "3 RANTs before this one". */
function placeOf(j) {
  if (j.status !== 'waiting') return 0;
  const i = order().indexOf(j.id);
  return i < 0 ? 0 : i + 1;
}

/** Single RANTs first, then batch RANTs, each in the order they came. */
function order() {
  const solo = waiting.filter((id) => !JOBS.get(id)?.batch);
  const batch = waiting.filter((id) => JOBS.get(id)?.batch);
  return [...solo, ...batch];
}

async function saveQueue() {
  const list = waiting.concat(running ? [running] : [])
    .map((id) => JOBS.get(id)).filter(Boolean)
    .map((j) => ({ id: j.id, deviceId: j.deviceId, project: j.project, batch: j.batch, push: j.push, created: j.created, tries: j.tries || 0 }));
  try {
    await r2Service.uploadBuffer(Buffer.from(JSON.stringify({ jobs: list })), QUEUE_KEY, 'application/json');
  } catch (e) { console.warn('[render-queue] could not save the line:', e.message); }
}

async function saveResult(j) {
  try {
    const { project, push: p, ...rest } = j;
    await r2Service.uploadBuffer(Buffer.from(JSON.stringify({ ...rest, title: project?.main?.title || '' })), resultKey(j.id), 'application/json');
  } catch (e) { console.warn('[render-queue] could not save a result:', e.message); }
}

function newJob({ id, deviceId, project, batch, push: p, created, tries }) {
  return {
    id: id || uuidv4(), deviceId, project, batch: Boolean(batch), push: p || null, created: created || Date.now(), tries: tries || 0,
    status: 'waiting', progress: 0, words: batch ? 'Waiting in your batch' : 'Waiting for the renderer',
    video: null, error: null, said: null, post: null, postStatus: null,
  };
}

/** Put a render in the line. Returns its public state. */
async function add({ deviceId, project, batch, push: p }) {
  await ready;   // never overwrite the saved line before it's been read back
  const j = newJob({ deviceId, project, batch, push: p });
  JOBS.set(j.id, j);
  waiting.push(j.id);
  await saveQueue();
  kick();
  return publicState(j);
}

/** The job, from memory or (after a restart) from R2. null = unknown. */
async function get(id, deviceId) {
  let j = JOBS.get(id);
  if (!j) {
    const buf = await r2Service.getFile(resultKey(id)).catch(() => null);
    if (buf) { try { j = JSON.parse(buf.toString('utf8')); } catch (_) { j = null; } }
  }
  if (!j || j.deviceId !== deviceId) return null;
  return publicState(j);
}

function notify(j) {
  if (!j.push) return;
  const title = j.status === 'done' ? 'Your RANT is ready 🎉' : 'A RANT didn’t render';
  const name = String(j.project?.main?.title || '').trim();
  const body = j.status === 'done'
    ? `${name ? `“${name.slice(0, 80)}”` : 'Your video'} is made. Open Get Transcript to save it to Photos.`
    : `${name ? `“${name.slice(0, 80)}”` : 'One video'} didn’t render. Open it and tap Make my RANT to try again.`;
  push.send(j.push, { title, body, data: { renderId: j.id, projectId: String(j.project?.id || '') } })
    .then((ok) => { if (ok) console.log(`[push] sent "${title}" for ${j.id.slice(0, 8)}`); });
}

async function runOne(j) {
  j.status = 'working';
  j.words = 'Starting';
  const project = j.project;
  // The Facebook post is written while the video renders, from what was said.
  const onSaid = (said) => {
    j.said = said || null;
    if (!j.said) return;
    j.postStatus = 'working';
    rantPost.writePost({ said: j.said, title: project.main.title, url: project.main.sourceUrl })
      .then((p) => { j.post = p; j.postStatus = 'done'; })
      .catch((e) => { console.error('[rant-post] failed:', e.message); j.postStatus = 'failed'; })
      .finally(() => { if (j.status === 'done') saveResult(j); });
  };
  const workDir = path.join(process.env.TEMP_DIR || '/app/temp', `live-react-render-${j.id}`);
  try {
    const r = await liveRender.render(project, workDir, (f, words) => { j.progress = Math.round(f * 100); j.words = words; }, onSaid);
    j.words = 'Saving your video';
    const key = `live-react/${j.deviceId}/${String(project.id || 'p').replace(/[^a-z0-9-]/gi, '')}/final-${j.id.slice(0, 8)}.mp4`;
    const up = await r2Service.uploadFile(r.file, key, 'video/mp4');
    j.video = { url: up.downloadUrl || r2Service.getPublicUrl(key), duration: r.duration, width: r.width, height: r.height };
    j.status = 'done';
    j.progress = 100;
    j.words = 'Done';
    console.log(`[LiveReact] rendered ${r.width}x${r.height} ${Math.round(r.duration)}s for ${j.deviceId.slice(0, 6)}${j.batch ? ' (batch)' : ''}`);
  } catch (err) {
    console.error('[LiveReact] render failed:', err.message);
    j.status = 'failed';
    j.error = 'The video didn’t render. Tap Make my RANT to try again.';
  } finally {
    fs.remove(workDir).catch(() => {});
  }
  await saveResult(j);
  notify(j);
  setTimeout(() => JOBS.delete(j.id), KEEP_MS).unref();
}

async function kick() {
  if (running || !loaded) return;
  const next = order()[0];
  if (!next) return;
  waiting = waiting.filter((id) => id !== next);
  running = next;
  const j = JOBS.get(next);
  j.tries = (j.tries || 0) + 1;
  await saveQueue();
  try { await runOne(j); } catch (e) { console.error('[render-queue]', e.message); }
  running = null;
  await saveQueue();
  kick();
}

/** On start-up: put back whatever was waiting or rendering when the server stopped. */
async function load() {
  try {
    // A slow R2 moment must not look like an empty line (saving it would lose the batch).
    let buf = null;
    for (let i = 0; ; i++) {
      try { buf = await r2Service.getFile(QUEUE_KEY); break; } catch (e) {
        if (i >= 4) throw e;
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
      }
    }
    const list = buf ? (JSON.parse(buf.toString('utf8')).jobs || []) : [];
    for (const s of list.sort((a, b) => a.created - b.created)) {
      if (!s || !s.id || JOBS.has(s.id) || !s.project) continue;
      const j = newJob(s);
      JOBS.set(s.id, j);
      if (j.tries >= MAX_TRIES) {
        j.status = 'failed';
        j.error = 'The video didn’t render. Tap Make my RANT to try again.';
        await saveResult(j);
        notify(j);
        continue;
      }
      waiting.push(s.id);
    }
    if (list.length) console.log(`[render-queue] ${list.length} render(s) back in line after a restart`);
  } catch (e) {
    console.warn('[render-queue] could not read the line:', e.message);
  }
  loaded = true;
  await saveQueue();
  kick();
}
const ready = new Promise((resolve) => setTimeout(() => load().finally(resolve), 3000));

module.exports = { add, get, ENV };
