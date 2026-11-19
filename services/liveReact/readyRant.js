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

/** 9-to-5 Freedom has its own full prompt (mentor mode), not a tone line. */
function mentorPrompt() {
  if (process.env.READY_RANT_PROMPT_9TO5) return process.env.READY_RANT_PROMPT_9TO5;
  const local = path.join(__dirname, '../../private/ready-rant-9to5.md');
  return fs.existsSync(local) ? fs.readFileSync(local, 'utf8') : null;
}

/** ABOUT THE SPEAKER for one phone (scrambled who), so only the owner's own
 *  facts are ever claimed. Env READY_RANT_PROFILES = {"<who>": "facts"}. */
function speakerFor(who) {
  if (!who) return '';
  try {
    const all = JSON.parse(process.env.READY_RANT_PROFILES || '{}');
    if (all[who]) return String(all[who]).trim();
  } catch (_) { /* bad JSON: fall back to the local file */ }
  const local = path.join(__dirname, '../../private/speakers', `${who}.md`);
  return fs.existsSync(local) ? fs.readFileSync(local, 'utf8').trim() : '';
}

const shuffled = (a) => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
// When the 9-to-5 viewer does the step: rotated so videos don't all say "this week".
const WHENS = ['tonight', 'after work today', 'on your lunch break tomorrow', 'this weekend', 'tomorrow morning before work',
  'on your commute', 'before you sleep tonight', 'right after this video', 'this Saturday', 'in the next 24 hours',
  'next time you scroll your phone', 'this week'];

/** Mentor-mode PLAN: a different fact (spread over every RANT + the ending,
 *  random order each time) and a different "when" for each RANT. */
function variety(about, most) {
  const facts = shuffled(String(about || '').split('\n').filter((l) => /^\s*-/.test(l))
    .map((l) => l.replace(/^\s*-\s*/, '').replace(/\s*\(.*?\)\s*$/, '').trim())
    .filter((l) => !/lives in|Muslim|never name the apps/i.test(l)));
  const whens = shuffled(WHENS);
  const lines = [];
  for (let i = 0; i < most; i++) {
    const parts = [];
    if (facts.length) parts.push(i < facts.length ? `fact: ${facts[i]}` : 'fact: none (no number in this one)');
    if (i > 0) parts.push(`the viewer does the step: ${whens[i]}`);
    lines.push(`RANT ${i + 1}${i === 0 ? ' (re-hook)' : ''}: ${parts.join('; ') || 'no fact'}`);
  }
  if (facts.length > most) lines.push(`ENDING: fact (optional): ${facts[most]}`);
  return `PLAN (variety; follow it, say it in your own words):\n${lines.join('\n')}`;
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
  nine_to_five: [
    "9-to-5 Freedom. The viewer is a 9-to-5 worker (salary, boss, commute, fixed income). Whatever the video is about, turn it into a tip, an advice or a push for them to start their own business or a second income on the side, so they don't rely only on the job.",
    'THIS TONE CHANGES THE STOP RULE: RANT 1 stops the video as EARLY as possible, right after the creator finishes their FIRST sentence (ignore the "first 15%" rule for RANT 1 only). List RANT 1 FIRST in the rants array; its stop_after is the end of the opening sentence. RANT 1 is a second hook: 1-2 short lines that tie this video to the 9-to-5 viewer so they know it is for them and keep watching (e.g. "If you have a 9-to-5, listen to this one carefully." then why). No tip yet, just the connection and a reason to stay.',
    'Then 1 or 2 more RANTs at the strongest moments (normal stop rules). Each finds the honest link between what the creator just said and a 9-to-5 worker building their own income: one clear tip, advice, lesson or push they can use this week. Sound like someone who has done it and knows the way, calm and sure, so the viewer trusts you and wants to follow you. Never shame the job (it pays the bills), never promise money or results, no "quit your job tomorrow".',
    'The ending verdict speaks to the 9-to-5 viewer: one line on what this video means for their own income.',
  ].join(' '),
};

/** Tones that also change WHERE the stops go (not just how they sound). */
const TONE_STOPS = {
  // Early re-hook + 1-2 tips: 2-3 RANTs whatever the length, first one early.
  nine_to_five: { earlyFirst: true, most: (n) => Math.min(Math.max(n, 2), 3) },
};

/** The user's own words, kept short and on one block. */
function cleanExtra(extra) {
  return String(extra || '').replace(/\s+/g, ' ').trim().slice(0, 500);
}

/** The user's own words WIN (19 Nov 2026, Mosh: "it ignores my instructions",
 *  e.g. 9-to-5 + roast, Iron Man's voice, two lines). They used to sit as a
 *  polite note above a long transcript, under a rulebook (and the 9-to-5
 *  mentor prompt) with its own voice and word counts, so the rulebook won.
 *  Now they go at the very END of the system prompt AND after the transcript,
 *  and say plainly what they override. Only the safety and the machinery stay. */
