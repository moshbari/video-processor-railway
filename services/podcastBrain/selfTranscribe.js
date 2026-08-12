/**
 * 🎧 Getting an episode's words without leaving the server.
 *
 * WHY THIS EXISTS
 *
 * The Podcast Brain used to be fed by a chain that ran entirely in Mosh's
 * browser: the upload page remembered the project id, handed it to a Chrome
 * extension, the extension woke up every three minutes for up to three hours
 * opening YouTube tabs, scraped the caption panel, and posted the result back.
 *
 * Eight hops, every one of them able to fail without saying anything, and all
 * of it needing Chrome open and awake. It failed three times in two days —
 * once on two spellings of the same link, once because a reloaded extension
 * orphaned the page that was supposed to talk to it.
 *
 * The video is already sitting in our own R2 bucket the moment /prepare
 * finishes. So we transcribe that. No browser, no extension, no YouTube, and
 * no waiting twenty minutes to three hours for captions that may never come —
 * the episode is ready minutes after upload.
 *
 * It is also more accurate for the job: the timestamps come from the exact file
 * being cut, so a hook can never drift against the copy in the editor.
 */

const path = require('path');
const fs = require('fs-extra');
const ffmpeg = require('fluent-ffmpeg');

const manualClipService = require('../manualClipService');
const transcriptionService = require('../transcriptionService');

// 5 minutes, and EVERY episode is cut into chunks — not only the ones too big
// to send in one piece.
//
// Why: Whisper sometimes falls into a loop and returns the same syllable over
// and over instead of the words ('আমি আমি আমি…' for half an hour). It is far
// more likely to do that on mixed Bangla/English speech, and once it starts it
// does not recover — so a whole 31-minute episode sent as one file came back as
// 72 lines of noise, and five Claude passes were spent on it before anyone
// noticed. Chunking means a loop can only ever spoil five minutes, each chunk
// starts Whisper fresh, and a spoiled chunk can be retried on its own.
// (It also keeps every piece far below Whisper's 25MB limit: five minutes of
// mono 64k speech is about 2.4MB, so size never has to be thought about again.)
const CHUNK_SECONDS = 300;

// Whisper's own tell for repeated text: gzip compresses it far better than real
// speech. 2.4 is the threshold OpenAI's own reference decoder uses.
const COMPRESSION_LOOP = 2.4;

// A chunk gets this many goes before we accept we cannot hear it. Whisper is
// deterministic at temperature 0, so a retry only helps if we nudge it.
const CHUNK_ATTEMPT_TEMPERATURES = [0, 0.4, 0.8];

// Whisper REPORTS a language by name ('bengali') but only ACCEPTS one as a
// two-letter code ('bn'). Sending back what it just told us would be rejected,
// so what comes out of one chunk is translated before it is used as the hint for
// the next. Anything not in here simply means no hint — never a bad one.
const LANGUAGE_CODES = {
  bengali: 'bn', bangla: 'bn', english: 'en', hindi: 'hi', urdu: 'ur',
  arabic: 'ar', tamil: 'ta', nepali: 'ne', assamese: 'as',
};

function languageCode(reported) {
  if (!reported) return null;
  const key = String(reported).trim().toLowerCase();
  if (/^[a-z]{2}$/.test(key)) return key;
  return LANGUAGE_CODES[key] || null;
}

