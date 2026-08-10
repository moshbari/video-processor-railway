/**
 * 📋 The Podcast Brain report.
 *
 * Everything the brain worked out that isn't literally a hook range or a cut
 * range: the cold-open running order, the bench, the USE WITH CARE flags, the
 * moment map, and any place the code overruled the model. The editor shows this
 * in a collapsible panel beside the video so Mosh can swap slots by hand.
 *
 * It is markdown because he reads it; the machine-usable parts already went into
 * the hooks and cuts queues.
 */

const { toTimecode } = require('./timecode');

function fmtRange(a, b) {
  return `${toTimecode(a)}-${toTimecode(b)}`;
}

function coldOpenSection(coldOpen) {
  if (!coldOpen?.coldOpen?.length) return '';
  const rows = coldOpen.coldOpen
    .map(e => `${String(e.slot).padStart(2, ' ')}. ${String(e.slotName || '').padEnd(10)} "${e.quote}"   ${e.start}-${e.end}   (${e.durationSec}s)`)
    .join('\n');

  const total = coldOpen.totalSec;
  const warn = (total < 60 || total > 90)
    ? `\n\n> ⚠️ Total is ${total}s — outside the 60-90s target.`
    : '';

  const notes = coldOpen.notes?.length
    ? `\n\n**Slots that could not be filled honestly:**\n${coldOpen.notes.map(n => `- ${n}`).join('\n')}`
    : '';

  return `## 🎬 Cold open — the montage running order

\`\`\`
COLD OPEN   (total: ${total}s)
${rows}
\`\`\`

**Arc:** ${coldOpen.arc || '—'}${warn}${notes}

These ten are tagged \`CO-1\`…\`CO-10\` in the hooks queue, so you can spot them
while you delete the rest down.`;
}

function benchSection(coldOpen) {
  if (!coldOpen?.bench?.length) return '';
  const rows = coldOpen.bench
    .map(b => `| "${b.quote}" | ${b.speaker || '—'} | ${b.start}-${b.end} | ${b.couldFill || '—'} |`)
    .join('\n');
  return `## 🪑 Bench — spares you can swap into any slot

| Quote | Speaker | Timestamp | Could fill |
|---|---|---|---|
${rows}`;
}

function careSection(coldOpen) {
  if (!coldOpen?.useWithCare?.length) return '';
  const rows = coldOpen.useWithCare.map(u => `- **"${u.quote}"** — ${u.why}`).join('\n');
  return `## ⚠️ Use with care

Spicy but risky as standalone clips. Flagged rather than dropped — your call.

${rows}`;
}

function hooksSection(hooksPass, hooks) {
  if (!hooksPass?.hooks?.length) return '';
  const byN = new Map(hooks.map(h => [h._n, h]));
  const rows = hooksPass.hooks
    .map(h => {
      const built = byN.get(h.n);
      const co = built?._coldOpenSlot ? `CO-${built._coldOpenSlot}` : '';
      const dropped = built ? '' : ' ❌ unusable timestamp';
      return `| ${h.n} | "${h.quote}" | ${h.speaker || '—'} | ${h.start}-${h.end} | ${h.rating}/5 | ${h.bucket} | ${co}${dropped} |`;
    })
    .join('\n');

  const total = hooksPass.hooks.length;
  const bucketB = hooksPass.hooks.filter(h => h.bucket === 'B').length;
  const pct = total ? Math.round((bucketB / total) * 100) : 0;
  const warn = pct < 40 ? `\n\n> ⚠️ Only ${pct}% Bucket B (target is at least 40%).` : '';

  return `## 🎣 All hooks (${total}, ${pct}% Bucket B)${warn}

| # | Hook | Speaker | Timestamp | Rating | Bucket | Cold open |
|---|---|---|---|---|---|---|
${rows}`;
}

function cutsSection(cutsPass, cuts, adjustments) {
  const lines = [];
  lines.push(`## ✂️ Cuts (${cuts.length} after merging)`);

  if (cutsPass?.hardCloseFound === false) {
    lines.push(`\n> ${cutsPass.hardCloseNote || 'No hard close found in this call.'}`);
  }

  if (cuts.length) {
    lines.push('\n| # | What | Timestamp |\n|---|---|---|');
    lines.push(cuts.map((c, i) => `| ${i + 1} | ${c.title} | ${fmtRange(c.startTime, c.endTime)} |`).join('\n'));
  }

  if (adjustments.length) {
    lines.push(`\n### Changed to protect hooks\n\nA cut is never allowed to swallow a hook — the cold open teases the moment, the body has to pay it off.\n`);
    lines.push(adjustments.map(a => `- ${a}`).join('\n'));
  }

  if (cutsPass?.endFlow) {
    lines.push(`\n### How the episode now ends\n\n${cutsPass.endFlow}`);
  }

  return lines.join('\n');
}

function momentMapSection(momentMap) {
  if (!momentMap?.map?.length) return '';
  const rows = momentMap.map.map(m => `| ${m.movement} | ${m.beat} | ${m.start} |`).join('\n');

  let warn = '';
  if (momentMap.unplaceable?.length) {
    warn = `\n\n> ⚠️ **${momentMap.unplaceable.length} movement(s) could not be found in the transcript.** These may be invented — check before posting:\n${momentMap.unplaceable.map(u => `> - **${u.movement}**: ${u.beat} — ${u.why}`).join('\n')}`;
  }

  const attribution = momentMap.attributionCheck
    ? `\n\n**Quote attribution check:** ${momentMap.attributionCheck}`
    : '';

  return `## 🗺️ Moment map — every beat of the post, and where it happened

| Movement | Beat | Timestamp |
|---|---|---|
${rows}${warn}${attribution}`;
}

function variationsSection(variations) {
  if (!variations) return '';
  return `## ✍️ First-line variations\n\n${variations}`;
}

/**
 * Build the whole report. Sections that have no content are skipped rather than
 * printed empty — a failed pass should look obviously absent, not look like a
 * pass that found nothing.
 */
function buildReport({ hooksPass, hooks, coldOpenPass, cutsPass, cuts, adjustments, momentMap, variations, failures, videoTitle }) {
  const parts = [
    `# 🎙️ Podcast Brain — ${videoTitle || 'episode'}`,
    hooksPass?.summary ? `${hooksPass.summary}` : '',
    coldOpenSection(coldOpenPass),
    hooksSection(hooksPass, hooks),
    benchSection(coldOpenPass),
    careSection(coldOpenPass),
    cutsSection(cutsPass, cuts, adjustments),
    momentMapSection(momentMap),
    variationsSection(variations),
  ];

  if (failures?.length) {
    parts.push(`## ❌ Passes that failed\n\n${failures.map(f => `- **${f.pass}**: ${f.error}`).join('\n')}\n\nThe rest of the report is still usable. Re-run to try these again.`);
  }

  return parts.filter(Boolean).join('\n\n---\n\n');
}

module.exports = { buildReport };
