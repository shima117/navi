import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqliteDb } from '../src/core/memory/Db';
import { isMemoryJournal } from '../src/core/memory/MemoryJournal';
import { InMemoryMemoryStore, isManagedMemoryStore } from '../src/core/memory/MemoryStore';
import { MIGRATIONS, migrate, schemaVersion, type Migration } from '../src/core/memory/migrations';
import { SqliteMemoryStore } from '../src/core/memory/SqliteMemoryStore';
import { count, DAY, makeStore, T0 } from './memory-helpers';

afterEach(() => vi.restoreAllMocks());

describe('migrations', () => {
  it('creates every §6.5 table and records the version', () => {
    const { db } = makeStore();
    expect(schemaVersion(db)).toBe(MIGRATIONS.length);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => String(r.name));
    for (const t of ['sessions', 'utterances', 'memories', 'topics', 'screen_events', 'plugin_state', 'preferences']) {
      expect(tables).toContain(t);
    }
  });

  it('is idempotent', () => {
    const { db } = makeStore();
    expect(migrate(db)).toEqual({ from: 1, to: 1 });
    expect(count(db, 'schema_migrations')).toBe(1);
  });

  it('rolls back a failing migration', () => {
    const db = openSqliteDb(DatabaseSync, ':memory:');
    const broken: Migration[] = [
      ...MIGRATIONS,
      {
        version: 2,
        name: 'broken',
        up(d) {
          d.exec('CREATE TABLE half_done (x INTEGER)');
          d.exec('THIS IS NOT SQL');
        },
      },
    ];
    expect(() => migrate(db, broken)).toThrow();
    expect(schemaVersion(db)).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").get()).toBeUndefined();
  });

  it('refuses a database written by a newer build', () => {
    const db = openSqliteDb(DatabaseSync, ':memory:');
    migrate(db);
    db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (99, ?, 0)').run('future');
    expect(() => new SqliteMemoryStore(db)).toThrow(/newer/);
  });
});

describe('SqliteMemoryStore CRUD', () => {
  it('writes, lists, updates and removes', () => {
    const { store } = makeStore();
    const a = store.write('ユーザーはタルコフが好き', 'session', T0);
    expect(a.id).not.toBe('');
    expect(a.tier).toBe('session');
    expect(store.list().map((m) => m.text)).toEqual(['ユーザーはタルコフが好き']);

    const edited = store.update(a.id, 'ユーザーはタルコフのPvPが好き');
    expect(edited?.text).toBe('ユーザーはタルコフのPvPが好き');
    expect(edited?.source).toBe('user');
    expect(store.update(a.id, '   ')).toBeNull();
    expect(store.update('999', '存在しない')).toBeNull();
    expect(store.update('not-a-number', 'x')).toBeNull();

    store.remove(a.id);
    expect(store.list()).toEqual([]);
    expect(() => store.remove('bogus')).not.toThrow();
  });

  it('ignores empty or punctuation-only writes', () => {
    const { store } = makeStore();
    expect(store.write('   ', 'session', T0).id).toBe('');
    expect(store.write('。。！', 'session', T0).id).toBe('');
    expect(store.list()).toEqual([]);
  });

  it('dedupes exact and near-duplicate writes, keeps distinct facts', () => {
    const { store } = makeStore();
    const a = store.write('ユーザーはタルコフが好き', 'session', T0);
    const b = store.write('ユーザーは タルコフが好き。', 'session', T0 + 1000);
    const c = store.write('ユーザーはタルコフが好きです', 'session', T0 + 2000);
    expect(b.id).toBe(a.id);
    expect(c.id).toBe(a.id);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]!.lastUsedAt).toBe(T0 + 2000);

    store.write('ユーザーはサイドストーリーより対人戦が好き', 'session', T0);
    expect(store.list()).toHaveLength(2);
  });

  it('search is side-effect free and matches substrings', () => {
    const { store } = makeStore();
    store.write('ユーザーはタルコフが好き', 'long', T0);
    store.write('ユーザーは辛いものが苦手', 'session', T0);
    const hits = store.search('タルコフ');
    expect(hits.map((m) => m.text)).toEqual(['ユーザーはタルコフが好き']);
    expect(hits[0]!.uses).toBe(0);
    expect(store.search('', { tier: 'session' }).map((m) => m.text)).toEqual(['ユーザーは辛いものが苦手']);
  });

  it('redacts secrets and never stores inline images', () => {
    const { store, db } = makeStore();
    store.write('ユーザーのAPIキーは sk-abcdefghijklmnopqrstuvwx らしい', 'session', T0);
    store.logUtterance({ role: 'user', text: 'パスワードは hunter22 です', at: T0 });
    store.logScreenEvent({ kind: 'vision', source: 'Chrome', summary: '画像 data:image/png;base64,iVBORw0KGgoAAAANS', at: T0 });
    const dump = JSON.stringify([
      db.prepare('SELECT * FROM memories').all(),
      db.prepare('SELECT * FROM utterances').all(),
      db.prepare('SELECT * FROM screen_events').all(),
    ]);
    expect(dump).not.toContain('sk-abcdef');
    expect(dump).not.toContain('hunter22');
    expect(dump).not.toContain('base64');
    expect(dump).toContain('[伏せ字]');
  });

  it('reports stats', () => {
    const { store } = makeStore();
    store.beginSession(T0);
    store.write('ユーザーはタルコフが好き', 'long', T0);
    store.write('今日は工場マップ', 'session', T0);
    store.logUtterance({ role: 'user', text: 'こんにちは', at: T0 });
    expect(store.stats()).toMatchObject({ backend: 'sqlite', long: 1, session: 1, utterances: 1, sessions: 1 });
  });
});

