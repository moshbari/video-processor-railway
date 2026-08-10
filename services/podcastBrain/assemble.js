/**
 * 🧩 Turn the five passes into the two lists the editor actually renders.
 *
 * The passes run independently, so nothing has reconciled them yet. This file
 * does that reconciliation, and it is where Mosh's editing rules stop being
 * prose in a prompt and become something the code guarantees.
 */

const { normalizeRange, mergeRanges, toTimecode } = require('./timecode');

/** Slot names in cold-open order, used to tag hooks that made the montage. */
const SLOT_NAMES = ['JAB', 'TABOO', 'FEAR', 'NUMBER', 'CONFESSION', 'FAILURE', 'MIRROR', 'FUNNY', 'GUT-PUNCH', 'COMMAND'];

/**
 * Build the hooks queue.
 *
 * Mosh wants ALL the hooks in the queue (18-32 of them) so he can delete down in
 * the editor rather than hunt for the ones he wants. The editor concatenates the
 * queue in `order` in front of the video, so the order here is the order he'd
 * hear if he rendered without trimming — table order, best-rated first.
 *
 * The ten that pass B chose for the cold open get their slot stamped into the
 * title ("CO-1 JAB"), so while he deletes down he can see at a glance which rows
 * form the montage. Titles are written straight to the library, not pasted, so
 * they survive verbatim.
 */
function buildHooks({ hooksPass, coldOpenPass, videoDuration }) {
  const bySlot = new Map();
  for (const entry of coldOpenPass?.coldOpen || []) {
    const n = Number(entry.hookN);
    if (Number.isFinite(n)) {
      const slot = Number(entry.slot);
      const name = entry.slotName || SLOT_NAMES[slot - 1] || '';
      bySlot.set(n, { slot, name });
    }
  }

  const hooks = [];
  let order = 0;
  for (const raw of hooksPass?.hooks || []) {
    const range = normalizeRange(raw, videoDuration);
    if (!range) continue;

    const quote = String(raw.quote || '').replace(/\s+/g, ' ').trim();
    const co = bySlot.get(Number(raw.n));
    const parts = [];
    if (co) parts.push(`CO-${co.slot} ${co.name}`.trim());
    if (raw.rating) parts.push(`★${raw.rating}`);
    if (raw.bucket) parts.push(raw.bucket);
    const tag = parts.length ? `[${parts.join(' · ')}] ` : '';

    hooks.push({
      title: `${tag}${quote}`.slice(0, 200),
      startTime: range.startTime,
      endTime: range.endTime,
      order: order++,
      // Kept for the report, stripped before the payload goes to the library.
      _n: raw.n,
      _coldOpenSlot: co ? co.slot : null,
    });
  }
  return hooks;
}

/**
 * Subtract the protected ranges from one cut, returning 0, 1 or 2 pieces.
 *
 * Mosh's rule is "never cut a section containing a hook — if a cut touches a
 * hook, end the cut where the hook starts". The reason matters: the cold open
 * teases a moment and the body pays it off. Cut the moment out of the body and
 * the tease has nothing behind it.
 *
 * His wording truncates the cut, which throws away the part after the hook too.
 * Subtracting the hook out of the middle honours the same rule and keeps more of
 * the cut, so that is what happens here.
 */
function subtractOne(cut, protectedRanges) {
  let pieces = [{ ...cut }];
  for (const p of protectedRanges) {
    const next = [];
    for (const piece of pieces) {
      if (p.endTime <= piece.startTime || p.startTime >= piece.endTime) {
        next.push(piece);
        continue;
      }
      if (p.startTime > piece.startTime) {
        next.push({ ...piece, endTime: p.startTime, _clipped: true });
      }
      if (p.endTime < piece.endTime) {
        next.push({ ...piece, startTime: p.endTime, _clipped: true });
      }
    }
    pieces = next;
    if (!pieces.length) break;
  }
  // A sliver left over after subtraction isn't worth a cut point.
  return pieces.filter(p => p.endTime - p.startTime >= 1);
}

/**
 * Build the Danger Zone cut list: normalise, merge overlaps, then carve the
 * hooks back out. Returns the cuts plus a note of what the hook rule changed, so
 * the report can tell Mosh rather than silently editing his cut list.
 */
function buildCuts({ cutsPass, hooks, videoDuration }) {
  const raw = [];
  for (const row of cutsPass?.cuts || []) {
    const range = normalizeRange(row, videoDuration);
    if (!range) continue;
    const what = String(row.what || '').replace(/\s+/g, ' ').trim();
    const kind = row.kind === 'hardclose' ? 'hardclose' : 'flow';
    raw.push({
      title: `${kind === 'hardclose' ? '[hard close] ' : ''}${what}`.slice(0, 200),
      startTime: range.startTime,
      endTime: range.endTime,
    });
  }

  const merged = mergeRanges(raw, 1);

  const protectedRanges = hooks.map(h => ({ startTime: h.startTime, endTime: h.endTime }));
  const kept = [];
  const adjustments = [];
  for (const cut of merged) {
    const pieces = subtractOne(cut, protectedRanges);
    if (!pieces.length) {
      adjustments.push(`Dropped "${cut.title}" (${toTimecode(cut.startTime)}-${toTimecode(cut.endTime)}) — it was entirely inside hook material.`);
      continue;
    }
    if (pieces.some(p => p._clipped)) {
      adjustments.push(`Trimmed "${cut.title}" (${toTimecode(cut.startTime)}-${toTimecode(cut.endTime)}) around a hook — now ${pieces.map(p => `${toTimecode(p.startTime)}-${toTimecode(p.endTime)}`).join(', ')}.`);
    }
    for (const p of pieces) {
      delete p._clipped;
      kept.push(p);
    }
  }

  return { cuts: mergeRanges(kept, 0), adjustments };
}

/**
 * Stitch the model's post body onto the CTA. The CTA is a constant (see
 * prompts/shared.js) because Mosh's rule is that it is appended verbatim.
 */
function buildSocialPost({ postBody, ctaBlock }) {
  const body = String(postBody || '').trim();
  if (!body) return '';
  return `${body}\n\n---\n\n${ctaBlock}`;
}

module.exports = { buildHooks, buildCuts, buildSocialPost, subtractOne, SLOT_NAMES };
