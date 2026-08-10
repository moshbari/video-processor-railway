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
   * Find the video record for a jobId, checking the user's own library first and
   * the shared "public" one second (a video may have been prepared before the
   * user signed in). Returns { owner, data, video } or null when it's nowhere.
   *
   * Every update* method goes through this so they all agree on where a video
   * lives. They used to disagree — updateHooks looked only in the user's library
   * while updateCuts checked both — which meant a video prepared anonymously
   * would silently keep its cuts and silently lose its hooks.
   */
  async _findVideo(userId, jobId) {
    for (const owner of [userId, null]) {
      const data = await this.load(owner);
      const video = data.videos.find(x => x.jobId === jobId);
      if (video) return { owner, data, video };
    }
    return null;
  }

  /**
   * Save the user's marked hooks for one video (auto-save from the editor).
   * Stored as a lean array: { title, startTime, endTime, order }.
   *
   * Returns true when the hooks were stored, false when the video isn't in the
   * library yet. Anything writing hooks automatically (rather than from a person
   * clicking in the editor) MUST check this — a false here is the difference
   * between "saved" and "silently thrown away".
   */
  async updateHooks(userId, jobId, hooks) {
    const found = await this._findVideo(userId, jobId);
    if (!found) return false; // video not in library (e.g. still being prepared)
    found.video.hooks = (Array.isArray(hooks) ? hooks : []).map(h => ({
      title: h.title || '',
      startTime: Number(h.startTime) || 0,
      endTime: Number(h.endTime) || 0,
      order: Number(h.order) || 0,
    }));
    await this.save(found.owner, found.data);
    return true;
  }

  /**
   * Save the user's Danger Zone removal sections for one video (auto-save from
   * the editor), so reopening the project brings them back. Stored lean:
   * { title, startTime, endTime }. Checks the user's library then the public
   * one (a video may have been saved under either).
   */
  async updateCuts(userId, jobId, cuts) {
    const found = await this._findVideo(userId, jobId);
    if (!found) return false;
    found.video.cuts = (Array.isArray(cuts) ? cuts : []).map(c => ({
      title: c.title || '',
      startTime: Number(c.startTime) || 0,
      endTime: Number(c.endTime) || 0,
    }));
    await this.save(found.owner, found.data);
    return true;
  }

  /**
   * Save the Facebook/social post the Podcast Brain wrote for this episode.
   * Plain text (usually Bengali, ~3,000 words) — the editor shows it in a copy box.
   */
  async updateSocialPost(userId, jobId, socialPost) {
    const found = await this._findVideo(userId, jobId);
    if (!found) return false;
    found.video.socialPost = typeof socialPost === 'string' ? socialPost : '';
    await this.save(found.owner, found.data);
    return true;
  }

  /**
   * Save the full Podcast Brain report (markdown): the hooks table, the cold-open
   * montage, the bench, USE WITH CARE flags and the moment map. Everything the
   * brain produced that isn't directly a hook or a cut lives here so Mosh can
   * read it beside the video and swap slots by hand.
   */
  async updateBrainReport(userId, jobId, report) {
    const found = await this._findVideo(userId, jobId);
    if (!found) return false;
    found.video.brainReport = typeof report === 'string' ? report : '';
    await this.save(found.owner, found.data);
    return true;
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
   * 🎬 Save the user's intro clip (a fetched R2 url that plays at the very start
   * of the final video) for one video, so reopening the project brings it back.
   */
  async updateIntro(userId, jobId, introUrl, introLabel) {
    const url = introUrl ? String(introUrl) : null;
    const label = String(introLabel || '').slice(0, 200);
    for (const owner of [userId, null]) {
      const data = await this.load(owner);
      const v = data.videos.find(x => x.jobId === jobId);
      if (v) {
        v.introUrl = url;
        v.introLabel = url ? label : '';
        await this.save(owner, data);
        return;
      }
    }
  }

  /**
   * 📺 Save the user's animated lower-third CTA overlays for one video
   * (auto-save from the editor), so reopening the project brings them back.
   * Stored lean: { style, line1, line2, startSec, endSec, stay, auto }.
   * `auto` marks the ones Auto-place dropped, so reopening the project lets the
   * editor re-space that batch instead of piling a second set on top.
   */
  async updateLowerThirds(userId, jobId, lowerThirds) {
    const lean = (Array.isArray(lowerThirds) ? lowerThirds : [])
      .map(lt => ({
        style: String(lt.style || 'bar'),
        line1: String(lt.line1 || '').slice(0, 120),
        line2: String(lt.line2 || '').slice(0, 120),
        startSec: Math.max(0, Number(lt.startSec ?? lt.startTime) || 0),
        endSec: (lt.endSec === null || lt.endSec === undefined) ? null : Number(lt.endSec),
        stay: !!lt.stay,
        auto: !!lt.auto,
      }))
      .filter(lt => lt.line1.trim() || lt.line2.trim());
    for (const owner of [userId, null]) {
      const data = await this.load(owner);
      const v = data.videos.find(x => x.jobId === jobId);
      if (v) {
        v.lowerThirds = lean;
        await this.save(owner, data);
        return;
      }
    }
  }

  /**
   * 🎙️ Save the user's ReVoice sections for one video (auto-save from the
   * editor), so a refresh/reopen brings back every marked section AND its
   * recorded clip. The recordings already live in R2, so we only store their
   * URLs here. Stored lean: { title, startTime, endTime, audioUrl,
   * audioDuration, align, mode, fitMode }.
   */
  async updateRevoice(userId, jobId, revoice) {
    const lean = (Array.isArray(revoice) ? revoice : [])
      .map(r => ({
        title: r.title || '',
        startTime: Number(r.startTime) || 0,
        endTime: Number(r.endTime) || 0,
        audioUrl: r.audioUrl ? String(r.audioUrl) : null,
        audioDuration: Number(r.audioDuration) || 0,
        align: r.align === 'end' ? 'end' : 'start',
        mode: r.mode === 'overlay' ? 'overlay' : 'replace',
        fitMode: ['speed', 'trim', 'none'].includes(r.fitMode) ? r.fitMode : 'auto',
        source: r.source === 'ai' ? 'ai' : r.source === 'recording' ? 'recording' : null,
        provider: r.provider ? String(r.provider) : null,
        voiceName: r.voiceName ? String(r.voiceName) : null,
        createdAt: Number(r.createdAt) || null,
      }))
      .filter(r => r.audioUrl && r.endTime > r.startTime);
    for (const owner of [userId, null]) {
      const data = await this.load(owner);
      const v = data.videos.find(x => x.jobId === jobId);
      if (v) {
        v.revoice = lean;
        await this.save(owner, data);
        return;
      }
    }
  }

  /**
   * 🖼️ Save the user's background-image sections for one video (auto-save from
   * the editor), so a refresh/reopen brings back every section: its time range,
   * the uploaded background image (which already lives in R2 — we only store its
   * URL + key), the fit mode, and where the user dragged/sized the video overlay.
   * Stored lean: { title, startSec, endSec, imageUrl, imageKey, fitMode,
   * pip: { xPct, yPct, wPct } }. We keep `imageKey` so deleting the project can
   * sweep the images too.
   */
  async updateBackgroundSections(userId, jobId, sections) {
    const clamp01 = (n, d) => {
      const x = Number(n);
      return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : d;
    };
    const lean = (Array.isArray(sections) ? sections : [])
      .map(s => ({
        title: String(s.title || '').slice(0, 120),
        startSec: Math.max(0, Number(s.startSec ?? s.startTime) || 0),
        endSec: Math.max(0, Number(s.endSec ?? s.endTime) || 0),
        imageUrl: s.imageUrl ? String(s.imageUrl) : null,
        imageKey: s.imageKey ? String(s.imageKey) : null,
        fitMode: s.fitMode === 'original' ? 'original' : 'fit',
        pip: {
          xPct: clamp01(s.pip?.xPct, 0.62),
          yPct: clamp01(s.pip?.yPct, 0.6),
          wPct: clamp01(s.pip?.wPct, 0.34),
        },
      }))
      .filter(s => s.imageUrl && s.endSec > s.startSec);
    for (const owner of [userId, null]) {
      const data = await this.load(owner);
      const v = data.videos.find(x => x.jobId === jobId);
      if (v) {
        v.backgroundSections = lean;
        await this.save(owner, data);
        return;
      }
    }
  }

  /**
   * 🔧 Save the editor's on/off toggles for one video (auto-save), so reopening
   * the project brings them back like every other setting. Currently the two
   * booleans that live outside the segment lists: `removeSilences` (auto-cut
   * quiet gaps) and `levelAudio` (even out speaker volumes). Only the keys that
   * are actually provided are written, so saving one toggle never clobbers the
   * other.
   */
  async updateSettings(userId, jobId, settings) {
    const s = settings && typeof settings === 'object' ? settings : {};
    for (const owner of [userId, null]) {
      const data = await this.load(owner);
      const v = data.videos.find(x => x.jobId === jobId);
      if (v) {
        if ('removeSilences' in s) v.removeSilences = !!s.removeSilences;
        if ('levelAudio' in s) v.levelAudio = !!s.levelAudio;
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

  /**
   * Like get(), but falls back to the shared "public" library — the same
   * user-then-public lookup every update* method does. Use this anywhere you
   * need to READ a video that might have been prepared before the user signed in.
   */
  async getAnywhere(userId, jobId) {
    const found = await this._findVideo(userId, jobId);
    return found ? found.video : null;
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
      // Sweep any background images the user uploaded for this project too, so
      // deleting the project frees them immediately (they'd expire via the R2
      // lifecycle anyway, but don't wait for that).
      for (const bg of (Array.isArray(target.backgroundSections) ? target.backgroundSections : [])) {
        if (bg && bg.imageKey) {
          await r2Service.deleteFile(bg.imageKey).catch(err =>
            console.error(`[VideoLibrary] Could not delete background ${bg.imageKey}:`, err.message)
          );
        }
      }
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
