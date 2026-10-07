import type { DatabaseSync } from 'node:sqlite';

/**
 * The tiny slice of SQLite the memory store uses. Keeping it behind an
 * interface lets tests open ':memory:' and keeps `node:sqlite` itself out of
 * this module: the caller passes the DatabaseSync constructor in, so the
 * Electron main process can load it lazily and fall back if it is missing.
 */
export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export interface DbStatement {
  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number };
  get(...params: SqlValue[]): SqlRow | undefined;
  all(...params: SqlValue[]): SqlRow[];
}

export interface Db {
  exec(sql: string): void;
  /** Prepared statements are cached per SQL string. */
  prepare(sql: string): DbStatement;
  /** Runs fn atomically. Nested calls join the outer transaction. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export type DatabaseSyncCtor = typeof DatabaseSync;

export function openSqliteDb(Ctor: DatabaseSyncCtor, path: string): Db {
  const raw = new Ctor(path);
  try {
    // WAL keeps the UI responsive while a write is in flight; ignored for ':memory:'.
    raw.exec('PRAGMA journal_mode = WAL');
    raw.exec('PRAGMA synchronous = NORMAL');
    raw.exec('PRAGMA busy_timeout = 2000');
  } catch (err) {
    raw.close();
    throw err;
  }

  const cache = new Map<string, DbStatement>();
  let depth = 0;

  return {
    exec: (sql) => raw.exec(sql),
    prepare(sql) {
      let stmt = cache.get(sql);
      if (!stmt) {
        const s = raw.prepare(sql);
        stmt = {
          run: (...params) => {
            const r = s.run(...params);
            return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
          },
          get: (...params) => s.get(...params) as SqlRow | undefined,
          all: (...params) => s.all(...params) as SqlRow[],
        };
        cache.set(sql, stmt);
      }
      return stmt;
    },
    transaction(fn) {
      if (depth > 0) return fn();
      raw.exec('BEGIN IMMEDIATE');
      depth++;
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        try {
          raw.exec('ROLLBACK');
        } catch {
          // The failed statement may already have ended the transaction.
        }
        throw err;
      } finally {
        depth--;
      }
    },
    close() {
      cache.clear();
      raw.close();
    },
  };
}