describe.each([
  { fts: true, label: 'FTS5' },
  { fts: false, label: 'bigram scan' },
])('recall ($label)', ({ fts }) => {
  it('uses the requested backend', () => {
    expect(makeStore({ fts }).store.ftsEnabled).toBe(fts);
  });

  it('returns related memories only, best first', () => {
    const { store } = makeStore({ fts });
    store.write('ユーザーは仕事が嫌い', 'session', T0);
    store.write('ユーザーはバナナが好き', 'session', T0);
    store.write('ユーザーの仕事は在宅のエンジニア', 'session', T0);
    const hits = store.recall('仕事がだるい', 3);
    expect(hits.map((m) => m.text)).toEqual(['ユーザーは仕事が嫌い', 'ユーザーの仕事は在宅のエンジニア']);
    expect(store.recall('量子力学', 3)).toEqual([]);
  });

  it('breaks relevance ties by recency, then by use count', () => {
    const { store, clock } = makeStore({ fts });
    const old = store.write('タルコフの工場マップが好き', 'session', T0 - 60 * DAY);
    const recent = store.write('タルコフの森マップが好き', 'session', T0);
    clock.now = T0;
    expect(store.recall('タルコフ', 2).map((m) => m.id)).toEqual([recent.id, old.id]);

    const { store: s2 } = makeStore({ fts });
    const a = s2.write('タルコフの工場マップが好き', 'session', T0);
    const b = s2.write('タルコフの森マップが好き', 'session', T0);
    for (let i = 0; i < 5; i++) s2.recall('タルコフの森', 1);
    expect(s2.recall('タルコフ', 2).map((m) => m.id)).toEqual([b.id, a.id]);
  });

  it('lets strong relevance beat recency', () => {
    const { store } = makeStore({ fts });
    const stale = store.write('ユーザーはサイドストーリーより対人戦が好き', 'long', T0 - 120 * DAY);
    const fresh = store.write('ユーザーはカレーが好き', 'session', T0);
    expect(store.recall('対人戦が好き', 2).map((m) => m.id)).toEqual([stale.id, fresh.id]);
  });

  it('marks recalled memories as used', () => {
    const { store, clock } = makeStore({ fts });
    const m = store.write('ユーザーはバナナが好き', 'session', T0);
    clock.now = T0 + 5000;
    const [hit] = store.recall('バナナ', 1);
    expect(hit).toMatchObject({ id: m.id, uses: 1, lastUsedAt: T0 + 5000 });
    expect(store.list()[0]).toMatchObject({ uses: 1, lastUsedAt: T0 + 5000 });
  });
});

