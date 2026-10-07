import { DatabaseSync } from 'node:sqlite';
import { openSqliteDb, type Db } from '../src/core/memory/Db';
import { SqliteMemoryStore, type SqliteMemoryStoreOptions } from '../src/core/memory/SqliteMemoryStore';

export const DAY = 86_400_000;
export const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

/** In-memory SQLite store with a controllable clock. */
export function makeStore(opts: SqliteMemoryStoreOptions & { db?: Db } = {}) {
  const db = opts.db ?? openSqliteDb(DatabaseSync, ':memory:');
  const clock = { now: T0 };
  const store = new SqliteMemoryStore(db, { now: () => clock.now, ...opts });
  return { db, store, clock };
}

export function count(db: Db, table: string): number {
  return Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0);
}
