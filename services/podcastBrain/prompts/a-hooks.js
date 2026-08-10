/**
 * PASS A — Steps 1 & 2 of Mosh's instructions: read the call, then find 18-32
 * hook moments.
 *
 * This is the pass everything else leans on. The cold open (pass B) picks its
 * ten slots from this table, and the cut list (pass C) is forbidden from cutting
 * across anything in it. If this pass is bland, the whole episode is bland — so
 * the anti-boring rules are stated as hard failures, not preferences.
 */

const { jsonContract } = require('./shared');

const SHAPE = `{
  "summary": "2-3 short lines: show topic, who the guest is, their awareness level",
  "hooks": [
    {
      "n": 1,
      "quote": "the exact spoken words, lightly cleaned, in the original language",
      "speaker": "host" | "guest" | "unknown",
      "start": "HH:MM:SS",
      "end": "HH:MM:SS",
      "rating": 5,
      "why": "one short line: why this stops the thumb",
      "bucket": "A" | "B"
    }
  ]
}`;

function build({ transcript }) {
  const prompt = `Read the FULL transcript below before writing anything.

Work out: the show topic, who is host and who is guest, the target audience, the
audience's pain points and awareness level. Keep that mapping in your head — put
only 2-3 lines of it in "summary".

Then find 18-32 hook moments usable as a preview/pre-sell at the start of the podcast.

LENGTH & SPICE RULES (non-negotiable — this is where most attempts fail)

- Every hook is 5-12 seconds. 15 seconds absolute maximum.
- CUT BEFORE THE RESOLUTION. End on the claim, the confession, the insult or the
  number — never include the explanation that follows. A hook is an unfinished
  sentence, not a summary. If the line explains itself, it is dead as a hook.
  Example: take "I had to struggle six years" and STOP. Do NOT continue into
  "...only to realise a mentor would have shortened it."
- If a strong moment is long, split it into two or three separate short hooks
  instead of stitching one long one. ("আমি চাকরিকে গোলামী বলি" and "ইচ্ছা করলেই
  বন্ধ করতে পারে না" are two hooks, not one.)
- Hunt for spike words, not teaching points: গোলামী, হারাম, স্ক্যাম, এমএলএম,
  ব্লাস্ট, জ্বর, পয়জন, ভুল, মিথ্যা, ব্লাইন্ড — plus raw numbers with no context.
- Boring is a failure. If a hook could appear in a textbook, delete it.

THE SIX TYPES THAT ALWAYS WORK — pull from all of them

1. Jabs at a group — "ভাই, ইউ আর নট ডিজিটাল মার্কেটার। ডিজিটাল মার্কেটার হচ্ছে যারা এমএলএম বিজনেস করে।"
2. Self-roasts — "'হোয়াট ইজ নেক্সট' — আমার গায়ে জ্বর এসে যায়।"
3. Failure confessions — "মার্চে আমার জিরো সেল ছিল।" / "ভাই, কিচ্ছু হচ্ছে না।"
4. Naked numbers — "১৩,০০০ ডলার খরচ করে শিখছি।" / "কয় টাকা লাগবে? ২০ টাকা।"
5. Bangla comedy lines — "জিলাপির প্যাঁচ দিবেন না।" / "২০ ডলারের মায়া ত্যাগ করতে হবে।"
6. Taboo admissions — "আমার idea হারামের লেভেলে চলে যায়।" / "আমার মেয়ে ফুল পর্দা করে।"

BUCKETS

Bucket A — PUNCH (surprise / scale / insult / number / joke).
Bucket B — MIRROR (recognition: a pain, fear, doubt or value the audience shares).

At least 40% of hooks must be Bucket B, and Bucket B hooks must be short and raw
too — not explained feelings.

TWO-PASS RULE
Pass 1: mark all punch hooks.
Pass 2: re-read the ENTIRE transcript hunting ONLY for emotional/relatable beats
before you finalise. Do not skip this. It is where the Bucket B hooks come from.

AUDIENCE SCAN
Search for every audience item in your instructions (deen-vs-dunya, halal, scam
fear, camera shyness, independence, family pressure, self-doubt, time scarcity,
future-fear). Every one that actually appears in this call gets at least one hook.

SORTING
Sort by rating descending. Ties → Bucket B above Bucket A. Number them "n" 1..N
in that final sorted order.

${jsonContract(SHAPE)}

---

TRANSCRIPT

${transcript}`;

  return { prompt, label: 'hooks' };
}

module.exports = { build };
