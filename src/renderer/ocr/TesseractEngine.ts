/**
 * tesseract.js (jpn+eng) in a Web Worker, loaded only from files published by
 * viteOcrAssets.ts — never from a CDN. Browser-only; OcrRunner owns its lifecycle.
 */
import type Tesseract from 'tesseract.js';
import { OCR_LANGS, OCR_PATHS, OCR_TESSERACT_PARAMS } from './ocrAssets';
import type { OcrEngine } from './OcrRunner';

type TesseractModule = typeof Tesseract;

export async function createTesseractEngine(): Promise<OcrEngine> {
  // Loaded on first use so the OCR code never weighs on startup.
  const mod = (await import('tesseract.js')) as TesseractModule & { default?: TesseractModule };
  const T: TesseractModule = typeof mod.createWorker === 'function' ? mod : mod.default!;

  const base = document.baseURI;
  let failInit: (reason: Error) => void = () => {};
  const initFailed = new Promise<never>((_, reject) => (failInit = reject));
  initFailed.catch(() => {});

  const worker = await Promise.race([
    T.createWorker([...OCR_LANGS], T.OEM.LSTM_ONLY, {
      workerPath: new URL(OCR_PATHS.worker, base).href,
      corePath: new URL(OCR_PATHS.coreDir, base).href,
      langPath: new URL(OCR_PATHS.langDir, base).href,
      // A real worker URL (not a blob: wrapper) keeps it under worker-src 'self'.
      workerBlobURL: false,
      // Language data is read from local files; do not copy it into IndexedDB.
      cacheMethod: 'none',
      gzip: true,
      logger: () => {},
      // tesseract.js otherwise rethrows worker errors from onmessage. Nothing is
      // logged here: error payloads are engine internals, never worth the risk (§20).
      errorHandler: () => failInit(new Error('tesseract worker error')),
    }),
    initFailed,
  ]);
  // PSM '11' is Tesseract.PSM.SPARSE_TEXT; the shared constant keeps tests on the same settings.
  await worker.setParameters(OCR_TESSERACT_PARAMS as Partial<Tesseract.WorkerParams>);

  return {
    async recognize(image: Uint8Array): Promise<{ text: string; confidence: number }> {
      const { data } = await worker.recognize(new Blob([image as Uint8Array<ArrayBuffer>]));
      return { text: data.text ?? '', confidence: data.confidence ?? 0 };
    },
    terminate(): void {
      void worker.terminate().catch(() => {});
    },
  };
}
