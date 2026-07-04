/**
 * 📊 AI USAGE LEDGER — who is using how much AI, and what it costs.
 *
 * Two features in devrant call real AI and cost money:
 *   • "doc-factory" — Claude passes (subscription CLI or API fallback)
 *   • "audio-rant"  — AI voiceovers (OpenAI / ElevenLabs text-to-voice)
 *
 * Nothing was ever tracked. This service records ONE row per AI job, keyed by
 * the Supabase user (the X-User-Id header the frontend already sends), so an
 * admin can see per-user spend. It mirrors the R2-per-user pattern used by
 * docFactory/library.js so it survives Railway restarts.
 *
 *   ai-usage/users/{userId}.json  — per-user totals + recent events
 *   ai-usage/index.json           — light per-user summary for the dashboard
 *
 * "AI credit" here means an estimated US-dollar cost. For Claude subscription
 * runs the `claude` CLI reports total_cost_usd (the API-equivalent price of that
 * run) which we store verbatim; otherwise we estimate from tokens/characters
 * using the rate table below. It is an ESTIMATE for visibility, not a bill.
 */

const r2Service = require('./r2Service');

const INDEX_KEY = 'ai-usage/index.json';
const userKey = (uid) => `ai-usage/users/${uid}.json`;

// How many recent events to keep inline per user (full history is not needed
// for a spend dashboard; the running totals are always exact).
const MAX_EVENTS = 300;

// ---------------------------------------------------------------------------
// Cost estimation (USD). Public list prices, per 1,000,000 units.
// Claude token prices are used ONLY to estimate the credit-equivalent of a
// subscription run when the CLI doesn't report total_cost_usd. Override any of
// these with env vars if prices change.
// ---------------------------------------------------------------------------
const num = (v, d) => (v != null && !isNaN(parseFloat(v)) ? parseFloat(v) : d);

// $/1M tokens: [input, output]. Cache reads are billed at ~0.1x input.
const CLAUDE_RATES = {
  opus:   [num(process.env.RATE_OPUS_IN, 5),   num(process.env.RATE_OPUS_OUT, 25)],   // claude-opus-4-8
  sonnet: [num(process.env.RATE_SONNET_IN, 3), num(process.env.RATE_SONNET_OUT, 15)], // claude-sonnet-5
  haiku:  [num(process.env.RATE_HAIKU_IN, 1),  num(process.env.RATE_HAIKU_OUT, 5)],   // claude-haiku-4-5
};

// $/1M characters of text turned into speech.
const TTS_RATES = {
  openai:     num(process.env.RATE_TTS_OPENAI, 15),      // OpenAI tts-1
  elevenlabs: num(process.env.RATE_TTS_ELEVENLABS, 180), // ~$0.18 / 1k chars (plan-dependent estimate)
};

function claudeTier(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('opus')) return 'opus';
  if (m.includes('haiku')) return 'haiku';
  return 'sonnet'; // default (doc-factory subscription runs use sonnet)
}

function round(n) { return Math.round((n + Number.EPSILON) * 1e6) / 1e6; }

function estimateCost({ provider, model, tokens, characters }) {
  const p = String(provider || '').toLowerCase();
  if (p === 'openai' || p === 'elevenlabs' || p === '11labs') {
    const rate = TTS_RATES[p === '11labs' ? 'elevenlabs' : p] || 0;
    return round(((characters || 0) / 1e6) * rate);
  }
  // Claude / anthropic token cost
  const [inRate, outRate] = CLAUDE_RATES[claudeTier(model)];
  const t = tokens || {};
  const inputCost  = ((t.input || 0) / 1e6) * inRate;
  const cacheCost  = ((t.cacheRead || 0) / 1e6) * inRate * 0.1
                   + ((t.cacheCreate || 0) / 1e6) * inRate * 1.25;
  const outputCost = ((t.output || 0) / 1e6) * outRate;
  return round(inputCost + cacheCost + outputCost);
}

// ---------------------------------------------------------------------------
// Storage helpers (in-memory cache + serialized writes per key, single instance)
// ---------------------------------------------------------------------------
const cache = new Map();          // key -> parsed object
const chains = new Map();         // key -> tail promise (serializes writes)

function withLock(key, fn) {
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  chains.set(key, next.then(() => {}, () => {}));
  return next;
}

async function loadJson(key, fallback) {
  if (cache.has(key)) return cache.get(key);
  let data = fallback;
  if (r2Service.isConfigured && r2Service.isConfigured()) {
    const buf = await r2Service.getFile(key).catch(() => null);
    if (buf) {
      try {
        const parsed = JSON.parse(buf.toString('utf8'));
        if (parsed && typeof parsed === 'object') data = parsed;
      } catch (_) { /* corrupt -> start fresh */ }
    }
  }
  cache.set(key, data);
  return data;
}

async function saveJson(key, data) {
  cache.set(key, data);
  if (r2Service.isConfigured && r2Service.isConfigured()) {
    await r2Service.uploadBuffer(Buffer.from(JSON.stringify(data)), key, 'application/json');
  }
  return data;
}

