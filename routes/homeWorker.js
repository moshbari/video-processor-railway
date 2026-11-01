/**
 * 🏠 HOME DOWNLOADER routes — the helper on the home computer talks to these.
 * See services/homeWorker.js. Every call needs the X-Home-Token header.
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const os = require('os');
const fs = require('fs-extra');
const crypto = require('crypto');
const home = require('../services/homeWorker');

const router = express.Router();
const dir = path.join(process.env.TEMP_DIR || os.tmpdir(), 'home-worker');
fs.ensureDirSync(dir);
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, dir),
    filename: (_req, file, cb) => cb(null, `${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname) || '.bin'}`),
  }),
  limits: { fileSize: 4 * 1024 * 1024 * 1024 },
});

router.use((req, res, next) => {
  if (req.path === '/status') return next();
  if (!home.authed(req)) return res.status(401).json({ error: 'not allowed' });
  next();
});

router.get('/status', (_req, res) => res.json(home.status()));

router.get('/next', async (_req, res) => {
  const job = await home.next();
  if (!job) return res.status(204).end();
  res.json(job);
});

router.post('/:id/progress', express.json(), (req, res) => {
  res.json({ ok: home.progress(req.params.id, req.body && req.body.progress) });
});

router.post('/:id/file', upload.fields([{ name: 'video', maxCount: 1 }, { name: 'audio', maxCount: 1 }]), (req, res) => {
  const video = req.files && req.files.video && req.files.video[0];
  const audio = req.files && req.files.audio && req.files.audio[0];
  let info = {};
  try { info = JSON.parse((req.body && req.body.info) || '{}'); } catch (_) { /* keep empty */ }
  if (!video) return res.status(400).json({ error: 'no video file' });
  const ok = home.complete(req.params.id, { video: video.path, audio: audio ? audio.path : null }, info);
  if (!ok) { fs.remove(video.path).catch(() => {}); if (audio) fs.remove(audio.path).catch(() => {}); }
  res.json({ ok });
});

router.post('/:id/fail', express.json(), (req, res) => {
  res.json({ ok: home.fail(req.params.id, req.body && req.body.error) });
});

module.exports = router;
