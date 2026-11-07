/**
 * 🎥 RANT: find the women's faces in a video, so they can be blurred automatically.
 *
 *   1. faceScan.py finds and follows every face (free, on this server).
 *   2. Claude Haiku looks at a few small pictures of each face and says
 *      woman / man / unsure. Whole video frames are never sent.
 *
 * Unsure counts as a woman: a blurred man is a small mistake, a missed woman
 * is the mistake this feature exists to prevent. Same when the AI can't answer.
 *
 * Claude runs through the `claude` CLI on the owner's subscription, which suits
 * the COACH test. Members would need a paid API key (see project notes).
 */
const { spawn } = require('child_process');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

const CLAUDE_BIN = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'claude');
const PYTHON = process.env.FACE_SCAN_PYTHON || 'python3';
const MODEL = process.env.FACE_SCAN_MODEL || 'haiku';
const BATCH = 12;   // faces in one question

const SYSTEM = `You help a video creator who hides women's faces in commentary videos, for religious modesty and privacy. The faces get blurred; nobody is named or judged, and you never identify anyone.
You get small pictures of faces. Each "Face N" has 1 to 3 pictures of the same face in one shot.
For each face, say how the person looks: "woman" (including girls), "man" (including boys), or "unsure". Use the face, hair, clothing and headscarf. If it is a drawing, a mask, too small or too dark to tell, say "unsure". When in real doubt say "unsure": wrongly blurring is a small mistake, wrongly not blurring is a big one.
Reply with JSON only, nothing else: {"faces":[{"n":1,"label":"woman"}]}`;

function runPython(video, workDir, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, [path.join(__dirname, 'faceScan.py'), video, workDir]);
    let err = '';
    child.stdout.on('data', (d) => {
      const m = String(d).match(/progress ([\d.]+)\s*$/);
      if (m && onProgress) onProgress(Number(m[1]));
    });
    child.stderr.on('data', (d) => { err = (err + d).slice(-500); });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Face scan failed: ${err}`))));
  });
}

/** One question to Claude with pictures. Resolves to its text. */
function askClaude(content, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: os.tmpdir() };
    delete env.ANTHROPIC_API_KEY;
    const args = ['-p', '--model', MODEL, '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--system-prompt', SYSTEM, '--tools', ''];
    const child = spawn(CLAUDE_BIN, args, { env, cwd: os.tmpdir() });
    let buf = '', text = '', failed = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Claude took too long')); }, timeoutMs);
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const ev = JSON.parse(line);
          if (ev.type === 'result') {
            if (ev.is_error) failed = String(ev.result || 'error').slice(0, 200);
            else text = String(ev.result || '');
            // With stream-json input the CLI waits for more; one question is all we have.
            child.stdin.end();
          }
        } catch (_) { /* not a whole JSON line */ }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      if (text) resolve(text); else reject(new Error(failed || 'Claude gave no answer'));
    });
    child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
  });
}

function parseLabels(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)).faces || null; } catch (_) { return null; }
}

/** label for each track, by track id. Anything unanswered stays "unsure". */
async function classify(tracks, workDir) {
  const labels = new Map(tracks.map((t) => [t.id, 'unsure']));
  let answered = 0;
  for (let i = 0; i < tracks.length; i += BATCH) {
    const group = tracks.slice(i, i + BATCH);
    const content = [];
    for (let n = 0; n < group.length; n++) {
      content.push({ type: 'text', text: `Face ${n + 1}:` });
      for (const c of group[n].crops) {
        const data = (await fs.readFile(path.join(workDir, c))).toString('base64');
        content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
      }
    }
    content.push({ type: 'text', text: `That is all ${group.length} faces. Reply with the JSON.` });
    try {
      const faces = parseLabels(await askClaude(content));
      for (const f of faces || []) {
        const t = group[Number(f.n) - 1];
        if (t && ['woman', 'man', 'unsure'].includes(f.label)) { labels.set(t.id, f.label); answered++; }
      }
    } catch (e) {
      console.warn('[faceScan] Claude could not answer:', e.message);
    }
  }
  return { labels, answered };
}

/** Scan a video file. Returns { duration, tracks: [{id,start,end,label,boxes}], answered }. */
async function scan(video, workDir, onProgress) {
  await runPython(video, workDir, (p) => onProgress && onProgress(p * 0.8));
  const { tracks, duration } = await fs.readJson(path.join(workDir, 'tracks.json'));
  if (onProgress) onProgress(0.85);
  const { labels, answered } = await classify(tracks, workDir);
  return {
    duration,
    answered,
    tracks: tracks.map((t) => ({ id: t.id, start: t.start, end: t.end, label: labels.get(t.id), boxes: t.boxes })),
    _crops: tracks.map((t) => ({ id: t.id, crops: t.crops })),
  };
}

module.exports = { scan };