describe('tiers and promotion', () => {
  it('promotes a session memory recalled in a second session', () => {
    const { store } = makeStore();
    store.beginSession(T0);
    const m = store.write('ユーザーはタルコフのショアラインが苦手', 'session', T0);
    store.recall('ショアライン苦手', 1);
    store.recall('ショアライン苦手', 1);
    expect(store.list()[0]!.tier).toBe('session');

    store.endSession(T0 + 1000);
    store.beginSession(T0 + DAY);
    const [hit] = store.recall('ショアラインが苦手', 1);
    expect(hit).toMatchObject({ id: m.id, tier: 'long' });
  });

  it('promotes a session memory rewritten in a second session', () => {
    const { store } = makeStore();
    store.beginSession(T0);
    store.write('ユーザーは夜にゲームをする', 'session', T0);
    store.beginSession(T0 + DAY);
    expect(store.write('ユーザーは夜にゲームをする', 'session', T0 + DAY).tier).toBe('long');
  });

  it('weak recall hits do not count towards promotion', () => {
    const { store } = makeStore();
    store.beginSession(T0);
    store.write('ユーザーはタルコフの工場マップでよく死ぬ', 'session', T0);
    store.beginSession(T0 + DAY);
    // Shares only "工場": related enough to recall (0.25), too weak to count.
    expect(store.recall('工場の見学', 1)).toHaveLength(1);
    expect(store.list()[0]!.tier).toBe('session');
  });

  it('keeps everything session-tier while long-term memory is off', () => {
    const { store } = makeStore({ longTermEnabled: () => false });
    store.beginSession(T0);
    expect(store.write('ユーザーはタルコフが好き', 'long', T0).tier).toBe('session');
    store.beginSession(T0 + DAY);
    store.recall('タルコフが好き', 1);
    store.beginSession(T0 + 2 * DAY);
    store.recall('タルコフが好き', 1);
    expect(store.list()[0]!.tier).toBe('session');
  });

  it('explicit long writes are long-term and never demoted', () => {
    const { store } = makeStore();
    const m = store.write('ユーザーはタルコフが好き', 'long', T0);
    expect(m.tier).toBe('long');
    expect(store.write('ユーザーはタルコフが好き', 'session', T0).tier).toBe('long');
  });

  it('clearSession drops session memories only; clearAll forgets everything but plugin data', () => {
    const { store, db } = makeStore();
    store.beginSession(T0);
    store.write('ユーザーはタルコフが好き', 'long', T0);
    store.write('今日はレイドで3回死んだ', 'session', T0);
    store.logUtterance({ role: 'user', text: 'またやられた', at: T0 });
    store.bumpTopic({ label: 'タルコフの話', event: 'start', at: T0 });
    store.setPreference('tone', 'dry');
    store.setPluginState('tarkov', 'tasks', ['Debut']);

    store.clearSession();
    expect(store.list().map((m) => m.tier)).toEqual(['long']);
    expect(count(db, 'utterances')).toBe(1);

    store.clearAll();
    expect(store.list()).toEqual([]);
    for (const t of ['utterances', 'screen_events', 'topics', 'preferences']) expect(count(db, t)).toBe(0);
    expect(store.getPluginState('tarkov', 'tasks')).toEqual(['Debut']);
    // The running session keeps its row so later writes still attach to it.
    expect(count(db, 'sessions')).toBe(1);
    expect(store.recall('タルコフ', 3)).toEqual([]);
  });

  it('clearTier long keeps session memories', () => {
    const { store } = makeStore();
    store.write('ユーザーはタルコフが好き', 'long', T0);
    store.write('今日はレイドで3回死んだ', 'session', T0);
    store.clearTier('long');
    expect(store.list().map((m) => m.tier)).toEqual(['session']);
  });
});

describe('journal', () => {
  it('opens and closes sessions, closing ones left open by a crash', () => {
    const { store, db } = makeStore();
    const first = store.beginSession(T0);
    store.logUtterance({ role: 'user', text: 'こんにちは', at: T0 + 500 });
    const second = store.beginSession(T0 + DAY);
    expect(second).not.toBe(first);
    expect(Number(db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(first)?.ended_at)).toBe(T0 + 500);
    store.endSession(T0 + DAY + 100);
    expect(Number(db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(second)?.ended_at)).toBe(T0 + DAY + 100);
  });

  it('counts topics and merges near-identical labels', () => {
    const { store } = makeStore();
    store.beginSession(T0);
    store.bumpTopic({ label: 'タルコフのタスクの話', event: 'start', at: T0 });
    store.bumpTopic({ label: 'タルコフのタスクの話', event: 'continue', at: T0 + 1 });
    store.bumpTopic({ label: 'タルコフのタスクの話', event: 'drop', at: T0 + 2 });
    store.beginSession(T0 + DAY);
    store.bumpTopic({ label: 'タルコフのタスクの話だけど', event: 'start', at: T0 + DAY });
    store.bumpTopic({ label: '晩ごはん', event: 'start', at: T0 + DAY });
    const [top, other] = store.listTopics();
    expect(top).toMatchObject({ label: 'タルコフのタスクの話', mentions: 3, starts: 2, drops: 1, sessions: 2 });
    expect(other).toMatchObject({ label: '晩ごはん', mentions: 1 });
  });

  it('round-trips plugin state and preferences as JSON', () => {
    const { store } = makeStore();
    store.setPluginState('tarkov', 'progress', { level: 12, tasks: ['Debut'] });
    expect(store.getPluginState('tarkov', 'progress')).toEqual({ level: 12, tasks: ['Debut'] });
    store.setPluginState('tarkov', 'progress', { level: 13 });
    expect(store.getPluginState('tarkov', 'progress')).toEqual({ level: 13 });
    store.setPluginState('tarkov', 'progress', null);
    expect(store.getPluginState('tarkov', 'progress')).toBeNull();
    store.setPreference('tone', { dry: true });
    expect(store.getPreference('tone')).toEqual({ dry: true });
    expect(store.getPreference('missing')).toBeNull();
  });

  it('purges logs and unused session memories past the retention window', () => {
    const { store, db } = makeStore();
    const now = T0 + 100 * DAY;
    store.beginSession(T0);
    store.logUtterance({ role: 'user', text: '古い発言', at: T0 });
    store.logScreenEvent({ kind: 'vision', source: 'Chrome', summary: '古い画面', at: T0 });
    store.bumpTopic({ label: '古い話題', event: 'start', at: T0 });
    store.write('使われていない古いセッション記憶', 'session', T0);
    store.write('ずっと覚えている長期記憶', 'long', T0);
    store.endSession(T0 + 1000);

    store.beginSession(now - DAY);
    store.logUtterance({ role: 'user', text: '新しい発言', at: now - DAY });
    store.logScreenEvent({ kind: 'plugin', source: 'tarkov', summary: '新しいイベント', at: now - DAY, importance: 0.5 });
    store.write('最近のセッション記憶', 'session', now - DAY);

    const result = store.purge(now, 30);
    expect(result).toEqual({ utterances: 1, screenEvents: 1, topics: 1, sessionMemories: 1, sessions: 1 });
    expect(store.list().map((m) => m.text).sort()).toEqual(['ずっと覚えている長期記憶', '最近のセッション記憶'].sort());
    expect(count(db, 'utterances')).toBe(1);
    expect(store.recall('使われていない古いセッション記憶', 3).map((m) => m.text)).not.toContain('使われていない古いセッション記憶');
    if (store.ftsEnabled) expect(count(db, 'memories_fts')).toBe(2);
  });
});