/** Seconds → "M:SS", or "H:MM:SS" once an episode passes the hour. */
function stamp(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

/** Speech-sized audio: mono, 16kHz, 64k mp3. Small enough to send, plenty for words. */
function extractAudio(videoPath, audioPath, { seek, duration } = {}) {
  return new Promise((resolve, reject) => {
    let cmd = ffmpeg(videoPath);
    if (seek != null) cmd = cmd.seekInput(seek);
    if (duration != null) cmd = cmd.duration(duration);
    cmd
      .noVideo()
      .audioCodec('libmp3lame')
      .audioBitrate('64k')
      .audioChannels(1)
      .audioFrequency(16000)
      .format('mp3')
      .on('end', () => resolve(audioPath))
      .on('error', (err) => reject(new Error(`Could not read the audio from this episode: ${err.message}`)))
      .save(audioPath);
  });
}

/**
 * Does this look like Whisper talking to itself rather than transcribing?
 *
 * Three independent tells, because no single one is safe on its own:
 *   - the same line returned again and again
 *   - Whisper's own compression_ratio, which spikes on repeated text
 *   - a wall of words with almost no different words in it
 *
 * Real speech, even a monologue, never looks like any of these. A short or very
 * quiet stretch is NOT called looped — that is what the coverage check is for.
 */
function looksLooped(segments) {
  const texts = (segments || []).map(s => String(s.text || '').trim()).filter(Boolean);
  if (texts.length < 4) return { looped: false, reason: null };

  // The same line coming back again and again. Short lines are left out of this
  // one: 'হ্যাঁ', 'okay', 'hmm' are said honestly a hundred times in a real call,
  // and counting them would make a long friendly conversation look like a loop.
  // A loop repeats whole lines, not just words.
  const substantial = texts.filter(t => t.split(/\s+/).filter(Boolean).length >= 4);
  const uniqueRatio = substantial.length >= 8 ? new Set(substantial).size / substantial.length : 1;

  const ratios = (segments || []).map(s => s.compression_ratio).filter(n => typeof n === 'number');
  const highCompression = ratios.length ? ratios.filter(r => r > COMPRESSION_LOOP).length / ratios.length : 0;

  // One line made almost entirely of the same word over and over ('আমি আমি আমি
  // আমি…'). Measured line by line ON PURPOSE: counting different words across a
  // whole transcript looks worse the longer the transcript gets, so a two-hour
  // call would eventually fail a test that a five-minute one passes. This one
  // reads the same at any length.
  const selfRepeating = texts.filter((t) => {
    const w = t.split(/\s+/).filter(Boolean);
    if (w.length < 4) return false;
    const counts = new Map();
    for (const x of w) counts.set(x, (counts.get(x) || 0) + 1);
    return Math.max(...counts.values()) / w.length > 0.6;
  }).length / texts.length;

  let reason = null;
  if (uniqueRatio < 0.5) reason = `the same line came back ${Math.round((1 - uniqueRatio) * 100)}% of the time`;
  else if (highCompression > 0.5) reason = 'the text repeats itself instead of moving on';
  else if (selfRepeating > 0.4) reason = 'line after line is the same word repeated';

  return { looped: !!reason, reason, uniqueRatio, highCompression, selfRepeating };
}

/**
 * Ask Whisper for one piece of audio, and don't accept an answer that is
 * obviously it looping. Each go nudges the temperature, because at 0 Whisper is
 * deterministic — asking the same question the same way gets the same loop.
 *
 * Returns { segments, language, attempts, looped } — `looped: true` means every
 * attempt came back as noise and this stretch could not be heard.
 */
async function transcribeChunkWithRetries(chunkPath, { language, onProgress, label }) {
  let last = { segments: [], language: null };

  for (let i = 0; i < CHUNK_ATTEMPT_TEMPERATURES.length; i++) {
    const out = await transcriptionService.transcribe(chunkPath, {
      response_format: 'verbose_json',
      temperature: CHUNK_ATTEMPT_TEMPERATURES[i],
      language: language || undefined,
    });
    const segments = out.segments || [];
    last = { segments, language: out.language || null };

    const verdict = looksLooped(segments);
    if (!verdict.looped) return { ...last, attempts: i + 1, looped: false };

    console.log(`[PodcastBrain] ${label}: attempt ${i + 1} looped (${verdict.reason})`);
    if (i < CHUNK_ATTEMPT_TEMPERATURES.length - 1) {
      onProgress?.({
        type: 'transcribe-retry',
        message: `Couldn't make out ${label} — listening to it again…`,
      });
    }
  }

  return { ...last, attempts: CHUNK_ATTEMPT_TEMPERATURES.length, looped: true };
}

/**
 * Turn a prepared episode into the timestamped transcript the Brain reads.
 *
 * Returns { transcript, segments, language, source }. `transcript` is the
 * "M:SS - words" format every pass expects — the same shape the old YouTube
 * scrape produced, so nothing downstream changes.
 */
async function transcribeEpisode({ jobId, userId, onProgress, language: askedLanguage }) {
  // The source may only exist in R2 by now; this pulls it back to disk.
  const job = await manualClipService.ensureSourceAvailable(jobId, userId);
  const videoPath = job.videoPath;

  const workDir = path.join(path.dirname(videoPath), 'podcast-audio');
  await fs.ensureDir(workDir);

  try {
    onProgress?.({ type: 'transcribe-start', message: 'Listening to the episode…' });

    const durationSec = job.videoDuration || 0;
    console.log(`[PodcastBrain] ${jobId}: ${Math.round(durationSec)}s, language=${askedLanguage || 'auto'}`);

    const segments = [];
    // What we SEND (a two-letter code, or nothing). Once a chunk tells us what
    // it heard, later chunks are given that hint so one noisy stretch mid-call
    // cannot be mistaken for a different language entirely.
    let hint = languageCode(askedLanguage);
    let language = askedLanguage || null;   // what we REPORT, for the log
    let unheardSeconds = 0;      // stretches Whisper only ever returned noise for
    const unheard = [];          // and where they were, for the message

    // Every episode is chunked, not only the ones too big to send whole — see
    // CHUNK_SECONDS above for why. Each chunk's timestamps are relative to
    // itself, so they are shifted back onto the episode's own clock.
    //
    // The chunk count is NOT taken from the stored duration. A missing or zero
    // duration would have silently produced a single chunk — the first minutes
    // of a two-hour call transcribed, the rest thrown away, and a perfectly
    // confident-looking result. Instead we keep cutting until a chunk comes back
    // with no audio in it, which is the file actually telling us it has ended.
    // The stored duration is used only to estimate how many parts to promise.
    const estimated = durationSec ? Math.ceil(durationSec / CHUNK_SECONDS) : 0;
    const MAX_CHUNKS = 120;          // 10 hours; a backstop, never a real limit
    for (let i = 0; i < MAX_CHUNKS; i++) {
      const offset = i * CHUNK_SECONDS;
      const chunkPath = path.join(workDir, `chunk_${i + 1}.mp3`);
      onProgress?.({
        type: 'transcribe-progress',
        message: estimated
          ? `Listening to the episode… part ${i + 1} of ${estimated}`
          : `Listening to the episode… part ${i + 1}`,
      });
      await extractAudio(videoPath, chunkPath, { seek: offset, duration: CHUNK_SECONDS });

      // An empty chunk means we have run off the end of the file. That is the
      // end of the episode, so stop — don't skip and keep going, or a silent
      // gap mid-call would look like the end.
      const chunkSize = (await fs.stat(chunkPath).catch(() => ({ size: 0 }))).size;
      if (chunkSize < 2048) { await fs.remove(chunkPath).catch(() => {}); break; }

      const heard = await transcribeChunkWithRetries(chunkPath, {
        language: hint,
        onProgress,
        label: `${stamp(offset)}–${stamp(offset + CHUNK_SECONDS)}`,
      });
      await fs.remove(chunkPath).catch(() => {});

      if (heard.looped) {
        // Three goes and it is still repeating itself. Throw these lines away
        // rather than let noise into the transcript — a Claude pass cannot tell
        // 'আমি আমি আমি…' from something the guest actually said, and will cut
        // the episode to pieces on the strength of it.
        unheardSeconds += CHUNK_SECONDS;
        unheard.push(`${stamp(offset)}–${stamp(offset + CHUNK_SECONDS)}`);
        console.log(`[PodcastBrain] ${jobId}: gave up on ${stamp(offset)}–${stamp(offset + CHUNK_SECONDS)}`);
      } else {
        language = language || heard.language;
        hint = hint || languageCode(heard.language);
        for (const seg of heard.segments) {
          segments.push({ ...seg, start: (seg.start || 0) + offset, end: (seg.end || 0) + offset });
        }
      }

      if (estimated && i + 1 >= estimated && durationSec && offset + CHUNK_SECONDS >= durationSec) break;
    }

    const lines = segments
      .map(s => `${stamp(s.start)} - ${String(s.text || '').trim()}`)
      .filter(l => l.split(' - ').slice(1).join(' - ').trim());

    // ⛔ The gate. Everything below decides whether what we heard is worth
    // spending five Claude passes on — because the cost of getting this wrong is
    // not a wasted run, it is an editor filled with confident nonsense that took
    // a person twenty minutes to work out was nonsense.
    if (!lines.length) {
      throw new Error(
        unheard.length
          ? 'I listened to the whole episode but the words came back as the same sounds repeated over and over, not real sentences. Nothing was analysed and nothing in your editor was changed. Try listening again, or paste the YouTube transcript instead.'
          : 'Nothing could be heard in this episode, so there is nothing to work from.'
      );
    }

    // Most of the call unheard — what is left cannot describe the episode, and
    // a report built on it would quietly be about the few minutes that survived.
    if (durationSec && unheardSeconds > durationSec * 0.35) {
      throw new Error(
        `I could only make out ${Math.round(((durationSec - unheardSeconds) / durationSec) * 100)}% of this episode — the rest came back as the same sounds repeated over and over. Nothing was analysed and nothing in your editor was changed. Try listening again, or paste the YouTube transcript instead.`
      );
    }

    // Belt to those braces: the joined transcript itself must not read like a
    // loop, and an episode should produce far more than a couple of lines a
    // minute. Both of these are what the 31-minute call that started all this
    // would have failed on.
    // 1.5 lines a minute is far below anything a real conversation produces —
    // even a slow, pause-heavy call runs several times that. It is deliberately
    // this low so a genuinely quiet recording is never thrown out; the tests
    // above are what actually catch a loop.
    const whole = looksLooped(segments);
    const linesPerMinute = durationSec ? lines.length / (durationSec / 60) : Infinity;
    if (whole.looped || (durationSec > 300 && linesPerMinute < 1.5)) {
      throw new Error(
        'I listened to this episode but what came back is not real speech — ' +
        (whole.reason || 'there are far too few words for a call this long') +
        '. That happens sometimes with mixed Bangla/English audio. Nothing was analysed and nothing in your editor was changed. Try listening again, or paste the YouTube transcript instead.'
      );
    }

    const heardNote = unheard.length ? ` (couldn't make out ${unheard.join(', ')})` : '';
    onProgress?.({
      type: 'transcribe-done',
      message: `Heard ${lines.length} lines${heardNote}.`,
      cues: lines.length,
      unheard,
    });
    console.log(`[PodcastBrain] ${jobId}: transcribed ${lines.length} cues (${language || 'unknown language'})${heardNote}`);

    return { transcript: lines.join('\n'), segments, language, source: 'whisper', unheard };
  } finally {
    await fs.remove(workDir).catch(() => {});
  }
}

module.exports = { transcribeEpisode, stamp, looksLooped };
