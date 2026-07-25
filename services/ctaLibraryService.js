/**
 * ⭐ SAVED CTA LINKS (per user)
 *
 * A tiny address book of the CTA clips a user re-uses in every podcast, so they
 * never paste the same GoHighLevel / Tella link twice. It stores ONLY links —
 * no video files are copied or kept anywhere by this service. Picking a saved
 * CTA simply feeds its link into the normal fetch-clip flow, exactly as if the
 * user had pasted it.
 *
 * R2 layout: cta-library/{userId}.json
 *   { ctas: [ { id, name, url, note, durationFormatted, useCount,
 *               createdAt, lastUsedAt } ] }
 *
 * Unlimited entries per user (the file is a few KB even with hundreds).
 */

const r2Service = require('./r2Service');
const crypto = require('crypto');

const MAX_NAME = 80;
const MAX_URL = 2000;

class CtaLibraryService {
  _key(userId) {
    return `cta-library/${userId || 'public'}.json`;
  }

  async load(userId) {
    try {
      const buf = await r2Service.getFile(this._key(userId));
      if (!buf) return { ctas: [] };
      const data = JSON.parse(buf.toString('utf-8'));
      return { ctas: Array.isArray(data.ctas) ? data.ctas : [] };
    } catch (err) {
      console.error(`[CtaLibrary] Load failed for ${userId}:`, err.message);
      return { ctas: [] };
    }
  }

  async save(userId, data) {
    const buf = Buffer.from(JSON.stringify(data), 'utf-8');
    await r2Service.uploadBuffer(buf, this._key(userId), 'application/json');
  }

  async list(userId) {
    const { ctas } = await this.load(userId);
    return ctas;
  }

  /**
   * Add one saved CTA link. Only http(s) links are accepted (GoHighLevel media,
   * Tella, Drive, YouTube… anything the clip fetcher already understands). The
   * same link twice just refreshes the existing entry's name instead of piling
   * up duplicates.
   */
  async add(userId, { name, url, note, durationFormatted } = {}) {
    const cleanUrl = String(url || '').trim();
    if (!cleanUrl) throw new Error('Please paste the CTA link you want to save.');
    if (!/^https?:\/\//i.test(cleanUrl)) {
      throw new Error('That does not look like a link. Paste the full link starting with https://');
    }
    if (cleanUrl.length > MAX_URL) throw new Error('That link is too long to save.');

    const cleanName = String(name || '').trim().slice(0, MAX_NAME) || this._nameFromUrl(cleanUrl);
    const data = await this.load(userId);

    const existing = data.ctas.find(c => c.url === cleanUrl);
    if (existing) {
      existing.name = cleanName;
      if (note !== undefined) existing.note = String(note || '').slice(0, 200);
      if (durationFormatted) existing.durationFormatted = durationFormatted;
      await this.save(userId, data);
      console.log(`[CtaLibrary] Refreshed "${cleanName}" for ${userId}`);
      return existing;
    }

    const cta = {
      id: crypto.randomUUID(),
      name: cleanName,
      url: cleanUrl,
      note: String(note || '').slice(0, 200),
      durationFormatted: durationFormatted || '',
      useCount: 0,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    data.ctas.unshift(cta);
    await this.save(userId, data);
    console.log(`[CtaLibrary] Saved "${cleanName}" for ${userId} (${data.ctas.length} total)`);
    return cta;
  }

  /** Rename / re-link one saved CTA. */
  async update(userId, id, patch = {}) {
    const data = await this.load(userId);
    const cta = data.ctas.find(c => c.id === id);
    if (!cta) throw new Error('That saved CTA is no longer there.');

    if (patch.name !== undefined) {
      const cleanName = String(patch.name || '').trim().slice(0, MAX_NAME);
      if (!cleanName) throw new Error('Please give this CTA a name.');
      cta.name = cleanName;
    }
    if (patch.url !== undefined) {
      const cleanUrl = String(patch.url || '').trim();
      if (!/^https?:\/\//i.test(cleanUrl)) {
        throw new Error('That does not look like a link. Paste the full link starting with https://');
      }
      cta.url = cleanUrl.slice(0, MAX_URL);
    }
    if (patch.note !== undefined) cta.note = String(patch.note || '').slice(0, 200);

    await this.save(userId, data);
    return cta;
  }

  /** Forget one saved CTA (the link only — nothing else is touched). */
  async remove(userId, id) {
    const data = await this.load(userId);
    const before = data.ctas.length;
    data.ctas = data.ctas.filter(c => c.id !== id);
    if (data.ctas.length === before) return false;
    await this.save(userId, data);
    console.log(`[CtaLibrary] Removed a saved CTA for ${userId} (${data.ctas.length} left)`);
    return true;
  }

  /**
   * Bump usage stats when a saved CTA is actually used, so the most-used ones
   * can float to the top of the picker. Never allowed to break the flow.
   */
  async touch(userId, id) {
    try {
      const data = await this.load(userId);
      const cta = data.ctas.find(c => c.id === id);
      if (!cta) return;
      cta.useCount = (cta.useCount || 0) + 1;
      cta.lastUsedAt = new Date().toISOString();
      await this.save(userId, data);
    } catch (err) {
      console.error('[CtaLibrary] touch failed:', err.message);
    }
  }

  // "https://storage.gohighlevel.com/.../my-offer-cta.mp4" → "my offer cta"
  _nameFromUrl(url) {
    try {
      const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
      const base = last.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[-_]+/g, ' ').trim();
      return (base || 'Saved CTA').slice(0, MAX_NAME);
    } catch {
      return 'Saved CTA';
    }
  }
}

module.exports = new CtaLibraryService();
