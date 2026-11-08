/**
 * 🎥 RANT: find the women's faces in a video, so they can be blurred automatically.
 *
 *   1. faceScan.py finds and follows every face (free, on this server).
 *   2. Claude Sonnet looks at up to 3 small pictures of each face (the face
 *      in a green box) and labels EVERY picture woman / man / unsure. A face
 *      is a woman if any of its pictures says so. Whole frames are never sent.
 *      (Haiku until 8 Nov 2026: it called a woman a man and blurred men.)
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
const MODEL = process.env.FACE_SCAN_MODEL || 'sonnet';
const BATCH = 30;   // pictures in one question

const SYSTEM = `You help a video creator who hides women's faces in commentary videos, for religious modesty and privacy. The faces get blurred; nobody is named or judged, and you never identify anyone.
You get small numbered pictures cut from a video. Each picture has ONE face marked with a green box. Other people may be in the picture too: judge ONLY the face inside the green box.
For each picture, say how that person looks: "woman" (including girls), "man" (including boys), or "unsure". Use the face, hair, beard, clothing and headscarf. If it is a drawing, a mask, too small, too blurry or too dark to tell, say "unsure". When in real doubt say "unsure": wrongly blurring is a small mistake, wrongly not blurring is a big one.
Reply with JSON only, nothing else, one entry per picture: {"pictures":[{"n":1,"label":"woman"}]}`;

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
  try { const j = JSON.parse(text.slice(a, b + 1)); return j.pictures || j.faces || null; } catch (_) { return null; }
}

/**
 * label for each track, by track id. Every picture is judged on its own, then
 * a face is "woman" if any picture says woman, "man" only if every answered
 * picture says man, otherwise "unsure" (blurred). Unanswered stays "unsure".
 */
async function classify(tracks, workDir) {
  const pics = [];
  for (const t of tracks) for (const c of t.crops) pics.push({ id: t.id, file: c });
  const said = new Map(tracks.map((t) => [t.id, []]));
  let answered = 0;
  for (let i = 0; i < pics.length; i += BATCH) {
    const group = pics.slice(i, i + BATCH);
    const content = [];
    for (let n = 0; n < group.length; n++) {
      content.push({ type: 'text', text: `Picture ${n + 1}:` });
      const data = (await fs.readFile(path.join(workDir, group[n].file))).toString('base64');
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });
    }
    content.push({ type: 'text', text: `That is all ${group.length} pictures. Reply with the JSON.` });
    try {
      const out = parseLabels(await askClaude(content, 180000));
      for (const f of out || []) {
        const p = group[Number(f.n) - 1];
        if (p && ['woman', 'man', 'unsure'].includes(f.label)) { said.get(p.id).push(f.label); answered++; }
      }
    } catch (e) {
      console.warn('[faceScan] Claude could not answer:', e.message);
    }
  }
  const labels = new Map();
  for (const t of tracks) {
    const l = said.get(t.id);
    labels.set(t.id, l.includes('woman') ? 'woman' : (l.length && l.every((x) => x === 'man')) ? 'man' : 'unsure');
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

module.exports = { scan, classify };
