/**
 * 📋 The To-RANT list: videos shared to Get Transcript, downloaded one by one.
 *
 * 12 Nov 2026, Mosh: "I want all of them to be saved as ready to make… in
 * sequence. The first one is the priority… unlimited… they should go one by
 * one. And I should not even need to keep the app open… so I can simply keep
 * checking videos and put them into the to-do rant list."
 *
 * Each phone has its own list, in the order the videos were shared. One phone's
 * videos download one at a time, oldest first; a few phones can download at
 * once (MAX_PARALLEL), so one long list never holds up someone else.
 *
 * The whole list is written to R2 (one small file per Railway environment), so
 * a deploy or restart picks up where it stopped: a download that was running
 * starts again from the top. A finished video stays on the list until the
 * phone removes it (it does that when a RANT is started on it) or KEEP_DAYS.
 * When a video is ready, the phone gets a push notification (if it sent a
 * push token).
 */
const { v4: uuidv4 } = require('uuid');
const r2Service = require('../r2Service');
const push = require('./push');

const ENV = String(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.NODE_ENV || 'local').replace(/[^a-z0-9-]/gi, '') || 'local';
const LIST_KEY = `live-react/grab-queue/${ENV}.json`;
const MAX_PARALLEL = Math.max(1, Number(process.env.LIVE_REACT_QUEUE_PARALLEL || 2));
const KEEP_DAYS = Number(process.env.LIVE_REACT_QUEUE_KEEP_DAYS || 30);
const MAX_TRIES = 3;   // a download that took the server down 3 times is given up

const ITEMS = new Map();   // id -> item
let runGrab = null;        // set by the route (the same download a single grab uses)
let loaded = false;
let running = 0;

const publicItem = (j, place) => ({
  id: j.id, url: j.url, status: j.status, stage: j.stage || null, progress: j.progress || 0,
  main: j.main || null, warning: j.warning || null, error: j.error || null,
  created: j.created, place,
});

/** One phone's list, oldest first, with each waiting video's place in its line. */
function listFor(deviceId) {
  const mine = [...ITEMS.values()].filter((j) => j.deviceId === deviceId).sort((a, b) => a.created - b.created);
  let n = 0;
  return mine.map((j) => publicItem(j, j.status === 'waiting' ? ++n : 0));
}

let saving = null;
let again = false;
async function save() {
  if (saving) { again = true; return saving; }
  saving = (async () => {
    do {
      again = false;
      const items = [...ITEMS.values()].map(({ id, deviceId, url, status, stage, main, warning, error, created, push: p, tries }) =>
        ({ id, deviceId, url, status: status === 'working' ? 'waiting' : status, stage, main, warning, error, created, push: p, tries: tries || 0 }));
      try {
        await r2Service.uploadBuffer(Buffer.from(JSON.stringify({ items })), LIST_KEY, 'application/json');
      } catch (e) { console.warn('[grab-queue] could not save the list:', e.message); }
    } while (again);
  })().finally(() => { saving = null; });
  return saving;
}

function notify(j) {
  if (!j.push) return;
  const name = String(j.main?.title || '').trim();
  const msg = j.status === 'done'
    ? { title: 'Ready to RANT 🎬', body: `${name ? `“${name.slice(0, 80)}”` : 'Your video'} is in. Open Get Transcript to film your RANT.` }
    : { title: 'A video didn’t download', body: `${j.error || 'One video on your To-RANT list didn’t download.'} Open your list to try again.` };
  push.send(j.push, { ...msg, data: { queueId: j.id } })
    .then((ok) => { if (ok) console.log(`[push] sent "${msg.title}" for queue ${j.id.slice(0, 8)}`); });
}

/** Start every download that may start now. */
function kick() {
  if (!loaded || !runGrab) return;
  const busy = new Set([...ITEMS.values()].filter((j) => j.status === 'working').map((j) => j.deviceId));
  // The next video of each phone that isn't downloading yet, oldest list first.
  const heads = new Map();
  for (const j of [...ITEMS.values()].sort((a, b) => a.created - b.created)) {
    if (j.status !== 'waiting' || busy.has(j.deviceId) || heads.has(j.deviceId)) continue;
    heads.set(j.deviceId, j);
  }
  for (const j of heads.values()) {
    if (running >= MAX_PARALLEL) break;
    start(j);
  }
}

