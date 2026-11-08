/**
 * 🎥 LIVE REACT — Ready-made RANT. The video's transcript (from the shared Get
 * Transcript transcriber) goes to the RANT writer prompt; it picks the moments
 * and writes a RANT for each, plus an ending. The stops are then checked here
 * so the AI can never break the rules: right after a sentence the creator said,
 * not in the opening hook, not in the last seconds, spread out, never more
 * than the video's length allows.
 *
 * The master prompt is NOT in this (public) repo: it comes from the
 * READY_RANT_PROMPT env var, or a local git-ignored private/ready-rant-prompt.md.
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { pickCta } = require('./rantCtas');

const TRANSCRIBER = process.env.TRANSCRIBER_URL || 'https://transcriber-production-f2f1.up.railway.app';
// Claude on the owner's subscription (was OpenAI until its credit ran out, 7 Nov 2026).
const MODEL = process.env.READY_RANT_CLAUDE_MODEL || 'sonnet';
const { askText, jsonIn } = require('./claudeText');

function masterPrompt() {
  if (process.env.READY_RANT_PROMPT) return process.env.READY_RANT_PROMPT;
  const local = path.join(__dirname, '../../private/ready-rant-prompt.md');
  return fs.existsSync(local) ? fs.readFileSync(local, 'utf8') : null;
}

/** How many RANTs a video of this length may have. */
function mostFor(d) {
  if (d <= 40) return 1;
  if (d <= 75) return 2;
  if (d <= 180) return Math.max(3, Math.min(5, Math.round(d / 36)));
  if (d <= 480) return Math.min(7, Math.max(5, Math.round(d / 60)));
  return Math.round(d / 75);
}

/** Timed lines from the transcriber. Tries the video's own link, then our copy. */
async function transcript(urls) {
  let lastErr = null;
  for (const url of urls.filter(Boolean)) {
    try {
      const { data } = await axios.post(`${TRANSCRIBER}/transcribe`, { url, language: 'auto' }, { timeout: 6 * 60 * 1000 });
      const segs = (data && data.segments || [])
        .map((s) => ({ start: Number(s.start), end: Number(s.end), text: String(s.text || '').trim() }))
        .filter((s) => s.text && Number.isFinite(s.start));
      if (segs.length) return segs;
      lastErr = new Error(data && data.error || 'no transcript');
    } catch (e) {
      lastErr = e;
      console.warn('[ready-rant] transcript failed for', url, '-', e.response?.data?.error || e.message);
    }
  }
  throw lastErr || new Error('no transcript');
}

/** Every word with the time it was said, spread across its line. Caption lines
 *  overlap (each stays up while the next rolls in), so a line's words run from
 *  its start to the next line's start. */
function wordsOf(segs) {
  const words = [];
  segs.forEach((s, i) => {
    const next = segs[i + 1];
    const stop = next && next.start > s.start ? Math.min(next.start, Number.isFinite(s.end) ? Math.max(s.end, s.start + 0.2) : next.start) : (Number.isFinite(s.end) ? s.end : s.start + 2);
    const list = s.text.split(/\s+/).filter(Boolean);
    list.forEach((w, k) => {
      const a = s.start + ((stop - s.start) * k) / list.length;
      const b = s.start + ((stop - s.start) * (k + 1)) / list.length;
      words.push({ text: w, start: a, end: b });
    });
  });
  return words;
}

const norm = (s) => String(s).toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{M}\p{N}$']/gu, '');

/** The time just after the creator says the quoted words (the stop). Falls
 *  back to the quote's last 4, then 3 words if the AI changed a word early on. */
function locate(quote, words) {
  const seq = words.map((w) => norm(w.text));
  const q = String(quote || '').split(/\s+/).map(norm).filter(Boolean);
  for (const take of [q.length, 4, 3]) {
    if (take > q.length || take < 1) continue;
    const tail = q.slice(q.length - take);
    for (let i = 0; i + tail.length <= seq.length; i++) {
      if (tail.every((t, k) => seq[i + k] === t)) return words[i + tail.length - 1].end;
    }
  }
  return null;
}

/** Optional voices the user can pick in the app. They change HOW it sounds,
 *  never the facts, the stops or the JSON. Halal and kind: no swearing, no
 *  mocking religion, looks, family or anyone's background. */
const TONES = {
  funny: 'Funny. Light, playful jokes and surprising comparisons. Still makes a real point.',
  roast_creator: "Roast the creator. Tease the creator's claims, hype and logic like a friendly roast battle. Sharp and funny, never cruel: roast what they SAY, never who they are.",
  roast_system: 'Roast the system. Aim the jokes at the system, industry or trend behind the video (the algorithm, the hustle culture, the bank, the government, the market), not at the creator.',
  wise_comedian: 'Wise stand-up comedian. Get the laugh first, then land one true, wise point people remember. Like a comedian who is secretly a teacher.',
  serious: 'Straight talk. No jokes. Calm, clear and direct, like a mentor telling a friend the truth.',
};

