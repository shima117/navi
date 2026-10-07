import type { Db } from '../memory/Db';
import { isVerifiedSuccess } from './OperationReport';
import { TASK_TERMINAL, type TaskKind, type TaskRecord } from './TaskProtocol';

/** All database IO occurs in the separate Agent process, never Electron main. */
export class TaskDatabase {
  constructor(private readonly db: Db) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
      record_json TEXT NOT NULL, created_at INTEGER NOT NULL, ended_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS agent_audit (
      id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL
    );`);
  }
  create(record: TaskRecord): TaskRecord {
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT record_json FROM agent_tasks WHERE idempotency_key = ?').get(record.request.idempotencyKey);
      if (existing) {
        const prior = JSON.parse(String(existing.record_json)) as TaskRecord;
        if (prior.request.kind !== record.request.kind || prior.request.projectRoot !== record.request.projectRoot) throw new Error('Idempotency key conflicts with another action');
        return prior;
      }
      this.db.prepare('INSERT INTO agent_tasks(id,idempotency_key,kind,record_json,created_at) VALUES(?,?,?,?,?)')
        .run(record.request.id, record.request.idempotencyKey, record.request.kind, JSON.stringify(record), record.request.createdAt);
      this.audit(record);
      return structuredClone(record);
    });
  }
  save(record: TaskRecord): void {
    if (record.snapshot.status === 'DONE' && !isVerifiedSuccess(record.snapshot.lastReport, record.request.id)) throw new Error('Unverified completion');
    this.db.transaction(() => {
      const old = this.get(record.request.id);
      if (!old) throw new Error('Task not registered');
      if (TASK_TERMINAL.has(old.snapshot.status)) return;
      this.db.prepare('UPDATE agent_tasks SET record_json = ?, ended_at = ? WHERE id = ?')
        .run(JSON.stringify(record), record.endedAt, record.request.id);
      if (old.snapshot.status !== record.snapshot.status) this.audit(record);
    });
  }
  get(id: string): TaskRecord | null {
    const row = this.db.prepare('SELECT record_json FROM agent_tasks WHERE id = ?').get(id);
    return row ? JSON.parse(String(row.record_json)) as TaskRecord : null;
  }
  hasIdempotencyKey(key: string): boolean { return !!this.db.prepare('SELECT id FROM agent_tasks WHERE idempotency_key = ?').get(key); }
  recent(): TaskRecord[] {
    return this.db.prepare('SELECT record_json FROM agent_tasks ORDER BY CASE WHEN ended_at IS NULL THEN 0 ELSE 1 END, created_at DESC LIMIT 128').all()
      .map((row) => JSON.parse(String(row.record_json)) as TaskRecord);
  }
  recover(now: number): TaskRecord[] {
    for (const record of this.recent()) {
      if (TASK_TERMINAL.has(record.snapshot.status) || record.snapshot.status === 'PAUSED') continue;
      record.snapshot = { ...record.snapshot, status: 'WAITING', phase: 'recovery',
        currentAction: '前の作業は再開せずに保留しています。', blocker: '前回の作業プロセスが終了しました。再開するか確認してください。', lastUpdateAt: now };
      this.save(record);
    }
    return this.recent();
  }
  estimate(kind: TaskKind, remaining: number): import('./TaskSnapshotPublisher').TaskSnapshot['eta'] {
    const rows = this.db.prepare('SELECT record_json FROM agent_tasks WHERE kind = ? AND ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 20').all(kind);
    const durations = rows.map((row) => JSON.parse(String(row.record_json)) as TaskRecord)
      .filter((r) => r.snapshot.status === 'DONE' && r.startedAt !== null)
      .map((r) => (r.endedAt! - r.startedAt!) / 1000).filter((n) => n >= 0).sort((a, b) => a - b);
    if (durations.length < 3) return null;
    return { minSeconds: durations[Math.floor((durations.length - 1) * .2)]! * remaining,
      maxSeconds: durations[Math.ceil((durations.length - 1) * .9)]! * remaining, confidence: 'LOW' };
  }
  close(): void { this.db.close(); }
  private audit(record: TaskRecord): void {
    this.db.prepare('INSERT INTO agent_audit(task_id,state,at) VALUES(?,?,?)').run(record.request.id, record.snapshot.status, record.snapshot.lastUpdateAt);
  }
}
