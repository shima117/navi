/**
 * Build-time only (imported by vite.config.ts, never by the renderer):
 * publishes the tesseract.js worker, WASM cores and jpn/eng traineddata
 * from node_modules so OCR runs without any network access.
 */
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Plugin } from 'vite';
import { OCR_CORE_FILES, OCR_LANGS, OCR_PATHS, OCR_TRAINEDDATA_VARIANT } from './ocrAssets';

export interface OcrAssetSource {
  /** Published path relative to the renderer root, e.g. "ocr/lang/jpn.traineddata.gz". */
  path: string;
  /** Absolute file in node_modules. */
  file: string;
}

const nodeRequire = createRequire(import.meta.url);

function packageDir(name: string): string | null {
  try {
    return path.dirname(nodeRequire.resolve(`${name}/package.json`));
  } catch {
    return null;
  }
}

/** Every OCR runtime file and where it comes from. Missing packages are simply left out. */
export function ocrAssetSources(): OcrAssetSource[] {
  const out: OcrAssetSource[] = [];
  const tess = packageDir('tesseract.js');
  if (tess) out.push({ path: OCR_PATHS.worker, file: path.join(tess, 'dist', 'worker.min.js') });
  const core = packageDir('tesseract.js-core');
  if (core) for (const f of OCR_CORE_FILES) out.push({ path: `${OCR_PATHS.coreDir}${f}`, file: path.join(core, f) });
  for (const lang of OCR_LANGS) {
    const data = packageDir(`@tesseract.js-data/${lang}`);
    if (data) {
      out.push({
        path: `${OCR_PATHS.langDir}${lang}.traineddata.gz`,
        file: path.join(data, OCR_TRAINEDDATA_VARIANT, `${lang}.traineddata.gz`),
      });
    }
  }
  return out.filter((a) => existsSync(a.file));
}

function contentType(file: string): string {
  // .gz is served as opaque bytes: tesseract.js gunzips it itself, so no Content-Encoding.
  return file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
}

export function ocrAssetsPlugin(): Plugin {
  return {
    name: 'navi-ocr-assets',
    configureServer(server) {
      const byPath = new Map(ocrAssetSources().map((a) => [`/${a.path}`, a.file]));
      server.middlewares.use((req, res, next) => {
        const file = byPath.get((req.url ?? '').split('?')[0] ?? '');
        if (!file) return next();
        res.setHeader('Content-Type', contentType(file));
        createReadStream(file).on('error', next).pipe(res);
      });
    },
    generateBundle() {
      const assets = ocrAssetSources();
      const expected = 1 + OCR_CORE_FILES.length + OCR_LANGS.length;
      if (assets.length < expected) {
        // Not fatal: OCR switches itself off at runtime and everything else keeps working.
        this.warn(`OCR assets incomplete (${assets.length}/${expected}); screen OCR will be unavailable`);
      }
      for (const a of assets) this.emitFile({ type: 'asset', fileName: a.path, source: readFileSync(a.file) });
    },
  };
}
