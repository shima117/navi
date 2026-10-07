import { app, ipcMain } from 'electron';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { openSqliteDb, type DatabaseSyncCtor, type Db } from '../../src/core/memory/Db';
import { clampRetentionDays, isMemoryJournal } from '../../src/core/memory/MemoryJournal';
import {
  InMemoryMemoryStore,
  isManagedMemoryStore,
  type ManagedMemoryStore,
  type MemoryItem,
  type MemoryStats,
  type MemoryStore,
  type MemoryTier,
} from '../../src/core/memory/MemoryStore';
import { MemoryWriter } from '../../src/core/memory/MemoryWriter';
import { SessionSummarizer } from '../../src/core/memory/SessionSummarizer';
import { SqliteMemoryStore } from '../../src/core/memory/SqliteMemoryStore';
import { IPC } from '../ipc';
import type { SettingsStore } from '../settings';
import type { Feature } from './Feature';

const DB_FILE = 'navi.sqlite';
/** Mid-session summaries, so a crash does not lose a long evening's worth. */
const SUMMARY_INTERVAL_MS = 20 * 60_000;
const PERIODIC_MIN_USER_TURNS = 6;
/** Periodic summaries only run after this long without conversation. */
const PERIODIC_IDLE_MS = 90_000;
/** How long quitting may wait for the end-of-session summary. */
const SHUTDOWN_SUMMARY_TIMEOUT_MS = 8_000;
const LIST_LIMIT = 500;
const MAX_QUERY_LEN = 200;

let openError: string | null = null;
let writer: MemoryWriter | null = null;
let summarizer: SessionSummarizer | null = null;
let summaryTimer: ReturnType<typeof setInterval> | null = null;
/** Pending end-of-session work; will-quit waits for it before the database closes. */
let shutdown: Promise<void> | null = null;

/**
 * Called by createContext: opens userData/navi.sqlite, or falls back to the
 * in-memory store if SQLite cannot be loaded or opened (§19). Memory then
 * lasts until quit, and the Memory tab says so.
 */
export function createMemoryStore(settings: SettingsStore): MemoryStore {
  let db: Db | null = null;
  try {
    // Loaded lazily so a runtime without node:sqlite degrades instead of crashing main.
    const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: DatabaseSyncCtor };
    const dir = app.getPath('userData');
    mkdirSync(dir, { recursive: true });
    db = openSqliteDb(DatabaseSync, path.join(dir, DB_FILE));
    return new SqliteMemoryStore(db, { longTermEnabled: () => settings.current.persistMemory });
  } catch (err) {
    try {
      db?.close();
    } catch {
      // Already unusable.
    }
    openError = err instanceof Error ? err.message : String(err);
    console.error('[memory] SQLite unavailable, keeping memories in RAM only:', openError);
    return new InMemoryMemoryStore();
  }
}

function asTier(v: unknown): MemoryTier | undefined {
  return v === 'session' || v === 'long' ? v : undefined;
}

