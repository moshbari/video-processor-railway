/**
 * PASS C — Steps 3 & 4: the removable sections and the hard-close removal.
 *
 * These are one pass because Step 4's cuts have to merge with Step 3's (an
 * overlapping pair must become one cut, not two), and because both are judged
 * against the same question: would a retargeting viewer sit through this?
 *
 * This pass runs at the same time as the hooks pass, so it cannot see the hook
 * list. That is deliberate — waiting would cost minutes for a rule the engine
 * enforces anyway: after both finish, any cut overlapping a hook is truncated at
 * the hook boundary in code. The prompt still asks for the rule so the model
 * doesn't hand back a cut list built around destroying its own best material.
 */

const { jsonContract } = require('./shared');

const SHAPE = `{
  "cuts": [
    {
      "n": 1,
      "what": "short description of the section",
      "start": "HH:MM:SS",
      "end": "HH:MM:SS",
      "why": "why it is useless, or: sign-up pressure / hard close",
      "kind": "flow" | "hardclose"
    }
  ],
  "hardCloseFound": true,
  "hardCloseNote": "if the guest is already a member and there is no hard close, say so in one line",
  "endFlow": "write out how the episode now ends after these cuts, and confirm it plays clean"
}`;

function build({ transcript }) {
  const prompt = `Find the sections to remove from this call before publishing it.

PART 1 — USELESS SECTIONS (find 5-12, kind: "flow")

Call setup talk (camera/audio/whiteboard/mic checks), name confusion, meta-talk
about the conversation or about publishing it, "who asked what" confusion,
garbled audio, half-told tangents, word-search fumbling, late-night/sleepy
filler, screen-share searching, battery/phone/AC interruptions, and small talk
that breaks flow.

Rules: do not over-cut. Keep the emotional core — main stories, money talk,
objections, genuine Q&A.

PART 2 — THE HARD CLOSE (kind: "hardclose")

No sign-up pressure in the published episode. Judge everything through a
RETARGETING VIEWER's eyes — they don't want to watch a sales push or a sales
negotiation. Price may be REVEALED (one clean statement), never DISCUSSED.

CUT:
- price-rise scarcity
- deposit / price-lock offers
- commitment-for-commitment
- guilt about time spent
- support-ending scarcity
- "decide now" loops
- hesitation-probe questions after the guest asks for time
- ALL payment-plan and payment-method logistics (installments, "X now Y later",
  extra-charge math, PayPal/card, VAT, who-pays-what)
- discount asks AND the discount-defence that follows, even if hook-worthy in isolation

Prefer one clean section-level mega-cut over many slivers when a whole arc is
negotiation.

KEEP:
- one clean price reveal per offer
- guarantee/refund policy stated as information or philosophy (often the best hooks)
- genuine teaching Q&A
- honest qualifying
- "how I deal with people" moments
- the warm goodbye

Rules: list each pressure pocket as its own cut, keeping genuine Q&A between
them. End the final cut a few seconds BEFORE the closing salam, so the episode
ends warmly. If the guest is already a member and there is no hard close, set
"hardCloseFound" false and say so in "hardCloseNote".

ACROSS BOTH PARTS

- Merge overlapping or adjacent cuts into one.
- Number "n" 1..N in chronological order.
- Never cut a moment that is obviously a great standalone hook (a confession, a
  naked number, a jab, a taboo admission). If a cut would have to swallow one,
  end the cut where that moment starts and say so in "why".
- After cutting, write "endFlow": how the episode now ends, and confirm it plays clean.

${jsonContract(SHAPE)}

---

TRANSCRIPT

${transcript}`;

  return { prompt, label: 'cuts' };
}

module.exports = { build };
