import type { AppContext } from '../context';

/**
 * A self-contained slice of the main process: IPC handlers, bus wiring and
 * lifecycle. Add new functionality as a Feature and list it in features/index.ts.
 */
export interface Feature {
  name: string;
  /** Register IPC handlers and bus subscriptions. Runs before any window opens. */
  setup(ctx: AppContext): void | Promise<void>;
  /** Runs after the windows exist and the session has started. */
  start?(ctx: AppContext): void | Promise<void>;
  /** Runs on app quit. Must not throw. */
  stop?(ctx: AppContext): void | Promise<void>;
}
