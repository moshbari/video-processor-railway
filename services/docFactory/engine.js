/**
 * 🎬 DOC FACTORY — the "brain" (RANT Squad)
 *
 * Turns ONE keyword/idea into a finished faceless DOODLE documentary plan:
 * a curiosity-gap title, a sourced fact bank, and a full panel-by-panel
 * script — each panel = one short line of narration + a doodle illustration
 * prompt (or a bold text-card) + background. Downstream services turn that
 * into images + voiceover + an assembled MP4.
 *
 * Same family as Book Factory / Pain Finder / The Closer's Council: it runs
 * on the user's CLAUDE SUBSCRIPTION (the `claude` CLI via setup-token), with a
 * server ANTHROPIC_API_KEY fallback. Ported to CommonJS for this backend.
 *
 * The agents (each a real Claude pass, streamed live):
 *   The Scout         — finds the angle + the highest-tension title.
 *   The Researcher    — builds a fact bank (WebSearch), fact vs. speculation.
 *   The Architect     — structures the story into ordered beats (acts).
 *   The Narrator      — writes the immersive narration, act by act.
 *   The Cinematographer — turns each line into a doodle prompt + on-screen text.
 *   The Critic        — sanity-checks the title + opening, ships the final.
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

// The `claude` CLI ships with @anthropic-ai/claude-code (a dependency).
const CLAUDE_BIN = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'claude');

// The single doodle look every panel must share, so ~160 panels feel like ONE
// hand. Reused by the image step too (manual prompt sheet + API generation).
const STYLE_BIBLE =
  'Hand-drawn cartoon DOODLE in the style of a simple explainer video: thick ' +
  'black marker outlines, flat bright color fills (no gradients, no shading, no ' +
  'photorealism), childlike clarity, one clear subject, lots of empty space. ' +
  'Stick-figure people. Plain flat background.';

function sanitizeClaudeToken(token) {
  return String(token || '').replace(/\s+/g, '');
}

// The look every panel shares. In SEMI-AUTOMATIC mode the creator may add a
// style nudge (e.g. "watercolor", "neon", "2D South-Park style"); we append it
// to the fixed bible so the whole video still feels like one hand.
function effectiveStyle(styleOverride) {
  const ov = String(styleOverride || '').trim();
  return ov ? `${STYLE_BIBLE} ADDITIONAL STYLE DIRECTION FROM THE CREATOR (apply to every panel): ${ov}` : STYLE_BIBLE;
}

// SEMI-AUTOMATIC creator directives, folded into the writing prompts so the
// script obeys them. Hook/CTA are ALSO injected deterministically after writing
// (see injectHookCta) so they land word-for-word even if the model paraphrases.
function directivesBlock({ hook, cta, directives } = {}) {
  const parts = [];
  if (hook && String(hook).trim()) parts.push(`- OPEN the video with THIS EXACT hook line, word for word, as the very first narration panel: "${String(hook).trim()}"`);
  if (cta && String(cta).trim()) parts.push(`- The closing call-to-action is FIXED and is added automatically as the final panel. Do NOT write your own CTA, pitch, sign-off, or "DM me / link in bio" lines, and do NOT repeat, split, or paraphrase the CTA anywhere in the script. Simply end on the story's natural payoff — the CTA follows on its own.`);
  if (directives && String(directives).trim()) parts.push(`- Also follow these instructions from the creator: ${String(directives).trim()}`);
  if (!parts.length) return '';
  return `\n\nCREATOR DIRECTIVES (these are mandatory — follow them exactly, they override the defaults):\n${parts.join('\n')}`;
}

// Strip the style-bible prefix we bake onto every doodlePrompt, leaving just the
// human "scene" the creator sees + edits in the manual image-prompt review.
function rawScene(doodlePrompt) {
  const s = String(doodlePrompt || '');
  const i = s.indexOf('Scene:');
  return (i >= 0 ? s.slice(i + 'Scene:'.length) : s).trim();
}

// Build ONE normalized panel object the same way everywhere (main pipeline,
// hook/CTA injection, and the manual revisers) so every panel has the same shape.
function buildPanel({ narration, panelType, doodlePrompt, callout, bg }, styleBible, n, beat) {
  const pt = panelType === 'text-card' ? 'text-card' : 'illustration';
  const b = ['white', 'night', 'parchment'].includes(bg) ? bg : 'white';
  const narr = String(narration || '').trim();
  return {
    n,
    beat: beat || 1,
    narration: narr,
    panelType: pt,
    // EVERY panel gets a doodle — the bold callout is overlaid on it later.
    doodlePrompt: `${styleBible} Scene: ${rawScene(doodlePrompt) || narr}`,
    callout: String(callout || '').trim(),
    bg: b,
    bgHex: bgHex(b),
    image: null,
  };
}

function renumber(panels) {
  panels.forEach((p, i) => { p.n = i + 1; });
  return panels;
}

// Deterministically guarantee the word-for-word hook/CTA the SEMI creator asked
// for. If the writer already opened/closed with it (case-insensitive contains),
// we leave it; otherwise we prepend/append a clean panel so it lands exactly.
function injectHookCta(panels, { hook, cta }, styleBible) {
  const h = String(hook || '').trim();
  const c = String(cta || '').trim();
  if (h) {
    const first = panels[0];
    const has = first && first.narration.toLowerCase().includes(h.toLowerCase());
    if (!has) panels.unshift(buildPanel({ narration: h, panelType: 'illustration', doodlePrompt: h, bg: panels[0] ? panels[0].bg : 'white' }, styleBible, 1, 1));
  }
  if (c) {
    // The CTA belongs exactly once, at the very end. The writer sometimes still
    // sprinkles the pitch across several panels (or repeats it), so first strip
    // ANY panel that is just a fragment or echo of the CTA, then append it clean.
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const nc = norm(c);
    for (let i = panels.length - 1; i >= 0; i--) {
      const np = norm(panels[i].narration);
      if (np.length >= 6 && (nc.includes(np) || np.includes(nc))) panels.splice(i, 1);
    }
    const last = panels[panels.length - 1];
    panels.push(buildPanel({ narration: c, panelType: 'illustration', doodlePrompt: c, bg: last ? last.bg : 'white' }, styleBible, panels.length + 1, last ? last.beat : 1));
  }
  return renumber(panels);
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const MISSION = `THE BIG PICTURE — read this first.

You are the production team for a FACELESS YouTube documentary channel in the
"animated doodle explainer" genre — the kind of video that asks an irresistible
question ("What Did Ancient Humans Do at Night?") and answers it with calm,
immersive narration over simple hand-drawn doodles. One of these just did 7.5M
views in two months. Your job is to manufacture another one from a single idea.

WHAT MAKES THE FORMAT WORK (obey all of it):
- THE TITLE is everything: a curiosity gap you cannot not click. A simple,
  concrete question or promise about something familiar made strange.
- THE NARRATION is calm, warm and IMMERSIVE. Present tense, often second person
  ("Imagine you are lying in the dark, the fire dying down..."). It puts the
  viewer INSIDE the scene. Short, plain sentences. It teases forward constantly
  ("but the real reason is stranger than that...").
- IT IS HONEST. Mix established facts with clearly-framed informed speculation
  ("we can't know for sure, but the bones suggest..."). Never invent fake facts.
- THE VISUALS are dead simple doodles, ONE idea per panel, changing every few
  seconds. EVERY panel has a doodle — even the ones that land a key word or
  number. For those, the bold word/number is laid OVER the doodle as on-screen
  text; it is NEVER bare text on an empty card. There is always a drawing behind
  it, because a picture holds the viewer far better than a word alone.
- Pace: a new panel roughly every 3 seconds. A 1-minute video is ~18 panels.`;

const BLUEPRINT_SHAPE = `{
  "title": "the ONE winning title — a curiosity-gap question/promise, concrete and simple, ideally 4-9 words. No clickbait lies.",
  "alt_titles": ["3-4 strong alternates in the same vein"],
  "angle": "1-2 sentences: the specific angle/hook this video takes and the promise it keeps.",
  "target_minutes": 1,
  "tone": "one line describing the narration voice for this specific topic.",
  "thumbnail_idea": "1 sentence: a simple doodle + 2-4 bold words that would make a high-CTR thumbnail.",
  "fact_bank": [
    { "claim": "a specific, usable fact or vivid detail about the topic", "type": "fact", "source": "where it comes from (study/era/site/url) or 'general knowledge'" },
    { "claim": "an informed but uncertain detail worth dramatizing", "type": "speculation", "source": "the basis for the educated guess" }
  ],
  "beats": [
    { "n": 1, "beat": "one line: what happens in this section of the story", "purpose": "hook | context | escalation | vivid-scene | reveal | payoff | close" }
  ]
}`;

const BLUEPRINT_SYSTEM = `You are THE SCOUT, THE RESEARCHER and THE ARCHITECT of Doc Factory, working together to turn a single idea into the blueprint for one faceless doodle documentary.

${MISSION}

YOUR JOB IN THIS PASS:
- THE SCOUT: take the user's idea/keyword and find the most curiosity-driving ANGLE. Write the highest-tension TITLE (plus alternates). This is a SHORT ~1-minute video — keep the promise tight and immediately payable.
- THE RESEARCHER: use WebSearch to gather real substance. Build a FACT BANK of specific facts and vivid details, each tagged "fact" or "speculation" with its source. 8-16 entries. Never fabricate; if uncertain, mark it speculation.
- THE ARCHITECT: lay out the STORY as an ordered list of BEATS (sections/acts) — a strong hook, rising curiosity, a vivid scene, a real reveal, a satisfying close. Use roughly 2 beats per minute of target length (e.g. ~2-3 beats for a 1-minute video). Each beat is one line + its narrative purpose. The beats will later be expanded into the full narration. Keep it tight — this is a ~1-minute video, so no filler.

Output ONLY a JSON object wrapped in <json></json> tags, no other prose, of this shape:
<json>
${BLUEPRINT_SHAPE}
</json>`;

const PANELS_SHAPE = `{
  "panels": [
    {
      "narration": "ONE short spoken line for this panel — ~6-14 words, calm/immersive/present-tense, flows naturally from the previous line. This is what the voiceover says while this panel is on screen.",
      "panelType": "illustration | text-card  (text-card = an EMPHASIS panel — it still has a doodle, it just also carries a big bold word/number)",
      "doodlePrompt": "ALWAYS REQUIRED, for every panel: a short description of ONE simple doodle scene that matches the line (subject + action + setting). For an emphasis panel, draw a doodle that visually represents the key word/number too — never leave this empty.",
      "callout": "bold on-screen text laid OVER the doodle (a word, number, or 2-4 words) — REQUIRED for 'text-card' emphasis panels, optional short label otherwise; empty string if none.",
      "bg": "white | night | parchment"
    }
  ]
}`;

function panelsSystem(styleBible = STYLE_BIBLE) {
  return `You are THE NARRATOR and THE CINEMATOGRAPHER of Doc Factory. You receive ONE beat of an already-structured documentary and you expand JUST THAT BEAT into a sequence of panels.

${MISSION}

THE DOODLE STYLE BIBLE (every illustration shares this — describe only the subject, the look is fixed):
${styleBible}

YOUR JOB IN THIS PASS:
- THE NARRATOR: write the voiceover for this beat as a flowing sequence of SHORT lines (~6-14 words each). Calm, immersive, present-tense, plain words. It must connect smoothly to the previous beat (you are given the last line) and tease forward. Cover the beat fully but do not drift into other beats.
- THE CINEMATOGRAPHER: split the narration so EACH line is ONE panel (~3 seconds on screen). EVERY panel gets a doodlePrompt — a one-subject doodle that literally shows the line. Then for each panel decide:
   • a plain "illustration" — just the doodle, no big text (callout empty or a tiny label), OR
   • a "text-card" emphasis panel when the line lands a key word, number, or phrase — STILL give it a doodlePrompt (a doodle that pictures that idea) AND set the bold "callout" that will sit on top of the doodle.
  NEVER produce a panel with an empty doodlePrompt. Use a sensible mix of emphasis vs plain panels. Choose bg (white default; night for dark/nighttime scenes; parchment for ancient/historical framing).

Aim for roughly 6-12 panels for this beat (more for big beats). Output ONLY a JSON object wrapped in <json></json> tags, no other prose, of this shape:
<json>
${PANELS_SHAPE}
</json>`;
}

const CRITIC_SYSTEM = `You are THE CRITIC of Doc Factory — the final gate before production.

${MISSION}

You receive a finished blueprint (title + opening panels). Attack it: Is the TITLE truly a click-worthy curiosity gap, concrete and honest (not vague, not a lie)? Does the OPENING narration hook in the first two lines and pull the viewer in? Is the voice calm, immersive and present-tense? Fix what's weak.

Output ONLY a JSON object wrapped in <json></json> tags of this shape (improve the values; keep the same keys):
<json>
{ "title": "the final, sharpest title", "alt_titles": ["..."], "thumbnail_idea": "the final thumbnail idea", "opening_ok": true, "notes": "1-2 sentences on what you changed or confirmed." }
</json>`;

// ---------------------------------------------------------------------------
// JSON extraction
// ---------------------------------------------------------------------------

function extractJson(text) {
  let raw = null;
  const tagged = String(text).match(/<json>([\s\S]*?)<\/json>/i);
  if (tagged) raw = tagged[1].trim();
  if (!raw) {
    const first = String(text).indexOf('{');
    const last = String(text).lastIndexOf('}');
    if (first !== -1 && last !== -1 && last > first) raw = String(text).slice(first, last + 1);
  }
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ---------------------------------------------------------------------------
// One `claude` CLI pass (subscription) in stream-json mode, surfacing activity
// ---------------------------------------------------------------------------

function runClaudePass({ token, model, prompt, withTools, onActivity, onUsage, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    const tok = sanitizeClaudeToken(token);
    if (tok) {
      // Server subscription mode: isolate the token from any ~/.claude on the box.
      env.CLAUDE_CODE_OAUTH_TOKEN = tok;
      env.HOME = os.tmpdir();
      delete env.ANTHROPIC_API_KEY;
    }
    // No token => inherit the environment and use the machine's logged-in `claude`
    // (local dev / testing only; gated by DOC_FACTORY_LOCAL_AUTH in makeRunner).
    const args = ['-p', '--model', model || 'sonnet', '--output-format', 'stream-json', '--verbose'];
    if (withTools) args.push('--allowedTools', 'WebSearch,WebFetch');
    let child, buf = '', finalText = '', asstText = '', lastErr = '', settled = false, usage = null;
    const finish = (fn, v) => {
      if (settled) return; settled = true; clearTimeout(timer);
      try { child && child.kill('SIGKILL'); } catch (_) {}
      fn(v);
    };
    const timer = setTimeout(
      () => finish(reject, new Error('Doc Factory hit the safety time limit and was stopped. Please run it again.')),
      timeoutMs || 9 * 60 * 1000
    );
    try { child = spawn(CLAUDE_BIN, args, { env, cwd: os.tmpdir() }); }
    catch (_) { return finish(reject, new Error("Couldn't run the Claude CLI on the server.")); }

    const handleEvent = (ev) => {
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
        for (const block of ev.message.content) {
          if (block.type === 'tool_use') {
            const n = (block.name || '').toLowerCase();
            const q = (block.input && (block.input.query || block.input.url)) || '';
            if (n.includes('websearch')) onActivity && onActivity({ icon: '🔍', text: `Researching: ${q || 'the topic'}` });
            else if (n.includes('webfetch')) onActivity && onActivity({ icon: '📄', text: `Reading: ${q || 'a source'}` });
            else if (n) onActivity && onActivity({ icon: '⚙️', text: `Using ${block.name}` });
          } else if (block.type === 'text' && typeof block.text === 'string') {
            asstText += block.text + '\n';
          }
        }
      } else if (ev.type === 'result') {
        if (typeof ev.result === 'string') finalText = ev.result;
        // The CLI's final result event carries token usage + the API-equivalent
        // dollar cost of this pass — the "AI credit" figure we want to track.
        const u = ev.usage || {};
        usage = {
          input: u.input_tokens || 0,
          output: u.output_tokens || 0,
          cacheRead: u.cache_read_input_tokens || 0,
          cacheCreate: u.cache_creation_input_tokens || 0,
          costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
          model,
        };
      }
    };

    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        try { handleEvent(JSON.parse(line)); } catch (_) {}
      }
    });
    child.stderr.on('data', (d) => (lastErr += d.toString()));
    child.on('error', (e) => finish(reject, new Error(
      e.code === 'ENOENT' ? "The Claude CLI isn't installed on the server." : e.message
    )));
    child.on('close', () => {
      const out = finalText || asstText;
      const blob = (out + ' ' + lastErr).toLowerCase();
      if (/invalid bearer token|failed to authenticate|unauthorized|\b401\b/.test(blob) && !out.includes('<json>')) {
        return finish(reject, new Error('Your Claude subscription token was rejected. Re-run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN.'));
      }
      if (usage && onUsage) { try { onUsage(usage); } catch (_) {} }
      finish(resolve, out);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// One pass via the Anthropic SDK (server API-key fallback)
// ---------------------------------------------------------------------------

async function runApiPass({ apiKey, model, system, prompt, maxTokens }) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: model || 'claude-opus-4-8',
    max_tokens: maxTokens || 8000,
    system,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const u = msg.usage || {};
  const usage = {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheCreate: u.cache_creation_input_tokens || 0,
    costUsd: null,
  };
  return { text, usage };
}

// A small adapter so the rest of the code calls ONE function regardless of mode.
// onUsage (optional) is fired once per Claude pass with token/cost usage so the
// caller can tally per-user AI spend.
function makeRunner({ oauthToken, apiKey, subModel, apiModel, emit, onUsage }) {
  if (oauthToken) {
    return ({ system, prompt, withTools, timeoutMs }) =>
      runClaudePass({
        token: oauthToken, model: subModel || 'sonnet',
        prompt: `${system}\n\n${prompt}`, withTools,
        onActivity: (a) => emit && emit({ type: 'activity', ...a }), onUsage, timeoutMs,
      });
  }
  if (apiKey) {
    // The SDK fallback has no live tool stream; note it once.
    const apiM = apiModel || 'claude-opus-4-8';
    return async ({ system, prompt }) => {
      const { text, usage } = await runApiPass({ apiKey, model: apiM, system, prompt, maxTokens: 8000 });
      if (usage && onUsage) { try { onUsage({ ...usage, model: apiM }); } catch (_) {} }
      return text;
    };
  }
  if (process.env.DOC_FACTORY_LOCAL_AUTH === '1') {
    // Local testing: use the machine's logged-in `claude` (no token, real HOME).
    return ({ system, prompt, withTools, timeoutMs }) =>
      runClaudePass({
        token: '', model: subModel || 'sonnet',
        prompt: `${system}\n\n${prompt}`, withTools,
        onActivity: (a) => emit && emit({ type: 'activity', ...a }), onUsage, timeoutMs,
      });
  }
  throw new Error('No Claude connected. Set CLAUDE_CODE_OAUTH_TOKEN (your subscription) or ANTHROPIC_API_KEY on the server.');
}

// ---------------------------------------------------------------------------
// The pipeline: idea -> blueprint -> panels (act by act) -> critic -> final
// ---------------------------------------------------------------------------

function bgHex(bg) {
  if (bg === 'night') return '#0f1b3d';
  if (bg === 'parchment') return '#efe2c0';
  return '#ffffff';
}

async function runDocFactory({ idea, minutes, oauthToken, apiKey, subModel, apiModel, emit, onUsage, mode, hook, cta, directives, styleOverride }) {
  const say = (e) => { try { emit && emit(e); } catch (_) {} };
  const run = makeRunner({ oauthToken, apiKey, subModel, apiModel, emit, onUsage });
  // Doc Factory is capped at a 1-minute maximum. The frontend only offers the
  // 1-minute option; this clamp is the backstop so any request (including the
  // old default of 8) collapses to 1 minute.
  const MAX_MINUTES = 1;
  const targetMinutes = Math.max(1, Math.min(MAX_MINUTES, Number(minutes) || 1));
  // The word-for-word CTA is honored in ALL modes (it's business-critical, so the
  // creator controls it everywhere). The hook, freeform directions and style
  // override stay a Semi-only nicety — in 'auto'/'manual' those remain empty.
  const ctaText = String(cta || '').trim();
  const semiHook = mode === 'semi' ? String(hook || '').trim() : '';
  const semiDirectives = mode === 'semi' ? directives : '';
  const styleBible = effectiveStyle(mode === 'semi' ? styleOverride : '');
  const directives_ = directivesBlock({ hook: semiHook, cta: ctaText, directives: semiDirectives });

  // ---- Pass 1: blueprint (Scout + Researcher + Architect, with WebSearch) ----
  say({ type: 'phase', key: 'blueprint' });
  say({ type: 'activity', icon: '🧭', text: 'Scouting the angle and researching…' });
  const blueprintPrompt =
    `THE IDEA / KEYWORD FROM THE CREATOR:\n"""\n${String(idea || '').trim()}\n"""\n\n` +
    `Target length: about ${targetMinutes} minutes.${directives_}\n\nProduce the blueprint JSON now.`;
  const blueprintText = await run({
    system: BLUEPRINT_SYSTEM, prompt: blueprintPrompt, withTools: true, timeoutMs: 9 * 60 * 1000,
  });
  const blueprint = extractJson(blueprintText);
  if (!blueprint || !blueprint.title || !Array.isArray(blueprint.beats) || !blueprint.beats.length) {
    throw new Error("Couldn't build the blueprint — please run it again.");
  }
  say({ type: 'activity', icon: '✅', text: `Title: "${blueprint.title}" — ${blueprint.beats.length} beats` });

  // ---- Pass 2: narration + panels, ACT BY ACT (keeps quality + flow) ----
  say({ type: 'phase', key: 'scripting' });
  const panels = [];
  let lastLine = '';
  const factBankText = (blueprint.fact_bank || [])
    .map((f) => `- [${f.type}] ${f.claim}${f.source ? ` (${f.source})` : ''}`).join('\n');
  // Word budget keeps the finished video close to the requested length
  // (~145 spoken words/min). Split evenly across the beats.
  const wordBudget = Math.round(targetMinutes * 145);
  const perBeatWords = Math.max(40, Math.round(wordBudget / blueprint.beats.length));

  for (let i = 0; i < blueprint.beats.length; i++) {
    const beat = blueprint.beats[i];
    say({ type: 'activity', icon: '✍️', text: `Writing act ${i + 1}/${blueprint.beats.length}: ${beat.beat || ''}`.slice(0, 140) });
    const beatPrompt =
      `VIDEO TITLE: ${blueprint.title}\nANGLE: ${blueprint.angle || ''}\nTONE: ${blueprint.tone || 'calm, immersive'}\n\n` +
      `FACT BANK (use only what fits this beat; never contradict it):\n${factBankText}\n\n` +
      `THIS IS BEAT ${beat.n || i + 1} of ${blueprint.beats.length} — purpose: ${beat.purpose || 'story'}.\n` +
      `BEAT: ${beat.beat}\n\n` +
      (lastLine
        ? `The previous panel's narration line was: "${lastLine}". Continue smoothly from it.\n\n`
        : `This is the OPENING of the video — the first 1-2 lines must hook hard.\n\n`) +
      `LENGTH: keep this beat's narration to about ${perBeatWords} words total (the whole video targets ~${wordBudget} words for ${targetMinutes} min). Be economical — short lines, no padding.${directives_}\n\n` +
      `Expand ONLY this beat into panels now. Return the panels JSON.`;
    let beatPanels = [];
    try {
      const beatText = await run({ system: panelsSystem(styleBible), prompt: beatPrompt, withTools: false, timeoutMs: 5 * 60 * 1000 });
      const parsed = extractJson(beatText);
      if (parsed && Array.isArray(parsed.panels)) beatPanels = parsed.panels;
    } catch (e) {
      say({ type: 'activity', icon: '⚠️', text: `Act ${i + 1} hiccuped — continuing.` });
    }
    for (const p of beatPanels) {
      const narration = String(p.narration || '').trim();
      if (!narration && !p.callout) continue;
      // EVERY panel gets a doodle now — even emphasis ("text-card") panels. The
      // bold callout is laid over the doodle by the assembler, so the viewer
      // always sees a drawing, never bare text on a flat card.
      panels.push(buildPanel(p, styleBible, panels.length + 1, beat.n || i + 1));
      if (narration) lastLine = narration;
    }
  }

  if (!panels.length) throw new Error('No panels were produced — please run it again.');

  // ---- Guarantee the word-for-word CTA (ALL modes) + the semi hook, exactly once ----
  if (ctaText || semiHook) injectHookCta(panels, { hook: semiHook, cta: ctaText }, styleBible);

  // ---- Pass 3: critic polishes the title + checks the opening (best effort) ----
  say({ type: 'phase', key: 'polish' });
  let finalTitle = blueprint.title;
  let altTitles = Array.isArray(blueprint.alt_titles) ? blueprint.alt_titles : [];
  let thumbnailIdea = blueprint.thumbnail_idea || '';
  try {
    const opening = panels.slice(0, 6).map((p) => p.narration).filter(Boolean).join(' ');
    const criticText = await run({
      system: CRITIC_SYSTEM,
      prompt: `CURRENT TITLE: ${blueprint.title}\nALT TITLES: ${altTitles.join(' | ')}\nTHUMBNAIL IDEA: ${thumbnailIdea}\n\nOPENING NARRATION (first panels):\n"${opening}"\n\nReturn the critic JSON.`,
      withTools: false, timeoutMs: 3 * 60 * 1000,
    });
    const crit = extractJson(criticText);
    if (crit && crit.title) {
      finalTitle = crit.title;
      if (Array.isArray(crit.alt_titles) && crit.alt_titles.length) altTitles = crit.alt_titles;
      if (crit.thumbnail_idea) thumbnailIdea = crit.thumbnail_idea;
    }
  } catch (_) { /* keep blueprint title */ }

  say({ type: 'phase', key: 'done' });

  const words = panels.reduce((s, p) => s + (p.narration ? p.narration.split(/\s+/).length : 0), 0);
  const textCards = panels.filter((p) => p.panelType === 'text-card').length;
  return {
    idea: String(idea || '').trim(),
    title: finalTitle,
    alt_titles: altTitles,
    angle: blueprint.angle || '',
    tone: blueprint.tone || '',
    thumbnail_idea: thumbnailIdea,
    target_minutes: targetMinutes,
    mode: mode === 'semi' ? 'semi' : mode === 'manual' ? 'manual' : 'auto',
    style_bible: styleBible,
    fact_bank: blueprint.fact_bank || [],
    beats: blueprint.beats,
    panels,
    stats: {
      panels: panels.length,
      text_cards: textCards,
      illustrations: panels.length - textCards,
      words,
      est_minutes: +(words / 150).toFixed(1), // ~150 wpm narration
    },
  };
}

