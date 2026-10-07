# NAVI — contributor notes

Local-first AI friend app (Electron + React + TS). Spec: `docs/design.md` (Japanese). Section refs like §12 point there.

## Commands
- `npm test` — vitest (`tests/**/*.test.ts`)
- `npm run typecheck` — renderer/core + electron tsconfigs
- `npm run build` — vite (renderer) + tsc (main, CJS) + esbuild (preload bundle)
- `cd voice-service && python3 -m unittest discover -s tests -t .`
- Electron binary is installed; GUI runs under `xvfb-run -a`. `e2e/fakeServices.cjs` fakes Ollama (:11434) and VOICEVOX (:50021).

## Architecture rules
- `src/core/` is game-agnostic Friend Core. Never put game-specific logic there (§25); games are `GamePlugin`s under `src/plugins/<game>/`.
- Only `FriendOrchestrator` decides what Navi says. Vision/plugins return context, never speech.
- Main process = `electron/features/*.ts` (`Feature` with setup/start/stop) listed in `electron/features/index.ts`. Shared services live on `AppContext` (`electron/context.ts`).
- IPC channel names live in `electron/ipc.ts`; the renderer API is `electron/preload.ts` (bundled by esbuild, so it may import `./ipc`). No Node access in renderers.
- Renderer tabs: `src/renderer/tabs/*` registered in `src/renderer/tabs/registry.ts`; shared state via `useNavi()` (`src/renderer/state/NaviContext.tsx`). Plugin panels register in `src/renderer/plugin-ui/registry.ts`.
- Any module failure (Ollama, VOICEVOX, STT, Vision, avatar, plugin) must degrade, never crash or block conversation (§19).
- Shared-screen frames stay in RAM; never write them to disk or logs (§20).
- Everything binds/talks to 127.0.0.1 only.

## Style
- Match surrounding code: strict TS, small modules, comments explain *why*. UI strings are Japanese.
- Every new pure module gets vitest coverage. Keep `npm test`, `npm run typecheck`, `npm run build` green before committing.
