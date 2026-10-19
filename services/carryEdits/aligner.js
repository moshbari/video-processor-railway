/**
 * 🔊 Finding the same moment in two versions of a video, by ear.
 *
 * WHY THIS EXISTS
 *
 * Every edit in the podcast editor is a time in the source video: hooks, cuts,
 * voice changes, ReVoice. When the video is re-edited elsewhere (Tella trims a
 * stumble, a scene is redone visually) and imported again, those times point at
 * the wrong places — everything after the first trim is early or late by
 * however much was taken out.
 *
 * A visual re-edit doesn't touch the voice. So we listen: take a few seconds of
 * sound from the old video around each edit, find exactly where that sound
 * happens in the new one, and that is the edit's new time. A moment whose sound
 * is gone from the new video (that part was deleted) can't be found, and is
 * reported as such rather than guessed at silently.
 *
 * HOW
 *
 * Both soundtracks become a 100-per-second "loudness fingerprint": the energy of
 * each 10ms, plus the energy of its rapid changes (which carries the consonants).
 * Logged, so a louder or quieter export only shifts it — and normalised cross-
 * correlation ignores shifts. Speech's rhythm over six seconds is as good as
 * unique in an episode.
 *
 * Searching is coarse-to-fine: 50ms steps first, near where the neighbouring
 * edits moved to, then the whole video if that fails; then a 10ms refine.
 */

const { spawn } = require('child_process');

const SAMPLE_RATE = 8000;
const HOP = 80;                 // 10ms per frame
const FPS = SAMPLE_RATE / HOP;  // 100 frames per second
const COARSE = 5;               // 50ms per coarse frame

const WINDOW_SEC = 6;           // how much sound identifies a moment
const LONG_WINDOW_SEC = 12;     // tried when six seconds is mostly silence
const LOCAL_SEARCH_SEC = 90;    // how far either side of the expected spot to look first

const MIN_SCORE = 0.8;          // correlation below this isn't the same sound
const AMBIGUOUS_MARGIN = 0.03;  // a runner-up this close elsewhere = can't tell which
const AGREE_SEC = 0.15;         // before- and after-sound agree within this = confident
const SEAM_SCORE = 0.95;        // on a seam, only a near-perfect side counts as found

/**
 * Decode a video's soundtrack (a URL or a path) to the two fingerprint tracks.
 * Streams through ffmpeg, so an hour-long episode never sits in memory as audio.
 */
function fingerprint(input) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-v', 'error', '-nostdin',
      '-i', input,
      '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE),
      '-f', 's16le', 'pipe:1',
    ]);

    const energy = [];
    const detail = [];
    let carry = Buffer.alloc(0);
    let prev = 0;
    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const frameBytes = HOP * 2;
      const whole = Math.floor(buf.length / frameBytes) * frameBytes;
      for (let off = 0; off < whole; off += frameBytes) {
        let e = 0;
        let d = 0;
        for (let i = 0; i < HOP; i++) {
          const s = buf.readInt16LE(off + i * 2);
          e += s * s;
          const diff = s - prev;
          d += diff * diff;
          prev = s;
        }
        energy.push(Math.log10(e / HOP + 1));
        detail.push(Math.log10(d / HOP + 1));
      }
      carry = buf.subarray(whole);
    });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`Could not read the soundtrack (${stderr.trim().slice(-200) || `ffmpeg ${code}`})`));
      resolve(buildTrack(Float32Array.from(energy), Float32Array.from(detail)));
    });
  });
}

/** Fine (10ms) and coarse (50ms) versions of a fingerprint, with prefix sums. */
function buildTrack(energy, detail) {
  const coarseLen = Math.floor(energy.length / COARSE);
  const ce = new Float32Array(coarseLen);
  const cd = new Float32Array(coarseLen);
  for (let i = 0; i < coarseLen; i++) {
    let a = 0;
    let b = 0;
    for (let k = 0; k < COARSE; k++) { a += energy[i * COARSE + k]; b += detail[i * COARSE + k]; }
    ce[i] = a / COARSE;
    cd[i] = b / COARSE;
  }
  return {
    duration: energy.length / FPS,
    fine: withSums([energy, detail]),
    coarse: withSums([ce, cd]),
  };
}