/** The user's own words, kept short and on one block. */
function cleanExtra(extra) {
  return String(extra || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

function promptLines(segs) {
  return segs.map((s) => `[${s.start.toFixed(1)}] ${s.text}`).join('\n');
}

async function write({ segs, duration, language, tone, extra }) {
  const prompt = masterPrompt();
  if (!prompt) throw new Error('Ready-made RANT is not set up on the server yet.');
  const most = mostFor(duration);
  let user = `Video length: ${Math.round(duration)} seconds\nMost RANTs allowed: ${most}\nLanguage: ${language === 'bengali' ? 'Bengali' : 'English'}`;
  if (TONES[tone]) user += `\n\nTONE (the user picked this; use it for every RANT and the ending, but keep every other rule, keep it honest and keep it halal: no swearing, no mocking religion, looks or family): ${TONES[tone]}`;
  const note = cleanExtra(extra);
  if (note) user += `\n\nEXTRA INSTRUCTIONS FROM THE USER (follow them, as long as they don't break the JSON shape, the stop_after quotes or the most-RANTs limit; fewer RANTs or shorter lines are always fine):\n${note}`;
  user += `\n\nTranscript (seconds in brackets):\n${promptLines(segs)}`;
  // A long video (10+ RANTs) can take Claude well over 4 minutes; the app waits.
  const text = await askText({ system: prompt + '\n\nReply with ONE JSON object and nothing else.', user, model: MODEL, timeoutMs: 9 * 60 * 1000 });
  return { out: jsonIn(text), most, usage: { model: MODEL } };
}

/** The AI's picks → safe stops, in order, never breaking the rules. */
function place(out, words, duration, most) {
  const gap = (duration / (most + 1)) * 0.6;
  const picks = (Array.isArray(out.rants) ? out.rants : [])
    .map((r) => ({ at: locate(r.stop_after, words), script: String(r.script || '').trim(), why: String(r.why_here || '').trim() }))
    .filter((r) => r.at != null && r.script)
    .sort((a, b) => a.at - b.at);
  const kept = [];
  for (const r of picks) {
    if (r.at < duration * 0.15 || r.at > duration - 3) continue;
    if (kept.length && r.at - kept[kept.length - 1].at < gap) continue;
    if (kept.length >= most) break;
    kept.push({ ...r, at: Math.round(r.at * 10) / 10 });
  }
  return kept;
}

/** { rants: [{at, script, why}], ending } */
async function readyRant({ sourceUrl, mainUrl, duration, language, tone, extra }) {
  const segs = await transcript([sourceUrl, mainUrl]);
  const words = wordsOf(segs);
  const dur = Number(duration) > 0 ? Number(duration) : (words.length ? words[words.length - 1].end : 0);
  const { out, most, usage } = await write({ segs, duration: dur, language, tone, extra });
  const rants = place(out, words, dur, most);
  console.log(`[ready-rant] ${Math.round(dur)}s → ${rants.length}/${most} RANTs (${usage?.prompt_tokens || 0} in, ${usage?.completion_tokens || 0} out)`);
  // The ending is the AI's verdict + one of Mosh's 99% DFY calls to action (random).
  const verdict = String(out.ending || '').trim();
  const ending = [verdict, pickCta(language)].filter(Boolean).join(' ');
  return { rants, ending };
}

/** "Pick by words": the transcript as tappable lines, one sentence each (or
 *  ~9 s chunks when the captions have no full stops). Overlapping caption
 *  pieces are cleaned first, then every word gets its time within its piece. */
function linesOf(segs) {
  // 1. Drop the words a piece repeats from the end of the one before it.
  const clean = [];
  let said = '';
  for (const s of segs) {
    let t = s.text.replace(/\s+/g, ' ').trim();
    const tail = said.split(' ').slice(-8).join(' ');
    const w = t.split(' ');
    for (let k = Math.min(8, w.length); k > 0; k--) {
      if (tail.endsWith(w.slice(0, k).join(' '))) { t = w.slice(k).join(' '); break; }
    }
    if (t) { clean.push({ start: s.start, end: s.end, text: t }); said = `${said} ${t}`.slice(-400); }
  }
  // 2. Timed words, 3. grouped into sentences.
  const words = wordsOf(clean);
  const out = [];
  let cur = null;
  words.forEach((w, i) => {
    if (cur && w.start - words[i - 1].end > 1.5) { out.push(cur); cur = null; }
    if (!cur) cur = { start: w.start, end: w.end, text: '' };
    cur.text = cur.text ? `${cur.text} ${w.text}` : w.text;
    cur.end = w.end;
    if (/[.!?।]["')\]]?$/.test(w.text) || cur.end - cur.start >= 9 || cur.text.length >= 160) { out.push(cur); cur = null; }
  });
  if (cur) out.push(cur);
  return out.map((l) => ({ start: Math.round(l.start * 100) / 100, end: Math.round(l.end * 100) / 100, text: l.text }));
}

module.exports = { TONES, readyRant, mostFor, wordsOf, locate, place, transcript, linesOf };
