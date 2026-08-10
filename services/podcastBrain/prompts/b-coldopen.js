/**
 * PASS B — Step 2B: build the cold-open montage.
 *
 * This is the one output that maps directly onto how the editor renders. The
 * podcast render extracts the hooks queue in `order` and concatenates it IN
 * FRONT of the full video — which is exactly what a cold open is. So these ten
 * picks, in this order, are the montage the audience actually hears first.
 *
 * It runs after pass A because it chooses from A's table rather than re-reading
 * the call. It still gets the transcript, because the "no two lines within 90
 * seconds of each other" rule needs the runtime, and because a slot with no
 * candidate in the table sometimes has one in the call.
 */

const { jsonContract } = require('./shared');

const SHAPE = `{
  "coldOpen": [
    {
      "slot": 1,
      "slotName": "JAB",
      "hookN": 12,
      "quote": "short quote",
      "speaker": "host" | "guest" | "unknown",
      "start": "HH:MM:SS",
      "end": "HH:MM:SS",
      "durationSec": 10
    }
  ],
  "totalSec": 78,
  "arc": "one line, plain words: attack → taboo → fear → ... → go",
  "bench": [
    { "quote": "...", "speaker": "guest", "start": "HH:MM:SS", "end": "HH:MM:SS", "couldFill": "JAB" }
  ],
  "useWithCare": [ { "quote": "...", "why": "why this is risky as a standalone clip" } ],
  "notes": [ "any slot you could not fill honestly, and what you used instead" ]
}`;

function build({ transcript, hooksJson }) {
  const prompt = `You already found the hooks for this call. Now build ONE montage: the 10 hooks
Mosh will stack at the very start of the episode, in the exact order he should
stack them.

This is NOT the top 10 by rating. It is sorted for RHYTHM. Fill these ten slots,
in this order, each from the hooks table:

1.  JAB        — the most aggressive/controversial line in the call. Open hot.
2.  TABOO      — a forbidden-sounding word said plainly (গোলামী / হারাম / স্ক্যাম / এমএলএম).
3.  FEAR       — the scam / trust / "is this real" beat, ideally in the GUEST's voice, not Mosh's.
4.  NUMBER     — the biggest or strangest number, with no explanation attached.
5.  CONFESSION — the guest admitting something is not working.
6.  FAILURE    — MOSH admitting a failure or a zero.
7.  MIRROR     — the audience's private self-doubt said out loud (camera shyness, "am I able", "how long do I wait").
8.  FUNNY      — the best short laugh line. Breaks tension before the end.
9.  GUT-PUNCH  — the one line that indicts their whole life plan.
10. COMMAND    — 3-6 words. An imperative, or the most quotable line in the call. The last thing they hear before the episode starts.

RULES FOR THE ORDER

- Total runtime 60-90 seconds. Put each line's duration in "durationSec" and the
  sum in "totalSec".
- Never two lines from the same speaker back to back if avoidable — alternate
  host and guest voices.
- Never two number-hooks back to back.
- Spread across the whole episode: no two montage lines from within 90 seconds of
  each other in the runtime. If a slot's best candidate clusters with another,
  use the next best.
- Nothing that resolves itself. Every line leaves a question open.
- No CTA, no product name, no ending spoiler.
- At least 3 of the 10 must be Bucket B, and at least 1 must be funny.
- If the call genuinely has no line for a slot, say so in "notes" and fill it with
  the next strongest hook. NEVER invent or stretch a quote to fit a slot.

THEN

- "bench": 15-20 more spicy hooks Mosh can swap into any slot, each tagged with
  which slot it could fill.
- "useWithCare": flag any line that is spicy but risky as a standalone clip (a
  religious ruling, a joke that reads as a threat out of context). Do not silently
  drop these — let Mosh decide.

Keep "hookN" pointing at the hook's "n" from the table so the two can be matched up.

${jsonContract(SHAPE)}

---

THE HOOKS TABLE YOU PRODUCED

${hooksJson}

---

TRANSCRIPT (for runtime spacing and for the bench)

${transcript}`;

  return { prompt, label: 'coldopen' };
}

module.exports = { build };
