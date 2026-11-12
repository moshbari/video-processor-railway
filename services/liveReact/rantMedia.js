// RANT videos (grabbed main videos, recorded takes, finished RANTs) live in
// their own bucket, which deletes everything after 25 days (like RANT Squad's
// rantscripts-videos). Set RANT_R2_BUCKET + RANT_R2_PUBLIC_URL to turn it on;
// without them, or if an upload there fails, the main bucket is used as before.
// Small JSON state (queues, render results, face scans) stays in the main bucket.
const r2Service = require('../r2Service');

const BUCKET = process.env.RANT_R2_BUCKET;
const PUBLIC = process.env.RANT_R2_PUBLIC_URL;
const own = BUCKET && PUBLIC ? new r2Service.R2Service({ bucket: BUCKET, publicUrl: PUBLIC }) : null;

async function uploadFile(filePath, key, mimeType) {
  if (own) {
    try {
      const up = await own.uploadFile(filePath, key, mimeType);
      return { ...up, downloadUrl: up.downloadUrl || own.getPublicUrl(key) };
    } catch (err) {
      console.error(`[rant-media] ${BUCKET} upload failed, using main bucket: ${err.message}`);
    }
  }
  const up = await r2Service.uploadFile(filePath, key, mimeType);
  return { ...up, downloadUrl: up.downloadUrl || r2Service.getPublicUrl(key) };
}

// RANT videos written to the main bucket before the RANT bucket existed (and
// any fallback uploads) go after 25 days too: once a day, delete media under
// live-react/<phone id>/ older than that. Queue/render/face JSON is left alone.
const KEEP_MS = 25 * 24 * 3600 * 1000;
const MEDIA = /^live-react\/[a-f0-9]{32}\/.+\.(mov|mp4|m4a|jpg|png)$/i;
async function sweepMainBucket() {
  const { ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
  r2Service.init();
  if (!r2Service.client) return;
  let token, gone = 0, freed = 0;
  const cutoff = Date.now() - KEEP_MS;
  do {
    const r = await r2Service.client.send(new ListObjectsV2Command({ Bucket: r2Service.bucketName, Prefix: 'live-react/', ContinuationToken: token }));
    for (const o of r.Contents || []) {
      if (!MEDIA.test(o.Key) || new Date(o.LastModified).getTime() > cutoff) continue;
      await r2Service.client.send(new DeleteObjectCommand({ Bucket: r2Service.bucketName, Key: o.Key }));
      gone++; freed += o.Size || 0;
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  console.log(`[rant-media] main bucket sweep: ${gone} old RANT files deleted (${Math.round(freed / 1e6)} MB)`);
}
function startSweeps() {
  const run = () => sweepMainBucket().catch((e) => console.error('[rant-media] sweep failed:', e.message));
  setTimeout(run, 60 * 1000);
  setInterval(run, 24 * 3600 * 1000);
}

module.exports = { uploadFile, sweepMainBucket, startSweeps, enabled: !!own, bucket: own ? BUCKET : null };
