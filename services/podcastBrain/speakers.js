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
function parseTranscript(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  const cues = [];
  const header = [];

  for (const line of lines) {
    const m = line.match(/^\s*(\d{1,3}:\d{2}(?::\d{2})?(?:[.,]\d+)?)\s*[-–—]\s*(.*)$/);
    if (m) {
      const at = toSeconds(m[1]);
      if (at !== null) {
        cues.push({ at, text: m[2].trim() });
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
