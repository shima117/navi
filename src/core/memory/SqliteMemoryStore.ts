import type { Db, SqlRow, SqlValue } from './Db';
import { migrate } from './migrations';
import type {
  MemoryJournal,
  PurgeResult,
  ScreenEventRecord,
  TopicBump,
  TopicRow,
  UtteranceRecord,
} from './MemoryJournal';
import {
  SEARCH_MIN_SCORE,
  searchScore,
  type ManagedMemoryStore,
  type MemoryItem,
  type MemorySource,
  type MemoryStats,
  type MemoryTier,
} from './MemoryStore';
import { MIN_RELEVANCE, rankScore } from './ranking';
import { isOnlyRedacted, redactSecrets } from './redact';
import { bigrams, dice, normalizeForMatch, overlapOf } from './similarity';

export interface SqliteMemoryStoreOptions {
  /**
   * Long-term writes and promotion happen only while this returns true
   * (the persistMemory setting). Otherwise 'long' writes land in 'session'.
   */
  longTermEnabled?: () => boolean;
  now?: () => number;
  /** false forces the bigram-scan fallback; otherwise FTS5 is feature-detected. */
  fts?: boolean;
}

/** A session memory seen in this many distinct sessions becomes long-term. */
export const PROMOTE_AFTER_SESSIONS = 2;
/** Weak recall hits should not count towards promotion. */
export const PROMOTION_MIN_RELEVANCE = 0.3;
/** Dice similarity above which a write is treated as a rewrite of an existing memory. */
export const DEDUPE_DICE = 0.8;
/** Topic labels this similar are counted as the same topic. */
const TOPIC_MATCH_DICE = 0.7;

const MAX_LEN = { memory: 300, utterance: 2000, screen: 600, source: 120, topic: 40 } as const;
const DAY_MS = 86_400_000;
const RECALL_CANDIDATES = 200;
const DEDUPE_CANDIDATES = 50;

interface MemoryRow {
  id: number;
  tier: MemoryTier;
  text: string;
  source: MemorySource;
  created_at: number;
  last_used_at: number;
  uses: number;
  last_session_id: number | null;
  session_count: number;
}

function num(v: SqlValue | undefined): number {
  return v === null || v === undefined ? 0 : Number(v);
}

function numOrNull(v: SqlValue | undefined): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function asMemoryRow(r: SqlRow): MemoryRow {
  return {
    id: num(r.id),
    tier: r.tier === 'long' ? 'long' : 'session',
    text: String(r.text ?? ''),
    source: r.source === 'summary' || r.source === 'user' ? r.source : 'conversation',
    created_at: num(r.created_at),
    last_used_at: num(r.last_used_at),
    uses: num(r.uses),
    last_session_id: numOrNull(r.last_session_id),
    session_count: num(r.session_count),
  };
}

function toItem(r: MemoryRow): MemoryItem {
  return {
    id: String(r.id),
    tier: r.tier,
    text: r.text,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    uses: r.uses,
    source: r.source,
  };
}

function parseId(id: string): number | null {
  return /^\d+$/.test(id) ? Number(id) : null;
}

/** Collapse whitespace, mask secrets (§20) and cap length. '' means "nothing worth storing". */
function cleanText(text: string, max: number): string {
  const { text: redacted } = redactSecrets(String(text).replace(/\s+/g, ' ').trim());
  if (isOnlyRedacted(redacted)) return '';
  // Slice by code point so an emoji is never cut in half.
  return redacted.length > max ? Array.from(redacted).slice(0, max).join('') : redacted;
}

function gramsOf(text: string): string {
  return [...bigrams(text)].join(' ');
}

/**
 * Durable memory in navi.sqlite (design doc §6.5). Conversation-facing calls
 * (MemoryStore + MemoryJournal) never throw: a storage error is logged and
 * the turn continues without memory (§19). Memory-tab calls do throw so the
 * UI can say the operation failed.
 */
export class SqliteMemoryStore implements ManagedMemoryStore, MemoryJournal {
  private readonly now: () => number;
  private readonly longTermEnabled: () => boolean;
  private readonly fts: boolean;
  private sessionId: number | null = null;
  private closed = false;

  /** Runs migrations; throws if the database is unusable so the caller can fall back. */
  constructor(
    private readonly db: Db,
    opts: SqliteMemoryStoreOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.longTermEnabled = opts.longTermEnabled ?? (() => true);
    migrate(db, undefined, this.now());
    this.fts = opts.fts === false ? false : this.buildFtsIndex();
  }