// ---------------------------------------------------------------------------
// MANUAL MODE — revisers. The creator reviews the finished script (or the image
// prompts) and either edits them by hand (done in the route) or asks the AI to
// make changes. These run ONE Claude pass over the WHOLE current script.
// ---------------------------------------------------------------------------

// Rewrite the full script on the creator's note (re-runs the writer's room).
async function reviseScript({ project, instruction, oauthToken, apiKey, subModel, apiModel, emit, onUsage }) {
  const say = (e) => { try { emit && emit(e); } catch (_) {} };
  const run = makeRunner({ oauthToken, apiKey, subModel, apiModel, emit, onUsage });
  const styleBible = project.style_bible || STYLE_BIBLE;

  say({ type: 'phase', key: 'scripting' });
  say({ type: 'activity', icon: '✍️', text: 'Reworking the script on your notes…' });

  const current = (project.panels || [])
    .map((p) => `#${p.n} [${p.bg || 'white'}]${p.callout ? ` (bold: ${p.callout})` : ''} ${p.narration}`)
    .join('\n');

  const system = `You are THE NARRATOR and THE CINEMATOGRAPHER of Doc Factory, REVISING an existing, finished script for a faceless doodle documentary because the creator asked for changes.

${MISSION}

THE DOODLE STYLE BIBLE (every illustration shares this — describe only the subject, the look is fixed):
${styleBible}

You are given the CURRENT full script as an ordered list of panels (one short narration line each, with any bold on-screen word). Apply the creator's CHANGE REQUEST faithfully. You may rewrite, add, remove, reorder, split or merge panels — but ONLY change what the request implies; keep everything else as it is. Preserve the calm, immersive, present-tense voice, the one-short-line-per-panel rhythm, and the rule that EVERY panel has a doodlePrompt. Return the COMPLETE revised script (every panel, in final order).

Output ONLY a JSON object wrapped in <json></json> tags, no other prose, of this shape:
<json>
${PANELS_SHAPE}
</json>`;

  const prompt =
    `VIDEO TITLE: ${project.title}\nANGLE: ${project.angle || ''}\nTONE: ${project.tone || 'calm, immersive'}\n\n` +
    `THE CURRENT SCRIPT (${(project.panels || []).length} panels):\n${current}\n\n` +
    `THE CREATOR'S CHANGE REQUEST:\n"""\n${String(instruction || '').trim()}\n"""\n\n` +
    `Return the full revised panels JSON now.`;

  const text = await run({ system, prompt, withTools: false, timeoutMs: 8 * 60 * 1000 });
  const parsed = extractJson(text);
  if (!parsed || !Array.isArray(parsed.panels) || !parsed.panels.length) {
    throw new Error("Couldn't apply those changes — please try rewording your note.");
  }
  const panels = [];
  for (const p of parsed.panels) {
    const narration = String(p.narration || '').trim();
    if (!narration && !p.callout) continue;
    panels.push(buildPanel(p, styleBible, panels.length + 1, p.beat || 1));
  }
  if (!panels.length) throw new Error("Couldn't apply those changes — please try again.");
  return panels;
}