function emptyBucket() {
  return { runs: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, characters: 0, lastSeen: null };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record one AI job. Never throws — logging must not break a user's render.
 *
 * @param {object} p
 * @param {string} p.userId    Supabase user id (X-User-Id). Falls back to 'anonymous'.
 * @param {string} [p.email]   optional friendly label (X-User-Email)
 * @param {string} p.feature   'doc-factory' | 'audio-rant'
 * @param {string} [p.provider] 'anthropic' | 'openai' | 'elevenlabs'
 * @param {string} [p.model]   model id / name
 * @param {object} [p.tokens]  { input, output, cacheRead, cacheCreate }
 * @param {number} [p.characters] characters of TTS
 * @param {number} [p.costUsd] known cost (e.g. CLI total_cost_usd); else estimated
 * @param {object} [p.meta]    small extra info (jobId, provider counts, etc.)
 */
async function record(p) {
  try {
    const uid = p.userId || 'anonymous';
    const feature = p.feature || 'unknown';
    const tokens = p.tokens || {};
    const characters = p.characters || 0;
    const cost = (typeof p.costUsd === 'number' && p.costUsd >= 0)
      ? round(p.costUsd)
      : estimateCost({ provider: p.provider, model: p.model, tokens, characters });

    const evt = {
      ts: Date.now(),
      feature,
      provider: p.provider || null,
      model: p.model || null,
      inputTokens: tokens.input || 0,
      outputTokens: tokens.output || 0,
      cacheReadTokens: tokens.cacheRead || 0,
      cacheCreateTokens: tokens.cacheCreate || 0,
      characters,
      costUsd: cost,
      meta: p.meta || null,
    };

    await withLock(userKey(uid), async () => {
      const u = await loadJson(userKey(uid), {
        userId: uid, email: p.email || null, totals: emptyBucket(), byFeature: {}, events: [],
      });
      if (p.email) u.email = p.email;
      u.totals = u.totals || emptyBucket();
      u.byFeature[feature] = u.byFeature[feature] || emptyBucket();
      for (const bucket of [u.totals, u.byFeature[feature]]) {
        bucket.runs += 1;
        bucket.costUsd = round(bucket.costUsd + cost);
        bucket.inputTokens += evt.inputTokens + evt.cacheReadTokens + evt.cacheCreateTokens;
        bucket.outputTokens += evt.outputTokens;
        bucket.characters += characters;
        bucket.lastSeen = evt.ts;
      }
      u.events = [evt, ...(u.events || [])].slice(0, MAX_EVENTS);
      await saveJson(userKey(uid), u);
    });

    await withLock(INDEX_KEY, async () => {
      const idx = await loadJson(INDEX_KEY, { users: {}, updatedAt: null });
      idx.users = idx.users || {};
      const row = idx.users[uid] || {
        userId: uid, email: p.email || null, costUsd: 0, runs: 0, byFeature: {}, lastSeen: null,
      };
      if (p.email) row.email = p.email;
      row.costUsd = round(row.costUsd + cost);
      row.runs += 1;
      row.lastSeen = evt.ts;
      row.byFeature[feature] = row.byFeature[feature] || { runs: 0, costUsd: 0 };
      row.byFeature[feature].runs += 1;
      row.byFeature[feature].costUsd = round(row.byFeature[feature].costUsd + cost);
      idx.users[uid] = row;
      idx.updatedAt = evt.ts;
      await saveJson(INDEX_KEY, idx);
    });

    return evt;
  } catch (err) {
    console.error('[usageService] record failed (non-fatal):', err.message);
    return null;
  }
}

// Full dashboard report: every user, sorted by spend, plus grand totals.
async function getReport() {
  const idx = await loadJson(INDEX_KEY, { users: {}, updatedAt: null });
  const users = Object.values(idx.users || {})
    .sort((a, b) => (b.costUsd || 0) - (a.costUsd || 0));
  const totals = users.reduce((acc, u) => {
    acc.users += 1;
    acc.runs += u.runs || 0;
    acc.costUsd = round(acc.costUsd + (u.costUsd || 0));
    for (const [f, v] of Object.entries(u.byFeature || {})) {
      acc.byFeature[f] = acc.byFeature[f] || { runs: 0, costUsd: 0 };
      acc.byFeature[f].runs += v.runs || 0;
      acc.byFeature[f].costUsd = round(acc.byFeature[f].costUsd + (v.costUsd || 0));
    }
    return acc;
  }, { users: 0, runs: 0, costUsd: 0, byFeature: {} });
  return { updatedAt: idx.updatedAt, totals, users };
}

// One user's detail (recent events + per-feature totals).
async function getUser(uid) {
  return loadJson(userKey(uid), { userId: uid, email: null, totals: emptyBucket(), byFeature: {}, events: [] });
}

module.exports = { record, getReport, getUser, estimateCost };
