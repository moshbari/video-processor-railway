/**
 * 🎙️ PODCAST BRAIN
 *
 * Takes the timestamped transcript of one of Mosh's calls and produces the three
 * things he used to produce by hand in a claude.ai Project:
 *
 *   1. the hooks queue      (18-32 hooks, the best ten tagged as the cold open)
 *   2. the Danger Zone cuts (flow cuts + hard-close removal, merged)
 *   3. the Facebook post    (~3,000 Bengali words, CTA appended verbatim)
 *
 * plus a report holding everything else the passes found.
 *
 * THE PASS GRAPH
 *
 *   A (hooks) ──┐
 *   C (cuts)    ├─ start together, all they need is the transcript
 *   D (post) ───┘
 *        │
 *   B (cold open) waits on A — it picks its ten slots from A's table
 *   E (moment map) waits on D — it fact-checks D against the transcript
 *
 * Five passes instead of one because the original instruction asks for a 32-row
 * table AND 3,000 words of Bengali AND a cut list AND a moment map from an
 * hour-long transcript. We have measured that shape failing on another app: a
 * 23.7k-character prompt thought for six minutes and returned nothing.
 *
 * A pass that fails does not fail the run. Hooks without a cold open are still
 * worth having; cuts without a post are still worth having. Whatever survived is
 * pushed and the report says plainly what didn't.
 */

const { makeRunner, extractJson } = require('../docFactory/engine');
const usageService = require('../usageService');
const r2Service = require('../r2Service');

const shared = require('./prompts/shared');
const passA = require('./prompts/a-hooks');
const passB = require('./prompts/b-coldopen');
const passC = require('./prompts/c-cuts');
const passD = require('./prompts/d-post');
const passE = require('./prompts/e-momentmap');

const { buildHooks, buildCuts, buildSocialPost } = require('./assemble');
const { buildReport } = require('./report');

// Measured on a real 1h55m Bengali call (839 cues, 86k characters):
//
//   post   on opus    → finished in 251s
//   hooks  on sonnet  → still going at 600s, killed by the timeout
//   cuts   on sonnet  → still going at 600s, killed by the timeout
//
// So the first guesses here were wrong in both directions. The hooks pass is not
// the "cheap structural" job it looks like — it re-reads the whole call twice by
// instruction and emits 18-32 exact Bengali quotes with timestamps, which is
// comparable work to writing the post. Opus did the larger job in a fraction of
// the time sonnet needed for a smaller one, so everything runs on it.
const STRUCT_MODEL = process.env.PODCAST_BRAIN_MODEL || 'opus';
const POST_MODEL = process.env.PODCAST_BRAIN_POST_MODEL || 'opus';

// Bengali costs roughly 3-4x the tokens per character of English. An hour-long
// call is ~86k characters of it, and every pass reads all of them. Ten minutes
// was sized against a toy transcript; these are sized against a real episode,
// with room for one that runs long rather than a second wasted run.
const STRUCT_TIMEOUT_MS = Number(process.env.PODCAST_BRAIN_TIMEOUT_MS) || 25 * 60 * 1000;
const POST_TIMEOUT_MS = Number(process.env.PODCAST_BRAIN_POST_TIMEOUT_MS) || 30 * 60 * 1000;

/**
 * Save one pass's raw output to R2.
 *
 * Mosh's instructions end with "Save each pass as its own file — never overwrite
 * a previous version." Re-running an episode therefore adds files rather than
 * destroying the earlier read, so a good first attempt can't be lost to a worse
 * second one.
 */
async function savePass(jobId, index, label, text, stamp) {
  try {
    const key = `podcast-brain/${jobId}/${index}-${label}-${stamp}.md`;
    await r2Service.uploadBuffer(Buffer.from(String(text), 'utf-8'), key, 'text/markdown; charset=utf-8');
    return key;
  } catch (err) {
    console.error(`[PodcastBrain] Could not archive pass ${label}:`, err.message);
    return null;
  }
}

