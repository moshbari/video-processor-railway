/**
 * 🎬 DOC FACTORY — image layer.
 *
 * Each panel gets one image. There are three ways to fill them (Mosh wants both
 * API and manual, Book-Factory style):
 *   - text-card  -> rendered programmatically by ffmpeg drawtext (free, instant)
 *   - manual     -> the user generates in ChatGPT and uploads (handled in routes)
 *   - api        -> auto-generated from the doodle prompt (OpenAI gpt-image-1,
 *                   reusing the OPENAI_API_KEY this backend already has)
 *
 * Everything lands in R2 under docfactory/{id}/img_{n}.png and the panel's
 * `image` field is set to the public URL.
 */

const os = require('os');
const path = require('path');
const fs = require('fs-extra');
const r2Service = require('../r2Service');
const { renderTextCard } = require('./textCard');

const IMG_W = 1920;
const IMG_H = 1080;

function r2KeyForImage(id, n) {
  return `docfactory/${id}/img_${String(n).padStart(3, '0')}.png`;
}

// ---- text-card: ffmpeg drawtext -> R2 -------------------------------------
async function renderTextCardPanel(project, panel) {
  const tmp = path.join(os.tmpdir(), `df-${project.id}-card-${panel.n}.png`);
  await renderTextCard({ callout: panel.callout || '', bgHex: panel.bgHex, outPath: tmp });
  const up = await r2Service.uploadBuffer(await fs.readFile(tmp), r2KeyForImage(project.id, panel.n), 'image/png');
  fs.remove(tmp).catch(() => {});
  panel.image = up.url;
  panel.imageSource = 'text-card';
  return panel;
}

// ---- api: OpenAI gpt-image-1 from the doodle prompt -> R2 ------------------
async function generateApiImage(project, panel) {
  if (!process.env.OPENAI_API_KEY) throw new Error('No image API configured (set OPENAI_API_KEY) — use manual upload instead.');
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const bgName = panel.bg === 'night' ? 'solid dark navy blue' : panel.bg === 'parchment' ? 'solid warm parchment cream' : 'solid white';
  const base = panel.doodlePrompt || `${project.style_bible} Scene: ${panel.narration}`;
  const prompt = `${base} Background: ${bgName}, flat, no border. 16:9 framing.`;
  const resp = await client.images.generate({
    model: 'gpt-image-1',
    prompt,
    size: '1536x1024', // closest 3:2 landscape; assembler pads to 16:9
    quality: process.env.DOC_FACTORY_IMG_QUALITY || 'medium', // doodles are line art; 'medium' is plenty and ~3x cheaper than 'high'
    n: 1,
  });
  const b64 = resp.data && resp.data[0] && resp.data[0].b64_json;
  if (!b64) throw new Error('Image API returned no image.');
  const buffer = Buffer.from(b64, 'base64');
  const up = await r2Service.uploadBuffer(buffer, r2KeyForImage(project.id, panel.n), 'image/png');
  panel.image = up.url;
  panel.imageSource = 'api';
  return panel;
}

// ---- manual: store an uploaded file buffer for panel n -> R2 --------------
async function storeUploadedImage(project, n, buffer, mime) {
  const ext = (mime && mime.includes('jpeg')) ? '.jpg' : '.png';
  const key = `docfactory/${project.id}/img_${String(n).padStart(3, '0')}${ext}`;
  const up = await r2Service.uploadBuffer(buffer, key, mime || 'image/png');
  const panel = project.panels.find((p) => p.n === Number(n));
  if (panel) { panel.image = up.url; panel.imageSource = 'manual'; }
  return up.url;
}

/**
 * Every panel now has a doodle (emphasis panels included — their bold word is
 * overlaid on the doodle by the assembler). If mode==='api' we generate those
 * doodles; if mode==='manual' we leave them for the user's ChatGPT uploads. The
 * rare panel with no doodlePrompt falls back to a plain text-card (free).
 * Returns { textCards, generated, pendingManual }.
 */
async function fillImages(project, { mode = 'manual', limit = Infinity, onProgress } = {}) {
  let textCards = 0, generated = 0, pendingManual = 0;
  for (const panel of project.panels) {
    if (panel.image) continue; // already filled (e.g. a prior partial run)
    // Every panel should have a doodle now (emphasis panels included). Only the
    // rare panel with NO doodlePrompt falls back to a plain text-card.
    if (!panel.doodlePrompt) {
      await renderTextCardPanel(project, panel);
      textCards++;
      onProgress && onProgress({ n: panel.n, kind: 'text-card' });
    } else if (mode === 'api' && generated < limit) {
      await generateApiImage(project, panel);
      generated++;
      onProgress && onProgress({ n: panel.n, kind: 'api' });
    } else {
      pendingManual++;
    }
  }
  return { textCards, generated, pendingManual };
}

// Build the copy-paste prompt sheet for the panels the user makes by hand.
function promptSheet(project) {
  const lines = [`# ${project.title} — doodle prompt sheet`, ''];
  lines.push(`STYLE (paste once, keep it on every image):`, project.style_bible, '');
  for (const p of project.panels) {
    if (!p.doodlePrompt) continue; // the rare bare text-card is auto-rendered
    // Every panel needs a doodle. The callout is added as overlay text by us —
    // draw ONLY the doodle, leave room near the bottom for the bold word.
    lines.push(`#${p.n}: ${p.doodlePrompt || p.narration}` + (p.callout ? `  [bold overlay text, added automatically: ${p.callout}]` : ''));
  }
  return lines.join('\n');
}

module.exports = {
  fillImages,
  renderTextCardPanel,
  generateApiImage,
  storeUploadedImage,
  promptSheet,
  r2KeyForImage,
  IMG_W,
  IMG_H,
};
