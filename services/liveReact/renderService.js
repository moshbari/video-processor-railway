/**
 * 🎥 LIVE REACT — render compositor (Get Transcript phone apps).
 *
 * The phone records against one main video:
 *   - watch clips: the reactor's face (no sound) while a stretch of the video played
 *   - talks: the video paused at a moment and the reactor spoke (front or back camera)
 *   - an optional intro (before the video) and ending (after it)
 *   - extra clips (from Photos, Files, a link like Tella, or recorded on the
 *     front/back camera), each placed before or after the RANT, in order
 *   - an optional CTA clip (the user's own ready-made video), at the very end
 *
 * Final video, in order:
 *   intro → [main video piece with the face box] → talk (over the frozen frame)
 *   → next piece → … → ending
 *
 * Talks are cleaned first: Oops cuts (back to the pause before the slip),
 * "cut a bit" ranges the user marked, then silence cutting in AiPrompter /
 * FlowCast's three styles. Blur Me and the colour look apply to the reactor
 * only, never the main video. "Blur the video" blurs picked stretches of the
 * main video (never the reactor), with the same strength scale as Blur Me.
 * Every piece is normalised to the main video's size, 30fps, stereo 48k, then
 * joined with the concat demuxer.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const r2Service = require('../r2Service');
const captions = require('./captions');
const rantPost = require('./rantPost');
const talkWords = require('./talkWords');
const faceMask = require('./faceMask');

const FPS = 30;
const CTA_WORDS = new Map();   // CTA clip url|lang|script -> caption words (same clip, many RANTs)
const LUT_DIR = path.join(__dirname, '..', '..', 'assets', 'luts');
const LOOKS = ['orangeTeal', 'studio', 'pinkCyan', 'darkCinema', 'podcast', 'golden', 'cinematicBlue', 'moody', 'vintage', 'vibrant', 'pastel', 'mono'];

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

// --- "Blur the video": picked stretches of the main video -------------------

// A frame's edge can land a hair either side of a marked moment: a little
// extra blur is fine, a sharp frame of what should be hidden is not.
const BLUR_PAD = 0.05;

/** The stretches to blur, in main-video seconds: tidied, padded and merged. */
function blurRanges(list, mainLen) {
  const out = [];
  (Array.isArray(list) ? list : [])
    .map((r) => [Number(r && r[0]), Number(r && r[1])])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .map(([a, b]) => [Math.max(0, a - BLUR_PAD), Math.min(mainLen, b + BLUR_PAD)])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0])
    .forEach(([a, b]) => {
      const last = out[out.length - 1];
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else out.push([a, b]);
    });
  return out;
}

/** gblur for the main video, sized like Blur Me. strength 0…1 → up to 4% of the short side. */
function mainBlur(strength, shortSide) {
  return `gblur=sigma=${f3(Math.max(0.5, strength * 0.04 * shortSide))}:steps=3`;
}

/** The blur for a stretch [a,b] of the main video, in that piece's own time ('' if none of it is blurred). */
function pieceBlur(ranges, a, b, sigmaFilter) {
  const hits = ranges
    .map(([s, e]) => [Math.max(s, a) - a, Math.min(e, b) - a])
    .filter(([s, e]) => e > s);
  if (!hits.length) return '';
  return `,${sigmaFilter}:enable='${hits.map(([s, e]) => `between(t,${f3(s)},${f3(e)})`).join('+')}'`;
}

/** Is this moment of the main video inside a blurred stretch? */
function isBlurred(ranges, t) {
  return ranges.some(([s, e]) => t >= s && t <= e);
}

// --- cleaning a talk: oops, cut-a-bit, silences ------------------------------

/** The talk's sound as 16 kHz mono 16-bit samples. */
function pcm(file) {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-f', 's16le', '-']);
    const parts = [];
    child.stdout.on('data', (d) => parts.push(d));
    child.on('close', () => resolve(Buffer.concat(parts)));
    child.on('error', () => resolve(Buffer.alloc(0)));
  });
}