function userRules(note) {
  return [
    "THE USER'S OWN INSTRUCTIONS: TOP PRIORITY. Follow them exactly, in every RANT and the ending:",
    `"""${note}"""`,
    'They OVERRIDE anything above about tone, voice, mood, character, style, structure, length, word counts, the number of lines, how many RANTs (fewer is fine) and the mentor/teacher style.',
    '- A tone or mood (roast, angry, funny, calm, crazy...): write it that way, all the way, even if a tone above says otherwise. When they also picked a tone above, keep its TOPIC (e.g. 9-to-5 workers and their own income) and use THEIR mood for it.',
    "- A character's voice (e.g. Iron Man, a pirate, a grandma): write as that character would talk, their attitude and rhythm, in your own words (no long quotes from films).",
    '- A length (e.g. "two lines", "10 words", "short"): EVERY RANT and the ending stays inside it. Count before you answer. This beats every word count above.',
    'Only these never change: the JSON shape, stop_after copied exactly from the transcript, the most-RANTs limit, honesty (no made-up facts, no promised money or results), and halal (no swearing, no mocking religion, looks, family or anyone\'s background; a roast hits ideas and claims, not people\'s worth).',
  ].join('\n');
}

function promptLines(segs) {
  return segs.map((s) => `[${s.start.toFixed(1)}] ${s.text}`).join('\n');
}

async function write({ segs, duration, language, tone, extra, who }) {
  const mentor = tone === 'nine_to_five';
  const prompt = mentor ? mentorPrompt() : masterPrompt();
  if (!prompt) throw new Error('Ready-made RANT is not set up on the server yet.');
  const most = TONE_STOPS[tone] ? TONE_STOPS[tone].most(mostFor(duration)) : mostFor(duration);
  let user = `Video length: ${Math.round(duration)} seconds\nMost RANTs allowed: ${most}\nLanguage: ${language === 'bengali' ? 'Bengali' : 'English'}`;
  const about = mentor ? speakerFor(who) : '';
  if (about) user += `\n\nABOUT THE SPEAKER (true facts; never stretch them, never promise the viewer results):\n${about}`;
  if (mentor) user += `\n\n${variety(about, most)}`;
  if (TONES[tone] && !mentor) user += `\n\nTONE (the user picked this; use it for every RANT and the ending, but keep every other rule, keep it honest and keep it halal: no swearing, no mocking religion, looks or family): ${TONES[tone]}`;
  const note = cleanExtra(extra);
  if (note) user += `\n\nThe user gave their own instructions (top priority, repeated after the transcript):\n${note}`;
  user += `\n\nTranscript (seconds in brackets):\n${promptLines(segs)}`;
  if (note) user += `\n\n${userRules(note)}`;
  // A long video (10+ RANTs) can take Claude well over 4 minutes; the app waits.
  // Mentor mode writes on Opus (tested 15Nov26: far more specific than Sonnet; only 2-3 RANTs, so it stays quick).
  const model = mentor ? (process.env.READY_RANT_9TO5_MODEL || 'opus') : MODEL;
  const system = prompt + (note ? `\n\n${userRules(note)}` : '') + '\n\nReply with ONE JSON object and nothing else.';
  const text = await askText({ system, user, model, timeoutMs: 9 * 60 * 1000 });
  let out = jsonIn(text);
  if (note) out = await obey(out, note, language);
  return { out, most, usage: { model } };
}

/** Second pass when the user wrote instructions: the first pass still drifted
 *  back to the rulebook's voice and word counts (tested 19 Nov 2026: 9-to-5 +
 *  "roast, angry, Iron Man, two lines" came back calm and 45 words). This one
 *  sees ONLY the scripts and the instructions, so the instructions win. The
 *  stops (stop_after) are never touched. A failure keeps the first pass. */
