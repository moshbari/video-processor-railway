/**
 * 🎬 DOC FACTORY — voice + video assembler (Phase 3).
 *
 * Turns a project (panels with images) into a finished MP4:
 *   1. Per-panel narration via TTS (reuses voiceService) -> exact per-panel
 *      duration (no ASR needed; we authored the text).
 *   2. Each panel = a still image shown for its narration's duration, scaled/
 *      padded to 1920x1080, 30fps (the measured reference look: static, no
 *      motion, hard cuts).
 *   3. All segments are produced with identical settings, so we join them with
 *      the fast concat DEMUXER (-c copy) — no full re-encode of 100+ panels.
 *   4. Optional low background-music bed mixed under the whole thing.
 *   5. Upload to R2 (docfactory/{id}/video.mp4) and return the download URL.
 *
 * Static stills + hard cuts on purpose — confirmed from the reference file
 * (~136 kbps video bitrate => no Ken Burns, no motion).
 */

const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');
const r2Service = require('../r2Service');
const voiceService = require('../voiceService');
const { renderTextCard, calloutOverlay } = require('./textCard');
const { frameDims } = require('./dims');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const FPS = 30;
const MIN_PANEL_SEC = 1.6; // floor for panels with no/short narration

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(bin)} exited ${code}: ${err.slice(-400)}`))));
  });
}

function probeDuration(file) {
  return new Promise((resolve) => {
    const child = spawn(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file]);
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('close', () => resolve(parseFloat(out.trim()) || 0));
    child.on('error', () => resolve(0));
  });
}

async function fetchToFile(url, dest) {
  // r2Service.downloadFile follows redirects and writes to disk.
  await r2Service.downloadFile(url, dest);
  return dest;
}

/**
 * Assemble the project's MP4.
 * @param {object} project  the project (panels must have .image set or be text-cards)
 * @param {object} opts { provider, voice, bgmUrl, bgmVolume, onProgress }
 * @returns {Promise<{url:string, durationSec:number, panels:number}>}
 */
// Build an atempo filter chain for any speed (a single atempo only spans
// 0.5–2.0, so we factor larger/smaller speeds into a chain). Our UI range is
// ~0.7–1.4, well within one stage, but this keeps it safe either way.
function atempoChain(speed) {
  let s = Math.max(0.5, Math.min(3, Number(speed) || 1));
  const stages = [];
  while (s > 2.0) { stages.push(2.0); s /= 2.0; }
  while (s < 0.5) { stages.push(0.5); s /= 0.5; }
  stages.push(+s.toFixed(4));
  return stages.map((x) => `atempo=${x}`).join(',');
}

async function assemble(project, opts = {}) {
  const { provider = 'openai', voice, bgmUrl, bgmVolume = 0.12, onProgress } = opts;
  // Narration playback speed (1 = normal). Clamp to a sane, natural range.
  const speed = Math.max(0.7, Math.min(1.4, Number(opts.speed) || 1));
  // Orientation: render override wins, else the project's, else landscape.
  // Both are full 1080p — landscape 1920x1080, portrait 1080x1920.
  const { W, H, orientation } = frameDims(opts.orientation || project.orientation);
  const work = path.join(process.env.TEMP_DIR || os.tmpdir(), `docfactory-${project.id}`);
  await fs.ensureDir(work);
  const segDir = path.join(work, 'segs');
  await fs.ensureDir(segDir);

  const say = (m) => { try { onProgress && onProgress(m); } catch (_) {} };
  const panels = project.panels;
  const segFiles = [];
  let totalSec = 0;

  for (let i = 0; i < panels.length; i++) {
    const panel = panels[i];
    const base = path.join(segDir, `p${String(panel.n).padStart(3, '0')}`);

    // 1) narration audio (or silence)
    let audioFile = `${base}.audio`;
    let dur = MIN_PANEL_SEC;
    if (panel.narration && panel.narration.trim()) {
      try {
        const { buffer, ext } = await voiceService.generateTTS({ provider, text: panel.narration, voice });
        audioFile = `${base}${ext}`;
        await fs.writeFile(audioFile, buffer);
        // Apply the creator's chosen narration speed (slower/faster) uniformly,
        // whatever the TTS provider — atempo changes tempo without pitch shift.
        if (speed !== 1) {
          try {
            const sped = `${base}.spd${ext}`;
            await run(FFMPEG, ['-y', '-i', audioFile, '-filter:a', atempoChain(speed), '-vn', sped]);
            audioFile = sped;
          } catch (_) { /* keep the original-speed audio if atempo fails */ }
        }
        dur = Math.max(MIN_PANEL_SEC, await probeDuration(audioFile));
      } catch (e) {
        say({ n: panel.n, warn: `voice failed (${e.message.slice(0, 60)}) — silent panel` });
        audioFile = null;
      }
    } else {
      audioFile = null;
    }

    // 2) image (use the panel's image; render a placeholder card if missing)
    let imgFile = `${base}.png`;
    if (panel.image) {
      try { await fetchToFile(panel.image, imgFile); }
      catch (_) { imgFile = null; }
    } else { imgFile = null; }
    if (!imgFile) {
      imgFile = `${base}.png`;
      await renderTextCard({ callout: panel.callout || panel.narration || '', bgHex: panel.bgHex, outPath: imgFile, W, H });
      panel._placeholder = true;
    }

    // 3) build the segment (still image for `dur`, with audio or generated silence)
    const seg = path.join(segDir, `seg${String(i).padStart(3, '0')}.mp4`);
    let vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${(panel.bgHex || '#000000').replace('#', '0x')},fps=${FPS},format=yuv420p`;
    // Emphasis panels: lay the bold callout OVER the doodle. Skip when the image
    // is a placeholder text-card (the callout is already the whole card there).
    let calloutFile = null;
    if (panel.callout && panel.callout.trim() && imgFile && !panel._placeholder) {
      try {
        const ov = await calloutOverlay({ callout: panel.callout, tag: `${project.id}-${panel.n}`, W });
        vf += ',' + ov.vf;
        calloutFile = ov.file;
      } catch (_) { /* doodle alone is fine if the overlay can't be built */ }
    }
    const args = ['-y', '-loop', '1', '-i', imgFile];
    if (audioFile) args.push('-i', audioFile);
    else args.push('-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=44100`);
    args.push(
      '-t', dur.toFixed(3),
      '-vf', vf,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '192k',
      '-shortest', '-movflags', '+faststart', seg
    );
    await run(FFMPEG, args);
    if (calloutFile) fs.remove(calloutFile).catch(() => {});
    segFiles.push(seg);
    totalSec += dur;
    say({ n: panel.n, of: panels.length, dur: +dur.toFixed(1), done: i + 1 });
  }

  // 4) fast concat (all segments share identical codec/fps/format)
  const listFile = path.join(work, 'concat.txt');
  await fs.writeFile(listFile, segFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
  const joined = path.join(work, 'joined.mp4');
  await run(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', '-movflags', '+faststart', joined]);

  // 5) optional background-music bed
  let finalFile = joined;
  if (bgmUrl) {
    const bgm = path.join(work, 'bgm');
    try {
      await fetchToFile(bgmUrl, bgm);
      const mixed = path.join(work, 'final.mp4');
      await run(FFMPEG, [
        '-y', '-i', joined, '-stream_loop', '-1', '-i', bgm,
        '-filter_complex',
        `[1:a]volume=${bgmVolume}[bg];[0:a][bg]amix=inputs=2:duration=first:dropout_transition=2[a]`,
        '-map', '0:v', '-map', '[a]',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', mixed,
      ]);
      finalFile = mixed;
    } catch (e) {
      say({ warn: `background music skipped (${e.message.slice(0, 60)})` });
    }
  }

  // 6) upload to R2 — name the file after the video's TITLE so a download saves
  // as "What-Did-Ancient-Humans-Do-at-Night.mp4", not a generic "video.mp4".
  // R2 is a different domain, so the browser takes the filename from the URL's
  // last segment; putting the title there is what actually renames the download.
  const fileName = fileSlug(project.title);
  const key = `docfactory/${project.id}/${fileName}.mp4`;
  const up = await r2Service.uploadFile(finalFile, key, 'video/mp4');
  fs.remove(work).catch(() => {});

  return { url: up.downloadUrl || up.url, key, fileName: `${fileName}.mp4`, durationSec: +totalSec.toFixed(1), panels: panels.length, orientation, width: W, height: H };
}

// Turn a title into a safe, readable file name (keeps words + case, drops
// punctuation/emoji, spaces -> hyphens). Falls back if the title is empty.
function fileSlug(title) {
  const base = String(title || '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')   // strip punctuation, emoji, ? ! : etc.
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
    .replace(/^-+|-+$/g, '');
  return base || 'doodle-documentary';
}

module.exports = { assemble, fileSlug };