/**
 * Quiet stretches of at least minSilence seconds, measured like AiPrompter's
 * SilenceTrimmer / FlowCast: -40 dBFS RMS in 50 ms windows. (ffmpeg's
 * silencedetect checks every sample, so a phone mic's room hiss keeps breaking
 * the silence and the pause before Stop was never found.) A run that reaches
 * the end comes back ending at the end of the sound.
 */
async function detectSilences(file, minSilence) {
  const buf = await pcm(file);
  const rate = 16000, per = rate * 0.05, n = Math.floor(buf.length / 2);
  const silent = [];
  for (let i = 0; i < n; i += per) {
    const end = Math.min(n, i + per);
    let sum = 0;
    for (let k = i; k < end; k++) { const v = buf.readInt16LE(k * 2) / 32768; sum += v * v; }
    const rms = Math.sqrt(sum / Math.max(1, end - i));
    silent.push((rms > 0 ? 20 * Math.log10(rms) : -120) <= -40);
  }
  const out = [];
  for (let i = 0; i < silent.length;) {
    if (!silent[i]) { i++; continue; }
    let j = i;
    while (j < silent.length && silent[j]) j++;
    const s = i * 0.05, e = Math.min(j * 0.05, n / rate);
    if (e - s >= minSilence) out.push([s, e]);
    i = j;
  }
  return { list: out, openStart: null, soundEnd: n / rate };
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
    const { list, soundEnd } = await detectSilences(file, 0.5);
    for (const [s, e] of list) {
      // No padding at the clip's own edges: leading/trailing silence goes entirely
      // (the sound can stop a few ms before the picture).
      const a = s <= 0.05 ? 0 : s + st.after;
      const b = e >= Math.min(duration, soundEnd) - 0.1 ? duration : e - st.before;
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
 * A clip that's already made (imported clip, CTA clip) with its silences cut,
 * the same way as the talks when "Cut silences" is on. No look or volume here
 * (ctaPiece does those). Returns the file to use (the original if nothing to cut).
 */
async function trimSilences(file, style, out) {
  if (!SILENCE[style]) return file;
  try {
    const len = await probeDuration(file);
    if (!(len > 0.2) || !(await hasAudio(file))) return file;
    const cuts = await talkCuts(file, len, {}, style);
    const keep = keepRanges(len, cuts);
    if (!cuts.length || !keep.length) return file;
    const c = await cleanTalk(file, out, keep, '', false);
    return c.file || out;
  } catch (e) {
    console.warn('[LiveReact] trim silences:', e.message);
    return file;
  }
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
  try {
    await run(['-y', '-i', input, '-filter_complex', parts.join(';'), '-map', '[vo]', '-map', '[ao]', ...ENC, ...AENC, out], 'clean talk');
  } catch (err) {
    // Many pieces (a long talk with Tight silence cuts) + a colour look can make
    // ffmpeg's trim/concat graph fail ("Error reinitializing filters"). Same cut
    // in one pass instead: select keeps the frames/samples inside the ranges.
    console.warn(`[LiveReact] clean talk: ${n} pieces failed, trying one pass (${err.message.slice(0, 80)})`);
    const expr = keep.map(([a, b]) => `between(t,${f3(a)},${f3(b)})`).join('+');
    const one = [`[0:v]select='${expr}',setpts=N/FRAME_RATE/TB,${look ? look + ',' : ''}fps=${FPS},format=yuv420p[vo]`];
    one.push(audio
      ? `[0:a]aselect='${expr}',asetpts=N/SR/TB,aformat=sample_rates=48000:channel_layouts=stereo${evenVolume ? ',' + LOUDNORM : ''}[ao]`
      : `anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${f3(keep.reduce((t, [a, b]) => t + b - a, 0))}[ao]`);
    await run(['-y', '-i', input, '-filter_complex', one.join(';'), '-map', '[vo]', '-map', '[ao]', ...ENC, ...AENC, out], 'clean talk (one pass)');
  }
  return { file: out, duration: await probeDuration(out) };
}

// --- pieces of the final video ------------------------------------------------

/**
 * A stretch of the main video [a,b] with the face box laid over it from the
 * watch clips that cover it (faces recorded with the video, so they line up).
 */
async function watchPiece(main, a, b, watches, cw, ch, box, look, blur, evenVolume, out, videoBlur = '', faces = null, faceSigma = '') {
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
  // Blurred faces: the mask video says where. Done before anything is laid on
  // top, so the blur stays on the video and the reactor's box stays as it is.
  let faceIdx = -1;
  if (faces) { inputs.push('-i', faces.file); faceIdx = idx; idx++; }
  // Box size from the face picture's real shape, kept inside the frame.
  const fd = overlays.length ? await probeDisplaySize(watches.find((w) => w.file && inputs.includes(w.file)).file) : { width: 9, height: 16 };
  const faceAspect = fd.height / fd.width;
  let bw = even(box.wPct * cw);
  if (bw * faceAspect > ch * box.maxHPct) bw = even((ch * box.maxHPct) / faceAspect);
  const bh = Math.round(bw * faceAspect) + 8;
  const margin = Math.round(Math.min(cw, ch) * 0.03);
  const bx = box.xPct != null ? Math.round(box.xPct * cw) : cw - (bw + 8) - margin;
  // Portrait: the box ends at 62% of the height, not in the corner (3 Nov 2026,
  // Mosh: "the selfie is half gone under the border"). Facebook's feed and
  // profile show a 9:16 video cropped to 4:5 (only ~15%-85% of the height), and
  // full screen its caption + buttons cover the bottom ~35%. 15%-62% is seen
  // everywhere, and the box stays clear of "low" captions (72%).
  const safeBottom = ch > cw ? Math.round(ch * 0.62) : ch - margin;
  const by = box.yPct != null ? Math.min(ch - bh, Math.round(box.yPct * ch))
    : Math.max(ch > cw ? Math.round(ch * 0.15) : 0, safeBottom - bh);
  const parts = [`[0:v]scale=${cw}:${ch}:force_original_aspect_ratio=decrease,pad=${cw}:${ch}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS}${videoBlur}[base0]`];
  let last = 'base0';
  if (faces) {
    const when = faces.spans.map(([s, e]) => `between(t,${f3(s)},${f3(e)})`).join('+');
    parts[0] = parts[0].replace('[base0]', '[plain]');
    parts.push('[plain]split[fo][fb]');
    parts.push(`[fb]${faceSigma}:enable='${when}'[fbl]`);
    parts.push(`[${faceIdx}:v]format=gray,gblur=sigma=1,scale=${cw}:${ch}:flags=bilinear[fm]`);
    parts.push('[fbl][fm]alphamerge[fa]');
    parts.push('[fo][fa]overlay=eof_action=pass:format=auto[base0]');
  }
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
async function talkPiece(main, at, talkFile, talkLen, cw, ch, out, workDir, i, cap = '', stillBlur = '', hideFaces = null) {
  const still = path.join(workDir, `still-${i}.jpg`);
  // A frozen frame inside a blurred stretch is blurred too (once, here, not on every frame).
  const vf = stillBlur ? ['-vf', stillBlur] : [];
  await run(['-y', '-ss', f3(Math.max(0, at - 0.04)), '-i', main, ...vf, '-frames:v', '1', '-q:v', '2', still], 'still')
    .catch(() => run(['-y', '-i', main, ...vf, '-frames:v', '1', '-q:v', '2', still], 'still'));
  if (hideFaces) await hideFaces(still, at);
  const portrait = ch >= cw;
  let fc;
  if (portrait) {
    const mw = even(cw * 0.32);
    fc = `[1:v]scale=${cw}:${ch}:force_original_aspect_ratio=increase,crop=${cw}:${ch},setsar=1,fps=${FPS}[t];` +
         `[0:v]scale=${mw}:-2,pad=iw+8:ih+8:4:4:white[m];` +
         `[t][m]overlay=x=${Math.round(cw * 0.04)}:y=${Math.round(ch * 0.04)}${cap ? ',' + cap : ''},format=yuv420p[vo]`;
  } else {
    const th = even(ch * 0.9);
    fc = `[0:v]scale=${cw}:${ch}:force_original_aspect_ratio=decrease,pad=${cw}:${ch}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS}[bg];` +
         `[1:v]scale=-2:${th},pad=iw+8:ih+8:4:4:white[t];` +
         `[bg][t]overlay=x=W-w-${Math.round(cw * 0.03)}:y=(H-h)/2${cap ? ',' + cap : ''},format=yuv420p[vo]`;
  }
  await run(['-y', '-loop', '1', '-t', f3(talkLen), '-i', still, '-i', talkFile,
    '-filter_complex', fc, '-map', '[vo]', '-map', '1:a', '-t', f3(talkLen), ...ENC, ...AENC, out], 'talk piece');
  return out;
}

/** Intro / ending: the talk on its own, filling the frame (blurred copy behind it if the shapes differ). */
async function soloPiece(talkFile, talkLen, cw, ch, out, cap = '') {
  const fc = `[0:v]split[a][b];` +
    `[a]scale=${cw}:${ch}:force_original_aspect_ratio=increase,crop=${cw}:${ch},gblur=sigma=40,eq=brightness=-0.08[bg];` +
    `[b]scale=${cw}:${ch}:force_original_aspect_ratio=decrease,setsar=1[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=${FPS}${cap ? ',' + cap : ''},format=yuv420p[vo]`;
  await run(['-y', '-i', talkFile, '-filter_complex', fc, '-map', '[vo]', '-map', '0:a', '-t', f3(talkLen), ...ENC, ...AENC, out], 'solo piece');
  return out;
}

/**
 * The CTA clip at the very end (the user's own call-to-action video), fitted
 * into the frame with a blurred copy behind it if the shapes differ. It gets
 * the same colour look and the same captions as the rest of the RANT so it
 * matches; no Blur Me. Its silences are cut before this (trimSilences).
 */
async function ctaPiece(file, cw, ch, evenVolume, out, look = '', cap = '') {
  const len = await probeDuration(file);
  if (!(len > 0.2)) throw new Error('The CTA clip has no picture.');
  const audio = await hasAudio(file);
  const args = ['-y', '-i', file];
  if (!audio) args.push('-f', 'lavfi', '-t', f3(len), '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  const fc = `[0:v]${look ? look + ',' : ''}split[a][b];` +
    `[a]scale=${cw}:${ch}:force_original_aspect_ratio=increase,crop=${cw}:${ch},gblur=sigma=40,eq=brightness=-0.08[bg];` +
    `[b]scale=${cw}:${ch}:force_original_aspect_ratio=decrease,setsar=1[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,fps=${FPS}${cap ? ',' + cap : ''},format=yuv420p[vo];` +
    `[${audio ? '0' : '1'}:a]aformat=sample_rates=48000:channel_layouts=stereo${evenVolume ? ',' + LOUDNORM : ''}[ao]`;
  args.push('-filter_complex', fc, '-map', '[vo]', '-map', '[ao]', '-t', f3(len), ...ENC, ...AENC, out);
  await run(args, 'CTA clip');
  return out;
}

async function concat(files, out, workDir) {
  const list = path.join(workDir, 'concat.txt');
  await fs.writeFile(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  const joined = path.join(workDir, 'joined.mp4');
  await run(['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined], 'concat');
  // The AAC encoder's start-up delay leaves the picture starting ~21 ms after
  // the sound, so the first moment of the video has no picture: Photos and
  // Facebook take the thumbnail from there and show it black. Move the
  // picture back to 0 (no re-encode).
  const first = parseFloat(await ffprobe(['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#1',
    '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', joined]).catch(() => '0')) || 0;
  if (first > 0.001 && first < 1) {
    try {
      await run(['-y', '-itsoffset', f3(-first), '-i', joined, '-i', joined, '-map', '0:v', '-map', '1:a',
        '-c', 'copy', '-movflags', '+faststart', out], 'picture to 0');
      return out;
    } catch (e) {
      console.warn('[LiveReact] picture-to-0 skipped:', e.message);
    }
  }
  await run(['-y', '-i', joined, '-c', 'copy', '-movflags', '+faststart', out], 'faststart');
  return out;
}

// --- the whole render -----------------------------------------------------------

/**
 * project = {
 *   main: { url }, startAt, endAt, parts?: [[a, b], …]  (only these bits play, in order),
 *   blurs?: [[a, b], …]  (stretches of the main video to blur; options.videoBlur = strength 0…1),
 *   watches: [{ url, sourceStart, sourceEnd }],
 *   talks:   [{ kind: 'intro'|'talk'|'ending', at, url, oops: [], cuts: [[a,b]],
 *              words?: [{ text, start, end, endsSentence }], script?, lang? }],
 *   options: { silence: 'off'|'tight'|'natural'|'relaxed', blur: 0…1, look, lookStrength: 0…1,
 *              evenVolume: bool, faceBox: { xPct, yPct, wPct } },
 *   clips?: [{ url, place: 'before'|'after', recorded: bool, look: bool, captions: bool, script?, lang? }]
 *           (extra clips in the order they play; recorded = filmed in the app, so it
 *            is cleaned like a talk: silence cuts, look, Blur Me, captions)
 *   cta?: { url }   (optional CTA clip, added after everything else)
 * }
 * onProgress(fraction 0…1, words)
 */
async function render(project, workDir, onProgress = () => {}, onSaid = null) {
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

  // Extra clips: recorded ones are cleaned with the talks (kind 'clip'), imported ones are fitted as-is.
  const clips = (project.clips || []).filter((c) => c && c.url)
    .map((c) => ({ ...c, place: c.place === 'before' ? 'before' : 'after', kind: 'clip', oops: [], cuts: [], words: [] }));
  const allTalks = [...(project.talks || []).filter((t) => t.url), ...clips.filter((c) => c.recorded)];
  const watches = [];
  const fetchList = [...(project.watches || []).filter((w) => w.url), ...allTalks, ...clips.filter((c) => !c.recorded)];
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

  // "Blur the video": picked stretches of the main video, moving and frozen.
  const blurred = blurRanges(project.blurs, mainLen);
  const blurStrength = Math.max(0.05, Math.min(1, Number(opt.videoBlur) || 0.5));
  const blurFilter = mainBlur(blurStrength, Math.min(cw, ch));

  // Faces the AI found (and the user kept): the same strength, only on the face.
  const faceTracks = await faceMask.chosenTracks(project.faceBlur, r2Service, path.join(workDir, 'faces.json'));
  const hideFaces = !faceTracks.length ? null : async (still, at) => {
    const mask = await faceMask.maskStill(faceTracks, at, cw, ch, `${still}.mask.png`);
    if (!mask) return;
    const fixed = `${still}.faces.jpg`;
    await run(['-y', '-i', still, '-i', mask, '-filter_complex',
      `[0:v]split[o][b];[b]${blurFilter}[bl];[1:v]format=gray,gblur=sigma=1,scale=${cw}:${ch}:flags=bilinear[m];[bl][m]alphamerge[a];[o][a]overlay`,
      '-frames:v', '1', '-q:v', '2', fixed], 'faces on still');
    await fs.move(fixed, still, { overwrite: true });
  };

  // Face box: right side by default (portrait: inside Facebook's safe area, see
  // watchPiece), ~30% wide on a portrait video;
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
    const look = t.kind === 'clip' && t.look === false ? '' : reactorFilter(lut, blur, Math.min(dims.width, dims.height));
    const c = await cleanTalk(t.file, path.join(workDir, `talk-${i}.mp4`), keep, look, evenVolume);
    // Captions: words the phone didn't time (Android, or an iPhone talk it couldn't hear)
    // are timed here; then moved to where they land after the cuts.
    if (opt.captions && !(Array.isArray(t.words) && t.words.length)) {
      say(0.15 + 0.3 * (i / Math.max(1, allTalks.length)), `Timing captions for talk ${i + 1}`);
      t.words = await talkWords.timeWords(t.file, workDir, i, t.lang || opt.captions.lang || 'english', t.script);
    } else if (opt.captions) {
      // The phone's words aren't Bangla: make sure the talk wasn't Bangla speech.
      say(0.15 + 0.3 * (i / Math.max(1, allTalks.length)), `Checking captions for talk ${i + 1}`);
      const bn = await talkWords.banglaCheck(t.file, workDir, i, t.script, t.words);
      if (bn) t.words = bn;
    }
    if (opt.captions && Array.isArray(t.words)) c.words = captions.remapWords(t.words, cuts);
    cleaned.set(t, c);
  }

  // What was said in the RANT, for the Facebook post (written while the video renders).
  // Talks with no words and no script (captions off) are heard here just for the post.
  if (onSaid) {
    for (let i = 0; i < allTalks.length; i++) {
      const t = allTalks[i];
      if (!cleaned.has(t) || (Array.isArray(t.words) && t.words.length) || String(t.script || '').trim()) continue;
      t.words = await talkWords.timeWords(t.file, workDir, `post-${i}`, t.lang || 'english', '').catch(() => null);
    }
    try {
      // Clips before the RANT come first in what was said, clips after it last.
      const rank = (t) => (t.kind !== 'clip' ? t : { ...t, kind: t.place === 'before' ? 'intro' : 'ending' });
      onSaid(rantPost.saidIn(allTalks.filter((t) => cleaned.has(t)).map(rank)));
    } catch (e) { console.warn('[live-react] post text:', e.message); }
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
  const clipSteps = (place) => clips.filter((c) => c.place === place).forEach((c) => {
    if (c.recorded) { if (cleaned.has(c)) steps.push({ type: 'solo', t: c }); }
    else steps.push({ type: 'clip', c });
  });
  clipSteps('before');
  intros.forEach((t) => steps.push({ type: 'solo', t }));
  // "Pick your parts": only these bits of the video play, in order, each with
  // the talks made in it or right after it. The bits in between are left out.
  const parts = (Array.isArray(project.parts) ? project.parts : [])
    .map((p) => [Math.max(0, Number(p && p[0])), Math.min(mainLen, Number(p && p[1]))])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b - a >= 0.5)
    .sort((x, y) => x[0] - y[0]);
  if (parts.length) {
    // Each talk goes with the part it was made in (or the last part before it).
    const byPart = parts.map(() => []);
    for (const m of mids) {
      const raw = Number(m.t.at) || 0;
      let i = parts.findIndex(([a, b]) => raw >= a - 0.3 && raw <= b + 0.3);
      if (i < 0) { i = 0; parts.forEach(([a], j) => { if (a <= raw) i = j; }); }
      byPart[i].push({ t: m.t, at: Math.min(parts[i][1], Math.max(parts[i][0], raw)) });
    }
    parts.forEach(([a, b], i) => {
      let cur = a;
      for (const m of byPart[i].sort((x, y) => x.at - y.at)) {
        if (m.at - cur >= 0.2) steps.push({ type: 'watch', a: cur, b: m.at });
        steps.push({ type: 'talk', t: m.t, at: m.at });
        cur = m.at;
      }
      if (b - cur >= 0.2) steps.push({ type: 'watch', a: cur, b });
    });
  } else {
    let cursor = startAt;
    for (const m of mids) {
      if (m.at - cursor >= 0.2) steps.push({ type: 'watch', a: cursor, b: m.at });
      steps.push({ type: 'talk', t: m.t, at: m.at });
      cursor = m.at;
    }
    if (endAt - cursor >= 0.2) steps.push({ type: 'watch', a: cursor, b: endAt });
  }
  endings.forEach((t) => steps.push({ type: 'solo', t }));
  clipSteps('after');

  const pieces = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    say(0.45 + 0.5 * (i / steps.length), `Building part ${i + 1} of ${steps.length}`);
    const out = path.join(workDir, `piece-${String(i).padStart(3, '0')}.mp4`);
    if (s.type === 'watch') {
      const faces = faceTracks.length ? await faceMask.maskVideo(faceTracks, s.a, s.b, cw, ch, `${out}.mask.mp4`) : null;
      pieces.push(await watchPiece(main, s.a, s.b, watches, cw, ch, box, faceLook, blur, evenVolume, out, pieceBlur(blurred, s.a, s.b, blurFilter), faces, blurFilter));
    } else if (s.type === 'clip') {
      // An imported clip (Photos / Files / Tella or any link): silences cut like the talks, fitted like the CTA clip.
      const silence = opt.silence || 'relaxed';
      say(0.45 + 0.5 * (i / steps.length), `Cutting silences in clip ${i + 1}`);
      const clipFile = await trimSilences(s.c.file, silence, path.join(workDir, `clip-trim-${i}.mp4`));
      let cap = '';
      if (opt.captions && s.c.captions !== false) {
        say(0.45 + 0.5 * (i / steps.length), `Captions for clip ${i + 1}`);
        const key = `${s.c.url}|${opt.captions.lang || ''}|${s.c.script || ''}|${silence}`;
        let words = CTA_WORDS.get(key);
        if (!words) {
          words = await talkWords.timeWords(clipFile, workDir, `clip-${i}`, s.c.lang || opt.captions.lang || 'english', s.c.script || '').catch(() => []);
          if (words && words.length) { CTA_WORDS.set(key, words); if (CTA_WORDS.size > 200) CTA_WORDS.delete(CTA_WORDS.keys().next().value); }
        }
        cap = await captions.captionFilter(words, opt.captions.design, opt.captions.place, cw, ch, path.join(workDir, `captions-${i}.ass`));
      }
      pieces.push(await ctaPiece(clipFile, cw, ch, evenVolume, out, s.c.look === false ? '' : faceLook, cap));
    } else {
      const c = cleaned.get(s.t);
      const cap = opt.captions && !(s.t.kind === 'clip' && s.t.captions === false)
        ? await captions.captionFilter(c.words, opt.captions.design, opt.captions.place, cw, ch, path.join(workDir, `captions-${i}.ass`))
        : '';
      if (s.type === 'talk') {
        const hide = isBlurred(blurred, s.at) || isBlurred(blurred, Math.max(0, s.at - 0.04));
        pieces.push(await talkPiece(main, s.at, c.file, c.duration, cw, ch, out, workDir, i, cap, hide ? blurFilter : '', hide ? null : hideFaces));
      }
      else pieces.push(await soloPiece(c.file, c.duration, cw, ch, out, cap));
    }
  }
  if (!pieces.length) throw new Error('Nothing to render: no video and no talks.');

  // The CTA clip goes last, after the ending.
  if (project.cta && project.cta.url) {
    say(0.94, 'Adding your CTA clip');
    const ctaIn = path.join(workDir, `cta-in${path.extname(new URL(project.cta.url).pathname) || '.mp4'}`);
    await r2Service.downloadFile(project.cta.url, ctaIn);
    // Silences cut like everything else.
    const silence = opt.silence || 'relaxed';
    const ctaFile = await trimSilences(ctaIn, silence, path.join(workDir, 'cta-trim.mp4'));
    let cap = '';
    if (opt.captions) {
      // Same captions as the talks (the CTA is usually the same clip every RANT, so its words are kept a while).
      say(0.945, 'Captions for your CTA clip');
      const key = `${project.cta.url}|${opt.captions.lang || ''}|${project.cta.script || ''}|${silence}`;
      let words = CTA_WORDS.get(key);
      if (!words) {
        words = await talkWords.timeWords(ctaFile, workDir, 'cta', opt.captions.lang || 'english', project.cta.script || '');
        if (words && words.length) { CTA_WORDS.set(key, words); if (CTA_WORDS.size > 200) CTA_WORDS.delete(CTA_WORDS.keys().next().value); }
      }
      cap = await captions.captionFilter(words, opt.captions.design, opt.captions.place, cw, ch, path.join(workDir, 'captions-cta.ass'));
    }
    pieces.push(await ctaPiece(ctaFile, cw, ch, evenVolume, path.join(workDir, 'piece-cta.mp4'), faceLook, cap));
  }

  say(0.96, 'Joining it all together');
  const final = path.join(workDir, 'final.mp4');
  await concat(pieces, final, workDir);
  return { file: final, duration: await probeDuration(final), width: cw, height: ch };
}

module.exports = { render, talkCuts, keepRanges, ctaPiece, trimSilences, LOOKS, blurRanges };
