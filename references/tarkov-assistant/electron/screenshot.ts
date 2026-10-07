import { stat, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';

export interface ParsedScreenshotLocation {
  x: number;
  y: number;
  z: number;
  bearing: number | null;
  capturedAt: string;
  fileName: string;
  source: 'screenshot';
}

const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const SCREENSHOT_PATTERN = new RegExp(
  `^(\\d{4})-(\\d{2})-(\\d{2})\\[(\\d{2})-(\\d{2})\\]\\s*_\\s*(${NUMBER})\\s*,\\s*(${NUMBER})\\s*,\\s*(${NUMBER})\\s*_\\s*(${NUMBER})\\s*,\\s*(${NUMBER})\\s*,\\s*(${NUMBER})\\s*,\\s*(${NUMBER})(?:_.*?)?\\.(?:png|jpe?g)$`,
  'i',
);

export function parseScreenshotFileName(fileName: string): { ok: true; location: ParsedScreenshotLocation } | { ok: false; error: string } {
  const baseName = path.basename(fileName);
  const match = baseName.match(SCREENSHOT_PATTERN);
  if (!match) {
    return {
      ok: false,
      error: 'EFT本体のスクリーンショット名として解析できません。PrtScで作成されたPNGか確認してください。',
    };
  }
  const [year, month, day, hour, minute] = match.slice(1, 6).map(Number);
  const [x, y, z, qx, qy, qz, qw] = match.slice(6, 13).map(Number);
  if (![x, y, z, qx, qy, qz, qw].every(Number.isFinite)) {
    return { ok: false, error: 'ファイル名内の座標に無効な数値があります。' };
  }
  const daysInMonth = month >= 1 && month <= 12 ? new Date(year, month, 0).getDate() : 0;
  if (year < 2000 || year > 2200 || day < 1 || day > daysInMonth || hour > 23 || minute > 59) {
    return { ok: false, error: 'ファイル名内の撮影日時が正しくありません。' };
  }
  const norm = Math.hypot(qx, qy, qz, qw);
  let bearing: number | null = null;
  if (norm >= 0.5 && norm <= 1.5) {
    const nx = qx / norm;
    const ny = qy / norm;
    const nz = qz / norm;
    const nw = qw / norm;
    const yaw = Math.atan2(2 * (nw * ny + nx * nz), 1 - 2 * (ny * ny + nz * nz));
    bearing = ((yaw * 180) / Math.PI + 360) % 360;
  }
  const captured = new Date(year, month - 1, day, hour, minute);
  const capturedAt = captured.toISOString();
  return {
    ok: true,
    location: { x, y, z, bearing, capturedAt, fileName: baseName, source: 'screenshot' },
  };
}

export class ScreenshotWatcher {
  private watcher: FSWatcher | null = null;
  private handled = new Set<string>();
  private debounce = new Map<string, NodeJS.Timeout>();

  start(
    folder: string,
    onLocation: (location: ParsedScreenshotLocation) => void,
    onError?: (message: string) => void,
  ) {
    this.stop();
    this.watcher = watch(folder, { persistent: false }, (eventType, fileName) => {
      if (!fileName || (eventType !== 'rename' && eventType !== 'change')) return;
      const name = fileName.toString();
      if (!/\.(png|jpe?g)$/i.test(name)) return;
      const fullPath = path.join(folder, name);
      const existingTimer = this.debounce.get(fullPath);
      if (existingTimer) clearTimeout(existingTimer);
      this.debounce.set(
        fullPath,
        setTimeout(() => {
          this.debounce.delete(fullPath);
          stat(fullPath, (error, fileStat) => {
            if (error || !fileStat.isFile()) return;
            const identity = `${fullPath}:${fileStat.size}:${fileStat.mtimeMs}`;
            if (this.handled.has(identity)) return;
            const result = parseScreenshotFileName(name);
            if (!result.ok) {
              if (/^\d{4}-\d{2}-\d{2}\[\d{2}-\d{2}\]/.test(name)) {
                this.stop();
                onError?.('EFTのスクリーンショット形式を解析できないため監視を停止しました。設定画面の解析テストで確認してください。');
              }
              return;
            }
            this.handled.add(identity);
            if (this.handled.size > 250) this.handled = new Set([...this.handled].slice(-125));
            onLocation(result.location);
          });
        }, 450),
      );
    });
    this.watcher.on('error', (error) => {
      this.stop();
      onError?.(`スクリーンショット監視を停止しました: ${error.message}`);
    });
  }

  stop() {
    this.watcher?.close();
    this.watcher = null;
    for (const timer of this.debounce.values()) clearTimeout(timer);
    this.debounce.clear();
  }
}
