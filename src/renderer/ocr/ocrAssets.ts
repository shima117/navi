/**
 * Where the OCR runtime is published next to the renderer pages. Everything is
 * served from the app itself — tesseract.js would otherwise fetch its worker,
 * WASM core and language data from a CDN, and NAVI is local-first.
 * The files are copied out of node_modules by viteOcrAssets.ts.
 */
export const OCR_LANGS = ['jpn', 'eng'] as const;

export const OCR_PATHS = {
  worker: 'ocr/worker.min.js',
  /** Directory: tesseract.js picks the relaxed-SIMD / SIMD / plain LSTM build itself. */
  coreDir: 'ocr/core/',
  /** Directory holding `<lang>.traineddata.gz` for every OCR_LANGS entry. */
  langDir: 'ocr/lang/',
} as const;

/** LSTM-only cores: the legacy engine is never used, and its builds are larger. */
export const OCR_CORE_FILES = [
  'tesseract-core-relaxedsimd-lstm.wasm.js',
  'tesseract-core-simd-lstm.wasm.js',
  'tesseract-core-lstm.wasm.js',
] as const;

/** "best_int" models: integer-quantized, small and fast enough for a renderer worker. */
export const OCR_TRAINEDDATA_VARIANT = '4.0.0_best_int';

/**
 * Tesseract parameters for screen text. Sparse mode (PSM 11) finds scattered UI
 * text far better than page layout analysis; debug_file silences tesseract's
 * per-image chatter in the worker console.
 */
export const OCR_TESSERACT_PARAMS = { tessedit_pageseg_mode: '11', debug_file: '/dev/null' } as const;
