/**
 * 📊 Progress tracking for a Podcast Brain run.
 *
 * A run takes five Claude passes and can stretch past twenty minutes, so the
 * editor needs to be able to ask "how far along is it" without holding a request
 * open. This is the cursor-paged event log pattern already used by Pro-Rant and
 * Doc Factory (GET /render/:id?after=N): the client remembers how many events it
 * has seen and asks for the rest.
 *
 * Deliberately in memory. The valuable output is written to R2 the moment it
 * exists (see push.js), so a redeploy losing this log costs a progress bar, not
 * a twenty-minute run.
 */

const JOBS = new Map();
const TTL_MS = 6 * 60 * 60 * 1000; // keep finished runs readable for six hours

function start(jobId) {
  JOBS.set(jobId, {
    jobId,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    events: [{ ts: Date.now(), type: 'queued', message: 'Reading the transcript…' }],
    result: null,
    error: null,
  });
  return JOBS.get(jobId);
}

/** Human-readable line for each machine event the brain emits. */
function describe(evt) {
  switch (evt.type) {
    case 'start': return 'Starting the passes…';
    case 'pass-start': return `Working on: ${evt.pass}`;
    case 'pass-done': return `Finished ${evt.pass} (${evt.seconds}s)`;
    case 'pass-failed': return `${evt.pass} failed after ${evt.seconds}s — ${evt.error}`;
    case 'assembled': return `Assembled ${evt.hooks} hooks and ${evt.cuts} cuts`;
    case 'waiting-for-project': return `Waiting for the video to finish preparing (try ${evt.attempt})…`;
    case 'pushed': return `Saved to the editor: ${(evt.wrote || []).join(', ')}`;
    default: return evt.type;
  }
}

function emit(jobId, evt) {
  const job = JOBS.get(jobId);
  if (!job) return;
  job.events.push({ ts: Date.now(), message: describe(evt), ...evt });
}

function finish(jobId, { result, error }) {
  const job = JOBS.get(jobId);
  if (!job) return;
  job.status = error ? 'error' : 'complete';
  job.error = error || null;
  job.result = result || null;
  job.finishedAt = Date.now();
  setTimeout(() => JOBS.delete(jobId), TTL_MS).unref?.();
}

/** Read progress from a cursor. `after` is the number of events already seen. */
function read(jobId, after = 0) {
  const job = JOBS.get(jobId);
  if (!job) return null;
  const from = Math.max(0, Number(after) || 0);
  return {
    status: job.status,
    error: job.error,
    events: job.events.slice(from),
    nextCursor: job.events.length,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    result: job.status === 'complete' ? job.result : null,
  };
}

function isRunning(jobId) {
  return JOBS.get(jobId)?.status === 'running';
}

module.exports = { start, emit, finish, read, isRunning };