async function start(j) {
  running += 1;
  j.status = 'working';
  j.stage = 'download';
  j.progress = 0;
  j.error = null;
  j.tries = (j.tries || 0) + 1;
  await save();   // tries counted before the work, so a crash loop ends
  try {
    await runGrab(j);   // sets status done/failed, main, warning, error
  } catch (e) {
    j.status = 'failed';
    j.error = j.error || 'The video didn’t download. Tap Try again.';
  }
  running -= 1;
  if (!ITEMS.has(j.id)) { kick(); return; }   // removed while it downloaded
  if (j.status === 'done') j.tries = 0;
  console.log(`[grab-queue] ${j.status} ${j.id.slice(0, 8)}: ${j.url}`);
  await save();
  notify(j);
  kick();
}

async function add({ deviceId, url, push: p }) {
  await ready;
  // Already on the list (and not failed)? Same item back, no second copy.
  const same = [...ITEMS.values()].find((j) => j.deviceId === deviceId && j.url === url && j.status !== 'failed');
  if (same) { if (p) same.push = p; return { item: same, added: false }; }
  const j = { id: uuidv4(), deviceId, url, status: 'waiting', stage: null, progress: 0, created: Date.now(), push: p || null, tries: 0 };
  ITEMS.set(j.id, j);
  await save();
  kick();
  return { item: j, added: true };
}

async function remove(id, deviceId) {
  await ready;
  const j = ITEMS.get(id);
  if (!j || j.deviceId !== deviceId) return false;
  ITEMS.delete(id);   // a running download finishes but its result is dropped
  await save();
  kick();
  return true;
}

async function retry(id, deviceId) {
  await ready;
  const j = ITEMS.get(id);
  if (!j || j.deviceId !== deviceId || j.status !== 'failed') return null;
  j.status = 'waiting';
  j.error = null;
  j.tries = 0;
  j.progress = 0;
  // Back of the line? No: it keeps its place (it was shared earlier).
  await save();
  kick();
  return j;
}

async function list(deviceId) {
  await ready;
  return listFor(deviceId);
}

function setRunner(fn) { runGrab = fn; kick(); }

async function load() {
  try {
    let buf = null;
    for (let i = 0; ; i++) {
      try { buf = await r2Service.getFile(LIST_KEY); break; } catch (e) {
        if (/NoSuchKey|not ?found|404/i.test(`${e.name} ${e.message} ${e.Code || ''}`)) break;
        if (i >= 4) throw e;
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
      }
    }
    const items = buf ? (JSON.parse(buf.toString('utf8')).items || []) : [];
    const old = Date.now() - KEEP_DAYS * 86400000;
    for (const s of items) {
      if (!s || !s.id || ITEMS.has(s.id) || s.created < old) continue;
      const j = { ...s, progress: s.status === 'done' ? 100 : 0 };
      if (j.status === 'working') j.status = 'waiting';
      if (j.status === 'waiting' && (j.tries || 0) >= MAX_TRIES) {
        j.status = 'failed';
        j.error = 'The video didn’t download. Tap Try again.';
      }
      ITEMS.set(j.id, j);
    }
    const waitingCount = [...ITEMS.values()].filter((j) => j.status === 'waiting').length;
    if (items.length) console.log(`[grab-queue] ${ITEMS.size} video(s) on lists, ${waitingCount} waiting, after a restart`);
  } catch (e) {
    console.warn('[grab-queue] could not read the list:', e.message);
  }
  loaded = true;
  kick();
}
const ready = new Promise((resolve) => setTimeout(() => load().finally(resolve), 3000));

// Old finished items drop off.
setInterval(() => {
  const old = Date.now() - KEEP_DAYS * 86400000;
  let n = 0;
  for (const [id, j] of ITEMS) if (j.created < old && j.status !== 'working') { ITEMS.delete(id); n++; }
  if (n) save();
}, 6 * 60 * 60 * 1000).unref();

module.exports = { add, remove, retry, list, setRunner, ENV };
