/**
 * 📼 MANUAL VIDEO LIBRARY
 *
 * Remembers every video a user has prepared in the Manual Clip Maker, so they
 * can reopen it later without re-uploading. The source MP4 already lives
 * permanently in R2 (manual-clip/{jobId}/source.mp4); this just stores a small
 * per-user index of those videos (title, duration, playback URL, waveform) in
 * R2 so it survives server restarts and page refreshes.
 *
 * R2 layout: manual-clip-library/{userId}.json
 *   { videos:  [ { jobId, title, duration, durationFormatted, sourceKey,
 *                  playbackUrl, waveformPeaks, fileSize, createdAt } ],
 *     renders: [ { renderId, title, downloadUrl, r2Key, fileSize, duration,
 *                  durationFormatted, sourceJobId, hookCount, createdAt } ] }
 *
 * `videos` are editable source uploads (reopen to re-clip). `renders` are
 * finished output videos — each its own "project" with a permanent download
 * link, so past renders are never lost once the download screen is closed.
 */

const r2Service = require('./r2Service');
const { v4: uuidv4 } = require('uuid');

const MAX_VIDEOS = 50;   // keep the most recent N source videos per user
const MAX_RENDERS = 100; // keep the most recent N finished renders per user

class ManualVideoLibraryService {
  _key(userId) {
    return `manual-clip-library/${userId || 'public'}.json`;
  }

  async load(userId) {
    try {
      const buf = await r2Service.getFile(this._key(userId));
      if (!buf) return { videos: [], renders: [] };
      const data = JSON.parse(buf.toString('utf-8'));
      return {
        videos: Array.isArray(data.videos) ? data.videos : [],
        renders: Array.isArray(data.renders) ? data.renders : [],
      };
    } catch (err) {
      console.error(`[VideoLibrary] Load failed for ${userId}:`, err.message);
      return { videos: [], renders: [] };
    }
  }

  async save(userId, data) {
    const buf = Buffer.from(JSON.stringify(data), 'utf-8');
    await r2Service.uploadBuffer(buf, this._key(userId), 'application/json');
  }

  /**
   * Add (or refresh) a video for a user. Newest first, de-duped by jobId.
   */
  async add(userId, record) {
    if (!record || !record.jobId) return;
    const data = await this.load(userId);
    const videos = data.videos.filter(v => v.jobId !== record.jobId);
    videos.unshift({
      jobId: record.jobId,
      title: record.title || 'Untitled video',
      duration: record.duration || 0,
      durationFormatted: record.durationFormatted || '',
      sourceKey: record.sourceKey,
      playbackUrl: record.playbackUrl,
      waveformPeaks: record.waveformPeaks || [],
      fileSize: record.fileSize || 0,
      createdAt: record.createdAt || new Date().toISOString(),
    });
    data.videos = videos.slice(0, MAX_VIDEOS);
    await this.save(userId, data);
    console.log(`[VideoLibrary] Saved "${record.title}" for ${userId} (${data.videos.length} total)`);
  }

  /**
   * Save the user's marked hooks for one video (auto-save from the editor).
   * Stored as a lean array: { title, startTime, endTime, order }.
   */
  async updateHooks(userId, jobId, hooks) {
    const data = await this.load(userId);
    const v = data.videos.find(x => x.jobId === jobId);
    if (!v) return; // video not in library (e.g. prepared before this feature)
    v.hooks = (Array.isArray(hooks) ? hooks : []).map(h => ({
      title: h.title || '',
      startTime: Number(h.startTime) || 0,
      endTime: Number(h.endTime) || 0,
      order: Number(h.order) || 0,
    }));
    await this.save(userId, data);
  }

  /**
   * Save the user's Danger Zone removal sections for one video (auto-save from
   * the editor), so reopening the project brings them back. Stored lean:
   * { title, startTime, endTime }. Checks the user's library then the public
   * one (a video may have been saved under either).
   */
  async updateCuts(userId, jobId, cuts) {
    const lean = (Array.isArray(cuts) ? cuts : []).map(c => ({
      title: c.title || '',
      startTime: Number(c.startTime) || 0,
      endTime: Number(c.endTime) || 0,
    }));
    for (const owner of [userId, null]) {
      const data = await this.load(owner);
      const v = data.videos.find(x => x.jobId === jobId);
      if (v) {
        v.cuts = lean;
        await this.save(owner, data);
        return;
      }
    }
  }

  /**
   * Save the user's voice-disguise segments for one video (auto-save). Stored
   * lean: { title, startTime, endTime, preset }.
   */
  async updateDisguise(userId, jobId, disguise) {
    const lean = (Array.isArray(disguise) ? disguise : []).map(d => ({
      title: d.title || '',
      startTime: Number(d.startTime) || 0,
      endTime: Number(d.endTime) || 0,
      preset: String(d.preset || 'deep'),
    }));
    for (const owner of [userId, null]) {
      const data = await this.load(owner);
      const v = data.videos.find(x => x.jobId === jobId);
      if (v) {
        v.disguise = lean;
        await this.save(owner, data);
        return;
      }
    }
  }

