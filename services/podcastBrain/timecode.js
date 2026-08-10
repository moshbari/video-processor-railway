/**
 * 🕐 Timecode helpers for the Podcast Brain.
 *
 * The transcript comes from YouTube auto-captions, which write cue times as
 * M:SS under an hour and H:MM:SS past it. The model is asked for HH:MM:SS. The
 * editor stores plain seconds. Everything funnels through here so those three
 * conventions only have to agree in one file.
 */

/**
 * Parse a timecode into seconds. Accepts M:SS, MM:SS, H:MM:SS, HH:MM:SS, with an
 * optional decimal part, and a bare number of seconds. Returns null for anything
 * it cannot read — callers treat null as "drop this row", never as 0, because a
 * silently-zeroed timestamp means a cut at the start of the episode.
 */
function toSeconds(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;

  const str = String(value).trim();
  if (!str) return null;

  if (/^\d+(\.\d+)?$/.test(str)) {
    const n = parseFloat(str);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  const m = str.match(/^(?:(\d{1,3}):)?(\d{1,3}):(\d{1,2}(?:[.,]\d+)?)$/);
  if (!m) return null;

  const hasHours = m[1] !== undefined;
  const hours = hasHours ? parseInt(m[1], 10) : 0;
  const minutes = parseInt(m[2], 10);
  const seconds = parseFloat(String(m[3]).replace(',', '.'));
  if (!Number.isFinite(seconds) || seconds >= 60) return null;
  // Minutes only have to be < 60 when an hours field is present. Written as
  // MM:SS, "75:30" legitimately means 75 minutes — rejecting it would quietly
  // drop every section past the one-hour mark of a long call.
  if (hasHours && minutes > 59) return null;

  const total = hours * 3600 + minutes * 60 + seconds;
  return Number.isFinite(total) && total >= 0 ? total : null;
}

/** Seconds → HH:MM:SS, for anything a person will read. */
function toTimecode(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * Turn one model-produced row into a clean { startTime, endTime } pair, or null.
 *
 * Rejects (rather than repairs) rows that are unreadable, inverted, zero-length,
 * or that start past the end of the video. Repairs only the one case that is
 * unambiguous: an end time past the end of the video gets clamped, because the
 * model reaching for "the last thing said" is normal and harmless.
 */
function normalizeRange(row, videoDuration) {
  const start = toSeconds(row.start ?? row.startTime ?? row.from);
  let end = toSeconds(row.end ?? row.endTime ?? row.to);
  if (start === null || end === null) return null;

  const duration = Number(videoDuration) > 0 ? Number(videoDuration) : null;
  if (duration !== null) {
    if (start >= duration) return null;
    if (end > duration) end = duration;
  }
  if (end <= start) return null;

  return { startTime: start, endTime: end };
}

/** Do two ranges touch at all? */
function overlaps(a, b) {
  return a.startTime < b.endTime && b.startTime < a.endTime;
}

/**
 * Merge overlapping or touching ranges into one. `gap` lets ranges that are
 * merely adjacent (a second apart, say) collapse together, which is what Mosh's
 * instruction "merge overlapping/adjacent cuts" asks for.
 */
function mergeRanges(ranges, gap = 1) {
  const sorted = [...ranges].sort((a, b) => a.startTime - b.startTime);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startTime <= last.endTime + gap) {
      if (r.endTime > last.endTime) {
        last.endTime = r.endTime;
        // Keep both descriptions when two different sections become one cut.
        if (r.title && last.title && !last.title.includes(r.title)) {
          last.title = `${last.title} + ${r.title}`.slice(0, 200);
        }
      }
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

module.exports = { toSeconds, toTimecode, normalizeRange, overlaps, mergeRanges };
