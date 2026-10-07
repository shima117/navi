import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Db } from '../memory/Db';
import type { TaskRequest } from './TaskProtocol';

export const PROJECT_CONSENT_TTL = 15 * 60 * 1000;
export interface ProjectConsent {
  id: string;
  taskId: string;
  projectRoot: string;
  grantedAt: number;
  expiresAt: number;
}
export interface ApprovalRecord extends ProjectConsent {
  capability: 'PROJECT_INSPECT';
  dataClass: 'PRIVATE';
  state: 'APPROVED' | 'CONSUMED' | 'REVOKED';
  fingerprint: string;
}
const safeId = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9-]{1,80}$/i.test(v);
export function projectFingerprint(taskId: string, root: string): string {
  return createHash('sha256').update(JSON.stringify(['PROJECT_INSPECT', taskId, root, 'PRIVATE', 'LOCAL_ONLY'])).digest('hex');
}

/** Native main issues consent; renderers/models can never grant through IPC. */
export class ApprovalStore {
  constructor(private readonly db: Db, private readonly now = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_approvals (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL, granted_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_approval_audit (
      id INTEGER PRIMARY KEY, approval_id TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL
    );`);
  }
  grantProject(consent: ProjectConsent): void {
    const now = this.now();
    if (!consent || !safeId(consent.id) || !safeId(consent.taskId)
      || typeof consent.projectRoot !== 'string' || consent.projectRoot.length > 4096
      || !path.isAbsolute(consent.projectRoot) || path.resolve(consent.projectRoot) !== consent.projectRoot
      || !Number.isFinite(consent.grantedAt) || !Number.isFinite(consent.expiresAt)
      || consent.grantedAt > now || consent.grantedAt < now - 30000 || consent.expiresAt <= now
      || consent.expiresAt - consent.grantedAt > PROJECT_CONSENT_TTL) throw new Error('Invalid project consent');
    // Pick only known fields; a supplied state/capability cannot widen the grant.
    const record: ApprovalRecord = { id: consent.id, taskId: consent.taskId, projectRoot: consent.projectRoot,
      grantedAt: consent.grantedAt, expiresAt: consent.expiresAt, capability: 'PROJECT_INSPECT', dataClass: 'PRIVATE',
      state: 'APPROVED', fingerprint: projectFingerprint(consent.taskId, consent.projectRoot) };
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO agent_approvals(id,task_id,record_json,granted_at) VALUES(?,?,?,?)')
        .run(record.id, record.taskId, JSON.stringify(record), record.grantedAt);
      this.audit(record);
    });
  }
  authorize(request: TaskRequest): boolean {
    if (!request.approvalId || !request.projectRoot || request.kind !== 'PROJECT_INSPECT') return false;
    return this.db.transaction(() => {
      const record = this.get(request.approvalId!);
      if (!record || !['APPROVED', 'CONSUMED'].includes(record.state) || record.dataClass !== 'PRIVATE'
        || !Number.isFinite(record.expiresAt) || record.expiresAt <= this.now()
        || record.capability !== request.kind || record.taskId !== request.id || record.projectRoot !== request.projectRoot
        || record.fingerprint !== projectFingerprint(request.id, request.projectRoot!)) return false;
      if (record.state === 'APPROVED') this.save({ ...record, state: 'CONSUMED' });
      // Retries of this exact task/scope remain authorized until expiry/revocation.
      return true;
    });
  }
  get(id: string): ApprovalRecord | null {
    const row = this.db.prepare('SELECT record_json FROM agent_approvals WHERE id = ?').get(id);
    return row ? JSON.parse(String(row.record_json)) as ApprovalRecord : null;
  }
  list(): ApprovalRecord[] {
    return this.db.prepare('SELECT record_json FROM agent_approvals ORDER BY granted_at DESC LIMIT 128').all()
      .map((row) => JSON.parse(String(row.record_json)) as ApprovalRecord);
  }
  revokeTask(taskId: string): void {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT record_json FROM agent_approvals WHERE task_id = ?').get(taskId);
      if (row) {
        const record = JSON.parse(String(row.record_json)) as ApprovalRecord;
        if (record.state !== 'REVOKED') this.save({ ...record, state: 'REVOKED' });
      }
    });
  }
  /** Restart is not implicit re-consent. Durable records are retained, authority is withdrawn. */
  invalidateSession(): void {
    this.db.transaction(() => {
      for (const row of this.db.prepare('SELECT record_json FROM agent_approvals').all()) {
        const record = JSON.parse(String(row.record_json)) as ApprovalRecord;
        if (record.state !== 'REVOKED') this.save({ ...record, state: 'REVOKED' });
      }
    });
  }
  private save(record: ApprovalRecord): void {
    this.db.prepare('UPDATE agent_approvals SET record_json = ? WHERE id = ?').run(JSON.stringify(record), record.id);
    this.audit(record);
  }
  private audit(record: ApprovalRecord): void {
    this.db.prepare('INSERT INTO agent_approval_audit(approval_id,state,at) VALUES(?,?,?)').run(record.id, record.state, this.now());
  }
}
