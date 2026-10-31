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

const OpenAI = require('openai');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const TRANSCRIBER = process.env.TRANSCRIBER_URL || 'https://transcriber-production-f2f1.up.railway.app';
const MODEL = process.env.READY_RANT_MODEL || 'gpt-6.1-sol';

let client = null;
const openai = () => (client ||= new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));

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

function promptLines(segs) {
  return segs.map((s) => `[${s.start.toFixed(1)}] ${s.text}`).join('\n');
}

async function write({ segs, duration, language }) {
  const prompt = masterPrompt();
  if (!prompt) throw new Error('Ready-made RANT is not set up on the server yet.');
  const most = mostFor(duration);
  const user = `Video length: ${Math.round(duration)} seconds\nMost RANTs allowed: ${most}\nLanguage: ${language === 'bengali' ? 'Bengali' : 'English'}\n\nTranscript (seconds in brackets):\n${promptLines(segs)}`;
  const res = await openai().chat.completions.create({
    model: MODEL,
    messages: [{ role: 'system', content: prompt }, { role: 'user', content: user }],
    response_format: { type: 'json_object' },
  });
  const text = res.choices?.[0]?.message?.content || '{}';
  return { out: JSON.parse(text), most, usage: res.usage };
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
async function readyRant({ sourceUrl, mainUrl, duration, language }) {
  const segs = await transcript([sourceUrl, mainUrl]);
  const words = wordsOf(segs);
  const dur = Number(duration) > 0 ? Number(duration) : (words.length ? words[words.length - 1].end : 0);
  const { out, most, usage } = await write({ segs, duration: dur, language });
  const rants = place(out, words, dur, most);
  console.log(`[ready-rant] ${Math.round(dur)}s → ${rants.length}/${most} RANTs (${usage?.prompt_tokens || 0} in, ${usage?.completion_tokens || 0} out)`);
  return { rants, ending: String(out.ending || '').trim() || null };
}

module.exports = { readyRant, mostFor, wordsOf, locate, place };
