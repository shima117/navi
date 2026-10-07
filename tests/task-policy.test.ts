import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { openSqliteDb, type Db } from '../src/core/memory/Db';
import { ApprovalStore, PROJECT_CONSENT_TTL, type ProjectConsent } from '../src/core/tasks/ApprovalStore';
import { PolicyEngine } from '../src/core/tasks/PolicyEngine';
import { TaskEngine, type TaskRunner } from '../src/core/tasks/TaskEngine';
import { TaskDatabase } from '../src/core/tasks/TaskDatabase';
import type { TaskRequest } from '../src/core/tasks/TaskProtocol';

const root = path.resolve('fixture-selected');
const request = (patch: Partial<TaskRequest> = {}): TaskRequest => ({
  id: 'task-a', idempotencyKey: 'task-a', kind: 'PROJECT_INSPECT', projectRoot: root,
  approvalId: 'approval-a', traceId: 'trace-a', createdAt: 1000, ...patch,
});
const consent = (patch: Partial<ProjectConsent> = {}): ProjectConsent => ({
  id: 'approval-a', taskId: 'task-a', projectRoot: root, grantedAt: 1000, expiresAt: 1000 + PROJECT_CONSENT_TTL, ...patch,
});
const connections: Db[] = [];
const engines: TaskEngine[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  for (const db of connections.splice(0)) db.close();
});
function setup() {
  const db = openSqliteDb(DatabaseSync, ':memory:'); connections.push(db);
  let now = 1000;
  const approvals = new ApprovalStore(db, () => now);
  const policy = new PolicyEngine(approvals);
  return { db, approvals, policy, setTime: (t: number) => { now = t; }, now: () => now };
}

