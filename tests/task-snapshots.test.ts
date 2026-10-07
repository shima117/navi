import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatTaskSnapshots, TaskSnapshotPublisher, type TaskSnapshot } from '../src/core/tasks/TaskSnapshotPublisher';
import type { OperationReport } from '../src/core/tasks/OperationReport';

const snap = (patch: Partial<TaskSnapshot> = {}): TaskSnapshot => ({
  id: 'a', title: 'コード修正', status: 'RUNNING', phase: 'test', currentAction: 'テストを確認しています。',
  progress: null, eta: null, lastUpdateAt: 1, ...patch,
});
const verified: OperationReport = { taskId: 'a', action: 'test', state: 'SUCCESS', summary: 'テスト通過',
  verified: true, verification: { method: 'EXIT_CODE', result: 'PASS', evidence: 'test process exit 0' }, timestamp: 10 };
afterEach(() => vi.useRealTimers());

describe('v3.2 snapshot publication', () => {
  it('updates internal state immediately but coalesces ten thousand progress events', () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const p = new TaskSnapshotPublisher(send);
    p.update(snap());
    for (let i = 2; i <= 10000; i++) p.update(snap({ progress: i / 10000, lastUpdateAt: i }));
    expect(p.read('a')?.progress).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(150);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0].lastUpdateAt).toBe(10000);
    p.dispose();
  });
  it.each(['PAUSED', 'NEEDS_APPROVAL', 'FAILED', 'CANCELLED', 'WAITING', 'VERIFYING'] as const)('delivers %s immediately and discards old progress', (status) => {
    vi.useFakeTimers();
    const send = vi.fn();
    const p = new TaskSnapshotPublisher(send);
    p.update(snap());
    p.update(snap({ progress: .4, lastUpdateAt: 2 }));
    p.update(snap({ status, lastUpdateAt: 3 }));
    expect(send).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(150);
    expect(send).toHaveBeenCalledTimes(2);
    p.dispose();
  });
  it('requires evidence for DONE and never reopens a terminal task with late progress', () => {
    const send = vi.fn();
    const p = new TaskSnapshotPublisher(send);
    expect(() => p.update(snap({ status: 'DONE' }))).toThrow('verified');
    expect(() => p.update(snap({ status: 'DONE' }), { ...verified, verified: false })).toThrow('verified');
    expect(() => p.update(snap({ status: 'DONE' }), { ...verified, taskId: 'other' })).toThrow('verified');
    p.update(snap({ status: 'DONE' }), verified);
    p.update(snap({ status: 'RUNNING', lastUpdateAt: 20 }));
    expect(p.read('a')?.status).toBe('DONE');
    p.dispose();
  });
  it('announces blocker changes and partial outcomes immediately', () => {
    const send = vi.fn();
    const p = new TaskSnapshotPublisher(send);
    p.update(snap());
    p.update(snap({ blocker: '入力待ち', lastUpdateAt: 2 }));
    p.update(snap({ blocker: '入力待ち', lastUpdateAt: 3 }), { ...verified, state: 'PARTIAL', verified: false });
    expect(send).toHaveBeenCalledTimes(3);
    expect(p.read('a')?.lastReport?.state).toBe('PARTIAL');
    expect(formatTaskSnapshots(p.list())).toContain('一部だけ');
    p.dispose();
  });
  it('isolates publication failure and keeps data immutable and capacity bounded', () => {
    const p = new TaskSnapshotPublisher(() => { throw new Error('renderer gone'); }, 150, 1);
    const original = snap();
    p.update(original);
    original.title = 'changed';
    const copy = p.read('a')!;
    copy.title = 'changed';
    expect(p.read('a')?.title).toBe('コード修正');
    expect(() => p.update(snap({ id: 'b' }))).toThrow('capacity');
    p.update(snap({ status: 'FAILED', lastUpdateAt: 2 }));
    p.update(snap({ id: 'b' }));
    expect(p.list()).toHaveLength(1);
    expect(p.read('a')).toBeNull();
    p.dispose();
  });
  it('reports unknown ETA honestly and never invents a task', () => {
    expect(formatTaskSnapshots([])).toContain('作業はありません');
    expect(formatTaskSnapshots([snap()])).toContain('まだ見積もれません');
    expect(formatTaskSnapshots([snap({ eta: { minSeconds: 60, maxSeconds: 180, confidence: 'LOW' } })])).toContain('1〜3分（不確か）');
  });
});