  get ftsEnabled(): boolean {
    return this.fts;
  }

  get currentSessionId(): number | null {
    return this.sessionId;
  }

  // ---- MemoryStore (conversation path: never throws) ----

  write(text: string, tier: MemoryTier, at: number, source: MemorySource = 'conversation'): MemoryItem {
    const clean = cleanText(text, MAX_LEN.memory);
    // Returned (unsaved) when there is nothing to store or the database failed.
    const transient: MemoryItem = { id: '', tier, text: clean, createdAt: at, lastUsedAt: at, uses: 0, source };
    if (!clean || !normalizeForMatch(clean)) return transient;
    return this.guard('write', transient, () => this.writeClean(clean, tier, at, source));
  }

  recall(query: string, limit = 5): MemoryItem[] {
    return this.guard('recall', [], () => {
      const q = bigrams(query);
      if (q.size === 0 || limit <= 0) return [];
      const now = this.now();
      const ranked = this.candidates(query, RECALL_CANDIDATES)
        .map((r) => ({ r, rel: overlapOf(bigrams(r.text), q) }))
        .filter((x) => x.rel > MIN_RELEVANCE)
        .map((x) => ({ ...x, score: rankScore(x.rel, toItem(x.r), now) }))
        .sort((a, b) => b.score - a.score || b.r.id - a.r.id)
        .slice(0, limit);
      if (ranked.length === 0) return [];
      return this.db.transaction(() =>
        ranked.map((x) => toItem(this.touch(x.r, now, { use: true, countSession: x.rel >= PROMOTION_MIN_RELEVANCE }))),
      );
    });
  }

  list(tier?: MemoryTier): MemoryItem[] {
    return this.guard('list', [], () => this.rows(tier).map(toItem));
  }

