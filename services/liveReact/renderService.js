/**
 * 🎥 LIVE REACT — render compositor (Get Transcript phone apps).
 *
 * The phone records against one main video:
 *   - watch clips: the reactor's face (no sound) while a stretch of the video played
 *   - talks: the video paused at a moment and the reactor spoke (front or back camera)
 *   - an optional intro (before the video) and ending (after it)
 *
 * Final video, in order:
 *   intro → [main video piece with the face box] → talk (over the frozen frame)
 *   → next piece → … → ending
 *
 * Talks are cleaned first: Oops cuts (back to the pause before the slip),
 * "cut a bit" ranges the user marked, then silence cutting in AiPrompter /
 * FlowCast's three styles. Blur Me and the colour look apply to the reactor
 * only, never the main video. Every piece is normalised to the main video's
 * size, 30fps, stereo 48k, then joined with the concat demuxer.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const r2Service = require('../r2Service');

const FPS = 30;
const LUT_DIR = path.join(__dirname, '..', '..', 'assets', 'luts');
const LOOKS = ['orangeTeal', 'studio', 'pinkCyan', 'darkCinema', 'golden', 'cinematicBlue', 'moody', 'vintage', 'vibrant', 'pastel', 'mono'];

// Same numbers as AiPrompter's SilenceTrimmer / FlowCast's SilenceDetector:
// -40 dBFS, silences of 0.5s+, keep this much after / before speech, never cut under 0.3s.
const SILENCE = {
  tight:   { after: 0.20, before: 0.10 },
  natural: { after: 0.40, before: 0.20 },
  relaxed: { after: 0.65, before: 0.30 },
};
const LOUDNORM = 'loudnorm=I=-16:TP=-1.5:LRA=11';
const ENC = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'];
const AENC = ['-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k'];

// --- ffmpeg helpers ---------------------------------------------------------

function run(args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-nostdin', ...args]);
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 20000) err = err.slice(-10000); });
    child.on('error', (e) => reject(new Error(`ffmpeg failed to start (${label}): ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(`ffmpeg ${label} failed (code ${code}): ${err.slice(-800)}`))));
  });
}

function ffprobe(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', args);
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.slice(-300)))));
  });
}

async function probeDuration(file) {
  const out = await ffprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', file]).catch(() => '0');
  const n = parseFloat(out);
  return Number.isFinite(n) ? n : 0;
}

/** Display size, with the phone's rotation flag applied. */
async function probeDisplaySize(file) {
  const out = await ffprobe(['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height:stream_side_data=rotation:stream_tags=rotate', '-of', 'json', file]).catch(() => '{}');
  try {
    const s = (JSON.parse(out).streams || [])[0] || {};
    let w = s.width || 1080, h = s.height || 1920;
    const rot = Math.abs(parseInt((s.tags && s.tags.rotate) || ((s.side_data_list || []).find((d) => d.rotation !== undefined) || {}).rotation || 0, 10));
    if (rot === 90 || rot === 270) [w, h] = [h, w];
    return { width: w, height: h };
  } catch (_) {
    return { width: 1080, height: 1920 };
  }
}

