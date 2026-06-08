/**
 * 🎬 TELLA SERVICE
 *
 * Fetch a video from a user's Tella account via the official Tella API:
 *   resolve share URL/ID -> vid_ id -> request an MP4 export -> poll -> download.
 *
 * Requires env: TELLA_API_KEY (the same key used by the tella-to-youtube app).
 *
 * NOTE: Tella's PUBLIC share URLs do NOT contain the API id. A share URL looks
 * like `.../video/<kebab-name>-<idSuffix>`, where <idSuffix> is the last few
 * characters of the real `vid_...` id. So when the input isn't already a vid_
 * id, we page the account's video list and match that suffix (kebab-name
 * fallback). A `.../video/vid_xxx/view` URL matches the regex directly.
 */

const path = require('path');
const fs = require('fs-extra');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const TELLA_BASE = 'https://api.tella.com/v1';
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// Slugify a name the way Tella builds share-URL slugs (best-effort fallback).
function kebab(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-');
}

function lastPathSegment(input) {
  try {
    const u = new URL(input);
    return u.pathname.split('/').filter(Boolean).pop() || '';
  } catch {
    return (input || '').trim();
  }
}

// Is this a Tella link or a raw vid_ id?
function isTellaUrl(input) {
  const raw = (input || '').trim();
  if (!raw) return false;
  if (/vid_[A-Za-z0-9]+/.test(raw)) return true;
  return /(^|\/\/)([\w-]+\.)*tella\.(tv|com)(\/|$)/i.test(raw);
}

async function tella(pathname, options = {}) {
  const apiKey = process.env.TELLA_API_KEY;
  if (!apiKey) {
    throw new Error('Tella is not set up on the server yet (missing TELLA_API_KEY).');
  }
  const res = await fetch(`${TELLA_BASE}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const msg = body?.error?.message || body?.message || text || res.statusText;
    if (res.status === 401 || res.status === 403) {
      throw new Error('Tella sign-in failed. Please check the Tella API key on the server.');
    }
    throw new Error(`Tella API error ${res.status}: ${msg}`);
  }
  return body;
}

async function resolveVideoId(input) {
  const raw = (input || '').trim();
  if (!raw) throw new Error('Please paste a Tella video link or ID.');

  const direct = raw.match(/vid_[A-Za-z0-9]+/);
  if (direct) return direct[0];

  const seg = lastPathSegment(raw);
  const token = (seg.split('-').pop() || '').toLowerCase();
  if (!token) throw new Error('Could not read a video ID from that link.');
  const slug = seg.toLowerCase();

  let cursor = null;
  let nameFallback = null;
  for (let page = 0; page < 30; page++) {
    const qs = cursor
      ? `/videos?limit=100&cursor=${encodeURIComponent(cursor)}`
      : `/videos?limit=100`;
    const data = await tella(qs);
    const videos = data.videos || [];
    for (const v of videos) {
      if ((v.id || '').toLowerCase().endsWith(token)) return v.id; // strong match
      if (!nameFallback) {
        const k = kebab(v.name);
        if (k && slug.startsWith(k)) nameFallback = v.id;
      }
    }
    cursor = data.pagination?.nextCursor || null;
    if (!cursor) break;
  }
  if (nameFallback) return nameFallback;
  throw new Error(
    "Couldn't find that video in your Tella account. Open the video in Tella, copy the link from your browser's address bar, and paste that — or paste the vid_ id."
  );
}

async function getVideo(videoId) {
  const data = await tella(`/videos/${encodeURIComponent(videoId)}`);
  return data.video || data;
}

async function startExport(videoId) {
  const data = await tella(`/videos/${encodeURIComponent(videoId)}/exports`, {
    method: 'POST',
    body: JSON.stringify({
      granularity: 'video', // full video, not clips/raw
      resolution: '1080p',
      fps: '30',
      speed: '1',
      subtitles: false,
    }),
  });
  return data.export || data;
}

// Poll the video's exports until the matching export completes and exposes an MP4 URL.
async function pollForDownloadUrl(videoId, exportId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const video = await getVideo(videoId);
    const exp = (video.exports || []).find((e) => e.exportId === exportId);
    if (exp) {
      if (exp.status === 'completed' && exp.downloadUrl) return exp.downloadUrl;
      if (exp.status === 'failed') throw new Error('Tella export failed. Please try again.');
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error('Tella took too long to prepare the video (timed out after 10 minutes).');
}

/**
 * Resolve + export + download a Tella video to `${outputDir}/video.mp4`.
 * @returns {Promise<{ videoPath: string, title: string }>}
 */
async function downloadTellaVideo(url, outputDir) {
  await fs.ensureDir(outputDir);

  const videoId = await resolveVideoId(url);
  console.log(`[Tella] Resolved to ${videoId}`);

  let title = 'Tella video';
  try {
    const video = await getVideo(videoId);
    title = video?.name || title;
  } catch { /* title is best-effort */ }

  const exp = await startExport(videoId);
  const exportId = exp?.exportId;
  if (!exportId) throw new Error('Tella did not start the export. Please try again.');
  console.log(`[Tella] Export started (${exportId}); waiting for it to finish...`);

  const downloadUrl = await pollForDownloadUrl(videoId, exportId);
  console.log(`[Tella] Export ready, downloading MP4...`);

  const videoPath = path.join(outputDir, 'video.mp4');
  const res = await fetch(downloadUrl);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download the Tella video (HTTP ${res.status}).`);
  }
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(videoPath));
  console.log(`[Tella] Saved to ${videoPath}`);

  return { videoPath, title };
}

module.exports = { isTellaUrl, downloadTellaVideo };
