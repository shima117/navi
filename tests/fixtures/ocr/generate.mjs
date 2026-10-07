// Regenerates the OCR fixtures (a fake shop price tag) with headless Chromium.
// Not run by the test suite: the outputs are committed. ocr-tesseract.test.ts reads
// the PGM (the renderer's format); the PNG is the same image for humans to look at.
//   node tests/fixtures/ocr/generate.mjs
// Uses the preinstalled Playwright Chromium; override with NAVI_CHROMIUM=/path/to/chrome.
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = (name) => fileURLToPath(new URL(name, import.meta.url));
const executablePath = process.env.NAVI_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({ executablePath });
try {
  const page = await browser.newPage();
  const { png, pgm } = await page.evaluate(() => {
    const w = 640;
    const h = 220;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#111111';
    g.font = '34px "IPAGothic", "IPAPGothic", sans-serif';
    g.fillText('週末セール 30%OFF', 24, 56);
    g.fillText('税込 ¥1,980', 24, 120);
    g.fillText('送料 500円', 24, 184);
    const rgba = g.getImageData(0, 0, w, h).data;
    // Binary PGM (P5): the same grayscale format the renderer hands to tesseract.
    const header = `P5\n${w} ${h}\n255\n`;
    const bytes = new Uint8Array(header.length + w * h);
    for (let i = 0; i < header.length; i++) bytes[i] = header.charCodeAt(i);
    for (let p = 0; p < w * h; p++) {
      bytes[header.length + p] = Math.round(0.299 * rgba[p * 4] + 0.587 * rgba[p * 4 + 1] + 0.114 * rgba[p * 4 + 2]);
    }
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return { png: c.toDataURL('image/png').split(',')[1], pgm: btoa(bin) };
  });
  writeFileSync(out('price-tag.png'), Buffer.from(png, 'base64'));
  writeFileSync(out('price-tag.pgm'), Buffer.from(pgm, 'base64'));
  console.log('wrote price-tag.png / price-tag.pgm');
} finally {
  await browser.close();
}