async function hasAudio(file) {
  const out = await ffprobe(['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file]).catch(() => '');
  return out.trim().length > 0;
}

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const f3 = (n) => Number(n).toFixed(3);

// --- the reactor's look: colour grade + Blur Me ----------------------------

/** A .cube for this look at this strength (blend of original and full look). */
async function lutFile(look, strength, workDir) {
  if (!LOOKS.includes(look) || !(strength > 0.001)) return null;
  const full = path.join(LUT_DIR, `${look}.cube`);
  if (strength >= 0.999) return full;
  const lines = (await fs.readFile(full, 'utf8')).split('\n');
  const size = parseInt((lines.find((l) => l.startsWith('LUT_3D_SIZE')) || 'LUT_3D_SIZE 32').split(/\s+/)[1], 10);
  const rows = lines.filter((l) => /^[\d.]+ [\d.]+ [\d.]+$/.test(l.trim()));
  let i = 0;
  const out = [`LUT_3D_SIZE ${size}`];
  // .cube order: red changes fastest, then green, then blue.
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    const [lr, lg, lb] = rows[i++].trim().split(' ').map(Number);
    const o = [r / (size - 1), g / (size - 1), b / (size - 1)];
    out.push([lr, lg, lb].map((v, k) => (o[k] + (v - o[k]) * strength).toFixed(6)).join(' '));
  }
  const p = path.join(workDir, `look-${look}-${Math.round(strength * 100)}.cube`);
  await fs.writeFile(p, out.join('\n'));
  return p;
}

/**
 * Filter text for the reactor's picture (empty when no look and no blur).
 * blur 0…1 → gaussian sigma up to 4% of the picture's short side: smooth,
 * frosted-glass blur (never pixel blocks). The app's preview uses the same scale.
 */
function reactorFilter(lut, blur, shortSide) {
  const parts = [];
  if (lut) parts.push(`lut3d=file='${lut.replace(/'/g, "\\'")}'`);
  if (blur > 0.001) parts.push(`gblur=sigma=${f3(Math.max(0.5, blur * 0.04 * shortSide))}:steps=3`);
  return parts.join(',');
}

// --- cleaning a talk: oops, cut-a-bit, silences ------------------------------

async function detectSilences(file, minSilence) {
  const log = await run(['-i', file, '-af', `silencedetect=noise=-40dB:d=${minSilence}`, '-f', 'null', '-'], 'silencedetect').catch(() => '');
  const out = [];
  let start = null;
  for (const line of log.split('\n')) {
    let m = /silence_start: (-?[\d.]+)/.exec(line);
    if (m) { start = Math.max(0, parseFloat(m[1])); continue; }
    m = /silence_end: ([\d.]+)/.exec(line);
    if (m && start !== null) { out.push([start, parseFloat(m[1])]); start = null; }
  }
  return { list: out, openStart: start };
}

/** Ranges (seconds) to REMOVE from a talk, merged and sorted. */
async function talkCuts(file, duration, talk, style) {
  const remove = [];

  // Oops: cut back from the tap to the pause before the slip. If the tap came
  // during a pause, the slip is the speech before that pause.
  const oops = (talk.oops || []).filter((o) => o > 0 && o <= duration + 0.5);
  if (oops.length) {
    const { list } = await detectSilences(file, 0.3);
    for (const o of oops) {
      const inside = list.find(([s, e]) => o >= s && o <= e);
      const ref = inside ? inside[0] : o;
      const before = list.filter(([, e]) => e <= ref - 0.05).pop();
      remove.push([before ? before[1] : 0, Math.min(duration, o)]);
    }
  }

  for (const c of talk.cuts || []) {
    if (Array.isArray(c) && c[1] > c[0]) remove.push([Math.max(0, c[0]), Math.min(duration, c[1])]);
  }

  const st = SILENCE[style];
  if (st) {
    const { list, openStart } = await detectSilences(file, 0.5);
    if (openStart !== null) list.push([openStart, duration]);
    for (const [s, e] of list) {
      // No padding at the clip's own edges: leading/trailing silence goes entirely.
      const a = s <= 0.05 ? 0 : s + st.after;
      const b = e >= duration - 0.05 ? duration : e - st.before;
      if (b - a >= 0.3) remove.push([a, b]);
    }
  }

  remove.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const r of remove) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  return merged;
}

/** The parts of [0,duration] that survive the cuts (anything under 0.1s dropped). */
function keepRanges(duration, cuts) {
  const keep = [];
  let t = 0;
  for (const [a, b] of cuts) {
    if (a > t + 0.1) keep.push([t, a]);
    t = Math.max(t, b);
  }
  if (duration > t + 0.1) keep.push([t, duration]);
  return keep;
}

/**
 * Clean one talk into a new file at its own size: keeps only `keep` ranges,
 * applies the reactor look, levels the voice. Returns { file, duration }.
 */
