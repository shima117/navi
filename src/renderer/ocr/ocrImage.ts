/**
 * Pure image helpers for OCR: which part of the frame to read, at what size,
 * and the grayscale bitmap handed to tesseract. No DOM, so they are unit-tested.
 */
import { REGION_GRID } from '../../core/screen/RegionHash';

export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** OCR at most the 1280x720 frame of §7.2, so one job stays around half a second. */
export const OCR_MAX_WIDTH = 1280;
export const OCR_MAX_HEIGHT = 720;
/** Small crops are enlarged: tesseract reads ~20px text far better than ~10px text. */
const MAX_UPSCALE = 2;

/**
 * The part of the frame to OCR: the bounding box of the changed grid cells,
 * padded by half a cell so text on a cell border is not cut. A change that
 * spans half the screen or more (or is unknown) reads the whole frame.
 */
export function ocrCropRect(cells: readonly number[], width: number, height: number, grid = REGION_GRID): PixelRect {
  const full = { x: 0, y: 0, width, height };
  let minC = grid;
  let maxC = -1;
  let minR = grid;
  let maxR = -1;
  for (const i of cells) {
    if (i < 0 || i >= grid * grid) continue;
    const r = Math.floor(i / grid);
    const c = i % grid;
    minC = Math.min(minC, c);
    maxC = Math.max(maxC, c);
    minR = Math.min(minR, r);
    maxR = Math.max(maxR, r);
  }
  if (maxC < 0) return full;
  if ((maxC - minC + 1) * (maxR - minR + 1) * 2 >= grid * grid) return full;
  const cw = width / grid;
  const ch = height / grid;
  const x0 = Math.max(0, Math.floor((minC - 0.5) * cw));
  const y0 = Math.max(0, Math.floor((minR - 0.5) * ch));
  const x1 = Math.min(width, Math.ceil((maxC + 1.5) * cw));
  const y1 = Math.min(height, Math.ceil((maxR + 1.5) * ch));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Output size for a crop: big frames are downscaled, small crops enlarged, never above the max. */
export function ocrOutputSize(
  crop: Pick<PixelRect, 'width' | 'height'>,
  maxWidth = OCR_MAX_WIDTH,
  maxHeight = OCR_MAX_HEIGHT,
): { width: number; height: number } {
  const scale = Math.min(MAX_UPSCALE, maxWidth / crop.width, maxHeight / crop.height);
  return {
    width: Math.max(1, Math.min(maxWidth, Math.round(crop.width * scale))),
    height: Math.max(1, Math.min(maxHeight, Math.round(crop.height * scale))),
  };
}

/**
 * Binary PGM (P5) grayscale. Leptonica inside tesseract decodes it directly,
 * so there is no PNG/JPEG encode on the renderer's main thread.
 */
export function rgbaToPgm(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array {
  const header = `P5\n${width} ${height}\n255\n`;
  const out = new Uint8Array(header.length + width * height);
  for (let i = 0; i < header.length; i++) out[i] = header.charCodeAt(i);
  for (let p = 0, o = header.length; p < width * height; p++, o++) {
    const i = p * 4;
    // Integer BT.601 luma (77+150+29 = 256).
    out[o] = (rgba[i]! * 77 + rgba[i + 1]! * 150 + rgba[i + 2]! * 29) >> 8;
  }
  return out;
}