async function obey(out, note, language) {
  const rants = Array.isArray(out.rants) ? out.rants : [];
  const scripts = rants.map(scriptOf);
  const ending = String(out.ending || '').trim();
  if (!scripts.some(Boolean) && !ending) return out;
  const system = [
    'You rewrite short spoken scripts (RANTs) that a person reads out loud while reacting to a video.',
    'Make EVERY script and the ending follow the user\'s instructions exactly: their tone, mood, character voice, length, style, format. Instructions beat how the drafts sound now.',
    '- Keep each script about the same moment and the same main point (and the same topic, e.g. 9-to-5 workers building their own income), unless the instructions say otherwise.',
    '- A length limit ("two lines", "10 words"...) is HARD: count, and cut facts or numbers to fit.',
    "- A character's voice: their attitude, swagger and rhythm, in your own words (no long film quotes).",
    '- Keep true facts only as they are (never invent numbers or promise results). Halal: no swearing, no mocking religion, looks, family or anyone\'s background; a roast hits ideas, not people.',
    `- Language: ${language === 'bengali' ? 'Bengali (Banglish business words are fine)' : 'English'}. Easy words, made to be spoken.`,
    'Reply with ONE JSON object and nothing else: {"rants": ["script 1", ...same count and order...], "ending": "..."}',
  ].join('\n');
  const user = `USER'S INSTRUCTIONS (follow exactly):\n"""${note}"""\n\nDRAFTS:\n${JSON.stringify({ rants: scripts, ending }, null, 1)}`;
  try {
    const r = jsonIn(await askText({ system, user, model: process.env.READY_RANT_OBEY_MODEL || 'sonnet', timeoutMs: 3 * 60 * 1000 }));
    const fresh = Array.isArray(r.rants) ? r.rants.map((x) => String(x || '').trim()) : [];
    return {
      ...out,
      rants: rants.map((x, i) => (fresh[i] ? { ...x, drafts: undefined, best: undefined, script: fresh[i] } : x)),
      ending: String(r.ending || '').trim() || out.ending,
    };
  } catch (e) {
    console.warn('[ready-rant] obey pass failed, keeping first pass:', e.message);
    return out;
  }
}

/** Mentor mode writes 3 drafts and names the best; older replies have script. */
function scriptOf(r) {
  const d = Array.isArray(r.drafts) ? r.drafts.map((x) => String(x || '').trim()) : [];
  const b = Number.isInteger(r.best) && d[r.best] ? d[r.best] : d.find(Boolean);
  return b || String(r.script || '').trim();
}

/** Where the creator's opening line ends: the first full stop/?/! after 1.5 s
 *  (within 20 s), else the first clear pause, else ~4 s in. Never past 15%. */
function firstLineEnd(words, duration) {
  const cap = Math.max(4, Math.min(20, duration * 0.15));
  const ok = (w) => w.end >= 1.5 && w.end <= cap;
  const dot = words.find((w) => ok(w) && /[.?!]["')\]]*$/.test(w.text));
  if (dot) return dot.end;
  const pause = words.find((w, i) => ok(w) && words[i + 1] && words[i + 1].start - w.end >= 0.4);
  if (pause) return pause.end;
  const near = words.find((w) => w.end >= Math.min(4, cap));
  return near && near.end <= cap ? near.end : null;
}

/** The AI's picks → safe stops, in order, never breaking the rules.
 *  earlyFirst (9-to-5 tone): the AI's FIRST RANT is the re-hook; the code puts
 *  it right after the creator's opening line (the AI's quote for it is not
 *  trusted: on long videos it matched a line minutes in). */
function place(out, words, duration, most, { earlyFirst = false } = {}) {
  const gap = (duration / (most + 1)) * 0.6;
  const list = Array.isArray(out.rants) ? out.rants : [];
  const kept = [];
  let rest = list;
  if (earlyFirst && list.length) {
    const at = firstLineEnd(words, duration);
    const script = scriptOf(list[0]);
    if (at != null && script) {
      kept.push({ at: Math.round(at * 10) / 10, script, why: String(list[0].why_here || '').trim() });
      rest = list.slice(1);
    }
  }
  const picks = rest
    .map((r) => ({ at: locate(r.stop_after, words), script: scriptOf(r), why: String(r.why_here || '').trim() }))
    .filter((r) => r.at != null && r.script)
    .sort((a, b) => a.at - b.at);
  const hooked = kept.length;
  for (const r of picks) {
    if (r.at < duration * 0.15 || r.at > duration - 3) continue;
    // The early re-hook doesn't push the next stop back; the 15% rule still does.
    const last = kept.length > hooked ? kept[kept.length - 1] : null;
    if (last && r.at - last.at < gap) continue;
    if (kept.length >= most) break;
    kept.push({ ...r, at: Math.round(r.at * 10) / 10 });
  }
  return kept;
}

/** { rants: [{at, script, why}], ending } */
async function readyRant({ sourceUrl, mainUrl, duration, language, tone, extra, who }) {
  const segs = await transcript([sourceUrl, mainUrl]);
  const words = wordsOf(segs);
  const dur = Number(duration) > 0 ? Number(duration) : (words.length ? words[words.length - 1].end : 0);
  const { out, most, usage } = await write({ segs, duration: dur, language, tone, extra, who });
  const rants = place(out, words, dur, most, TONE_STOPS[tone] || {});
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

module.exports = { TONES, TONE_STOPS, readyRant, write, speakerFor, mentorPrompt, mostFor, wordsOf, locate, place, transcript, linesOf };
