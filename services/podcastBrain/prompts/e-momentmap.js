/**
 * PASS E — Step 7: the moment map.
 *
 * One row per movement of the post, pointing at where in the episode that beat
 * actually happened. Mosh's stated purpose for it: "This lets me verify nothing
 * was invented and find each moment for clipping."
 *
 * So this pass is really a fact-check of pass D, done by a fresh reader who has
 * both the post and the transcript. It is the only place an invented scene gets
 * caught — which is why it is asked to flag a movement it CANNOT place rather
 * than quietly guessing a timestamp.
 */

const { jsonContract } = require('./shared');

const SHAPE = `{
  "map": [
    {
      "movement": "এক",
      "beat": "short description of what happens in this movement",
      "start": "HH:MM:SS",
      "found": true
    }
  ],
  "unplaceable": [
    { "movement": "সাত", "beat": "...", "why": "no moment in the transcript supports this" }
  ],
  "attributionCheck": "one line confirming you verified every quote in the post against the transcript, and naming any line whose speaker you could not confirm"
}`;

function build({ transcript, post }) {
  const prompt = `Below is a social post written about this call, and the call's transcript.

For every numbered movement of the post, find where in the episode that beat
actually happens, and give its timestamp.

Then do the check the post depends on:

- Re-read every quoted line in the post and confirm the transcript really contains
  it, said by the person the post attributes it to.
- Any movement you CANNOT place in the transcript goes in "unplaceable" — do NOT
  invent a timestamp to fill the row. An unplaceable movement means the post
  invented something, and Mosh needs to know.
- Any quote whose speaker you cannot confirm gets named in "attributionCheck".

Be strict. A wrong timestamp is a small annoyance; a fabricated scene that nobody
catches is the thing this step exists to prevent.

${jsonContract(SHAPE)}

---

THE POST

${post}

---

TRANSCRIPT

${transcript}`;

  return { prompt, label: 'momentmap' };
}

module.exports = { build };
