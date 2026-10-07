import type { Db } from './Db';

/**
 * Versioned schema migrations for navi.sqlite (design doc §6.5). Append new
 * migrations; never edit one that has shipped. Each runs in its own
 * transaction and is recorded in schema_migrations.
 */
export interface Migration {
  version: number;
  name: string;
  up(db: Db): void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up(db) {
      db.exec(`
        CREATE TABLE sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at INTEGER NOT NULL,
          ended_at INTEGER
        );

        -- Only written when the user opts in (persistUtterances, §6.5).
        CREATE TABLE utterances (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER,
          role TEXT NOT NULL CHECK (role IN ('user', 'navi')),
          source TEXT,
          text TEXT NOT NULL,
          at INTEGER NOT NULL
        );
        CREATE INDEX idx_utterances_at ON utterances(at);
        CREATE INDEX idx_utterances_session ON utterances(session_id);

        CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tier TEXT NOT NULL CHECK (tier IN ('session', 'long')),
          text TEXT NOT NULL,
          norm TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'conversation',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          last_used_at INTEGER NOT NULL,
          uses INTEGER NOT NULL DEFAULT 0,
          first_session_id INTEGER,
          last_session_id INTEGER,
          -- Distinct sessions this memory was written or recalled in (promotion).
          session_count INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_memories_tier ON memories(tier, last_used_at);
        CREATE INDEX idx_memories_norm ON memories(norm);

        CREATE TABLE topics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          key TEXT NOT NULL UNIQUE,
          label TEXT NOT NULL,
          mentions INTEGER NOT NULL DEFAULT 0,
          starts INTEGER NOT NULL DEFAULT 0,
          drops INTEGER NOT NULL DEFAULT 0,
          session_count INTEGER NOT NULL DEFAULT 0,
          last_session_id INTEGER,
          first_at INTEGER NOT NULL,
          last_at INTEGER NOT NULL
        );
        CREATE INDEX idx_topics_last_at ON topics(last_at);

        -- Text summaries only. Frames / images are never stored (§20).
        CREATE TABLE screen_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER,
          kind TEXT NOT NULL CHECK (kind IN ('vision', 'plugin')),
          source TEXT NOT NULL,
          summary TEXT NOT NULL,
          importance REAL,
          at INTEGER NOT NULL
        );
        CREATE INDEX idx_screen_events_at ON screen_events(at);

        CREATE TABLE plugin_state (
          plugin_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (plugin_id, key)
        );

        CREATE TABLE preferences (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
];

export function schemaVersion(db: Db): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get();
  return Number(row?.v ?? 0);
}

/**
 * Bring the schema up to date. Throws if the file was written by a newer
 * build, so the caller falls back instead of corrupting it.
 */
export function migrate(db: Db, migrations: Migration[] = MIGRATIONS, now = Date.now()): { from: number; to: number } {
  const from = schemaVersion(db);
  const latest = migrations.reduce((max, m) => Math.max(max, m.version), 0);
  if (from > latest) throw new Error(`navi.sqlite schema v${from} is newer than this build (v${latest})`);
  const pending = [...migrations].filter((m) => m.version > from).sort((a, b) => a.version - b.version);
  for (const m of pending) {
    db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, now);
    });
  }
  return { from, to: Math.max(from, latest) };
}
