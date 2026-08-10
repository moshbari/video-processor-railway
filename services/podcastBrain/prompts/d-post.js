/**
 * PASS D — Step 6: the Facebook/social post.
 *
 * The heaviest pass by far: ~3,000+ words of Bengali in Humayun Ahmed's voice.
 * It runs at the same time as the hooks and cuts passes because it needs nothing
 * from them — only the transcript.
 *
 * TWO THINGS ARE HANDLED IN CODE, NOT BY THE MODEL:
 *
 * 1. The CTA block. Mosh's rule is "appended verbatim — do not rewrite one word".
 *    A model asked to retype 300 words of Bengali will eventually retype them
 *    slightly differently, and nobody would notice for months. So the model stops
 *    before the CTA and the engine appends the constant.
 *
 * 2. Output is delimited plain text, not JSON. Three thousand words of Bengali
 *    prose with newlines inside a JSON string is a parse failure waiting to
 *    happen, and the failure would cost a full expensive pass to retry.
 */

const { CTA_BLOCK } = require('./shared');

function build({ transcript }) {
  const prompt = `Write ONE Facebook/social post that teases this episode.

FRAMEWORK (invisible): Hook → Context → But → Therefore. NEVER print these labels.

LENGTH — GO LONG. For a full-hour call, target ~3,000+ words of body. Use 20-25
real beats from the call. Structure it as numbered scene movements (এক / দুই /
তিন …) with "---" breaks so it reads like short chapters — one teaching beat,
story or exchange per movement. Long post, short sentences.

FIRST LINE = episode identifier + hook. One compact sentence stating who + what
this specific episode is ("…সেটা নিয়েই আজকের podcast episode"), carrying hook power.

SECOND BEAT = pattern-break: the weird, nobody-does-this angle. Said indirectly.
Hold the "why" as an open loop and resolve it later in the post.

VOICE & STYLE — first person as Mosh. Humayun Ahmed — Himu / Misir Ali flavour,
strong and unmistakable:
- Very short quiet sentences. 1-2 line paragraphs.
- Deadpan one-line asides after a quote ("আমি মাথা নাড়লাম। খরগোশ বিষয়টা গুরুত্বপূর্ণ।").
- Gentle observational humour about ordinary middle-class life. Warmth.
- A Misir Ali "one simple question solves the mystery" structure whenever the call
  contains a logical puzzle.
- 3rd-5th grade reading level. Bengali-English mix (English for business words).
- Narrator commentary may be invented; narrator EVENTS may not.

TRUTH RULES (non-negotiable):
- NEVER invent facts, dialogue, scenes or character details. Anticipation comes
  from REAL moments held back.
- Before quoting any line, RE-CHECK who said it. On coaching calls Mosh often
  articulates the guest's feeling and the guest agrees — quote that as an
  exchange. If ambiguous, write it unattributed ("উত্তরটা এল mic-এর ওপাশ থেকে").
- Never name Mosh's company; never name a specific company/MLM for negative framing.
- No religiously sensitive or irreverent jokes.
- Don't reveal the guest's full name — "কানাডার এক ভাই" style.

PRODUCT POSITIONING — the PRODUCT/program is the hero. Give the software agency
("আমাদের নিজেদের বানানো software"). Contrast when natural: MLM people sell dreams
and opportunity; we show a working product. Early in the post, define the program
in 5th-grade language: Mosh has a coaching program, "99% Done-For-You" — it helps
beginner 9-5 employees build halal income using AI and digital products in
~দেড় ঘণ্টা a day; his team does 99% of the technical work.

AUDIENCE BRIDGE — near the end, turn to the reader in second person, mirroring
their situation truthfully.

EMOJIS — about 1 per beat. A 3,000-word post carries 22-26 in the body.

ENDING — the last movement must land on a REAL time or number moment from the
call that sets up "দেড় ঘণ্টা" naturally. Then STOP.

DO NOT WRITE THE CTA. It is appended automatically, word for word, after your
last line. Your job is to make the handover land — end on the beat that makes the
CTA feel like the next sentence. For reference only, this is what will follow
your text (do not reproduce it, do not paraphrase it, do not refer to it):

<<<CTA_FOR_REFERENCE_ONLY
${CTA_BLOCK}
CTA_FOR_REFERENCE_ONLY>>>

OUTPUT FORMAT — plain text, exactly these two delimited sections, nothing else:

===POST===
(the full post body, ending on the setup beat — no CTA)
===VARIATIONS===
(4-5 alternative versions of the FIRST LINE, one per line, numbered. Include a
খোঁচা variant and a Misir Ali "question answered by another question" variant.)

---

TRANSCRIPT

${transcript}`;

  return { prompt, label: 'post' };
}

module.exports = { build };
