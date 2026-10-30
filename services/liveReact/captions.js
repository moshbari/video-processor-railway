/**
 * 🎥 LIVE REACT — captions on the reactor's talks.
 *
 * The phone times every word with AiPrompter's caption engine (Apple speech
 * for English, Soniox for Bangla, lined up against the script when there is
 * one) and sends { text, start, end, endsSentence } per word. Here we:
 *   1. move each word to its place after the talk's cuts (Oops, cut-a-bit,
 *      silences), dropping words that were cut out;
 *   2. group them into screens exactly like AiPrompter's CaptionPager;
 *   3. write an .ass file in one of AiPrompter's six designs, drawn by libass
 *      AFTER Blur Me and the colour look, so captions stay sharp and true.
 */

const path = require('path');
const fs = require('fs-extra');

const FONTS_DIR = path.join(__dirname, '..', '..', 'assets', 'fonts');
const BENGALI_FONT = 'Noto Sans Bengali';

// AiPrompter's CaptionTemplate looks (CaptionRenderer.swift). size = share of
// the video's width; stroke = black outline as a share of the font size.
const DESIGNS = {
  boldPop:   { maxWords: 3, maxChars: 18, size: 0.084, weight: 'black',    upper: true,  stroke: 0.13, active: { colour: ['FFD60A'] }, scale: 1.14 },
  colourPop: { maxWords: 2, maxChars: 14, size: 0.092, weight: 'black',    upper: true,  stroke: 0.13, active: { colour: ['39FF6A', 'FFD60A', 'FF4FD8'] }, scale: 1.10, popIn: true },
  highlight: { maxWords: 3, maxChars: 18, size: 0.072, weight: 'heavy',    upper: true,  stroke: 0,    shadow: true, active: { box: '7B4DFF' }, scale: 1.06 },
  oneWord:   { maxWords: 1, maxChars: 14, size: 0.13,  weight: 'black',    upper: true,  stroke: 0.12, active: null, scale: 1, popIn: true },
  clean:     { maxWords: 7, maxChars: 30, size: 0.05,  weight: 'semibold', upper: false, stroke: 0,    active: { colour: ['FFD60A'] }, scale: 1, band: true },
  glow:      { maxWords: 4, maxChars: 22, size: 0.066, weight: 'bold',     upper: false, stroke: 0,    shadow: true, active: { glow: '3DE8FF' }, scale: 1.05 },
};
// AiPrompter's CaptionPlacement centres.
const PLACES = { low: 0.72, middle: 0.5, high: 0.24 };
const FONT_FOR = { black: 'Poppins Black', heavy: 'Poppins ExtraBold', bold: 'Poppins', semibold: 'Poppins SemiBold' };

/** Seconds of [0, t] that the cuts removed. */
function removedBefore(t, cuts) {
  let r = 0;
  for (const [a, b] of cuts) {
    if (a >= t) break;
    r += Math.min(b, t) - a;
  }
  return r;
}

/** Words moved to their time in the cleaned talk; words that were cut out are dropped. */
function remapWords(words, cuts) {
  const out = [];
  for (const w of words || []) {
    const s = Number(w.start), e = Number(w.end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || !String(w.text || '').trim()) continue;
    const mid = (s + e) / 2;
    if (cuts.some(([a, b]) => mid >= a && mid <= b)) continue;
    const ns = s - removedBefore(s, cuts), ne = e - removedBefore(e, cuts);
    out.push({ text: String(w.text).trim(), start: ns, end: Math.max(ns + 0.05, ne), endsSentence: !!w.endsSentence });
  }
  return out;
}

/** AiPrompter's CaptionPager: screens of at most maxWords / maxChars, new screen after a sentence or a 0.7s pause. */
function pages(words, maxWords, maxChars) {
  const groups = [];
  let cur = [];
  for (const w of words) {
    const last = cur[cur.length - 1];
    if (last) {
      const chars = cur.reduce((n, x) => n + x.text.length + 1, 0) + w.text.length;
      if (cur.length >= maxWords || chars > maxChars || last.endsSentence || w.start - last.end > 0.7) {
        groups.push(cur); cur = [];
      }
    }
    cur.push(w);
  }
  if (cur.length) groups.push(cur);
  return groups.map((g, k) => {
    const lastEnd = g[g.length - 1].end;
    let end = lastEnd + 0.5;
    if (k + 1 < groups.length) end = Math.min(end, groups[k + 1][0].start);
    return { words: g, start: g[0].start, end: Math.max(end, lastEnd) };
  });
}

