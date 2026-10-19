/**
 * 🔁 Bring my edits to the new version of this video.
 *
 * WHY THIS EXISTS
 *
 * An episode gets an hour of work in the podcast editor — hooks, cuts, voice
 * changes, ReVoice, CTA overlays, spliced clips — and then it turns out the
 * video itself needs another pass in Tella. The re-edited export comes back as
 * a NEW project with none of that work on it, and every saved time in the old
 * project is now wrong by however much Tella trimmed before it.
 *
 * This copies all of it from the old project onto the new one, moving every
 * time to where that moment now is (found by sound — see aligner.js). Nothing
 * on the old project is touched; it stays as the safety copy.
 *
 * THE TWO CLOCKS
 *
 * Hooks, cuts, voice-disguise and ReVoice are timed on the SOURCE video, so
 * they map directly. CTA overlays, spliced clips and background sections are
 * timed on the FINAL video (hooks in front, cuts removed — the same maths as the
 * editor's src/lib/finalTimeline.ts). Those go final → old source → new source →
 * final again, using each project's own hooks and cuts.
 *
 * Anything whose sound couldn't be found in the new video still comes across,
 * at its best estimate, and is listed in the report (and hooks/cuts/voice
 * sections get "⚠️ Check" on their title) so it can be found and fixed by hand.
 */

const manualVideoLibraryService = require('../manualVideoLibraryService');
const r2Service = require('../r2Service');
const { fingerprint, mapTimes } = require('./aligner');

const LENGTH_TOLERANCE_SEC = 0.5; // a section whose length changed more than this gets checked
const CHECK_PREFIX = '⚠️ Check — ';

// jobId (the NEW project) → { status, message, error, report, startedAt }
const jobs = new Map();

// ---- the editor's final-timeline maths (src/lib/finalTimeline.ts), server side ----

function removedBefore(sourceTime, cuts) {
  let removed = 0;
  for (const c of cuts || []) {
    const s = Math.max(0, Math.min(c.startTime, c.endTime));
    const e = Math.max(0, Math.max(c.startTime, c.endTime));
    if (e <= sourceTime) removed += e - s;
    else if (s < sourceTime) removed += sourceTime - s;
  }
  return removed;
}

function sourceToFinal(sourceTime, hooksOffset, cuts) {
  const t = Math.max(0, sourceTime || 0);
  return Math.max(0, (hooksOffset || 0) + Math.max(0, t - removedBefore(t, cuts)));
}

function finalToSource(finalTime, hooksOffset, cuts) {
  let remaining = Math.max(0, (finalTime || 0) - (hooksOffset || 0));
  const sorted = (cuts || [])
    .map((c) => ({ start: Math.min(c.startTime, c.endTime), end: Math.max(c.startTime, c.endTime) }))
    .filter((c) => c.end > c.start)
    .sort((a, b) => a.start - b.start);
  let source = 0;
  for (const c of sorted) {
    const kept = c.start - source;
    if (remaining <= kept) return source + remaining;
    remaining -= Math.max(0, kept);
    source = c.end;
  }
  return source + remaining;
}

const hooksLength = (hooks) => (hooks || []).reduce((n, h) => n + Math.max(0, h.endTime - h.startTime), 0);

