/**
 * 📺 YouTube captions as a transcript for the AI clip finder.
 *
 * The Clip Maker's AI mode used to get its words one way only: download the
 * video, strip the audio, send it to Whisper. That is the worst of the two
 * routes available:
 *
 *  - it costs money per minute of audio, and a two-hour podcast is expensive;
 *  - Whisper invents words on marginal audio and LOOPS on long mixed
 *    Bengali/English speech (see the Podcast Brain, which was moved off it for
 *    exactly that reason);
 *  - YouTube blocks datacenter IPs, so the download it depends on is the least
 *    reliable step in the whole pipeline.
 *
 * If the video is on YouTube, YouTube has already transcribed it — for free,
 * with timestamps that line up with the file YouTube itself serves. The user's
 * own browser can read those captions through the "YT Transcript Scraper"
 * extension and post them here, which is what this file turns into the
 * `{ text, segments }` shape the rest of the service already speaks.
 *
 * Cue times are whole seconds (YouTube's transcript panel writes "M:SS"), which
 * is plenty for choosing where a clip starts and ends; the AI picks boundaries
 * on sentence edges anyway.
 */

const { parseTranscript } = require('./podcastBrain/speakers');
const { toSeconds } = require('./podcastBrain/timecode');

// How long a cue is allowed to run when nothing follows it to end it.
const TAIL_CUE_SECONDS = 6;
// A cue never stretches past this, however big the gap to the next one. A gap
// means silence, and a caption that lingers through the silence is both wrong
// on screen and wrong about when the words were said.
const MAX_CUE_SECONDS = 8;
// Cues are allowed to sit this far past the end of the video before they are
// treated as belonging to a different (longer) recording.
const OVERRUN_GRACE = 30;

/**
 * Accept either the plain "M:SS - words" transcript the extension hands the
 * page, or the raw `[{ timestamp, text }]` segments behind it. Both arrive from
 * the same place; supporting both means neither caller has to convert first.
 */
function toCues(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((s) => ({ at: toSeconds(s && (s.timestamp ?? s.start ?? s.at)), text: String((s && s.text) || '').trim() }))
      .filter((c) => c.at !== null && c.text);
  }
  return parseTranscript(raw).cues.filter((c) => c.text);
}

/**
 * Turn scraped captions into a transcription object.
 *
 * @param {string|Array} raw          the transcript, as text or as segments
 * @param {number} videoDuration      length of the video being cut, in seconds
 * @returns {{ text, segments, language, duration, source, cueCount, droppedCues, note }}
 * @throws when there is nothing usable inside the video's own timeline
 */
function transcriptionFromCaptions(raw, videoDuration) {
  const cues = toCues(raw).sort((a, b) => a.at - b.at);
  if (!cues.length) {
    throw new Error('That transcript has no timestamped lines in it. Each line needs to look like "1:04 - what was said".');
  }

  const limit = videoDuration > 0 ? videoDuration : Infinity;

  // Captions that run past the end of the video mean one of two things: the
  // link was for a different recording, or the uploaded file is a trim of it.
  // Either way the words out there describe footage nobody can cut, and left in
  // they make the AI propose clips that get thrown away as out of range.
  const inRange = cues.filter((c) => c.at <= limit + OVERRUN_GRACE);
  const droppedCues = cues.length - inRange.length;

  if (inRange.length < 3) {
    throw new Error(
      `Those captions do not belong to this video — they start at ${fmt(cues[0].at)} and the video is only ${fmt(videoDuration)} long. ` +
      'Check the YouTube link is the same recording.'
    );
  }

  const segments = inRange.map((cue, i) => {
    const next = inRange[i + 1];
    const start = Math.min(cue.at, limit);
    let end = next ? Math.min(next.at, start + MAX_CUE_SECONDS) : start + TAIL_CUE_SECONDS;
    if (Number.isFinite(limit)) end = Math.min(end, limit);
    if (end <= start) end = start + 0.5; // a caption always has some length
    return { start, end, text: cue.text };
  });

  const note = droppedCues
    ? `${droppedCues} caption line${droppedCues === 1 ? ' ran' : 's ran'} past the end of this video and ${droppedCues === 1 ? 'was' : 'were'} left out — the captions are for a longer cut of it.`
    : '';

  return {
    text: segments.map((s) => s.text).join(' '),
    segments,
    language: 'auto',
    duration: videoDuration || (segments.length ? segments[segments.length - 1].end : 0),
    source: 'youtube-captions',
    cueCount: segments.length,
    droppedCues,
    note,
  };
}

function fmt(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

module.exports = { transcriptionFromCaptions };
