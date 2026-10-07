import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { openSqliteDb } from '../src/core/memory/Db';
import { TaskDatabase } from '../src/core/tasks/TaskDatabase';
import { TaskEngine, type TaskOutcome, type TaskRunner } from '../src/core/tasks/TaskEngine';
import { CircuitBreaker, FailureBudget, ResourceLock, checkTaskPolicy } from '../src/core/tasks/TaskSafety';
import { initialTask, type TaskRequest } from '../src/core/tasks/TaskProtocol';
import { detectTaskIntent } from '../src/core/tasks/TaskIntent';
import { runLocalTask } from '../src/core/tasks/LocalTaskRunner';
import { mkdtemp, writeFile, rm, mkdir, symlink, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const request = (id = 'task-a', patch: Partial<TaskRequest> = {}): TaskRequest => ({
  id, idempotencyKey: id, kind: 'LOCAL_HEALTH', traceId: 'trace-a', createdAt: Date.now(), ...patch,
});
const outcome: TaskOutcome = { state: 'SUCCESS', summary: '確認済み', verification: { method: 'HTTP', result: 'PASS', evidence: 'HTTP 200 from fixed local health endpoint' } };
const engines: TaskEngine[] = [];
const dbs: TaskDatabase[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  for (const db of dbs.splice(0)) db.close();
  vi.unstubAllGlobals();
});
function database() { const db = new TaskDatabase(openSqliteDb(DatabaseSync, ':memory:')); dbs.push(db); return db; }
function engine(runner: TaskRunner = async () => outcome) {
  const db = database();
  const send = vi.fn();
  const e = new TaskEngine(db, runner, send);
  engines.push(e);
  return { db, e, send };
}

describe('agent persistence and safety', () => {
  it('stores idempotency across reopening and refuses conflicting reuse', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'navi-task-db-'));
    const file = path.join(dir, 'tasks.sqlite');
    const a = new TaskDatabase(openSqliteDb(DatabaseSync, file));
    a.create(initialTask(request()));
    a.close();
    const b = new TaskDatabase(openSqliteDb(DatabaseSync, file));
    try {
      expect(b.create(initialTask(request('task-b', { idempotencyKey: 'task-a' }))).request.id).toBe('task-a');
      expect(() => b.create(initialTask(request('task-c', { idempotencyKey: 'task-a', kind: 'PROJECT_INSPECT', projectRoot: dir })))).toThrow('conflicts');
      expect(b.recover(Date.now())[0]?.snapshot.status).toBe('WAITING');
    } finally { b.close(); await rm(dir, { recursive: true, force: true }); }
  });
  it('does not accept a success summary without verification', async () => {
    const { e, db } = engine(async () => ({ ...outcome, verification: { ...outcome.verification, result: 'FAIL' } }));
    e.enqueue(request());
    await vi.waitFor(() => expect(db.get('task-a')?.snapshot.status).toBe('WAITING'));
    expect(db.get('task-a')?.snapshot.lastReport?.verified).toBe(false);
    expect(db.get('task-a')?.snapshot.lastReport?.state).toBe('FAILED');
  });
  it('runs and verifies the action exactly once for duplicate keys', async () => {
    const run = vi.fn(async () => outcome);
    const { e, db } = engine(run);
    e.enqueue(request());
    e.enqueue(request());
    await vi.waitFor(() => expect(db.get('task-a')?.snapshot.status).toBe('DONE'));
    expect(run).toHaveBeenCalledTimes(1);
    expect(db.get('task-a')?.snapshot.lastReport?.verified).toBe(true);
  });
  it('cancellation wins over a late successful runner result', async () => {
    let release!: (result: TaskOutcome) => void;
    const { e, db } = engine(() => new Promise((resolve) => { release = resolve; }));
    e.enqueue(request());
    expect(e.control('CANCEL')).toBe(1);
    release(outcome);
    await vi.waitFor(() => expect(db.get('task-a')?.snapshot.status).toBe('CANCELLED'));
    await Promise.resolve();
    expect(db.get('task-a')?.snapshot.status).toBe('CANCELLED');
  });
  it('pause followed immediately by resume cannot be overwritten by the old abort', async () => {
    let calls = 0;
    const { e, db } = engine(async (_r, signal) => {
      if (++calls === 1) await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      return outcome;
    });
    e.enqueue(request());
    e.control('PAUSE');
    e.control('RESUME');
    await vi.waitFor(() => expect(db.get('task-a')?.snapshot.status).toBe('DONE'));
    expect(calls).toBe(2);
  });
  it('holds the same resource lock across work, and cancels queued work', async () => {
    let release!: (value: TaskOutcome) => void;
    const runner = vi.fn(() => new Promise<TaskOutcome>((resolve) => { release = resolve; }));
    const { e, db } = engine(runner);
    e.enqueue(request('task-a'));
    e.enqueue(request('task-b'));
    expect(runner).toHaveBeenCalledTimes(1);
    e.control('CANCEL', 'task-b');
    release(outcome);
    await vi.waitFor(() => expect(db.get('task-a')?.snapshot.status).toBe('DONE'));
    expect(db.get('task-b')?.snapshot.status).toBe('CANCELLED');
    expect(runner).toHaveBeenCalledTimes(1);
  });
  it('stops after two identical errors, persists the retry budget and does not resume automatically', async () => {
    const run = vi.fn(async () => { throw new Error('same-error'); });
    const { e, db } = engine(run);
    e.enqueue(request());
    await vi.waitFor(() => expect(db.get('task-a')?.snapshot.status).toBe('WAITING'));
    expect(run).toHaveBeenCalledTimes(2);
    expect(db.get('task-a')?.lastFailure?.consecutive).toBe(2);
    expect(e.control('RESUME')).toBe(0);
    expect(db.get('task-a')?.snapshot.lastReport?.state).toBe('WAITING_USER');
  });
  it('failure budget, breaker and locks fail closed', () => {
    const budget = new FailureBudget(0);
    budget.begin(1); budget.failed('a'); budget.begin(2); budget.failed('a');
    expect(budget.canAttempt(3)).toBe(false);
    expect(new FailureBudget(0).canAttempt(30000)).toBe(false);
    const paused = new FailureBudget(0);
    paused.begin(1); paused.pause(100);
    expect(paused.canAttempt(60000)).toBe(true);
    paused.resume(60000);
    expect(paused.canAttempt(60001)).toBe(true);
    const c = new CircuitBreaker(2, 100);
    c.failure(0); c.failure(1);
    expect(c.enter(50)).toBe(false);
    expect(c.enter(101)).toBe(true);
    expect(c.enter(101)).toBe(false);
    c.releaseProbe();
    expect(c.enter(101)).toBe(true);
    c.success();
    expect(c.state).toBe('CLOSED');
    const locks = new ResourceLock();
    const release = locks.acquire('a', ['repo:x'])!;
    expect(locks.acquire('b', ['repo:x', 'repo:y'])).toBeNull();
    expect(locks.acquire('c', ['repo:y'])).not.toBeNull();
    release();
    expect(locks.acquire('b', ['repo:x'])).not.toBeNull();
    for (const action of ['SHELL', 'INSTALL', 'CLOUD', 'SELF_UPDATE']) expect(() => checkTaskPolicy(action)).toThrow();
  });
  it('estimates only from observed successful tasks, not fixed constants', () => {
    const db = database();
    expect(db.estimate('LOCAL_HEALTH', .5)).toBeNull();
    for (let i = 0; i < 3; i++) {
      const record = initialTask(request(`history-${i}`));
      db.create(record);
      record.startedAt = 1000; record.endedAt = 5000 + i * 1000;
      record.snapshot.status = 'DONE';
      record.snapshot.lastReport = { taskId: record.request.id, action: 'LOCAL_HEALTH', state: 'SUCCESS', summary: 'ok',
        verified: true, verification: outcome.verification, timestamp: record.endedAt };
      db.save(record);
    }
    expect(db.estimate('LOCAL_HEALTH', .5)).toMatchObject({ minSeconds: 2, maxSeconds: 3, confidence: 'LOW' });
  });
});

