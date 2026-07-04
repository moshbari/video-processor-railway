/**
 * 🎬 PRO-RANT — render compositor.
 *
 * Turns a saved Pro-Rant project into one finished MP4:
 *   for each section, in order:
 *     1. cut the chosen [startSec, endSec] out of the main video
 *     2. if the section has a reaction: freeze the section's LAST frame, then
 *        play the reaction as a picture-in-picture box at the exact position +
 *        size the user set (free x / y / width — not just corners)
 *   then concatenate every piece into the final video.
 *
 * The render is server-owned and re-fetches all inputs from R2, so it survives
 * a page refresh or a server restart mid-render (the route re-attaches to it).
 *
 * Reuses: manualClipService.extractClipMaxQuality (trim), r2Service (fetch),
 * and the freeze + PiP technique proven in splitReactService/combineService.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const r2Service = require('../r2Service');
const manualClipService = require('../manualClipService');

const FPS = 30;

// --- small ffmpeg/ffprobe helpers -----------------------------------------

function run(args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args);
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => reject(new Error(`ffmpeg failed to start (${label}): ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg ${label} failed (code ${code}): ${err.slice(-600)}`));
    });
  });
}

function ffprobe(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffprobe', args);
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => reject(e));
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.slice(-300)))));
  });
}

async function probeDuration(file) {
  const out = await ffprobe(['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', file]).catch(() => '0');
  const n = parseFloat(out);
  return isNaN(n) ? 0 : n;
}

async function probeDimensions(file) {
  const out = await ffprobe(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', file]).catch(() => '');
  const m = /(\d+)x(\d+)/.exec(out);
  return m ? { width: parseInt(m[1], 10), height: parseInt(m[2], 10) } : { width: 1280, height: 720 };
}

async function hasAudio(file) {
  const out = await ffprobe(['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file]).catch(() => '');
  return out.trim().length > 0;
}

const even = (n) => { const v = Math.round(n); return v % 2 === 0 ? v : v + 1; };

// Grab the last frame of a clip as a still image (robust: seek from end).
async function extractLastFrame(videoPath, outPath) {
  try {
    await run(['-y', '-sseof', '-0.5', '-i', videoPath, '-vsync', '0', '-frames:v', '1', '-q:v', '2', outPath], 'lastframe');
    if (await fs.pathExists(outPath)) return outPath;
  } catch (_) { /* fall through */ }
  // Fallback: first frame.
  await run(['-y', '-i', videoPath, '-frames:v', '1', '-q:v', '2', outPath], 'firstframe');
  return outPath;
}