async function cleanTalk(input, out, keep, look, evenVolume) {
  const audio = await hasAudio(input);
  const n = keep.length;
  const parts = [];
  keep.forEach(([a, b], i) => {
    parts.push(`[0:v]trim=start=${f3(a)}:end=${f3(b)},setpts=PTS-STARTPTS[v${i}]`);
    parts.push(audio
      ? `[0:a]atrim=start=${f3(a)}:end=${f3(b)},asetpts=PTS-STARTPTS[a${i}]`
      : `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${f3(b - a)}[a${i}]`);
  });
  const joined = keep.map((_, i) => `[v${i}][a${i}]`).join('');
  parts.push(`${joined}concat=n=${n}:v=1:a=1[vc][ac]`);
  parts.push(`[vc]${look ? look + ',' : ''}fps=${FPS},format=yuv420p[vo]`);
  parts.push(`[ac]aformat=sample_rates=48000:channel_layouts=stereo${evenVolume ? ',' + LOUDNORM : ''}[ao]`);
  await run(['-y', '-i', input, '-filter_complex', parts.join(';'), '-map', '[vo]', '-map', '[ao]', ...ENC, ...AENC, out], 'clean talk');
  return { file: out, duration: await probeDuration(out) };
}

// --- pieces of the final video ------------------------------------------------

/**
 * A stretch of the main video [a,b] with the face box laid over it from the
 * watch clips that cover it (faces recorded with the video, so they line up).
 */