function byRecent(items: MemoryItem[]): MemoryItem[] {
  return [...items].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

/** Memory persistence policy, the memory pipeline, and the Memory tab API (§6.5, PR-09). */
export const memoryFeature: Feature = {
  name: 'memory',
  setup(ctx) {
    const { bus, settings, memory } = ctx;
    const managed = isManagedMemoryStore(memory) ? memory : null;
    const journal = isMemoryJournal(memory) ? memory : null;
    const managedOrThrow = (): ManagedMemoryStore => {
      if (!managed) throw new Error('memory store does not support management');
      return managed;
    };

    // Housekeeping before session.started: without persistMemory nothing from a
    // previous (possibly crashed) run may survive, and old logs age out.
    if (!settings.current.persistMemory) memory.clearSession();
    journal?.purge(Date.now(), clampRetentionDays(settings.current.utteranceRetentionDays));

    const s = new SessionSummarizer({
      chat: (messages, signal) => {
        const { model, keepAlive } = ctx.router.chatModel();
        return ctx.ollama.chat({
          model,
          keepAlive,
          format: 'json',
          options: { temperature: 0.2, num_predict: 400 },
          messages,
          signal,
        });
      },
      isOnline: () => ctx.health.isHealthy('chat'),
      enabled: () => settings.current.persistMemory,
      write: (fact) => memory.write(fact, 'long', Date.now(), 'summary'),
    });
    summarizer = s;

    writer = new MemoryWriter({
      bus,
      store: memory,
      journal,
      policy: () => ({
        persistMemory: settings.current.persistMemory,
        persistUtterances: settings.current.persistUtterances,
      }),
      turns: s,
    });
    writer.attach();
    bus.on('session.ended', () => void s.summarize());

    settings.onChange((next, prev) => {
      if (next.utteranceRetentionDays !== prev.utteranceRetentionDays) {
        journal?.purge(Date.now(), clampRetentionDays(next.utteranceRetentionDays));
      }
    });

    // Quitting closes windows, then fires will-quit: hold it until the summary
    // has been written and the database closed (bounded by the timeout).
    app.on('will-quit', (e) => {
      if (!shutdown) return;
      e.preventDefault();
      void shutdown.then(() => app.quit());
    });

    ipcMain.handle(IPC.memoryList, (_e, tier: unknown) =>
      byRecent(managedOrThrow().search('', { tier: asTier(tier), limit: LIST_LIMIT })),
    );
    ipcMain.handle(IPC.memorySearch, (_e, query: unknown, tier: unknown) =>
      managedOrThrow().search(String(query ?? '').slice(0, MAX_QUERY_LEN), { tier: asTier(tier), limit: LIST_LIMIT }),
    );
    ipcMain.handle(IPC.memoryUpdate, (_e, id: unknown, text: unknown) =>
      typeof id === 'string' && typeof text === 'string' ? managedOrThrow().update(id, text) : null,
    );
    ipcMain.handle(IPC.memoryDelete, (_e, id: unknown) => {
      if (typeof id === 'string') memory.remove(id);
    });
    ipcMain.handle(IPC.memoryClear, (_e, scope: unknown) => {
      const m = managedOrThrow();
      if (scope === 'session' || scope === 'long') m.clearTier(scope);
      else if (scope === 'all') {
        m.clearAll();
        // Otherwise an in-flight or upcoming summary would re-create what was just wiped.
        s.clear();
      } else throw new Error(`unknown memory scope: ${String(scope)}`);
    });
    ipcMain.handle(IPC.memoryStats, (): MemoryStats => {
      const stats = managedOrThrow().stats();
      return openError ? { ...stats, error: openError } : stats;
    });
  },
  start() {
    summaryTimer = setInterval(() => {
      void summarizer?.summarize({ minUserTurns: PERIODIC_MIN_USER_TURNS, idleSince: Date.now() - PERIODIC_IDLE_MS });
    }, SUMMARY_INTERVAL_MS);
  },
  stop(ctx) {
    if (summaryTimer) clearInterval(summaryTimer);
    summaryTimer = null;
    const finish = () => {
      try {
        writer?.detach();
        writer = null;
        if (!ctx.settings.current.persistMemory) ctx.memory.clearSession();
        if (isManagedMemoryStore(ctx.memory)) ctx.memory.close();
      } catch (err) {
        console.error('[memory] shutdown failed:', err);
      }
    };
    const s = summarizer;
    if (!s?.busy) {
      finish();
      return;
    }
    // session.ended started the end-of-session summary; let it finish (or give up) first.
    const giveUp = setTimeout(() => s.cancel(), SHUTDOWN_SUMMARY_TIMEOUT_MS);
    // summarize() never rejects, and finish() swallows errors, so quitting cannot hang on this.
    shutdown = s.summarize().then(() => {
      clearTimeout(giveUp);
      finish();
      shutdown = null;
    });
  },
};
