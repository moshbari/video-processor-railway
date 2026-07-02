/**
 * 🎬 DOC FACTORY — frame dimensions.
 *
 * Every panel image, text-card and the final video share ONE orientation so the
 * doodle fills the frame instead of being letterboxed. Both orientations are
 * full 1080p (the short side is always 1080):
 *   - landscape (16:9) -> 1920 x 1080   (the original, default)
 *   - portrait  (9:16) -> 1080 x 1920   (for Shorts / Reels / TikTok)
 */
function frameDims(orientation) {
  const o = String(orientation || 'landscape').toLowerCase();
  const portrait = o === 'portrait' || o === 'vertical' || o === '9:16';
  return portrait
    ? { W: 1080, H: 1920, portrait: true, orientation: 'portrait' }
    : { W: 1920, H: 1080, portrait: false, orientation: 'landscape' };
}

// Normalise whatever the frontend sends into 'portrait' | 'landscape'.
function normalizeOrientation(orientation) {
  return frameDims(orientation).orientation;
}

module.exports = { frameDims, normalizeOrientation };
