import { desktopCapturer, ipcMain, session } from 'electron';
import { classifyChange } from '../../src/core/screen/FrameDiff';
import type { FrameSummary } from '../../src/core/screen/FrameSummary';
import type { VisionFrame } from '../../src/core/screen/VisionService';
import { IPC, type CaptureSource } from '../ipc';
import type { Feature } from './Feature';

/** Continuous share of one user-chosen source (§7). */
export const captureFeature: Feature = {
  name: 'capture',
  setup(ctx) {
    const { capture, plugins, windows, bus } = ctx;

    // getDisplayMedia in the renderer receives exactly the source the user picked (§7.1).
    session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'] });
      const chosen = sources.find((s) => s.id === capture.sourceId);
      if (chosen) callback({ video: chosen });
      else callback({});
    });

    ipcMain.handle(IPC.captureListSources, async (): Promise<CaptureSource[]> => {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
      return sources
        .filter((s) => !s.name.startsWith('NAVI'))
        .map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.id.startsWith('screen:') ? 'screen' : 'window',
          thumbnailDataUrl: s.thumbnail.toDataURL(),
        }));
    });

    ipcMain.handle(IPC.captureStart, async (_e, sourceId: string, sourceName: string, kind: 'screen' | 'window') => {
      capture.sourceId = sourceId;
      capture.sourceName = sourceName;
      capture.kind = kind;
      capture.paused = false;
      const plugin = await plugins.onWindowShared({ sourceId, title: sourceName, kind });
      windows.push({ type: 'plugin', active: plugin?.id ?? null });
      windows.push({ type: 'capture', sharing: true, sourceName, paused: false });
    });

    ipcMain.handle(IPC.captureStop, () => {
      capture.sourceId = null;
      capture.sourceName = null;
      capture.paused = false;
      windows.push({ type: 'capture', sharing: false, sourceName: null, paused: false });
    });

    ipcMain.handle(IPC.captureSetPaused, (_e, paused: boolean) => {
      capture.paused = paused;
      windows.push({ type: 'capture', sharing: capture.sourceId !== null, sourceName: capture.sourceName, paused });
    });

    ipcMain.handle(IPC.captureGetState, () => ({
      sharing: capture.sourceId !== null,
      sourceName: capture.sourceName,
      paused: capture.paused,
    }));

    ipcMain.on(IPC.captureFrameSummary, (_e, summary: FrameSummary) => {
      if (!capture.sourceId || capture.paused || summary.sourceId !== capture.sourceId) return;
      bus.emit('screen.frame', summary);
      if (classifyChange(summary.change) !== 'none') bus.emit('screen.changed', summary);
      void plugins.onFrame(summary);
    });

    ipcMain.on(IPC.captureFrameResponse, (_e, requestId: string, frame: VisionFrame | null) => {
      ctx.frames.resolve(requestId, frame);
    });
  },
};
