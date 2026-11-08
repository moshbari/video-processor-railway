/**
 * 🔔 Apple push notifications for Get Transcript ("Your RANT is ready").
 *
 * Token-based APNs over HTTP/2, no extra packages. Needs these env vars:
 *   APNS_KEY     the .p8 key text (or base64 of it)
 *   APNS_KEY_ID  its 10-character id
 *   APNS_TEAM_ID G6J9BUHSNH
 *   APNS_TOPIC   com.zpresso.gettranscript (the app's bundle id)
 * Without them, sending is skipped quietly (the app still finds the video when opened).
 *
 * The phone says which APNs it belongs to: "production" (TestFlight / App
 * Store) or "sandbox" (a build run from Xcode).
 */
const http2 = require('http2');
const crypto = require('crypto');

const TEAM = process.env.APNS_TEAM_ID || 'G6J9BUHSNH';
const TOPIC = process.env.APNS_TOPIC || 'com.zpresso.gettranscript';

function keyText() {
  const raw = process.env.APNS_KEY || '';
  if (!raw) return '';
  if (raw.includes('BEGIN PRIVATE KEY')) return raw.replace(/\\n/g, '\n');
  try { return Buffer.from(raw, 'base64').toString('utf8'); } catch (_) { return ''; }
}

const configured = () => Boolean(keyText() && process.env.APNS_KEY_ID);

// Apple wants a fresh token at most every hour and at least every 20 minutes.
let cached = { token: '', at: 0 };
function token() {
  if (cached.token && Date.now() - cached.at < 40 * 60 * 1000) return cached.token;
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'ES256', kid: process.env.APNS_KEY_ID });
  const body = b64({ iss: TEAM, iat: Math.floor(Date.now() / 1000) });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key: keyText(), dsaEncoding: 'ieee-p1363' });
  cached = { token: `${head}.${body}.${sig.toString('base64url')}`, at: Date.now() };
  return cached.token;
}

/**
 * Send one notification. `to` = { token, env }. Resolves to true when Apple
 * took it; never throws (a missed notification must not break a render).
 */
function send(to, { title, body, data = {} }) {
  return new Promise((resolve) => {
    if (!configured() || !to || !/^[a-f0-9]{32,200}$/i.test(String(to.token || ''))) return resolve(false);
    const host = to.env === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
    let client;
    try { client = http2.connect(host); } catch (e) { console.warn('[push] connect:', e.message); return resolve(false); }
    const done = (ok) => { try { client.close(); } catch (_) {} resolve(ok); };
    client.on('error', (e) => { console.warn('[push] error:', e.message); done(false); });
    const payload = JSON.stringify({ aps: { alert: { title, body }, sound: 'default' }, ...data });
    let req;
    try {
      req = client.request({
        ':method': 'POST', ':path': `/3/device/${to.token}`,
        authorization: `bearer ${token()}`, 'apns-topic': TOPIC, 'apns-push-type': 'alert', 'apns-priority': '10',
        'content-type': 'application/json',
      });
    } catch (e) { console.warn('[push] request:', e.message); return done(false); }
    let status = 0, reply = '';
    req.setTimeout(15000, () => { req.close(); done(false); });
    req.on('response', (h) => { status = h[':status']; });
    req.on('data', (d) => { reply += d; });
    req.on('end', () => {
      if (status !== 200) console.warn(`[push] Apple said ${status} ${reply.slice(0, 120)}`);
      done(status === 200);
    });
    req.on('error', (e) => { console.warn('[push] send:', e.message); done(false); });
    req.end(payload);
  });
}

module.exports = { send, configured };
