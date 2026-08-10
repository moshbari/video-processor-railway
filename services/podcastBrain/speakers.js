/**
 * 🎤 Putting speaker labels onto a caption transcript.
 *
 * YouTube auto-captions have no idea who is talking — host and guest run
 * together in one flat stream. Mosh's instructions demand the opposite: every
 * quote in the social post has to be checked against who actually said it, and
 * the cold open is supposed to alternate voices.
 *
 * The backend already has speaker detection (manualClipService.detectSpeakers,
 * via AssemblyAI) which returns time ranges per speaker. AssemblyAI was rejected
 * here once for producing bad Bengali TRANSCRIPTION — but its time ranges are a
 * different thing, and that is all we take. The words still come from YouTube.
 *
 * NOTE ON WHY THIS IS NOT RUN AUTOMATICALLY YET: detectSpeakers writes progress
 * onto the SHARED manual-clip job for that video (including status:'error' when
 * it fails), which the editor is watching. Firing it from inside the brain would
 * make a diarization hiccup look like the video itself had failed. So the brain
 * accepts speaker ranges if it is given them, and runs unlabelled if not.
 */

const { toSeconds } = require('./timecode');

/**
 * Parse the transcript the extension scrapes from YouTube. Its shape is:
 *
 *   Video Title
 *   https://www.youtube.com/watch?v=...
 *
 *   0:00 - first caption cue
 *   0:08 - next caption cue
 *
 * Lines that aren't cues (the title, the URL, blanks) are kept out of the cue
 * list but not thrown away — the header is useful context for the model.
 */
/**
 * Strip YouTube's spoken-duration prefix from a caption line.
 *
 * Scraped from the transcript panel, cues often arrive with the timestamp
 * repeated as words before the actual speech:
 *
 *   "0:06 - 6 seconds আসসালামু আলাইকুম"
 *   "1:55:27 - 1 hour, 55 minutes, 27 seconds যাক ভাই"
 *
 * That is an accessibility label, not something anyone said. Left in, it ends
 * up inside the hook quotes.
 *
 * It is only removed when the phrase adds up to the SAME time as the cue — so a
 * line where someone genuinely says "30 seconds" keeps its words.
 */
function stripSpokenDuration(text, cueSeconds) {
  const m = String(text).match(
    /^\s*(?:(\d+)\s*hours?)?[, ]*(?:(\d+)\s*minutes?)?[, ]*(?:(\d+)\s*seconds?)?[, ]*\s*/i
  );
  if (!m || !m[0].trim()) return text;

  const h = m[1] ? parseInt(m[1], 10) : 0;
  const mi = m[2] ? parseInt(m[2], 10) : 0;
  const s = m[3] ? parseInt(m[3], 10) : 0;
  if (!m[1] && !m[2] && !m[3]) return text;

  const spoken = h * 3600 + mi * 60 + s;
  if (Math.abs(spoken - cueSeconds) > 1) return text; // real speech, leave it

  const rest = text.slice(m[0].length).trim();
  return rest || text; // never blank a line out entirely
}

function parseTranscript(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const cues = [];
  const header = [];

  for (const line of lines) {
    const m = line.match(/^\s*(\d{1,3}:\d{2}(?::\d{2})?(?:[.,]\d+)?)\s*[-–—]\s*(.*)$/);
    if (m) {
      const at = toSeconds(m[1]);
      if (at !== null) {
        cues.push({ at, text: stripSpokenDuration(m[2].trim(), at) });
        continue;
      }
    }
    if (!cues.length && line.trim()) header.push(line.trim());
  }

  return { header, cues };
}

/**
 * Which speaker was talking at time `t`? Returns null when nothing covers it —
 * a gap is better than a guess, because a wrong label is worse than no label.
 */
function speakerAt(t, ranges) {
  for (const r of ranges) {
    if (t >= r.startTime && t < r.endTime) return r.speaker;
  }
  return null;
}

/**
 * Flatten detectSpeakers' output — [{ speaker, segments: [{startTime, endTime}] }] —
 * into one time-sorted list.
 */
function flattenSpeakers(speakers) {
  const flat = [];
  for (const s of speakers || []) {
    for (const seg of s.segments || []) {
      const startTime = Number(seg.startTime);
      const endTime = Number(seg.endTime);
      if (Number.isFinite(startTime) && Number.isFinite(endTime) && endTime > startTime) {
        flat.push({ speaker: s.speaker, startTime, endTime });
      }
    }
  }
  return flat.sort((a, b) => a.startTime - b.startTime);
}

/**
 * Build the transcript the passes actually read.
 *
 * Without speaker ranges:   `0:08 - text`
 * With speaker ranges:      `[Speaker A] 0:08 - text`
 *
 * Returns { text, hasSpeakers, cueCount } — hasSpeakers drives which speaker
 * instructions the system prompt carries, so the model is either told to use the
 * labels or told plainly to stop guessing.
 */
function buildTranscriptForModel(raw, speakers) {
  const { header, cues } = parseTranscript(raw);

  // Nothing parsed as a cue — hand the raw text through rather than sending an
  // empty transcript, and say there are no speakers.
  if (!cues.length) {
    return { text: String(raw || '').trim(), hasSpeakers: false, cueCount: 0 };
  }

  const ranges = flattenSpeakers(speakers);
  const labelled = ranges.length > 0;

  const body = cues.map(c => {
    const stamp = timestampOf(c.at);
    if (!labelled) return `${stamp} - ${c.text}`;
    const who = speakerAt(c.at, ranges);
    return `${who ? `[${who}] ` : '[?] '}${stamp} - ${c.text}`;
  });

  const text = [...header, '', ...body].join('\n');
  return { text, hasSpeakers: labelled, cueCount: cues.length };
}

/** Cue timestamps stay in the transcript's own style: M:SS under an hour. */
function timestampOf(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

module.exports = { parseTranscript, buildTranscriptForModel, flattenSpeakers, speakerAt };
