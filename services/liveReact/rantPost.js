/**
 * 🎥 LIVE REACT — the Facebook post that comes with every RANT video.
 *
 * What the creator SAID in their RANT (caption words, or the script) plus the
 * video's title go through Mosh's Facebook text-post prompt (the same one as
 * "📝 FB post (Bangla, 99)" in Get Transcript), so the post is ready the moment
 * the video is: one tap, copy, paste on Facebook.
 *
 * The prompt is NOT in this (public) repo: env RANT_POST_PROMPT, or the local
 * git-ignored private/rant-post-prompt.md.
 */

const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const MODEL = process.env.RANT_POST_MODEL || process.env.READY_RANT_MODEL || 'gpt-6.1-sol';

let client = null;
const openai = () => (client ||= new OpenAI({ apiKey: process.env.OPENAI_API_KEY }));

function postPrompt() {
  if (process.env.RANT_POST_PROMPT) return process.env.RANT_POST_PROMPT;
  const local = path.join(__dirname, '../../private/rant-post-prompt.md');
  return fs.existsSync(local) ? fs.readFileSync(local, 'utf8') : null;
}

/** The words of every talk, in the order they play in the video. */
function saidIn(talks) {
  const rank = (t) => (t.kind === 'intro' ? -1 : t.kind === 'ending' ? 1e9 : Number(t.at) || 0);
  return [...(talks || [])]
    .sort((a, b) => rank(a) - rank(b))
    .map((t) => {
      const w = Array.isArray(t.words) && t.words.length ? t.words.map((x) => x.text).join(' ') : '';
      return (w || String(t.script || '')).trim();
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * { said, title, url, earlier? } → the post text.
 * earlier = a post already made: write a clearly different one ("New version").
 */
async function writePost({ said, title, url, earlier }) {
  const base = postPrompt();
  if (!base) throw new Error('The post writer is not set up on the server yet.');
  if (!String(said || '').trim()) throw new Error('Nothing was said in this RANT to write a post from.');
  let prompt = base.replace(/\s*INPUT:\s*$/i, '');
  prompt += `\n\nOUTPUT FOR THIS APP: reply with ONE JSON object and nothing else: {"post": "the final post, exactly as it should be pasted on Facebook"}. No headings, labels or quotes around it.`;
  prompt += `\n\nAbout my input: it is what I said in my RANT video (I pause someone's video and give my own take). Write the post from MY points and MY words; the video I reacted to is only background. Don't mention "RANT", "reaction" or "this video I reacted to" unless it helps the story.`;
  if (earlier) prompt += `\n\nThis is a fresh version. Here is an earlier one; write something clearly different (a new angle, a new hook), just as good:\n"""\n${String(earlier).slice(0, 6000)}\n"""`;
  const head = [title && `Video I reacted to: ${title}`, url].filter(Boolean).join('\n');
  prompt += `\n\nINPUT:\n${head ? head + '\n\n' : ''}What I said:\n${String(said).slice(0, 30000)}`;

  const res = await openai().chat.completions.create({
    model: MODEL,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
  });
  let out = {};
  try { out = JSON.parse(res.choices?.[0]?.message?.content || '{}'); } catch (_) { /* below */ }
  const post = String(out.post || '').trim();
  if (!post) throw new Error('The post came back empty.');
  console.log(`[rant-post] ${post.length} chars (${res.usage?.prompt_tokens || 0} in, ${res.usage?.completion_tokens || 0} out)`);
  return post;
}

module.exports = { saidIn, writePost };
