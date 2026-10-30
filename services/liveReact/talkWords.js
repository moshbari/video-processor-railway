/**
 * 🎥 LIVE REACT — caption words timed on the server, for talks that arrive
 * without them (the Android app, or an iPhone talk its speech engine couldn't
 * hear). OpenAI whisper-1 gives word times; when the talk was read from a
 * script, the script's words are laid over those times so the spelling is the
 * script's. Any failure just means that talk has no captions.
 */

const OpenAI = require('openai');
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');

let client = null;
const openai = () => (client ||= new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));

const sentenceEnd = (w) => /[.!?।]["')\]]?$/.test(w);

function extractAudio(file, out) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '48k', out]);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('audio extract failed'))));
    p.on('error', reject);
  });
}

/** Script words spread over the heard words' times, in order. */
function overScript(script, heard) {
  const tokens = String(script).split(/\s+/).filter(Boolean);
  if (!tokens.length || !heard.length) return [];
  const n = tokens.length, h = heard.length;
  return tokens.map((text, k) => {
    const a = heard[Math.min(h - 1, Math.floor((k * h) / n))];
    const b = heard[Math.min(h - 1, Math.max(Math.floor(((k + 1) * h) / n) - 1, Math.floor((k * h) / n)))];
    return { text, start: a.start, end: Math.max(a.start + 0.05, b.end), endsSentence: sentenceEnd(text) };
  }).map((w, k, all) => (k + 1 < all.length ? { ...w, end: Math.min(w.end, Math.max(w.start + 0.05, all[k + 1].start)) } : w));
}

/**
 * Words of one talk: [{ text, start, end, endsSentence }] in seconds into the take.
 * lang: 'english' | 'bengali'.
 */
async function timeWords(file, workDir, index, lang, script) {
  if (!process.env.OPENAI_API_KEY) return [];
  const audio = path.join(workDir, `words-${index}.m4a`);
  try {
    await extractAudio(file, audio);
    const res = await openai().audio.transcriptions.create({
      file: fs.createReadStream(audio),
      model: 'whisper-1',
      response_format: 'verbose_json',
      timestamp_granularities: ['word', 'segment'],
      language: lang === 'bengali' ? 'bn' : 'en',
      temperature: 0,
      ...(script ? { prompt: String(script).slice(0, 800) } : {}),
    });
    const heard = (res.words || [])
      .map((w) => ({ text: String(w.word || '').trim(), start: Number(w.start), end: Number(w.end) }))
      .filter((w) => w.text && Number.isFinite(w.start) && Number.isFinite(w.end));
    // whisper can loop on one syllable (seen with Bangla): far too many words a second = noise.
    const span = heard.length ? heard[heard.length - 1].end - heard[0].start : 0;
    if (heard.length > 8 && heard.length / Math.max(0.5, span) > 7) return [];
    if (script && String(script).trim()) return overScript(script, heard);
    // Sentence ends from whisper's segments (its words carry no punctuation).
    const ends = new Set((res.segments || []).map((s) => Number(s.end).toFixed(2)));
    return heard.map((w) => ({ ...w, endsSentence: ends.has(w.end.toFixed(2)) || sentenceEnd(w.text) }));
  } catch (e) {
    console.warn('[live-react] caption timing failed:', e.message);
    return [];
  } finally {
    fs.remove(audio).catch(() => {});
  }
}

module.exports = { timeWords, overScript };