const IMAGE_PROMPTS_SHAPE = `{
  "prompts": [
    { "n": 1, "doodlePrompt": "the revised one-subject doodle scene for this panel (subject + action + setting; NO style words — the style is fixed)", "callout": "optional bold on-screen word/number, empty string if none" }
  ]
}`;

// Refine the doodle (image) prompts on the creator's note. Narration is left
// untouched; only the drawing each panel shows (and optionally its bold word).
async function reviseImagePrompts({ project, instruction, oauthToken, apiKey, subModel, apiModel, emit, onUsage }) {
  const say = (e) => { try { emit && emit(e); } catch (_) {} };
  const run = makeRunner({ oauthToken, apiKey, subModel, apiModel, emit, onUsage });
  const styleBible = project.style_bible || STYLE_BIBLE;

  say({ type: 'phase', key: 'scripting' });
  say({ type: 'activity', icon: '🎬', text: 'Refining the doodle prompts…' });

  const current = (project.panels || [])
    .map((p) => `#${p.n}: ${rawScene(p.doodlePrompt) || p.narration}${p.callout ? `  (bold: ${p.callout})` : ''}  // line: ${p.narration}`)
    .join('\n');

  const system = `You are THE CINEMATOGRAPHER of Doc Factory, REVISING the doodle image prompts for a faceless doodle documentary because the creator asked for changes. Do NOT change the narration — only the doodle scene each panel draws (and, if asked, the bold on-screen callout word).

${MISSION}

THE DOODLE STYLE BIBLE (fixed — never restate it inside a prompt, just describe the subject):
${styleBible}

You are given every panel: its current doodle scene and the narration line it must illustrate. Apply the creator's CHANGE REQUEST to the doodle prompts. Keep ONE clear subject per panel. Return ONE entry per panel, in order, for EVERY panel (include unchanged ones unchanged).

Output ONLY a JSON object wrapped in <json></json> tags of this shape:
<json>
${IMAGE_PROMPTS_SHAPE}
</json>`;

  const prompt =
    `VIDEO TITLE: ${project.title}\n\nEVERY PANEL (#n: current doodle // narration line):\n${current}\n\n` +
    `THE CREATOR'S CHANGE REQUEST:\n"""\n${String(instruction || '').trim()}\n"""\n\nReturn the prompts JSON now.`;

  const text = await run({ system, prompt, withTools: false, timeoutMs: 8 * 60 * 1000 });
  const parsed = extractJson(text);
  if (!parsed || !Array.isArray(parsed.prompts)) {
    throw new Error("Couldn't refine the prompts — please try rewording your note.");
  }
  const byN = new Map(parsed.prompts.map((x) => [Number(x.n), x]));
  let changed = 0;
  for (const panel of project.panels) {
    const upd = byN.get(panel.n);
    if (!upd) continue;
    const scene = rawScene(upd.doodlePrompt);
    if (scene) {
      panel.doodlePrompt = `${styleBible} Scene: ${scene}`;
      panel.image = null;            // a changed prompt invalidates any old image
      panel.imageSource = undefined;
      changed++;
    }
    if (typeof upd.callout === 'string') panel.callout = upd.callout.trim();
  }
  return { panels: project.panels, changed };
}

module.exports = {
  runDocFactory,
  reviseScript,
  reviseImagePrompts,
  STYLE_BIBLE,
  effectiveStyle,
  rawScene,
  buildPanel,
  extractJson,
  // makeRunner is shared with the Podcast Brain (services/podcastBrain) so both
  // features talk to Claude the same way — subscription token first, API key as
  // a fallback — instead of each growing its own copy of the auth logic.
  makeRunner,
  sanitizeClaudeToken,
  bgHex,
};