async function watchPiece(main, a, b, watches, cw, ch, box, look, blur, evenVolume, out) {
  const len = b - a;
  const inputs = ['-ss', f3(a), '-t', f3(len), '-i', main];
  const overlays = [];
  let idx = 1;
  for (const w of watches) {
    const s = Math.max(a, w.sourceStart), e = Math.min(b, w.sourceEnd);
    if (e - s < 0.1) continue;
    inputs.push('-ss', f3(s - w.sourceStart), '-t', f3(e - s), '-i', w.file);
    overlays.push({ idx, at: s - a, len: e - s });
    idx++;
  }
  // Box size from the face picture's real shape, kept inside the frame.
  const fd = overlays.length ? await probeDisplaySize(watches.find((w) => w.file && inputs.includes(w.file)).file) : { width: 9, height: 16 };
  const faceAspect = fd.height / fd.width;
  let bw = even(box.wPct * cw);
  if (bw * faceAspect > ch * box.maxHPct) bw = even((ch * box.maxHPct) / faceAspect);
  const bh = Math.round(bw * faceAspect) + 8;
  const margin = Math.round(Math.min(cw, ch) * 0.03);
  const bx = box.xPct != null ? Math.round(box.xPct * cw) : cw - (bw + 8) - margin;
  const by = box.yPct != null ? Math.min(ch - bh, Math.round(box.yPct * ch)) : ch - bh - margin;
  const parts = [`[0:v]scale=${cw}:${ch}:force_original_aspect_ratio=decrease,pad=${cw}:${ch}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS}[base0]`];
  let last = 'base0';
  overlays.forEach((o, k) => {
    // Face box: the look, scaled to the box, THEN Blur Me sized to the box
    // itself, so the small face is hidden as well as a full-screen talk
    // (blurring first and shrinking after made it ~3x weaker and recognisable).
    const boxBlur = blur > 0.001 ? `,gblur=sigma=${f3(Math.max(0.5, blur * 0.04 * bw))}:steps=3` : '';
    parts.push(`[${o.idx}:v]${look ? look + ',' : ''}scale=${bw}:-2${boxBlur},pad=iw+8:ih+8:4:4:white,setpts=PTS-STARTPTS+${f3(o.at)}/TB[f${k}]`);
    parts.push(`[${last}][f${k}]overlay=x=${bx}:y=${by}:enable='between(t,${f3(o.at)},${f3(o.at + o.len)})':eof_action=pass[base${k + 1}]`);
    last = `base${k + 1}`;
  });
  parts.push(`[${last}]format=yuv420p[vo]`);
  const mainAudio = await hasAudio(main);
  const args = ['-y', ...inputs];
  if (mainAudio) {
    parts.push(`[0:a]aformat=sample_rates=48000:channel_layouts=stereo${evenVolume ? ',' + LOUDNORM : ''}[ao]`);
  } else {
    args.push('-f', 'lavfi', '-t', f3(len), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
    parts.push(`[${idx}:a]anull[ao]`);
  }
  args.push('-filter_complex', parts.join(';'), '-map', '[vo]', '-map', '[ao]', '-t', f3(len), ...ENC, ...AENC, out);
  await run(args, 'watch piece');
  return out;
}

/**
 * A talk in the middle of the video. Portrait video: the talk fills the frame
 * with the frozen video small in the corner (what the reactor saw while
 * recording). Landscape video: the frozen frame fills it and the talk sits
 * full-height at the side.
 */
async function talkPiece(main, at, talkFile, talkLen, cw, ch, out, workDir, i) {
  const still = path.join(workDir, `still-${i}.jpg`);
  await run(['-y', '-ss', f3(Math.max(0, at - 0.04)), '-i', main, '-frames:v', '1', '-q:v', '2', still], 'still')
    .catch(() => run(['-y', '-i', main, '-frames:v', '1', '-q:v', '2', still], 'still'));
  const portrait = ch >= cw;
  let fc;
  if (portrait) {
    const mw = even(cw * 0.32);
    fc = `[1:v]scale=${cw}:${ch}:force_original_aspect_ratio=increase,crop=${cw}:${ch},setsar=1,fps=${FPS}[t];` +
         `[0:v]scale=${mw}:-2,pad=iw+8:ih+8:4:4:white[m];` +
         `[t][m]overlay=x=${Math.round(cw * 0.04)}:y=${Math.round(ch * 0.04)},format=yuv420p[vo]`;
  } else {
    const th = even(ch * 0.9);
    fc = `[0:v]scale=${cw}:${ch}:force_original_aspect_ratio=decrease,pad=${cw}:${ch}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS}[bg];` +
         `[1:v]scale=-2:${th},pad=iw+8:ih+8:4:4:white[t];` +
         `[bg][t]overlay=x=W-w-${Math.round(cw * 0.03)}:y=(H-h)/2,format=yuv420p[vo]`;
  }
  await run(['-y', '-loop', '1', '-t', f3(talkLen), '-i', still, '-i', talkFile,
    '-filter_complex', fc, '-map', '[vo]', '-map', '1:a', '-t', f3(talkLen), ...ENC, ...AENC, out], 'talk piece');
  return out;
}

/** Intro / ending: the talk on its own, filling the frame (blurred copy behind it if the shapes differ). */
async function soloPiece(talkFile, talkLen, cw, ch, out) {
  const fc = `[0:v]split[a][b];` +
    `[a]scale=${cw}:${ch}:force_original_aspect_ratio=increase,crop=${cw}:${ch},gblur=sigma=40,eq=brightness=-0.08[bg];` +
    `[b]scale=${cw}:${ch}:force_original_aspect_ratio=decrease,setsar=1[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=${FPS},format=yuv420p[vo]`;
  await run(['-y', '-i', talkFile, '-filter_complex', fc, '-map', '[vo]', '-map', '0:a', '-t', f3(talkLen), ...ENC, ...AENC, out], 'solo piece');
  return out;
}

async function concat(files, out, workDir) {
  const list = path.join(workDir, 'concat.txt');
  await fs.writeFile(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  await run(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out], 'concat');
  return out;
}

// --- the whole render -----------------------------------------------------------

/**
 * project = {
 *   main: { url }, startAt, endAt,
 *   watches: [{ url, sourceStart, sourceEnd }],
 *   talks:   [{ kind: 'intro'|'talk'|'ending', at, url, oops: [], cuts: [[a,b]] }],
 *   options: { silence: 'off'|'tight'|'natural'|'relaxed', blur: 0…1, look, lookStrength: 0…1,
 *              evenVolume: bool, faceBox: { xPct, yPct, wPct } }
 * }
 * onProgress(fraction 0…1, words)
 */
async function render(project, workDir, onProgress = () => {}) {
  await fs.ensureDir(workDir);
  const opt = project.options || {};
  const say = (f, words) => onProgress(Math.max(0, Math.min(1, f)), words);

  say(0.02, 'Fetching your video');
  const main = path.join(workDir, 'main.mp4');
  await r2Service.downloadFile(project.main.url, main);
  const mainLen = await probeDuration(main);
  const size = await probeDisplaySize(main);
  const cw = even(size.width), ch = even(size.height);

  const startAt = Math.max(0, Number(project.startAt) || 0);
  const endAt = Math.min(mainLen, Number(project.endAt) || mainLen);

  const allTalks = (project.talks || []).filter((t) => t.url);
  const watches = [];
  const fetchList = [...(project.watches || []).filter((w) => w.url), ...allTalks];
  for (let i = 0; i < fetchList.length; i++) {
    say(0.04 + 0.1 * (i / Math.max(1, fetchList.length)), 'Fetching your recordings');
    const item = fetchList[i];
    const file = path.join(workDir, `in-${i}${path.extname(new URL(item.url).pathname) || '.mov'}`);
    await r2Service.downloadFile(item.url, file);
    item.file = file;
  }
  for (const w of project.watches || []) {
    if (w.file && Number.isFinite(w.sourceStart) && Number.isFinite(w.sourceEnd)) watches.push(w);
  }

  // Reactor look (colour + blur), sized to the camera picture's short side.
  const lut = await lutFile(opt.look, opt.lookStrength ?? 1, workDir);
  const blur = Math.max(0, Math.min(1, Number(opt.blur) || 0));
  const evenVolume = opt.evenVolume !== false;

  // Face box: bottom-right corner by default, ~30% wide on a portrait video;
  // on landscape no taller than 45% of the frame.
  const portrait = ch >= cw;
  const box = { wPct: portrait ? 0.30 : 0.22, maxHPct: portrait ? 0.32 : 0.45, ...(opt.faceBox || {}) };

  // Clean every talk.
  const cleaned = new Map();
  for (let i = 0; i < allTalks.length; i++) {
    const t = allTalks[i];
    say(0.15 + 0.3 * (i / Math.max(1, allTalks.length)), `Cleaning talk ${i + 1} of ${allTalks.length}`);
    const len = await probeDuration(t.file);
    const cuts = await talkCuts(t.file, len, t, opt.silence || 'relaxed');
    const keep = keepRanges(len, cuts);
    if (!keep.length) continue;   // nothing left (all silence)
    const dims = await probeDisplaySize(t.file);
    const look = reactorFilter(lut, blur, Math.min(dims.width, dims.height));
    cleaned.set(t, await cleanTalk(t.file, path.join(workDir, `talk-${i}.mp4`), keep, look, evenVolume));
  }

  // Watch clips get the same look; their blur is applied at box size in watchPiece.
  const faceLook = reactorFilter(lut, 0, 0);

  // Order: intro(s), then the timeline cut at every talk, then ending(s).
  const intros = allTalks.filter((t) => t.kind === 'intro' && cleaned.has(t));
  const endings = allTalks.filter((t) => t.kind === 'ending' && cleaned.has(t));
  const mids = allTalks
    .filter((t) => t.kind === 'talk' && cleaned.has(t))
    .map((t) => ({ t, at: Math.min(endAt, Math.max(startAt, Number(t.at) || 0)) }))
    .sort((x, y) => x.at - y.at);

  const steps = [];
  intros.forEach((t) => steps.push({ type: 'solo', t }));
  let cursor = startAt;
  for (const m of mids) {
    if (m.at - cursor >= 0.2) steps.push({ type: 'watch', a: cursor, b: m.at });
    steps.push({ type: 'talk', t: m.t, at: m.at });
    cursor = m.at;
  }
  if (endAt - cursor >= 0.2) steps.push({ type: 'watch', a: cursor, b: endAt });
  endings.forEach((t) => steps.push({ type: 'solo', t }));

  const pieces = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    say(0.45 + 0.5 * (i / steps.length), `Building part ${i + 1} of ${steps.length}`);
    const out = path.join(workDir, `piece-${String(i).padStart(3, '0')}.mp4`);
    if (s.type === 'watch') {
      pieces.push(await watchPiece(main, s.a, s.b, watches, cw, ch, box, faceLook, blur, evenVolume, out));
    } else {
      const c = cleaned.get(s.t);
      if (s.type === 'talk') pieces.push(await talkPiece(main, s.at, c.file, c.duration, cw, ch, out, workDir, i));
      else pieces.push(await soloPiece(c.file, c.duration, cw, ch, out));
    }
  }
  if (!pieces.length) throw new Error('Nothing to render: no video and no talks.');

  say(0.96, 'Joining it all together');
  const final = path.join(workDir, 'final.mp4');
  await concat(pieces, final, workDir);
  return { file: final, duration: await probeDuration(final), width: cw, height: ch };
}

module.exports = { render, talkCuts, keepRanges, LOOKS };
