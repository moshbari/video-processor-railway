/**
 * 🎥 LIVE REACT — one text question to Claude, on the owner's Claude
 * subscription (the bundled `claude` CLI + CLAUDE_CODE_OAUTH_TOKEN), the same
 * way the face scan asks. Used by the Facebook post and Ready-made RANT
 * (moved off OpenAI 7 Nov 2026, Mosh's choice).
 */
const { spawn } = require('child_process');
const os = require('os');
const path = require('path');

const CLAUDE_BIN = path.join(__dirname, '..', '..', 'node_modules', '.bin', 'claude');

/** { system?, user, model? } → Claude's reply text. */
function askText({ system, user, model = 'sonnet', timeoutMs = 240000 }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HOME: os.tmpdir() };
    delete env.ANTHROPIC_API_KEY;   // the subscription token, never a paid key
    const args = ['-p', '--model', model, '--output-format', 'json', '--tools', ''];
    if (system) args.push('--system-prompt', system);
    const child = spawn(CLAUDE_BIN, args, { env, cwd: os.tmpdir() });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Claude took too long')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err = (err + d).slice(-300); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', () => {
      clearTimeout(timer);
      let r = null;
      try { r = JSON.parse(out); } catch (_) { /* below */ }
      if (r && !r.is_error && r.result) return resolve(String(r.result));
      reject(new Error(`Claude: ${String((r && r.result) || err || 'no answer').slice(0, 200)}`));
    });
    child.stdin.end(user);
  });
}

/** The first {...} object in a reply (Claude sometimes wraps it in ```json). */
function jsonIn(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('Claude did not reply with JSON');
  return JSON.parse(text.slice(a, b + 1));
}

module.exports = { askText, jsonIn };
