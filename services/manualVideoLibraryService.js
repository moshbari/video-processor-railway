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
 *   { videos: [ { jobId, title, duration, durationFormatted, sourceKey,
 *                 playbackUrl, waveformPeaks, fileSize, createdAt } ] }
 */

const r2Service = require('./r2Service');

const MAX_VIDEOS = 50; // keep the most recent N per user

class ManualVideoLibraryService {
  _key(userId) {
    return `manual-clip-library/${userId || 'public'}.json`;
  }

  async load(userId) {
    try {
      const buf = await r2Service.getFile(this._key(userId));
      if (!buf) return { videos: [] };
      const data = JSON.parse(buf.toString('utf-8'));
      return { videos: Array.isArray(data.videos) ? data.videos : [] };
    } catch (err) {
      console.error(`[VideoLibrary] Load failed for ${userId}:`, err.message);
      return { videos: [] };
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
}

module.exports = new ManualVideoLibraryService();