  remove(id: string): void {
    const n = parseId(id);
    if (n === null) return;
    this.guard('remove', undefined, () =>
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM memories WHERE id = ?').run(n);
        if (this.fts) this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(n);
      }),
    );
  }

  clearSession(): void {
    this.guard('clearSession', undefined, () => this.clearTier('session'));
  }

  // ---- Memory tab (throws on failure) ----

  update(id: string, text: string): MemoryItem | null {
    this.assertOpen();
    const n = parseId(id);
    const clean = cleanText(text, MAX_LEN.memory);
    if (n === null || !clean || !normalizeForMatch(clean)) return null;
    return this.db.transaction(() => {
      const res = this.db
        .prepare("UPDATE memories SET text = ?, norm = ?, source = 'user', updated_at = ? WHERE id = ?")
        .run(clean, normalizeForMatch(clean), this.now(), n);
      if (res.changes === 0) return null;
      if (this.fts) {
        this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(n);
        this.db.prepare('INSERT INTO memories_fts (rowid, grams) VALUES (?, ?)').run(n, gramsOf(clean));
      }
      const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(n);
      return row ? toItem(asMemoryRow(row)) : null;
    });
  }

  search(query: string, opts: { tier?: MemoryTier; limit?: number } = {}): MemoryItem[] {
    this.assertOpen();
    const limit = opts.limit ?? 100;
    const pool = this.rows(opts.tier);
    if (!query.trim()) return pool.slice(0, limit).map(toItem);
    return pool
      .map((r) => ({ r, s: searchScore(r.text, query) }))
      .filter((x) => x.s >= SEARCH_MIN_SCORE)
      .sort((a, b) => b.s - a.s || b.r.last_used_at - a.r.last_used_at)
      .slice(0, limit)
      .map((x) => toItem(x.r));
  }

  clearTier(tier: MemoryTier): void {
    this.assertOpen();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM memories WHERE tier = ?').run(tier);
      this.dropOrphanFtsRows();
    });
  }

  /** Memories, logs, topics, preferences and past sessions. plugin_state belongs to plugins and stays. */
  clearAll(): void {
    this.assertOpen();
    this.db.transaction(() => {
      for (const table of ['memories', 'utterances', 'screen_events', 'topics', 'preferences']) {
        this.db.exec(`DELETE FROM ${table}`);
      }
      if (this.fts) this.db.exec('DELETE FROM memories_fts');
      this.db.prepare('DELETE FROM sessions WHERE id IS NOT ?').run(this.sessionId);
    });
  }

  stats(): MemoryStats {
    this.assertOpen();
    const count = (sql: string, ...params: SqlValue[]) => num(this.db.prepare(sql).get(...params)?.n);
    return {
      backend: 'sqlite',
      fts: this.fts,
      long: count("SELECT COUNT(*) AS n FROM memories WHERE tier = 'long'"),
      session: count("SELECT COUNT(*) AS n FROM memories WHERE tier = 'session'"),
      utterances: count('SELECT COUNT(*) AS n FROM utterances'),
      screenEvents: count('SELECT COUNT(*) AS n FROM screen_events'),
      topics: count('SELECT COUNT(*) AS n FROM topics'),
      sessions: count('SELECT COUNT(*) AS n FROM sessions'),
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch (err) {
      console.error('[memory] close failed:', errorMessage(err));
    }
  }

  // ---- MemoryJournal (never throws) ----

  beginSession(at: number): number | null {
    return this.guard('beginSession', null, () =>
      this.db.transaction(() => {
        // A crash leaves sessions open; close them at their last known activity.
        this.db
          .prepare(
            `UPDATE sessions SET ended_at = MAX(started_at,
               COALESCE((SELECT MAX(at) FROM utterances u WHERE u.session_id = sessions.id), started_at))
             WHERE ended_at IS NULL`,
          )
          .run();
        this.sessionId = this.db.prepare('INSERT INTO sessions (started_at) VALUES (?)').run(at).lastInsertRowid;
        return this.sessionId;
      }),
    );
  }

  /**
   * Marks the session finished. The id stays current so a summary written
   * while the app shuts down is still attributed to it.
   */
  endSession(at: number): void {
    if (this.sessionId === null) return;
    const id = this.sessionId;
    this.guard('endSession', undefined, () => {
      this.db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(at, id);
    });
  }

  logUtterance(u: UtteranceRecord): void {
    const text = cleanText(u.text, MAX_LEN.utterance);
    if (!text) return;
    this.guard('logUtterance', undefined, () => {
      this.db
        .prepare('INSERT INTO utterances (session_id, role, source, text, at) VALUES (?, ?, ?, ?, ?)')
        .run(this.sessionId, u.role, u.source ?? null, text, u.at);
    });
  }

  logScreenEvent(e: ScreenEventRecord): void {
    const summary = cleanText(e.summary, MAX_LEN.screen);
    if (!summary) return;
    const source = cleanText(e.source, MAX_LEN.source) || '?';
    this.guard('logScreenEvent', undefined, () => {
      this.db
        .prepare('INSERT INTO screen_events (session_id, kind, source, summary, importance, at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(this.sessionId, e.kind, source, summary, e.importance ?? null, e.at);
    });
  }

  bumpTopic(t: TopicBump): void {
    const label = cleanText(t.label, MAX_LEN.topic);
    const key = normalizeForMatch(label).slice(0, 64);
    if (!key) return;
    this.guard('bumpTopic', undefined, () =>
      this.db.transaction(() => {
        let row = this.db.prepare('SELECT * FROM topics WHERE key = ?').get(key);
        if (!row) {
          const recent = this.db.prepare('SELECT * FROM topics ORDER BY last_at DESC LIMIT 200').all();
          row = recent.find((r) => dice(String(r.key), key) >= TOPIC_MATCH_DICE);
        }
        if (!row) {
          const id = this.db
            .prepare('INSERT INTO topics (key, label, first_at, last_at) VALUES (?, ?, ?, ?)')
            .run(key, label, t.at, t.at).lastInsertRowid;
          row = this.db.prepare('SELECT * FROM topics WHERE id = ?').get(id);
          if (!row) return;
        }
        const newSession = this.sessionId !== null && numOrNull(row.last_session_id) !== this.sessionId;
        this.db
          .prepare(
            `UPDATE topics SET
               mentions = mentions + ?, starts = starts + ?, drops = drops + ?,
               session_count = session_count + ?, last_session_id = COALESCE(?, last_session_id),
               last_at = MAX(last_at, ?)
             WHERE id = ?`,
          )
          .run(
            t.event === 'drop' ? 0 : 1,
            t.event === 'start' ? 1 : 0,
            t.event === 'drop' ? 1 : 0,
            newSession ? 1 : 0,
            this.sessionId,
            t.at,
            num(row.id),
          );
      }),
    );
  }

  purge(now: number, retentionDays: number): PurgeResult {
    const empty: PurgeResult = { utterances: 0, screenEvents: 0, topics: 0, sessionMemories: 0, sessions: 0 };
    const cutoff = now - retentionDays * DAY_MS;
    return this.guard('purge', empty, () =>
      this.db.transaction(() => {
        const del = (sql: string, ...params: SqlValue[]) => this.db.prepare(sql).run(...params).changes;
        const result: PurgeResult = {
          utterances: del('DELETE FROM utterances WHERE at < ?', cutoff),
          screenEvents: del('DELETE FROM screen_events WHERE at < ?', cutoff),
          topics: del('DELETE FROM topics WHERE last_at < ?', cutoff),
          // Long-term memories are kept until the user deletes them.
          sessionMemories: del("DELETE FROM memories WHERE tier = 'session' AND last_used_at < ?", cutoff),
          sessions: del(
            'DELETE FROM sessions WHERE COALESCE(ended_at, started_at) < ? AND id IS NOT ?',
            cutoff,
            this.sessionId,
          ),
        };
        if (result.sessionMemories > 0) this.dropOrphanFtsRows();
        return result;
      }),
    );
  }

  // ---- Topics / plugin state / preferences ----

  listTopics(limit = 20): TopicRow[] {
    return this.guard('listTopics', [], () =>
      this.db
        .prepare('SELECT * FROM topics ORDER BY mentions DESC, last_at DESC LIMIT ?')
        .all(limit)
        .map((r) => ({
          key: String(r.key),
          label: String(r.label),
          mentions: num(r.mentions),
          starts: num(r.starts),
          drops: num(r.drops),
          sessions: num(r.session_count),
          firstAt: num(r.first_at),
          lastAt: num(r.last_at),
        })),
    );
  }

  getPluginState<T = unknown>(pluginId: string, key: string): T | null {
    return this.guard('getPluginState', null, () => {
      const row = this.db.prepare('SELECT value FROM plugin_state WHERE plugin_id = ? AND key = ?').get(pluginId, key);
      return row ? (JSON.parse(String(row.value)) as T) : null;
    });
  }

  /** null / undefined deletes the key. */
  setPluginState(pluginId: string, key: string, value: unknown): void {
    this.guard('setPluginState', undefined, () => {
      const json = value === undefined || value === null ? null : JSON.stringify(value);
      if (json === null || json === undefined) {
        this.db.prepare('DELETE FROM plugin_state WHERE plugin_id = ? AND key = ?').run(pluginId, key);
        return;
      }
      this.db
        .prepare(
          `INSERT INTO plugin_state (plugin_id, key, value, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (plugin_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(pluginId, key, json, this.now());
    });
  }

  getPreference<T = unknown>(key: string): T | null {
    return this.guard('getPreference', null, () => {
      const row = this.db.prepare('SELECT value FROM preferences WHERE key = ?').get(key);
      return row ? (JSON.parse(String(row.value)) as T) : null;
    });
  }

  /** null / undefined deletes the key. */
  setPreference(key: string, value: unknown): void {
    this.guard('setPreference', undefined, () => {
      const json = value === undefined || value === null ? null : JSON.stringify(value);
      if (json === null || json === undefined) {
        this.db.prepare('DELETE FROM preferences WHERE key = ?').run(key);
        return;
      }
      this.db
        .prepare(
          `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(key, json, this.now());
    });
  }

  // ---- internals ----

  private writeClean(clean: string, tier: MemoryTier, at: number, source: MemorySource): MemoryItem {
    const norm = normalizeForMatch(clean);
    const wantLong = tier === 'long' && this.longTermEnabled();
    return this.db.transaction(() => {
      const dup = this.findDuplicate(clean, norm);
      if (dup) return toItem(this.touch(dup, at, { use: false, countSession: true, promote: wantLong }));
      const id = this.db
        .prepare(
          `INSERT INTO memories
             (tier, text, norm, source, created_at, updated_at, last_used_at, uses,
              first_session_id, last_session_id, session_count)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        )
        .run(wantLong ? 'long' : 'session', clean, norm, source, at, at, at, this.sessionId, this.sessionId, this.sessionId === null ? 0 : 1)
        .lastInsertRowid;
      if (this.fts) this.db.prepare('INSERT INTO memories_fts (rowid, grams) VALUES (?, ?)').run(id, gramsOf(clean));
      return { id: String(id), tier: wantLong ? 'long' : 'session', text: clean, createdAt: at, lastUsedAt: at, uses: 0, source };
    });
  }

  /**
   * Record that a memory was used (recall) or rewritten (duplicate write).
   * Seeing it in a new session counts towards promotion to long-term.
   */
  private touch(row: MemoryRow, at: number, opts: { use: boolean; countSession: boolean; promote?: boolean }): MemoryRow {
    let sessionCount = row.session_count;
    let lastSession = row.last_session_id;
    if (opts.countSession && this.sessionId !== null && lastSession !== this.sessionId) {
      sessionCount++;
      lastSession = this.sessionId;
    }
    let tier = row.tier;
    if (tier === 'session' && this.longTermEnabled() && (opts.promote || sessionCount >= PROMOTE_AFTER_SESSIONS)) {
      tier = 'long';
    }
    const next: MemoryRow = {
      ...row,
      tier,
      uses: row.uses + (opts.use ? 1 : 0),
      last_used_at: Math.max(row.last_used_at, at),
      last_session_id: lastSession,
      session_count: sessionCount,
    };
    this.db
      .prepare('UPDATE memories SET tier = ?, uses = ?, last_used_at = ?, last_session_id = ?, session_count = ? WHERE id = ?')
      .run(next.tier, next.uses, next.last_used_at, next.last_session_id, next.session_count, next.id);
    return next;
  }

  private findDuplicate(clean: string, norm: string): MemoryRow | null {
    const exact = this.db.prepare('SELECT * FROM memories WHERE norm = ? LIMIT 1').get(norm);
    if (exact) return asMemoryRow(exact);
    let best: { r: MemoryRow; s: number } | null = null;
    for (const r of this.candidates(clean, DEDUPE_CANDIDATES)) {
      const s = dice(r.text, clean);
      if (s >= DEDUPE_DICE && (!best || s > best.s)) best = { r, s };
    }
    return best?.r ?? null;
  }

  /** Rows that share at least one bigram with the query (FTS5), or every row without FTS. */
  private candidates(query: string, limit: number): MemoryRow[] {
    if (this.fts) {
      const terms = [...bigrams(query)].map((g) => `"${g}"`);
      if (terms.length === 0) return [];
      try {
        return this.db
          .prepare(
            `SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid
             WHERE memories_fts MATCH ? ORDER BY f.rank LIMIT ?`,
          )
          .all(terms.join(' OR '), limit)
          .map(asMemoryRow);
      } catch (err) {
        console.error('[memory] FTS query failed, scanning instead:', errorMessage(err));
      }
    }
    return this.db.prepare('SELECT * FROM memories').all().map(asMemoryRow);
  }

  private rows(tier?: MemoryTier): MemoryRow[] {
    const rows = tier
      ? this.db.prepare('SELECT * FROM memories WHERE tier = ? ORDER BY last_used_at DESC, id DESC').all(tier)
      : this.db.prepare('SELECT * FROM memories ORDER BY last_used_at DESC, id DESC').all();
    return rows.map(asMemoryRow);
  }

  /**
   * The FTS index is derived data, rebuilt on every open. That keeps it
   * correct even if an older build (or a runtime without FTS5) edited the
   * memories table in between. Returns false when FTS5 is unavailable.
   */
  private buildFtsIndex(): boolean {
    try {
      this.db.transaction(() => {
        this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(grams, tokenize = 'unicode61')");
        this.db.exec('DELETE FROM memories_fts');
        const insert = this.db.prepare('INSERT INTO memories_fts (rowid, grams) VALUES (?, ?)');
        for (const r of this.db.prepare('SELECT id, text FROM memories').all()) insert.run(num(r.id), gramsOf(String(r.text)));
      });
      return true;
    } catch (err) {
      console.warn('[memory] FTS5 unavailable, using bigram scan:', errorMessage(err));
      return false;
    }
  }

  private dropOrphanFtsRows(): void {
    if (this.fts) this.db.exec('DELETE FROM memories_fts WHERE rowid NOT IN (SELECT id FROM memories)');
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('memory store is closed');
  }

  private guard<T>(label: string, fallback: T, fn: () => T): T {
    if (this.closed) return fallback;
    try {
      return fn();
    } catch (err) {
      // Message only: never log the text being stored.
      console.error(`[memory] ${label} failed:`, errorMessage(err));
      return fallback;
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