function withSums(channels) {
  return channels.map((x) => {
    const sum = new Float64Array(x.length + 1);
    const sq = new Float64Array(x.length + 1);
    for (let i = 0; i < x.length; i++) {
      sum[i + 1] = sum[i] + x[i];
      sq[i + 1] = sq[i] + x[i] * x[i];
    }
    return { x, sum, sq };
  });
}

/**
 * Normalised correlation of the query (old track, frames [qs, qs+n)) against the
 * target at every position in [from, to]. Each channel scores separately and
 * they're averaged. Returns { best, bestScore, runnerUp } — runnerUp is the best
 * score at least a second away from `best`.
 */
function scan(query, qs, target, n, from, to, framesPerSec) {
  from = Math.max(0, from);
  to = Math.min(target[0].x.length - n, to);
  if (to < from) return null;

  const qStats = query.map((c) => {
    const mean = (c.sum[qs + n] - c.sum[qs]) / n;
    const v = (c.sq[qs + n] - c.sq[qs]) / n - mean * mean;
    const q = new Float32Array(n);
    for (let i = 0; i < n; i++) q[i] = c.x[qs + i] - mean;
    return { q, sd: Math.sqrt(Math.max(v, 0)) };
  });
  if (qStats.some((s) => s.sd < 1e-3)) return null; // silence identifies nothing

  const scores = new Float32Array(to - from + 1);
  for (let p = from; p <= to; p++) {
    let total = 0;
    for (let ch = 0; ch < query.length; ch++) {
      const t = target[ch];
      const mean = (t.sum[p + n] - t.sum[p]) / n;
      const v = (t.sq[p + n] - t.sq[p]) / n - mean * mean;
      if (v <= 1e-6) { total = -Infinity; break; }
      const q = qStats[ch].q;
      const x = t.x;
      let dot = 0;
      for (let i = 0; i < n; i++) dot += q[i] * x[p + i];
      total += dot / (n * qStats[ch].sd * Math.sqrt(v));
    }
    scores[p - from] = total / query.length;
  }

  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  const gap = framesPerSec; // a second
  let runnerUp = -Infinity;
  for (let i = 0; i < scores.length; i++) {
    if (Math.abs(i - best) >= gap && scores[i] > runnerUp) runnerUp = scores[i];
  }
  return { best: best + from, bestScore: scores[best], runnerUp };
}

/**
 * Where does the sound of old[startSec, startSec+lenSec) begin in the new video?
 * `guessSec` is where it is expected (nearby edits' shift); null = no idea.
 * Returns { at, score } or null when the sound isn't in the new video.
 */
function locate(oldTrack, newTrack, startSec, lenSec, guessSec) {
  const cps = FPS / COARSE;
  const n = Math.round(lenSec * cps);
  const qs = Math.round(startSec * cps);
  if (qs < 0 || qs + n > oldTrack.coarse[0].x.length) return null;

  const tryRange = (from, to) => {
    const r = scan(oldTrack.coarse, qs, newTrack.coarse, n, from, to, cps);
    if (!r || r.bestScore < MIN_SCORE) return null;
    if (r.runnerUp > r.bestScore - AMBIGUOUS_MARGIN) return null;
    return r;
  };

  let hit = null;
  if (guessSec !== null && guessSec !== undefined) {
    const g = Math.round(guessSec * cps);
    const span = Math.round(LOCAL_SEARCH_SEC * cps);
    hit = tryRange(g - span, g + span);
  }
  if (!hit) hit = tryRange(0, Infinity);
  if (!hit) return null;

  // Refine to 10ms around the coarse answer.
  const fn = n * COARSE;
  const fqs = qs * COARSE;
  const centre = hit.best * COARSE;
  const fine = scan(oldTrack.fine, fqs, newTrack.fine, fn, centre - 2 * COARSE, centre + 2 * COARSE, FPS);
  const at = fine && fine.bestScore >= MIN_SCORE ? fine.best / FPS : centre / FPS;
  return { at, score: fine ? fine.bestScore : hit.bestScore };
}

