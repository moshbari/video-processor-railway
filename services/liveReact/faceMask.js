/**
 * 🎥 RANT: "where to blur" pictures for moving faces. The mask is a small black
 * video with a white oval on each chosen face; ffmpeg uses it to show the
 * blurred picture only there. Sizes are fractions of the frame.
 */
const { spawn } = require('child_process');
const fs = require('fs-extra');

const MASK_W = 320;
const MASK_FPS = 10;
const EDGE = 0.25;   // seconds the blur stays on before/after a face was seen

/** Where each chosen face is at time t: [{cx,cy,rx,ry}] */
function facesAt(tracks, t) {
  const out = [];
  for (const tr of tracks) {
    const b = tr.boxes;
    if (!b || !b.length || t < b[0][0] - EDGE || t > b[b.length - 1][0] + EDGE) continue;
    let i = 0;
    while (i < b.length - 1 && b[i + 1][0] < t) i++;
    const p = b[i], q = b[Math.min(i + 1, b.length - 1)];
    const k = q[0] > p[0] ? Math.max(0, Math.min(1, (t - p[0]) / (q[0] - p[0]))) : 0;
    const mix = (n) => p[n] + (q[n] - p[n]) * k;
    const x = mix(1), y = mix(2), w = mix(3), h = mix(4);
    // Bigger than the face: forehead, hair line, ears and chin are covered too.
    out.push({ cx: x + w / 2, cy: y + h * 0.42, rx: w * 0.85, ry: h * 0.95 });
  }
  return out;
}

function drawFrame(buf, W, H, faces) {
  buf.fill(0);
  for (const f of faces) {
    const cx = f.cx * W, cy = f.cy * H, rx = Math.max(2, f.rx * W), ry = Math.max(2, f.ry * H);
    const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(H - 1, Math.ceil(cy + ry));
    for (let y = y0; y <= y1; y++) {
      const dy = (y - cy) / ry;
      const half = rx * Math.sqrt(Math.max(0, 1 - dy * dy));
      const x0 = Math.max(0, Math.floor(cx - half)), x1 = Math.min(W - 1, Math.ceil(cx + half));
      buf.fill(255, y * W + x0, y * W + x1 + 1);
    }
  }
}

function maskSize(cw, ch) {
  const W = MASK_W;
  return { W, H: Math.max(2, Math.round((W * ch) / cw / 2) * 2) };
}

function encodeMask(args, write) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    ff.stderr.on('data', (d) => { err = (err + d).slice(-400); });
    ff.on('error', reject);
    ff.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`mask: ${err}`))));
    write(ff.stdin).then(() => ff.stdin.end(), reject);
  });
}

/** A mask video for the stretch [a,b] of the main video, or null if no chosen face shows in it. */
async function maskVideo(tracks, a, b, cw, ch, out) {
  const hits = spans(tracks, a, b);
  if (!hits.length) return null;
  const { W, H } = maskSize(cw, ch);
  const buf = Buffer.alloc(W * H);
  const frames = Math.ceil((b - a) * MASK_FPS) + 1;
  await encodeMask(['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${H}`, '-r', String(MASK_FPS), '-i', 'pipe:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-pix_fmt', 'yuv444p', out], async (stdin) => {
    for (let i = 0; i < frames; i++) {
      drawFrame(buf, W, H, facesAt(tracks, a + i / MASK_FPS));
      if (!stdin.write(Buffer.from(buf))) await new Promise((r) => stdin.once('drain', r));
    }
  });
  return { file: out, spans: hits };
}

/** One mask picture for a frozen frame at time t, or null if no chosen face is there. */
async function maskStill(tracks, t, cw, ch, out) {
  const faces = facesAt(tracks, t);
  if (!faces.length) return null;
  const { W, H } = maskSize(cw, ch);
  const buf = Buffer.alloc(W * H);
  drawFrame(buf, W, H, faces);
  await encodeMask(['-y', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${H}`, '-i', 'pipe:0', '-frames:v', '1', out],
    async (stdin) => { stdin.write(buf); });
  return out;
}

/** When chosen faces show during [a,b], in that stretch's own time (merged). */
function spans(tracks, a, b) {
  const list = tracks
    .filter((t) => t.boxes && t.boxes.length)
    .map((t) => [Math.max(a, t.boxes[0][0] - EDGE) - a, Math.min(b, t.boxes[t.boxes.length - 1][0] + EDGE) - a])
    .filter(([s, e]) => e > s)
    .sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of list) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 0.2) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

/** The tracks chosen for blurring, from the saved scan. Fails loudly: a RANT must not go out with the faces showing. */
async function chosenTracks(faceBlur, r2Service, file) {
  if (!faceBlur || !faceBlur.url || !Array.isArray(faceBlur.on) || !faceBlur.on.length) return [];
  await r2Service.downloadFile(faceBlur.url, file);
  const { tracks } = await fs.readJson(file);
  const on = new Set(faceBlur.on.map(Number));
  return (tracks || []).filter((t) => on.has(Number(t.id)));
}

module.exports = { facesAt, maskVideo, maskStill, spans, chosenTracks, EDGE };