/**
 * Split pass D's delimited output. Plain delimiters rather than JSON because
 * 3,000 words of Bengali prose inside a JSON string is a parse failure waiting
 * to happen, and that failure would cost the most expensive pass in the run.
 */
function parsePost(text) {
  const str = String(text || '');
  const postMatch = str.match(/===POST===\s*([\s\S]*?)(?====VARIATIONS===|$)/);
  const varMatch = str.match(/===VARIATIONS===\s*([\s\S]*)$/);

  // If the model ignored the delimiters entirely, the whole reply is the post —
  // better to keep 3,000 usable words than to throw them away on a formatting slip.
  const body = postMatch ? postMatch[1].trim() : str.trim();
  return { body, variations: varMatch ? varMatch[1].trim() : '' };
}

/**
 * Run one pass. Never throws — returns { ok, data, error } so one bad pass can't
 * take the others down with it.
 */
async function runPass({ runner, build, args, index, jobId, stamp, json, timeoutMs, system, onProgress }) {
  const { prompt, label } = build(args);
  const started = Date.now();
  onProgress?.({ type: 'pass-start', pass: label });

  try {
    const text = await runner({ system, prompt, timeoutMs });
    await savePass(jobId, index, label, text, stamp);

    let data = text;
    if (json) {
      data = extractJson(text);
      if (!data) throw new Error('the model did not return readable JSON');
    }

    const seconds = Math.round((Date.now() - started) / 1000);
    onProgress?.({ type: 'pass-done', pass: label, seconds });
    return { ok: true, data, label };
  } catch (err) {
    const seconds = Math.round((Date.now() - started) / 1000);
    console.error(`[PodcastBrain] Pass ${label} failed after ${seconds}s:`, err.message);
    onProgress?.({ type: 'pass-failed', pass: label, seconds, error: err.message });
    return { ok: false, error: err.message, label };
  }
}

/**
 * Run the whole brain.
 *
 * @param {object} p
 * @param {string} p.transcript      timestamped transcript, one cue per line
 * @param {boolean} p.hasSpeakers    true when the transcript carries [Speaker A] prefixes
 * @param {number} p.videoDuration   seconds, used to clamp every range
 * @param {string} [p.videoTitle]
 * @param {string} p.jobId
 * @param {string} [p.userId]
 * @param {string} [p.oauthToken]    Claude subscription token (preferred)
 * @param {string} [p.apiKey]        ANTHROPIC_API_KEY fallback
 * @param {function} [p.onProgress]
 * @returns {Promise<{hooks, cuts, socialPost, brainReport, failures}>}
 */
