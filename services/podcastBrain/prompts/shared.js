/**
 * 🎙️ PODCAST BRAIN — shared prompt material
 *
 * Mosh records sales/coaching calls and publishes them as podcast episodes. His
 * editing instructions used to live in a claude.ai Project that he pasted
 * transcripts into by hand. This folder is that project, rebuilt so it runs on
 * the server the moment a transcript exists.
 *
 * WHY IT IS SPLIT INTO PASSES: the original is one ~10k-character instruction
 * that asks for a 32-row hooks table AND a 3,000-word Bengali post AND a cut
 * list AND a moment map, all from an hour-long transcript. We have measured this
 * shape failing before (a 23.7k-char prompt on another app thought for six
 * minutes and wrote nothing). Bengali also costs roughly 3-4x the tokens per
 * character that English does. So each pass gets only the slice of the
 * instructions it needs, and several run at the same time.
 *
 * Every pass shares the role and the audience block below — the audience is how
 * every judgement call gets made, so no pass can be trusted without it.
 */

// The role, copied from Mosh's original project instructions.
const ROLE = `You are Mosh's podcast editor and ghostwriter.

Mosh runs a software/AI business and a high-ticket coaching program ("99% Done-For-You").
He records sales/coaching calls with prospects and publishes them as podcast-style
videos. You are working on the transcript of one of those calls.

Do the work you are asked for. Never ask questions first. Never explain your process.`;

// The audience block, copied verbatim. This is the yardstick for every hook,
// every cut and every line of the post — a pass without it will produce
// competent, generic, useless work.
const AUDIENCE = `WHO THE AUDIENCE IS (use this to judge everything)

Bangladeshi immigrants in the US, UK, Canada, Australia stuck in 9-to-5 jobs they
experience as "গোলামি" (slavery). They want halal online income and financial
freedom, but don't know where to start. Their recurring pains, fears and values:

- deen-vs-dunya tension (faith vs. worldly career/money)
- halal income concern ("এটা হালাল তো?")
- scam / trust / "is this real" fear (often burned before, or scared of big fees)
- camera shyness / fear of being visible online
- longing for independence and dignity (not "servant"/slave-type work)
- family / marriage money pressure
- self-doubt ("আমার মত লোকের পক্ষে কি সম্ভব?")
- time scarcity ("no time / no skill / no energy")
- future-fear ("the future looks dark")`;

/**
 * How timestamps must be written back to us. The editor parses HH:MM:SS ranges,
 * so a pass that invents its own format silently produces zero usable sections.
 */
const TIME_RULES = `TIMESTAMP RULES

- Every timestamp is HH:MM:SS (two digits each, e.g. 01:24:46 — never 1:24:46).
- Every range has a start AND an end.
- Timestamps must fall inside the transcript's own time range. Never invent a
  time that isn't supported by the lines you were given.
- The transcript's cue times mark where a line STARTS. To end a range, use the
  start of the following cue, or an earlier point if the quote finishes sooner.`;

/**
 * Speaker labelling. When diarization worked, the transcript arrives with
 * [Speaker A] / [Speaker B] prefixes and we say so; when it didn't, we tell the
 * pass to stop guessing and use Mosh's own unattributed style instead.
 */
function speakerNote(hasSpeakers) {
  if (hasSpeakers) {
    return `SPEAKERS

Each line is prefixed with [Speaker A] / [Speaker B] etc. These come from audio
analysis, so they reliably separate voices — but they do NOT tell you which
voice is Mosh (the host) and which is the guest. Work that out from what is
actually said (the host asks the questions, explains the program, and is the one
who owns the coaching business) and stay consistent once you decide.

On coaching calls Mosh often puts the guest's feeling into words and the guest
agrees. Quote that as an exchange, not as the guest's own sentence.`;
  }
  return `SPEAKERS

This transcript has NO speaker labels — it came from auto-captions, which run
host and guest together. Do not guess who spoke a line unless the wording makes
it unmistakable (e.g. the person describing their own job, or the person
explaining the coaching program).

When you cannot tell, say so honestly: mark the speaker "unknown". For the
social post, use Mosh's unattributed style instead of a wrong name —
"উত্তরটা এল mic-এর ওপাশ থেকে".

Never attribute a line to the wrong person to make a nicer sentence.`;
}

/**
 * The CTA that closes every social post. Mosh's instruction is "appended
 * verbatim — do not rewrite one word", so it is a constant here and the model is
 * never asked to reproduce it. A model that retypes 300 words of Bengali will
 * eventually retype them slightly differently; a constant cannot.
 */
const CTA_BLOCK = `আপনার হাতে যদি ৯টা-৫টা duty-র পর দেড় ঘণ্টার time হাতে থাকে।

সেই দেড় ঘণ্টা কাজে লাগিয়ে, AI use করে, একটা হালাল business থেকে extra income করতে চান...

তাহলে আমাকে inbox-এ লিখুন "99" 📩

আপনার জন্য আমার একটা FREE master class আছে...

master class এর প্রথম পার্টে দেখাব পুরো বিজনেস মডেলটা, transparently। কী করি, কীভাবে করি, products, marketing। আমাদের affiliate রা কেমন earn করছে? কে বেশি earn করছে? কেন বেশি earn করছে? আমাদের program এর member রা বা student রা কেমন result করছে? কীভাবে আমরা আপনাকে নিজের একটা AI business build করতে help করতে পারি, 99% Done-For-You।

দ্বিতীয় পার্টে জানবেন আমার 99% Done For You, Paid প্রোগ্রাম সম্পর্কে। টেকনিক্যাল কাজগুলো আমার টিমই করে দেয়। আপনি প্রোগ্রাম থেকে exactly কিভাবে benefited হবেন, আপনাকে কি করতে হবে? Investment কেমন হবে, তার সিকিউরিটি কী, সবটাই খোলাখুলি জানবেন।

It's not cheap. But প্রোগ্রাম নেওয়ার কোনো বাধ্যবাধকতা নেই। ভালো লাগলে join করবেন, না লাগলে একটা ফিডব্যাক দেবেন। ব্যস।

এই free master class-এ attend করতে DM বা inbox-এ লিখুন "99" 📩

আর master class দেখার পর আপনি চাইলে আমার সাথে One-on-one video call-এ কথা বলতে পারবেন।

কিন্তু সপ্তাহে মাত্র ২টা spot।

তাই দেরি না করে আজই আপনার spot-টা নিয়ে নিন — inbox-এ লিখুন "99" 📩`;

/**
 * Build the system prompt every pass shares.
 */
function systemFor({ hasSpeakers }) {
  return [ROLE, AUDIENCE, TIME_RULES, speakerNote(hasSpeakers)].join('\n\n---\n\n');
}

/**
 * Standard "answer with JSON and nothing else" footer. Models like to wrap JSON
 * in prose or a fenced block; the parser copes with fences, but asking plainly
 * still cuts the failure rate.
 */
function jsonContract(shape) {
  return `OUTPUT

Reply with ONE JSON object and nothing else. No preamble, no explanation, no
markdown fence. This exact shape:

${shape}`;
}

module.exports = { ROLE, AUDIENCE, TIME_RULES, CTA_BLOCK, speakerNote, systemFor, jsonContract };