const assTime = (t) => {
  const c = Math.max(0, Math.round(t * 100));
  const h = Math.floor(c / 360000), m = Math.floor(c / 6000) % 60, s = Math.floor(c / 100) % 60, cs = c % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
};
/** RRGGBB → ASS &HBBGGRR& */
const col = (hex, alpha = '00') => `&H${alpha}${hex.slice(4, 6)}${hex.slice(2, 4)}${hex.slice(0, 2)}&`;
const isBengali = (s) => /[\u0980-\u09FF]/.test(s);
const esc = (s) => s.replace(/\\/g, '＼').replace(/[{}]/g, '');

/**
 * The .ass text for one talk's captions on a cw×ch picture.
 * design: one of DESIGNS, place: low|middle|high.
 */
function buildAss(words, design, place, cw, ch) {
  const d = DESIGNS[design] || DESIGNS.boldPop;
  // AiPrompter sizes the font's em to a share of the width. libass draws an
  // em of ~0.58 × its Fontsize for Poppins (measured: Fontsize 200 → capital H
  // 81px, Poppins cap height 0.697 em), so scale up to match.
  const em = cw * d.size;
  const fs0 = Math.round(em / 0.58);
  const font = FONT_FOR[d.weight];
  const bold = d.weight === 'bold' ? -1 : 0;
  const outline = d.band ? Math.round(em * 0.35) : Math.round(em * d.stroke);
  const shadow = d.shadow ? Math.max(2, Math.round(em * 0.06)) : 0;
  const border = d.band ? 3 : 1;
  const outCol = d.band ? '&H66000000&' : '&H00000000&';
  const x = Math.round(cw / 2), y = Math.round((PLACES[place] ?? PLACES.low) * ch);

  const lines = [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${cw}`, `PlayResY: ${ch}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Cap,${font},${fs0},&H00FFFFFF&,&H00FFFFFF&,${outCol},&H99000000&,${bold},0,0,0,100,100,0,0,${border},${outline},${shadow},5,${Math.round(cw * 0.06)},${Math.round(cw * 0.06)},0,1`,
    '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  let wordIndex = 0;
  for (const pg of pages(words, d.maxWords, d.maxChars)) {
    const shown = pg.words.map((w) => {
      const t = esc(d.upper && !isBengali(w.text) ? w.text.toUpperCase() : w.text);
      return isBengali(t) ? `{\\fn${BENGALI_FONT}}${t}{\\fn${font}}` : t;
    });
    // One event per "word being said", so the active word changes in step with the voice.
    const steps = d.active ? pg.words.length : 1;
    for (let i = 0; i < steps; i++) {
      const start = i === 0 ? pg.start : pg.words[i].start;
      const end = d.active && i + 1 < pg.words.length ? pg.words[i + 1].start : pg.end;
      if (end - start < 0.02) continue;
      const parts = shown.map((t, k) => {
        if (!d.active || k !== i) return t;
        const sc = d.scale !== 1 ? `\\fscx${Math.round(d.scale * 100)}\\fscy${Math.round(d.scale * 100)}` : '';
        let tag = sc;
        if (d.active.colour) tag += `\\c${col(d.active.colour[(wordIndex + k) % d.active.colour.length])}`;
        if (d.active.box) tag += `\\3c${col(d.active.box)}\\bord${Math.round(em * 0.24)}\\shad0`;
        if (d.active.glow) tag += `\\3c${col(d.active.glow)}\\bord${Math.max(2, Math.round(em * 0.07))}\\blur${Math.round(em * 0.18)}`;
        return `{${tag}}${t}{\\r}`;
      });
      const pop = d.popIn && i === 0 ? '\\fscx80\\fscy80\\t(0,120,\\fscx100\\fscy100)' : '';
      lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Cap,,0,0,0,,{\\an5\\pos(${x},${y})${pop}}${parts.join(' ')}`);
    }
    wordIndex += pg.words.length;
  }
  return lines.join('\n') + '\n';
}

/** Writes the captions for one talk; returns the ffmpeg filter that draws them, or '' if none. */
async function captionFilter(words, design, place, cw, ch, outPath) {
  if (!words || !words.length) return '';
  await fs.writeFile(outPath, buildAss(words, design, place, cw, ch));
  const q = (p) => p.replace(/\\/g, '/').replace(/'/g, "\\'").replace(/:/g, '\\:');
  return `ass='${q(outPath)}':fontsdir='${q(FONTS_DIR)}'`;
}

module.exports = { remapWords, pages, buildAss, captionFilter, DESIGNS, PLACES };
