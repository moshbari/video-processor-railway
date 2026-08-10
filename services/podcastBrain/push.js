/**
 * 📮 Getting the brain's output into the editor, and being sure it landed.
 *
 * Two failure modes this file exists to prevent:
 *
 * 1. THE SILENT NO-OP. The library's update methods used to return nothing when
 *    the video wasn't in the library yet — so a push that arrived before
 *    /prepare finished "succeeded" and did nothing, and Mosh would open an empty
 *    editor with no error anywhere to explain it. They now return a boolean, and
 *    this file treats false as a reason to wait and try again.
 *
 * 2. LOSING AN EXPENSIVE RUN. The brain costs five Claude passes and up to
 *    twenty minutes. If a Railway redeploy lands between "brain finished" and
 *    "hooks saved", none of that should have to happen twice. So the result is
 *    written to R2 the moment it exists, before any attempt to push it.
 */

const r2Service = require('../r2Service');
const manualVideoLibraryService = require('../manualVideoLibraryService');

const resultKey = (jobId) => `podcast-brain/${jobId}/result.json`;

/** Persist the finished brain output so a failed push never means re-running it. */
async function saveResult(jobId, result) {
  try {
    const body = Buffer.from(JSON.stringify({ ...result, savedAt: new Date().toISOString() }), 'utf-8');
    await r2Service.uploadBuffer(body, resultKey(jobId), 'application/json');
    return true;
  } catch (err) {
    console.error(`[PodcastBrain] Could not save result for ${jobId}:`, err.message);
    return false;
  }
}

/** Read back a previously saved result, so a push can be retried on its own. */
async function loadResult(jobId) {
  try {
    const buf = await r2Service.getFile(resultKey(jobId));
    return buf ? JSON.parse(buf.toString('utf-8')) : null;
  } catch (err) {
    console.error(`[PodcastBrain] Could not load result for ${jobId}:`, err.message);
    return null;
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Backoff schedule for "the video isn't in the library yet".
 *
 * In the normal flow the video is prepared long before the transcript arrives —
 * YouTube captions take twenty minutes to three hours. This exists for the
 * abnormal flow, where the analysis somehow overtakes the prepare. Roughly an
 * hour of patience, front-loaded so the common case of "ready in seconds"
 * doesn't wait five minutes for no reason.
 */
const WAIT_SCHEDULE_MS = [
  2000, 5000, 10000, 15000, 30000, 60000,
  120000, 300000, 300000, 300000, 300000, 300000, 300000, 300000,
];

/**
 * Wait until the project exists in the library, or give up.
 *
 * Call this BEFORE running the brain, not after. A transcript aimed at a job id
 * that does not exist — a typo, a stale extension entry, a project that was
 * deleted — would otherwise spend five Claude passes producing a perfectly good
 * analysis with nowhere to put it.
 *
 * In the normal flow this returns immediately: the video is prepared long before
 * the transcript exists, because YouTube takes twenty minutes to three hours to
 * caption. The waiting is for the abnormal case.
 */
async function waitForProject({ userId, jobId, onProgress }) {
  let record = await manualVideoLibraryService.getAnywhere(userId, jobId);
  for (let i = 0; !record && i < WAIT_SCHEDULE_MS.length; i++) {
    onProgress?.({ type: 'waiting-for-project', attempt: i + 1 });
    await sleep(WAIT_SCHEDULE_MS[i]);
    record = await manualVideoLibraryService.getAnywhere(userId, jobId);
  }
  return record || null;
}

/**
 * Write the brain's output onto the saved project, then read it back and check.
 *
 * Returns { ok, wrote, error }. `ok:false` means Mosh will open an editor that
 * is missing something — the caller must surface that, never swallow it.
 */
async function pushToLibrary({ userId, jobId, result, onProgress }) {
  // 1. The project should already be here — the caller waited for it before
  //    spending anything. Check again anyway; it could have been deleted during
  //    the twenty minutes the analysis took.
  const record = await waitForProject({ userId, jobId, onProgress });
  if (!record) {
    return { ok: false, wrote: [], error: 'The video is no longer in the library, so there was nowhere to put the hooks and cuts.' };
  }

  // 2. Write each piece, keeping only what actually reported success.
  const wrote = [];
  const problems = [];

  const attempt = async (name, fn, present) => {
    if (!present) return;
    try {
      const stored = await fn();
      if (stored === false) problems.push(`${name} did not save`);
      else wrote.push(name);
    } catch (err) {
      problems.push(`${name} failed: ${err.message}`);
    }
  };

  await attempt('hooks', () => manualVideoLibraryService.updateHooks(userId, jobId, result.hooks), result.hooks?.length);
  await attempt('cuts', () => manualVideoLibraryService.updateCuts(userId, jobId, result.cuts), result.cuts?.length);
  await attempt('socialPost', () => manualVideoLibraryService.updateSocialPost(userId, jobId, result.socialPost), !!result.socialPost);
  await attempt('report', () => manualVideoLibraryService.updateBrainReport(userId, jobId, result.brainReport), !!result.brainReport);

  // 3. Read it back. A write that returned true but stored nothing is exactly
  //    the bug this whole file is defending against, so trust the read, not the
  //    return value.
  const after = await manualVideoLibraryService.getAnywhere(userId, jobId);
  if (!after) {
    return { ok: false, wrote, error: 'The project vanished between saving and checking.' };
  }

  if (result.hooks?.length && (after.hooks || []).length !== result.hooks.length) {
    problems.push(`hooks read back as ${(after.hooks || []).length} of ${result.hooks.length}`);
  }
  if (result.cuts?.length && (after.cuts || []).length !== result.cuts.length) {
    problems.push(`cuts read back as ${(after.cuts || []).length} of ${result.cuts.length}`);
  }
  if (result.socialPost && !after.socialPost) {
    problems.push('the social post read back empty');
  }

  if (problems.length) {
    return { ok: false, wrote, error: problems.join('; ') };
  }

  onProgress?.({ type: 'pushed', wrote });
  return { ok: true, wrote, error: null };
}

/** Save the result, then push it. The save happens first, always. */
async function deliver({ userId, jobId, result, onProgress }) {
  await saveResult(jobId, result);
  return pushToLibrary({ userId, jobId, result, onProgress });
}

module.exports = { deliver, pushToLibrary, waitForProject, saveResult, loadResult };