describe('read-only workers and task intents', () => {
  it('health checks stay on localhost, do not follow redirects and report partial honestly', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    const result = await runLocalTask(request(), new AbortController().signal, vi.fn());
    expect(result.state).toBe('PARTIAL');
    expect(result.verification.result).toBe('FAIL');
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [url, opts] of fetch.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(new URL(url).hostname).toBe('127.0.0.1');
      expect(opts.redirect).toBe('error');
    }
  });
  it('reads only the selected manifest, never executes scripts or echoes invalid JSON contents', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'navi-task-read-'));
    try {
      await writeFile(path.join(dir, 'package.json'), '{"scripts":{"postinstall":"DO NOT RUN"}}');
      const result = await runLocalTask(request('project', { kind: 'PROJECT_INSPECT', projectRoot: dir }), new AbortController().signal, vi.fn());
      expect(result.state).toBe('SUCCESS');
      expect(result.summary).not.toContain('DO NOT RUN');
      expect(result.verification.method).toBe('FILE');
      await writeFile(path.join(dir, 'package.json'), 'SECRET VALUE NOT JSON');
      await expect(runLocalTask(request('invalid', { kind: 'PROJECT_INSPECT', projectRoot: dir }), new AbortController().signal, vi.fn()))
        .rejects.toThrow('package.json の形式が正しくありません。');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('recognizes controls narrowly and does not convert file deletion text into global cancel', () => {
    expect(detectTaskIntent('NAVIの環境を確認して')).toEqual({ type: 'start', kind: 'LOCAL_HEALTH' });
    expect(detectTaskIntent('今進捗どう？').type).toBe('status');
    expect(detectTaskIntent('それ一旦止めて')).toEqual({ type: 'control', command: 'PAUSE', all: false });
    expect(detectTaskIntent('やめて')).toEqual({ type: 'control', command: 'CANCEL', all: true });
    expect(detectTaskIntent('このファイルを消して').type).toBe('none');
  });
  it('rejects oversized files and a root that resolves outside the authorized canonical path', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'navi-task-scope-'));
    try {
      const selected = path.join(dir, 'selected');
      const alias = path.join(dir, 'alias');
      await mkdir(selected);
      const canonical = await realpath(selected);
      await writeFile(path.join(selected, 'package.json'), Buffer.alloc(1024 * 1024 + 1, 32));
      await expect(runLocalTask(request('large', { kind: 'PROJECT_INSPECT', projectRoot: canonical }), new AbortController().signal, vi.fn()))
        .rejects.toThrow('大きすぎる');
      await writeFile(path.join(selected, 'package.json'), '{}');
      await symlink(selected, alias, process.platform === 'win32' ? 'junction' : 'dir');
      await expect(runLocalTask(request('redirected', { kind: 'PROJECT_INSPECT', projectRoot: alias }), new AbortController().signal, vi.fn()))
        .rejects.toThrow('場所が変わりました');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
