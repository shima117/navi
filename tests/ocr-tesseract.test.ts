/**
 * Integration: real tesseract.js (Node, worker_threads) with the same local
 * jpn+eng data and parameters the renderer uses, on a rendered price-tag
 * fixture (tests/fixtures/ocr, regenerate with generate.mjs). Takes ~1-3 s.
 * Set NAVI_SKIP_OCR_IT=1 to skip it on very slow machines.
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Tesseract from 'tesseract.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeOcrText, summarizeOcrText } from '../src/core/screen/OcrAnalysis';
import { OCR_LANGS, OCR_PATHS, OCR_TESSERACT_PARAMS } from '../src/renderer/ocr/ocrAssets';
import { rgbaToPgm } from '../src/renderer/ocr/ocrImage';
import { ocrAssetSources } from '../src/renderer/ocr/viteOcrAssets';

const fixture = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/ocr/${name}`, import.meta.url)));

/** Parse a binary PGM (P5, maxval 255) back into width/height/gray. */
function parsePgm(buf: Buffer): { width: number; height: number; gray: Uint8Array } {
  const m = /^P5\s+(\d+)\s+(\d+)\s+255\s/.exec(buf.subarray(0, 64).toString('latin1'))!;
  const width = Number(m[1]);
  const height = Number(m[2]);
  return { width, height, gray: new Uint8Array(buf.subarray(m[0].length, m[0].length + width * height)) };
}

describe.skipIf(process.env.NAVI_SKIP_OCR_IT === '1')('tesseract.js on a rendered price tag', () => {
  let worker: Tesseract.Worker;
  let langDir: string;

  beforeAll(async () => {
    // The published asset manifest must point at real files…
    const langs = ocrAssetSources().filter((a) => a.path.startsWith(OCR_PATHS.langDir));
    expect(langs.map((a) => path.basename(a.path)).sort()).toEqual(OCR_LANGS.map((l) => `${l}.traineddata.gz`).sort());
    // …and, like the renderer's ocr/lang/, tesseract wants them in one directory.
    langDir = mkdtempSync(path.join(tmpdir(), 'navi-ocr-'));
    for (const a of langs) copyFileSync(a.file, path.join(langDir, path.basename(a.path)));
    worker = await Tesseract.createWorker([...OCR_LANGS], Tesseract.OEM.LSTM_ONLY, {
      langPath: langDir,
      cacheMethod: 'none',
      gzip: true,
    });
    await worker.setParameters(OCR_TESSERACT_PARAMS as Partial<Tesseract.WorkerParams>);
  }, 60_000);

  afterAll(async () => {
    await worker?.terminate();
    if (langDir) rmSync(langDir, { recursive: true, force: true });
  });

  it('finds the price and the sale marker in the PGM the renderer would send', async () => {
    const { data } = await worker.recognize(fixture('price-tag.pgm'));
    const summary = summarizeOcrText(data.text);
    const a = analyzeOcrText(summary);
    expect(a.prices.map((p) => `${p.currency}:${p.value}`)).toEqual(expect.arrayContaining(['JPY:1980', 'JPY:500']));
    expect(a.sale).toBe(true);
    expect(a.saleMarkers).toEqual(expect.arrayContaining(['セール', '%OFF']));
    // Price lines lead the summary that goes to main.
    expect(summary.length).toBeLessThanOrEqual(300);
    expect(summary).toMatch(/1,980/);
  }, 30_000);

  it('reads images produced by rgbaToPgm', async () => {
    const { width, height, gray } = parsePgm(fixture('price-tag.pgm'));
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < gray.length; i++) {
      rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = gray[i]!;
      rgba[i * 4 + 3] = 255;
    }
    const { data } = await worker.recognize(Buffer.from(rgbaToPgm(rgba, width, height)));
    expect(data.confidence).toBeGreaterThan(50);
    expect(analyzeOcrText(data.text).prices.some((p) => p.value === 1980)).toBe(true);
  }, 30_000);
});