  /**
   * Save the user's added clips / CTAs for one video (auto-save from the editor),
   * so reopening the project brings them back like hooks/cuts. Stored lean:
   * { atTime: Number|null (null = at the very end), clipUrls: [String R2 urls] }.
   */
  async updateInserts(userId, jobId, inserts) {
    const lean = (Array.isArray(inserts) ? inserts : [])
      .map(p => ({
        atTime: (p.atTime === null || p.atTime === undefined) ? null : Number(p.atTime),
        clipUrls: (Array.isArray(p.clipUrls) ? p.clipUrls : []).filter(Boolean).map(String),
      }))
      .filter(p => p.clipUrls.length > 0);
    for (const owner of [userId, null]) {
      const data = await this.load(owner);
      const v = data.videos.find(x => x.jobId === jobId);
      if (v) {
        v.inserts = lean;
        await this.save(owner, data);
        return;
      }
    }
  }

  /**
   * Merge a patch into one saved video record (e.g. after re-encoding it to
   * match YouTube timestamps: new sourceKey/playbackUrl/duration/waveform +
   * a `normalized` flag). Looks in the user's library first, then the public
   * one, so it works regardless of which file the video was saved under.
   * Returns true if a record was found and updated.
   */
  async updateVideo(userId, jobId, patch) {
    for (const owner of [userId, null]) {
      const data = await this.load(owner);
      const v = data.videos.find(x => x.jobId === jobId);
      if (v) {
        Object.assign(v, patch || {});
        await this.save(owner, data);
        console.log(`[VideoLibrary] Updated ${jobId} for ${owner || 'public'}`);
        return true;
      }
    }
    return false;
  }

  async list(userId) {
    const data = await this.load(userId);
    return data.videos;
  }

  async get(userId, jobId) {
    const data = await this.load(userId);
    return data.videos.find(v => v.jobId === jobId) || null;
  }

  async remove(userId, jobId, { deleteSource = false } = {}) {
    const data = await this.load(userId);
    const target = data.videos.find(v => v.jobId === jobId);
    data.videos = data.videos.filter(v => v.jobId !== jobId);
    await this.save(userId, data);
    if (deleteSource && target?.sourceKey) {
      await r2Service.deleteFile(target.sourceKey).catch(err =>
        console.error(`[VideoLibrary] Could not delete source ${target.sourceKey}:`, err.message)
      );
    }
    console.log(`[VideoLibrary] Removed ${jobId} for ${userId}`);
  }

  // ============================================================
  // RENDERS — finished output videos, each its own downloadable "project"
  // ============================================================

  /**
   * Save a finished render. De-duped by r2Key so re-saving the same file just
   * refreshes it. Returns the stored record (with its renderId).
   */
  async addRender(userId, record) {
    if (!record || !record.downloadUrl) return null;
    const data = await this.load(userId);
    const renders = (data.renders || []).filter(r => r.r2Key !== record.r2Key);
    const entry = {
      renderId: record.renderId || uuidv4(),
      title: record.title || 'Untitled render',
      downloadUrl: record.downloadUrl,
      r2Key: record.r2Key || null,
      fileSize: record.fileSize || 0,
      duration: record.duration || 0,
      durationFormatted: record.durationFormatted || '',
      sourceJobId: record.sourceJobId || null,
      hookCount: record.hookCount || 0,
      createdAt: record.createdAt || new Date().toISOString(),
    };
    renders.unshift(entry);
    renders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    data.renders = renders.slice(0, MAX_RENDERS);
    await this.save(userId, data);
    console.log(`[VideoLibrary] Saved render "${entry.title}" for ${userId} (${data.renders.length} total)`);
    return entry;
  }

  async listRenders(userId) {
    const data = await this.load(userId);
    return data.renders || [];
  }

  async getRender(userId, renderId) {
    const data = await this.load(userId);
    return (data.renders || []).find(r => r.renderId === renderId) || null;
  }

  async removeRender(userId, renderId, { deleteFile = false } = {}) {
    const data = await this.load(userId);
    const target = (data.renders || []).find(r => r.renderId === renderId);
    data.renders = (data.renders || []).filter(r => r.renderId !== renderId);
    await this.save(userId, data);
    if (deleteFile && target?.r2Key) {
      await r2Service.deleteFile(target.r2Key).catch(err =>
        console.error(`[VideoLibrary] Could not delete render ${target.r2Key}:`, err.message)
      );
    }
    console.log(`[VideoLibrary] Removed render ${renderId} for ${userId}`);
  }
}

module.exports = new ManualVideoLibraryService();
