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

// Whisper's API refuses anything over 25MB. Chunk before we get near it.
const SIZE_LIMIT_MB = 24;
const CHUNK_SECONDS = 600;      // 10 minutes, same as the AI Clip Maker uses

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
 * Turn a prepared episode into the timestamped transcript the Brain reads.
 *
 * Returns { transcript, segments, language, source }. `transcript` is the
 * "M:SS - words" format every pass expects — the same shape the old YouTube
 * scrape produced, so nothing downstream changes.
 */
async function transcribeEpisode({ jobId, userId, onProgress }) {
  // The source may only exist in R2 by now; this pulls it back to disk.
  const job = await manualClipService.ensureSourceAvailable(jobId, userId);
  const videoPath = job.videoPath;

  const workDir = path.join(path.dirname(videoPath), 'podcast-audio');
  await fs.ensureDir(workDir);
  const audioPath = path.join(workDir, 'episode.mp3');

  try {
    onProgress?.({ type: 'transcribe-start', message: 'Listening to the episode…' });
    await extractAudio(videoPath, audioPath);

    const sizeMB = (await fs.stat(audioPath)).size / (1024 * 1024);
    const durationSec = job.videoDuration || 0;
    console.log(`[PodcastBrain] ${jobId}: audio ${sizeMB.toFixed(1)}MB, ${Math.round(durationSec)}s`);

    let segments = [];
    let language = null;

    if (sizeMB <= SIZE_LIMIT_MB) {
      const out = await transcriptionService.transcribe(audioPath, { response_format: 'verbose_json' });
      segments = out.segments || [];
      language = out.language;
    } else {
      // Long episode — same chunk-and-offset approach the AI Clip Maker uses.
      // Each chunk's timestamps are relative to itself, so they are shifted
      // back onto the episode's own clock before being joined.
      //
      // The chunk count is NOT taken from the stored duration. A missing or
      // zero duration would have silently produced a single chunk — the first
      // ten minutes of a two-hour call transcribed, the rest thrown away, and a
      // perfectly confident-looking result. Instead we keep cutting until a
      // chunk comes back with no audio in it, which is the file actually
      // telling us it has ended. The stored duration is used only to estimate
      // how many parts to promise in the progress message.
      const estimated = durationSec ? Math.ceil(durationSec / CHUNK_SECONDS) : 0;
      const MAX_CHUNKS = 60;           // 10 hours; a backstop, never a real limit
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

        const out = await transcriptionService.transcribe(chunkPath, { response_format: 'verbose_json' });
        language = language || out.language;
        for (const seg of (out.segments || [])) {
          segments.push({ ...seg, start: (seg.start || 0) + offset, end: (seg.end || 0) + offset });
        }
        await fs.remove(chunkPath).catch(() => {});
        if (estimated && i + 1 >= estimated && durationSec && offset + CHUNK_SECONDS >= durationSec) break;
      }
    }

    const lines = segments
      .map(s => `${stamp(s.start)} - ${String(s.text || '').trim()}`)
      .filter(l => l.split(' - ').slice(1).join(' - ').trim());

    if (!lines.length) {
      throw new Error('Nothing could be heard in this episode, so there is nothing to work from.');
    }

    onProgress?.({ type: 'transcribe-done', message: `Heard ${lines.length} lines.`, cues: lines.length });
    console.log(`[PodcastBrain] ${jobId}: transcribed ${lines.length} cues (${language || 'unknown language'})`);

    return { transcript: lines.join('\n'), segments, language, source: 'whisper' };
  } finally {
    await fs.remove(workDir).catch(() => {});
  }
}

module.exports = { transcribeEpisode, stamp };