describe('native policy and task-scoped consent', () => {
  it('allows only fixed health without a project or approval payload', () => {
    const { policy } = setup();
    expect(policy.authorize(request({ kind: 'LOCAL_HEALTH', projectRoot: undefined, approvalId: undefined })).state).toBe('ALLOW');
    expect(policy.authorize(request({ kind: 'LOCAL_HEALTH' })).state).toBe('DENY');
  });
  it.each(['SHELL', 'INSTALL', 'CLOUD', 'SELF_UPDATE', 'PC_OPERATION', 'PROTECTED_CORE_UPDATE'])('denies %s even with approval flags', (kind) => {
    const { approvals, policy } = setup(); approvals.grantProject(consent());
    expect(policy.authorize({ ...request(), kind, approved: true, tier: 'EXPERT' } as unknown as TaskRequest).state).toBe('DENY');
  });
  it('requires native consent and never trusts a task approved flag', () => {
    const { policy } = setup();
    expect(policy.authorize({ ...request(), approved: true } as TaskRequest).state).toBe('NEEDS_APPROVAL');
    expect(new PolicyEngine().authorize(request()).state).toBe('NEEDS_APPROVAL');
  });
  it('binds one consent to one task, exact root and capability; retries retain only that scope', () => {
    const { approvals, policy } = setup(); approvals.grantProject(consent());
    expect(policy.authorize(request({ id: 'task-b' })).state).toBe('NEEDS_APPROVAL');
    expect(policy.authorize(request({ projectRoot: path.resolve('other-project') })).state).toBe('NEEDS_APPROVAL');
    expect(policy.authorize(request()).state).toBe('ALLOW');
    expect(approvals.get('approval-a')?.state).toBe('CONSUMED');
    expect(policy.authorize(request()).state).toBe('ALLOW');
    expect(() => approvals.grantProject(consent())).toThrow();
    expect(approvals.list()).toHaveLength(1);
  });
  it('rejects relative, traversal and overbroad or stale consent', () => {
    const { approvals, policy } = setup();
    expect(policy.authorize(request({ projectRoot: '../anything' })).state).toBe('DENY');
    for (const patch of [
      { projectRoot: '../anything' }, { expiresAt: 1000 }, { grantedAt: 1001 },
      { expiresAt: 1001 + PROJECT_CONSENT_TTL }, { projectRoot: root + path.sep + '..' }, { id: '' },
    ]) expect(() => approvals.grantProject(consent(patch))).toThrow();
  });
  it('expires on the boundary and cannot silently renew through resume', () => {
    const { approvals, policy, setTime } = setup(); approvals.grantProject(consent());
    expect(policy.authorize(request()).state).toBe('ALLOW');
    setTime(1000 + PROJECT_CONSENT_TTL);
    expect(policy.authorize(request()).state).toBe('NEEDS_APPROVAL');
  });
  it('fails closed on a malformed durable authority record', () => {
    const { approvals, policy, db } = setup(); approvals.grantProject(consent());
    const record = approvals.get('approval-a')!;
    db.prepare('UPDATE agent_approvals SET record_json = ? WHERE id = ?')
      .run(JSON.stringify({ ...record, state: 'UNKNOWN' }), record.id);
    expect(policy.authorize(request()).state).toBe('NEEDS_APPROVAL');
  });
  it('revokes without deleting the audit, and reopening a session does not restore authority', () => {
    const { approvals, policy, db } = setup(); approvals.grantProject(consent());
    expect(policy.authorize(request()).state).toBe('ALLOW');
    approvals.invalidateSession();
    const reopened = new ApprovalStore(db, () => 1001);
    expect(new PolicyEngine(reopened).authorize(request()).state).toBe('NEEDS_APPROVAL');
    expect(reopened.list()[0]?.state).toBe('REVOKED');
    expect(db.prepare('SELECT state FROM agent_approval_audit ORDER BY id').all().map((r) => r.state)).toEqual(['APPROVED', 'CONSUMED', 'REVOKED']);
  });
  it('does not call the runner without approval and can still run unrelated health', async () => {
    const { db, policy, now } = setup();
    const tasks = new TaskDatabase(db);
    const runner = vi.fn<TaskRunner>(async () => ({ state: 'SUCCESS', summary: 'checked',
      verification: { method: 'HTTP', result: 'PASS', evidence: 'native check' } }));
    const e = new TaskEngine(tasks, runner, vi.fn(), now, 2, policy); engines.push(e);
    e.enqueue(request());
    await vi.waitFor(() => expect(tasks.get('task-a')?.snapshot.status).toBe('WAITING'));
    expect(tasks.get('task-a')?.attempts).toBe(0);
    expect(runner).not.toHaveBeenCalled();
    e.enqueue(request({ id: 'health-a', idempotencyKey: 'health-a', kind: 'LOCAL_HEALTH', projectRoot: undefined, approvalId: undefined }));
    await vi.waitFor(() => expect(tasks.get('health-a')?.snapshot.status).toBe('DONE'));
    expect(runner).toHaveBeenCalledTimes(1);
  });
  it('rechecks authorization before a retry and stops when revoked mid-task', async () => {
    const { db, approvals, policy, now } = setup(); approvals.grantProject(consent());
    const tasks = new TaskDatabase(db);
    const runner = vi.fn<TaskRunner>(async () => { approvals.revokeTask('task-a'); throw new Error('transient failure'); });
    const e = new TaskEngine(tasks, runner, vi.fn(), now, 2, policy); engines.push(e);
    e.enqueue(request());
    await vi.waitFor(() => expect(tasks.get('task-a')?.snapshot.status).toBe('WAITING'));
    expect(tasks.get('task-a')?.snapshot.blocker).toContain('承認');
    expect(runner).toHaveBeenCalledTimes(1);
  });
  it('cancel withdraws the active grant and blocks late success', async () => {
    const { db, approvals, policy, now } = setup(); approvals.grantProject(consent());
    const tasks = new TaskDatabase(db);
    let finish!: () => void;
    const runner: TaskRunner = async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { state: 'SUCCESS', summary: 'ok', verification: { method: 'FILE', result: 'PASS', evidence: 'native file check' } };
    };
    const e = new TaskEngine(tasks, runner, vi.fn(), now, 2, policy); engines.push(e);
    e.enqueue(request());
    e.control('CANCEL'); finish();
    await Promise.resolve();
    expect(tasks.get('task-a')?.snapshot.status).toBe('CANCELLED');
    expect(approvals.get('approval-a')?.state).toBe('REVOKED');
  });
});