function stamp(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Work out the new project's edits from the old one's. Pure — no I/O — so it
 * can be tested on two fingerprints.
 * Returns { patch, report }.
 */
function carry(oldRecord, oldTrack, newTrack) {
  const newDuration = newTrack.duration;
  const oldHooks = oldRecord.hooks || [];
  const oldCuts = oldRecord.cuts || [];
  const oldHooksOffset = hooksLength(oldHooks);

  // Final-clock items: where they sit in the old source (null = inside the hook montage).
  const finalToOldSource = (t) => (t < oldHooksOffset ? null : finalToSource(t, oldHooksOffset, oldCuts));

  const lowerThirds = oldRecord.lowerThirds || [];
  const inserts = oldRecord.inserts || [];
  const backgrounds = oldRecord.backgroundSections || [];

  const times = [];
  for (const list of [oldHooks, oldCuts, oldRecord.disguise || [], oldRecord.revoice || []]) {
    for (const x of list) times.push(x.startTime, x.endTime);
  }
  const ltSrc = lowerThirds.map((lt) => finalToOldSource(Number(lt.startSec) || 0));
  const insSrc = inserts.map((p) => (p.atTime === null || p.atTime === undefined ? null : finalToOldSource(Number(p.atTime))));
  const bgSrc = backgrounds.map((b) => finalToOldSource(Number(b.startSec) || 0));
  for (const t of [...ltSrc, ...insSrc, ...bgSrc]) if (t !== null) times.push(t);

  const map = mapTimes(oldTrack, newTrack, times);
  const clamp = (t) => round2(Math.max(0, Math.min(newDuration, t)));

  const checks = [];   // what a person should look at
  let moved = 0;

  // ---- source-clock ranges ----
  const mapRange = (item, kind, label) => {
    const s = map(item.startTime);
    const e = map(item.endTime);
    const startTime = clamp(s.time);
    let endTime = clamp(e.time);
    let problem = null;
    if (!s.found || !e.found) problem = 'part of it is no longer in the new video';
    else if (endTime <= startTime) problem = 'it no longer makes sense in the new video';
    else {
      const change = (endTime - startTime) - (item.endTime - item.startTime);
      if (Math.abs(change) > LENGTH_TOLERANCE_SEC) {
        problem = `it is ${Math.abs(change).toFixed(1)}s ${change < 0 ? 'shorter' : 'longer'} now (something inside it was re-edited)`;
      }
    }
    if (endTime <= startTime) endTime = clamp(startTime + Math.max(0.5, item.endTime - item.startTime));
    if (problem) {
      checks.push({ kind, label, was: `${stamp(item.startTime)}–${stamp(item.endTime)}`, now: `${stamp(startTime)}–${stamp(endTime)}`, why: problem });
    } else moved++;
    const title = item.title || '';
    return {
      ...item,
      title: problem && !title.startsWith(CHECK_PREFIX) ? `${CHECK_PREFIX}${title}` : title,
      startTime,
      endTime,
    };
  };

  const hooks = oldHooks.map((h, i) => mapRange(h, 'Hook', h.title || `Hook ${i + 1}`));
  const cuts = oldCuts.map((c, i) => mapRange(c, 'Removed section', c.title || `Section ${i + 1}`));
  const disguise = (oldRecord.disguise || []).map((d, i) => mapRange(d, 'Voice change', d.title || `Voice ${i + 1}`));
  const revoice = (oldRecord.revoice || []).map((r, i) => mapRange(r, 'ReVoice', r.title || `ReVoice ${i + 1}`));

  // ---- final-clock items, re-timed against the NEW hooks and cuts ----
  const newHooksOffset = hooksLength(hooks);
  const toNewFinal = (finalT, oldSrc) => {
    if (oldSrc === null) return { time: finalT, found: true }; // inside the hook montage: it keeps its place
    const m = map(oldSrc);
    return { time: sourceToFinal(m.time, newHooksOffset, cuts), found: m.found };
  };

  const newLowerThirds = lowerThirds.map((lt, i) => {
    const start = Number(lt.startSec) || 0;
    const length = Math.max(0, (Number(lt.endSec) || 0) - start);
    const r = toNewFinal(start, ltSrc[i]);
    const startSec = round2(r.time);
    if (!r.found) {
      checks.push({ kind: 'CTA overlay', label: lt.line1 || `CTA ${i + 1}`, was: stamp(start), now: stamp(startSec), why: 'the moment it marked is no longer in the new video' });
    } else moved++;
    return { ...lt, startSec, endSec: round2(startSec + length) };
  });

  const newInserts = inserts.map((p, i) => {
    if (p.atTime === null || p.atTime === undefined) { moved++; return { ...p }; } // "at the end" stays at the end
    const r = toNewFinal(Number(p.atTime), insSrc[i]);
    const atTime = round2(r.time);
    if (!r.found) {
      checks.push({ kind: 'Added clip', label: `Added clip ${i + 1}`, was: stamp(p.atTime), now: stamp(atTime), why: 'the moment it was spliced at is no longer in the new video' });
    } else moved++;
    return { ...p, atTime };
  });

  const newBackgrounds = backgrounds.map((b, i) => {
    const start = Number(b.startSec) || 0;
    const length = Math.max(0, (Number(b.endSec) || 0) - start);
    const r = toNewFinal(start, bgSrc[i]);
    const startSec = round2(r.time);
    if (!r.found) {
      checks.push({ kind: 'Background section', label: b.title || `Background ${i + 1}`, was: stamp(start), now: stamp(startSec), why: 'the moment it started at is no longer in the new video' });
    } else moved++;
    return { ...b, startSec, endSec: round2(startSec + length) };
  });

  const patch = {
    hooks,
    cuts,
    disguise,
    revoice,
    lowerThirds: newLowerThirds,
    inserts: newInserts,
    backgroundSections: newBackgrounds,
    introUrl: oldRecord.introUrl || null,
    introLabel: oldRecord.introUrl ? (oldRecord.introLabel || '') : '',
    removeSilences: !!oldRecord.removeSilences,
    levelAudio: !!oldRecord.levelAudio,
  };

  const report = {
    fromJobId: oldRecord.jobId,
    fromTitle: oldRecord.title || '',
    moved,
    checks,
    total: moved + checks.length,
    oldDuration: round2(oldTrack.duration),
    newDuration: round2(newDuration),
    counts: {
      hooks: hooks.length,
      cuts: cuts.length,
      disguise: disguise.length,
      revoice: revoice.length,
      lowerThirds: newLowerThirds.length,
      inserts: newInserts.length,
      backgroundSections: newBackgrounds.length,
    },
    at: new Date().toISOString(),
  };
  return { patch, report };
}

/** Which file to listen to: the project's master (the times are on its clock). */
function audioSourceOf(record) {
  const url = record.playbackUrl || (record.sourceKey ? r2Service.getPublicUrl(record.sourceKey) : null);
  return url ? r2Service.toPublicUrl(url) : null;
}

/**
 * Start carrying edits from `fromJobId` onto `toJobId`. Returns at once; poll
 * status(toJobId). One run per target at a time.
 */
function start(userId, toJobId, fromJobId) {
  const running = jobs.get(toJobId);
  if (running && running.status === 'running') return running;

  const job = { status: 'running', message: 'Getting both videos ready…', error: '', report: null, startedAt: Date.now() };
  jobs.set(toJobId, job);

  (async () => {
    try {
      const [oldRecord, newRecord] = await Promise.all([
        manualVideoLibraryService.getAnywhere(userId, fromJobId),
        manualVideoLibraryService.getAnywhere(userId, toJobId),
      ]);
      if (!oldRecord) throw new Error('The older version is no longer in your library.');
      if (!newRecord) throw new Error('This video is no longer in your library.');
      const oldUrl = audioSourceOf(oldRecord);
      const newUrl = audioSourceOf(newRecord);
      if (!oldUrl || !newUrl) throw new Error('One of the videos has no file to listen to.');

      job.message = 'Listening to both videos…';
      const [oldTrack, newTrack] = await Promise.all([fingerprint(oldUrl), fingerprint(newUrl)]);

      job.message = 'Finding where each edit is in the new version…';
      const { patch, report } = carry(oldRecord, oldTrack, newTrack);

      job.message = 'Saving…';
      const saved = await manualVideoLibraryService.updateVideo(userId, toJobId, { ...patch, carriedEdits: report });
      if (!saved) throw new Error('Could not save the edits onto this video.');

      job.status = 'complete';
      job.message = report.checks.length
        ? `Moved ${report.moved} edits — ${report.checks.length} need a look.`
        : `All ${report.moved} edits moved.`;
      job.report = report;
      console.log(`[CarryEdits] ${fromJobId} → ${toJobId}: ${report.moved} moved, ${report.checks.length} to check`);
    } catch (err) {
      console.error('[CarryEdits] Failed:', err);
      job.status = 'error';
      job.error = err.message || 'Something went wrong.';
    }
  })();

  return job;
}

function status(toJobId) {
  return jobs.get(toJobId) || null;
}

module.exports = { start, status, carry, finalToSource, sourceToFinal };