// Normalize any clip to canvas dims + 30fps + yuv420p + stereo 48k audio
// (silent audio injected if the clip has none) so concat is seamless.
async function normalizeClip(inPath, outPath, cw, ch) {
  const audio = await hasAudio(inPath);
  const vf = `scale=${cw}:${ch}:force_original_aspect_ratio=decrease,pad=${cw}:${ch}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p`;
  const args = ['-y'];
  if (audio) {
    args.push('-i', inPath, '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k', outPath);
  } else {
    // No audio track -> add a silent one so every clip is uniform for concat.
    args.push('-i', inPath, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
      '-vf', vf, '-shortest', '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '192k', outPath);
  }
  await run(args, 'normalize');
  return outPath;
}

// Build the freeze-frame + free-position/size PiP segment for one reaction.
// pip = { xPct, yPct, wPct } as fractions of the canvas (top-left origin).
async function buildFreezeWithReaction(sectionClip, reactionClip, outPath, cw, ch, pip, workDir, idx) {
  const framePath = path.join(workDir, `frame_${idx}.jpg`);
  await extractLastFrame(sectionClip, framePath);

  const dur = Math.max(0.4, await probeDuration(reactionClip));
  const pw = even(Math.max(40, (pip && pip.wPct ? pip.wPct : 0.32) * cw));
  const px = even(Math.min(Math.max(0, (pip && pip.xPct != null ? pip.xPct : 0.66) * cw), cw - pw));
  const py = even(Math.min(Math.max(0, (pip && pip.yPct != null ? pip.yPct : 0.66) * ch), ch - 40));
  const reactHasAudio = await hasAudio(reactionClip);

  const filter =
    `[0:v]scale=${cw}:${ch}:force_original_aspect_ratio=decrease,pad=${cw}:${ch}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS}[bg];` +
    `[1:v]scale=${pw}:-2,setsar=1[pip];` +
    `[bg][pip]overlay=${px}:${py}:shortest=1,format=yuv420p[v]`;

  const args = ['-y', '-loop', '1', '-t', String(dur), '-i', framePath, '-i', reactionClip,
    '-filter_complex', filter, '-map', '[v]'];
  if (reactHasAudio) args.push('-map', '1:a:0', '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k');
  else args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-map', '2:a:0', '-shortest', '-c:a', 'aac', '-b:a', '192k');
  args.push('-t', String(dur), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', outPath);

  await run(args, 'freeze+pip');
  return outPath;
}

async function concatDemuxer(clipPaths, outPath, workDir) {
  const listFile = path.join(workDir, 'concat.txt');
  const body = clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  await fs.writeFile(listFile, body);
  await run(['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outPath], 'concat')
    .catch(async () => {
      // If stream-copy concat fails (rare codec edge), fall back to re-encode.
      await run(['-y', '-f', 'concat', '-safe', '0', '-i', listFile,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', outPath], 'concat-reencode');
    });
  return outPath;
}

/**
 * Render a Pro-Rant project into one MP4.
 * @param {object} project  the saved project (main + sections)
 * @param {object} opts     { workDir, onProgress({text,done,of}) }
 * @returns {Promise<{ outputPath: string }>}
 */
async function render(project, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const workDir = opts.workDir || path.join(process.env.TEMP_DIR || '/tmp', 'pro-rant', project.id);
  await fs.ensureDir(workDir);

  const sections = Array.isArray(project.sections) ? project.sections.filter((s) => s && typeof s.startSec === 'number' && typeof s.endSec === 'number' && s.endSec > s.startSec) : [];
  if (!sections.length) throw new Error('Add at least one section (a start and end point) before rendering.');

  const total = sections.length;
  onProgress({ text: 'Fetching your main video…', done: 0, of: total });

  // 1. Bring the main video local (from its R2 copy).
  const mainPath = path.join(workDir, 'main.mp4');
  const mainUrl = project.main && (project.main.r2Url || project.main.url);
  if (!mainUrl) throw new Error('This project has no main video.');
  await r2Service.downloadFile(mainUrl, mainPath);

  // Canvas = the main video's real pixels (even numbers), so the reaction box
  // coordinates from the editor map 1:1.
  const dims = (project.canvas && project.canvas.width && project.canvas.height)
    ? project.canvas
    : await probeDimensions(mainPath);
  const cw = even(dims.width);
  const ch = even(dims.height);

  const pieces = [];
  for (let i = 0; i < total; i++) {
    const s = sections[i];
    onProgress({ text: `Building section ${i + 1} of ${total}…`, done: i, of: total });

    // 2. Cut [startSec, endSec] from the main video (max quality).
    const sectionRaw = path.join(workDir, `section_${i}_raw.mp4`);
    await manualClipService.extractClipMaxQuality(mainPath, s.startSec, s.endSec, sectionRaw);

    // Normalize the section clip to canvas so concat is seamless.
    const sectionClip = path.join(workDir, `section_${i}.mp4`);
    await normalizeClip(sectionRaw, sectionClip, cw, ch);
    pieces.push(sectionClip);

    // 3. If there's a reaction, add the freeze + PiP segment after it.
    const reactionUrl = s.reaction && (s.reaction.r2Url || s.reaction.url);
    if (reactionUrl) {
      const reactionPath = path.join(workDir, `reaction_${i}.mp4`);
      await r2Service.downloadFile(reactionUrl, reactionPath);
      const reactSeg = path.join(workDir, `reactseg_${i}.mp4`);
      await buildFreezeWithReaction(sectionClip, reactionPath, reactSeg, cw, ch, s.pip, workDir, i);
      pieces.push(reactSeg);
    }
  }

  onProgress({ text: 'Joining everything together…', done: total, of: total });
  const outputPath = path.join(workDir, 'final.mp4');
  if (pieces.length === 1) {
    await fs.copy(pieces[0], outputPath);
  } else {
    await concatDemuxer(pieces, outputPath, workDir);
  }

  return { outputPath };
}

// ---------------------------------------------------------------------------
// One-click silence removal for a reaction clip.
// Detect silent gaps (silencedetect), keep only the speaking parts (with a
// little padding) and concatenate them via the select/aselect filters so audio
// and video stay in sync. Returns how much was trimmed.
// ---------------------------------------------------------------------------
function detectSilence(input, noise, minSil) {
  return new Promise((resolve) => {
    const child = spawn('ffmpeg', ['-i', input, '-af', `silencedetect=noise=${noise}:d=${minSil}`, '-f', 'null', '-']);
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', () => resolve([]));
    child.on('close', () => {
      const starts = [], ends = [];
      let m;
      const reS = /silence_start:\s*(-?[0-9.]+)/g, reE = /silence_end:\s*([0-9.]+)/g;
      while ((m = reS.exec(err))) starts.push(parseFloat(m[1]));
      while ((m = reE.exec(err))) ends.push(parseFloat(m[1]));
      const out = [];
      for (let i = 0; i < starts.length; i++) out.push([Math.max(0, starts[i]), ends[i] != null ? ends[i] : null]);
      resolve(out);
    });
  });
}

async function removeSilence(inputPath, outputPath, opts = {}) {
  const noise = opts.noise || '-30dB';       // quieter than this counts as silence
  const minSil = opts.minSilence || 0.5;     // only cut pauses at least this long
  const pad = opts.pad != null ? opts.pad : 0.06; // keep a hair around speech
  const duration = await probeDuration(inputPath);
  const silences = await detectSilence(inputPath, noise, minSil);
  if (!silences.length) { await fs.copy(inputPath, outputPath); return { removed: 0, before: duration, after: duration }; }

  // Keep = the complement of the silent intervals.
  let t = 0; const keeps = [];
  for (const [s, e] of silences) {
    const end = e == null ? duration : e;
    if (s > t + 0.01) keeps.push([Math.max(0, t), Math.min(s, duration)]);
    t = Math.max(t, end);
  }
  if (t < duration - 0.01) keeps.push([t, duration]);

  // Pad, merge overlaps, drop slivers.
  const padded = keeps.map(([a, b]) => [Math.max(0, a - pad), Math.min(duration, b + pad)]);
  const merged = [];
  for (const k of padded) {
    const last = merged[merged.length - 1];
    if (last && k[0] <= last[1]) last[1] = Math.max(last[1], k[1]);
    else merged.push([k[0], k[1]]);
  }
  const finalKeeps = merged.filter(([a, b]) => b - a > 0.05);
  if (!finalKeeps.length) { await fs.copy(inputPath, outputPath); return { removed: 0, before: duration, after: duration }; }

  const expr = finalKeeps.map(([a, b]) => `between(t\\,${a.toFixed(3)}\\,${b.toFixed(3)})`).join('+');
  await run([
    '-y', '-i', inputPath,
    '-vf', `select=${expr},setpts=N/FRAME_RATE/TB`,
    '-af', `aselect=${expr},asetpts=N/SR/TB`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', '-b:a', '192k', outputPath,
  ], 'desilence');
  const after = await probeDuration(outputPath);
  return { removed: Math.max(0, duration - after), before: duration, after };
}

module.exports = { render, probeDuration, probeDimensions, removeSilence };
