/**
 * 🎬 DOC FACTORY — programmatic TEXT-CARD renderer.
 *
 * Many panels in this format are just a bold word/number on a flat color
 * (e.g. "SUMMER: 12 HRS", "FIRST SLEEP"). Those need no AI image at all — we
 * draw them with ffmpeg `drawtext`, free and instant, perfectly consistent.
 *
 * Uses the same fontless drawtext approach the existing renderService relies on
 * (the container's default fontconfig face). Set DOC_FACTORY_FONT to a .ttf to
 * force a specific face (used locally on macOS where there is no default).
 */

const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const W = 1920;
const H = 1080;

// Readable text color for each background.
function textColor(bgHex) {
  const hex = String(bgHex || '#ffffff').replace('#', '');
  const r = parseInt(hex.slice(0, 2), 16) || 0;
  const g = parseInt(hex.slice(2, 4), 16) || 0;
  const b = parseInt(hex.slice(4, 6), 16) || 0;
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luma < 140 ? '#ffffff' : '#111111'; // light text on dark bg, dark on light
}

// Wrap a callout into lines of at most `maxChars`, breaking on spaces.
function wrap(text, maxChars) {
  const words = String(text || '').trim().split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (!line) line = w;
    else if ((line + ' ' + w).length <= maxChars) line += ' ' + w;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/**
 * Render one text-card PNG.
 * @param {{callout:string, bgHex?:string, outPath:string}} opts
 * @returns {Promise<string>} outPath
 */
function renderTextCard({ callout, bgHex, outPath }) {
  return new Promise(async (resolve, reject) => {
    const bg = bgHex || '#ffffff';
    const fg = textColor(bg);
    const lines = wrap((callout || '').toUpperCase(), 16);
    // Scale font to the longest line + line count so big words fill the frame
    // and long ones still fit.
    const longest = lines.reduce((m, l) => Math.max(m, l.length), 1);
    let fontsize = Math.round(Math.min(220, Math.max(70, 1500 / longest)));
    if (lines.length >= 4) fontsize = Math.min(fontsize, 120);

    await fs.ensureDir(path.dirname(outPath));
    const txtFile = path.join(os.tmpdir(), `dfcard-${Date.now()}-${Math.round(process.hrtime()[1] / 1e3)}.txt`);
    await fs.writeFile(txtFile, lines.join('\n'), 'utf8');

    const fontArg = process.env.DOC_FACTORY_FONT ? `fontfile='${process.env.DOC_FACTORY_FONT}':` : '';
    const draw =
      `drawtext=${fontArg}textfile='${txtFile}':fontcolor=${fg}:fontsize=${fontsize}:` +
      `borderw=${Math.max(2, Math.round(fontsize / 24))}:bordercolor=${fg === '#ffffff' ? 'black@0.35' : 'white@0.5'}:` +
      `line_spacing=${Math.round(fontsize / 6)}:x=(w-text_w)/2:y=(h-text_h)/2`;

    const args = [
      '-y',
      '-f', 'lavfi', '-i', `color=c=${bg}:s=${W}x${H}`,
      '-vf', draw,
      '-frames:v', '1',
      outPath,
    ];
    const child = spawn(FFMPEG, args);
    let err = '';
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => { fs.remove(txtFile).catch(() => {}); reject(new Error(`ffmpeg text-card failed: ${e.message}`)); });
    child.on('close', (code) => {
      fs.remove(txtFile).catch(() => {});
      if (code === 0) resolve(outPath);
      else reject(new Error(`ffmpeg text-card exited ${code}: ${err.slice(-300)}`));
    });
  });
}

module.exports = { renderTextCard, textColor, wrap, W, H };