/**
 * Map one moment of the old video to the new one.
 *
 * Listens to the sound just AFTER the moment and just BEFORE it. When both are
 * found in the same place, that's the answer. When they disagree, the moment
 * sits on a seam of the re-edit (something was cut or added right there): the
 * side that matches more cleanly wins, but only a near-perfect match counts as
 * found — anything less is an estimate for a person to check. Six seconds
 * first, twelve if that's too quiet to tell.
 *
 * Returns { time, score, found } or null when neither side is heard at all.
 */
function mapPoint(oldTrack, newTrack, t, guessShift) {
  for (const len of [WINDOW_SEC, LONG_WINDOW_SEC]) {
    const sides = [
      { start: t, offset: 0 },          // sound after t
      { start: t - len, offset: len },  // sound before t
    ];
    const hits = [];
    for (const s of sides) {
      if (s.start < 0 || s.start + len > oldTrack.duration) continue;
      const guess = guessShift === null || guessShift === undefined ? null : s.start + guessShift;
      const hit = locate(oldTrack, newTrack, s.start, len, guess);
      if (hit) hits.push({ time: Math.max(0, hit.at + s.offset), score: hit.score });
    }
    if (!hits.length) continue;
    if (hits.length === 2 && Math.abs(hits[0].time - hits[1].time) <= AGREE_SEC) {
      return { time: (hits[0].time + hits[1].time) / 2, score: Math.max(hits[0].score, hits[1].score), found: true };
    }
    const best = hits.reduce((a, b) => (b.score > a.score ? b : a));
    // Only one side exists at the very start or end of the video — that's normal.
    const oneSided = (t - len < 0) || (t + len > oldTrack.duration);
    return { ...best, found: best.score >= (oneSided ? MIN_SCORE : SEAM_SCORE) };
  }
  return null;
}

/**
 * Map many moments at once. Returns a function old→{ time, found } that also
 * covers moments that couldn't be heard, by carrying over the shift of the
 * nearest moment that could (those come back with found: false).
 */
function mapTimes(oldTrack, newTrack, times) {
  const unique = [...new Set(times.filter((t) => Number.isFinite(t)).map((t) => Math.round(t * 100) / 100))]
    .sort((a, b) => a - b);
  const results = new Map();
  let lastShift = 0; // a light re-edit starts aligned
  for (const t of unique) {
    const hit = mapPoint(oldTrack, newTrack, t, lastShift);
    if (hit && hit.found) {
      lastShift = hit.time - t;
      results.set(t, { time: hit.time, found: true, score: hit.score });
    } else if (hit) {
      results.set(t, { time: hit.time, found: false, estimated: true, score: hit.score });
    } else {
      results.set(t, { time: null, found: false });
    }
  }

  const found = unique.filter((t) => results.get(t).found);
  for (const t of unique) {
    const r = results.get(t);
    if (r.found || r.estimated) continue;
    // Shift of the nearest heard moment before (or else after) this one.
    let ref = null;
    for (const f of found) { if (f <= t) ref = f; else break; }
    if (ref === null && found.length) ref = found[0];
    const shift = ref === null ? 0 : results.get(ref).time - ref;
    r.time = Math.max(0, Math.min(newTrack.duration, t + shift));
  }

  return (t) => {
    if (!Number.isFinite(t)) return { time: t, found: false };
    const r = results.get(Math.round(t * 100) / 100);
    return r ? { time: r.time, found: r.found } : { time: t, found: false };
  };
}

module.exports = { fingerprint, buildTrack, mapTimes, mapPoint };