async function runBrain({
  transcript, hasSpeakers, videoDuration, videoTitle, jobId, userId,
  oauthToken, apiKey, onProgress,
}) {
  if (!transcript || !String(transcript).trim()) {
    throw new Error('No transcript to work from.');
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const system = shared.systemFor({ hasSpeakers: !!hasSpeakers });

  const usageFor = (fallbackModel) => (u) => {
    usageService.record({
      userId,
      feature: 'podcast-brain',
      provider: 'anthropic',
      model: u.model || fallbackModel,
      tokens: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheCreate: u.cacheCreate },
      costUsd: typeof u.costUsd === 'number' ? u.costUsd : undefined,
      meta: { jobId },
    });
  };

  // makeRunner fixes the model when the runner is built, not per call — so the
  // post needs its own runner. Passing a model per call would silently run the
  // 3,000-word Bengali post on the fast structural model.
  const structRunner = makeRunner({
    oauthToken, apiKey, subModel: STRUCT_MODEL,
    apiModel: process.env.PODCAST_BRAIN_API_MODEL,
    emit: null, onUsage: usageFor(STRUCT_MODEL),
  });
  const postRunner = makeRunner({
    oauthToken, apiKey, subModel: POST_MODEL,
    apiModel: process.env.PODCAST_BRAIN_POST_API_MODEL || process.env.PODCAST_BRAIN_API_MODEL,
    emit: null, onUsage: usageFor(POST_MODEL),
  });

  const common = { runner: structRunner, jobId, stamp, system, onProgress };

  onProgress?.({ type: 'start', passes: ['hooks', 'cuts', 'post', 'coldopen', 'momentmap'] });

  // --- Wave 1: everything that only needs the transcript ---------------------
  // Chained onto their dependants immediately so the cold open starts the moment
  // hooks land, rather than waiting for the slowest of the three.
  const hooksChain = runPass({
    ...common, build: passA.build, args: { transcript },
    index: 1, json: true, timeoutMs: STRUCT_TIMEOUT_MS,
  }).then(async (hooksResult) => {
    if (!hooksResult.ok) return { hooksResult, coldOpenResult: { ok: false, error: 'skipped — the hooks pass failed', label: 'coldopen' } };
    const coldOpenResult = await runPass({
      ...common, build: passB.build,
      args: { transcript, hooksJson: JSON.stringify(hooksResult.data, null, 2) },
      index: 2, json: true, timeoutMs: STRUCT_TIMEOUT_MS,
    });
    return { hooksResult, coldOpenResult };
  });

  const cutsChain = runPass({
    ...common, build: passC.build, args: { transcript },
    index: 3, json: true, timeoutMs: STRUCT_TIMEOUT_MS,
  });

  const postChain = runPass({
    ...common, runner: postRunner, build: passD.build, args: { transcript },
    index: 4, json: false, timeoutMs: POST_TIMEOUT_MS,
  }).then(async (postResult) => {
    if (!postResult.ok) return { postResult, momentMapResult: { ok: false, error: 'skipped — the post pass failed', label: 'momentmap' }, parsed: null };
    const parsed = parsePost(postResult.data);
    const momentMapResult = await runPass({
      ...common, build: passE.build, args: { transcript, post: parsed.body },
      index: 5, json: true, timeoutMs: STRUCT_TIMEOUT_MS,
    });
    return { postResult, momentMapResult, parsed };
  });

  const [hooksSide, cutsResult, postSide] = await Promise.all([hooksChain, cutsChain, postChain]);

  // --- Assemble -------------------------------------------------------------
  const hooksPass = hooksSide.hooksResult.ok ? hooksSide.hooksResult.data : null;
  const coldOpenPass = hooksSide.coldOpenResult.ok ? hooksSide.coldOpenResult.data : null;
  const cutsPass = cutsResult.ok ? cutsResult.data : null;
  const parsed = postSide.parsed;
  const momentMap = postSide.momentMapResult.ok ? postSide.momentMapResult.data : null;

  const hooks = buildHooks({ hooksPass, coldOpenPass, videoDuration });
  const { cuts, adjustments } = buildCuts({ cutsPass, hooks, videoDuration });
  const socialPost = parsed ? buildSocialPost({ postBody: parsed.body, ctaBlock: shared.CTA_BLOCK }) : '';

  const failures = [
    hooksSide.hooksResult, hooksSide.coldOpenResult, cutsResult,
    postSide.postResult, postSide.momentMapResult,
  ].filter(r => r && !r.ok).map(r => ({ pass: r.label, error: r.error }));

  const brainReport = buildReport({
    hooksPass, hooks, coldOpenPass, cutsPass, cuts, adjustments,
    momentMap, variations: parsed?.variations, failures, videoTitle,
  });

  await savePass(jobId, 9, 'report', brainReport, stamp);

  onProgress?.({
    type: 'assembled',
    hooks: hooks.length,
    cuts: cuts.length,
    socialPostWords: socialPost ? socialPost.split(/\s+/).length : 0,
    failures: failures.length,
  });

  // Strip the fields that only the report needed.
  const cleanHooks = hooks.map(({ _n, _coldOpenSlot, ...h }) => h);

  return { hooks: cleanHooks, cuts, socialPost, brainReport, failures };
}

module.exports = { runBrain, parsePost };
