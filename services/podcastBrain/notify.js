/**
 * 📣 Telling somebody the episode is finished.
 *
 * Until now the only way to learn that an episode was done was to ask — the
 * upload page polled, and only while its tab was awake. So a run that finished
 * while Mosh was away from the screen told nobody, and he came back to a page
 * still showing "analysing…" from a quarter of an hour earlier.
 *
 * This is the other direction: when a run ends, we go and say so. Whoever is
 * listening (today the tellatotube upload page; tomorrow an email or a Telegram
 * message) gets one POST with everything needed to write a sentence a person
 * can read.
 *
 * TWO RULES THIS FILE OBEYS:
 *
 * 1. It never throws. A notification is the least important thing that happens
 *    at the end of a run — the hooks are already saved. Failing to announce
 *    must never turn a finished episode into a failed one.
 *
 * 2. It announces failures too. "It broke" is more useful than silence, and
 *    silence is exactly what made the original bug invisible for two days.
 */

const WEBHOOK_URL = process.env.PODCAST_DONE_WEBHOOK || '';
const WEBHOOK_SECRET = process.env.PODCAST_WEBHOOK_SECRET || '';
const TIMEOUT_MS = 10000;

/**
 * Announce the end of a run, however it ended.
 *
 * @param {object} p
 * @param {string} p.jobId
 * @param {string} [p.userId]
 * @param {string} [p.title]
 * @param {object} [p.result]  { hooks, cuts, hasSocialPost } when it worked
 * @param {string} [p.error]   why it didn't, when it didn't
 */
async function episodeFinished({ jobId, userId, title, result, error }) {
  if (!WEBHOOK_URL) return false;   // nobody is listening; that's a fine state to be in

  const payload = {
    jobId,
    userId: userId || null,
    title: title || '',
    ok: !error,
    error: error || null,
    hooks: result?.hooks ?? 0,
    cuts: result?.cuts ?? 0,
    hasSocialPost: !!result?.hasSocialPost,
    finishedAt: new Date().toISOString(),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(WEBHOOK_SECRET ? { 'x-podcast-secret': WEBHOOK_SECRET } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[PodcastBrain] Notify returned HTTP ${res.status} for ${jobId}`);
      return false;
    }
    console.log(`[PodcastBrain] Announced ${jobId} (${payload.ok ? 'done' : 'failed'})`);
    return true;
  } catch (err) {
    // Deliberately swallowed. See rule 1 above.
    console.error(`[PodcastBrain] Could not announce ${jobId}:`, err.message);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { episodeFinished };