describe('durability and failure', () => {
  it('persists across reopen and rebuilds the FTS index', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'navi-memory-'));
    try {
      const file = path.join(dir, 'navi.sqlite');
      const a = new SqliteMemoryStore(openSqliteDb(DatabaseSync, file));
      a.beginSession(T0);
      a.write('ユーザーはタルコフが好き', 'long', T0);
      a.close();

      // Edited by a run without FTS: the index must not go stale.
      const b = new SqliteMemoryStore(openSqliteDb(DatabaseSync, file), { fts: false });
      b.write('ユーザーは辛いものが苦手', 'session', T0);
      b.close();

      const c = new SqliteMemoryStore(openSqliteDb(DatabaseSync, file));
      expect(c.ftsEnabled).toBe(true);
      expect(c.recall('辛いもの', 1).map((m) => m.text)).toEqual(['ユーザーは辛いものが苦手']);
      expect(c.stats()).toMatchObject({ long: 1, session: 1, sessions: 1 });
      c.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('degrades instead of throwing on the conversation path (§19)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { store, db } = makeStore();
    store.write('ユーザーはタルコフが好き', 'session', T0);
    db.exec('DROP TABLE memories');
    expect(store.recall('タルコフ', 3)).toEqual([]);
    expect(store.write('新しい記憶', 'session', T0).id).toBe('');
    expect(() => store.clearSession()).not.toThrow();
    expect(() => store.logUtterance({ role: 'user', text: 'x', at: T0 })).not.toThrow();
  });

  it('is inert after close', () => {
    const { store } = makeStore();
    store.close();
    expect(store.write('ユーザーはタルコフが好き', 'session', T0).id).toBe('');
    expect(store.recall('タルコフ')).toEqual([]);
    expect(() => store.stats()).toThrow(/closed/);
    expect(() => store.close()).not.toThrow();
  });
});

describe('store capabilities', () => {
  it('both stores support the Memory tab; only SQLite keeps a journal', () => {
    const sqlite = makeStore().store;
    const mem = new InMemoryMemoryStore();
    expect(isManagedMemoryStore(sqlite)).toBe(true);
    expect(isManagedMemoryStore(mem)).toBe(true);
    expect(isMemoryJournal(sqlite)).toBe(true);
    expect(isMemoryJournal(mem)).toBe(false);
  });

  it('in-memory fallback supports edit, search and clearing', () => {
    const mem = new InMemoryMemoryStore();
    const a = mem.write('ユーザーはタルコフが好き', 'long', T0);
    mem.write('今日はレイドで3回死んだ', 'session', T0);
    expect(mem.update(a.id, 'ユーザーはタルコフが大好き')?.text).toBe('ユーザーはタルコフが大好き');
    expect(mem.search('タルコフ').map((m) => m.id)).toEqual([a.id]);
    expect(mem.stats()).toMatchObject({ backend: 'memory', long: 1, session: 1 });
    mem.clearSession();
    expect(mem.list().map((m) => m.tier)).toEqual(['long']);
    mem.clearAll();
    expect(mem.list()).toEqual([]);
  });
});
