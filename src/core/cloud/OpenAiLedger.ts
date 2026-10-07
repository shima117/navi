import type { Db } from '../memory/Db';
import type { TaskRequest } from '../tasks/TaskProtocol';
import { OPENAI_LIMITS, OPENAI_RATES_EXPIRE, type OpenAiCloudState } from './OpenAiOptions';
import { cloudFingerprint, validOpenAiPayload, CLOUD_CONSENT_TTL, type CloudConsent, type OpenAiPayload } from './OpenAiScope';

export class OpenAiLedger {
  constructor(private readonly db: Db, private readonly now = Date.now) {
    // Paid-call reservation must commit durably before HTTP, not just reach the WAL page cache.
    db.exec(`PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS openai_approvals (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL,
      granted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS openai_calls (
      task_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, day TEXT NOT NULL, month TEXT NOT NULL,
      charged_micros INTEGER NOT NULL, state TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS openai_audit (
      id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL
    );`);
  }
  grant(consent: CloudConsent, payload: OpenAiPayload): void {
    const now = this.now();
    if (!consent || typeof consent.id !== 'string' || typeof consent.taskId !== 'string'
      || !/^[a-z0-9-]{1,80}$/i.test(consent.id) || !/^[a-z0-9-]{1,80}$/i.test(consent.taskId)
      || !validOpenAiPayload(payload) || consent.fingerprint !== cloudFingerprint(consent.taskId, payload)
      || !Number.isFinite(consent.grantedAt) || !Number.isFinite(consent.expiresAt)
      || consent.grantedAt > now || consent.grantedAt < now - 30000 || consent.expiresAt <= now
      || consent.expiresAt - consent.grantedAt > CLOUD_CONSENT_TTL || now >= OPENAI_RATES_EXPIRE) throw new Error('Invalid OpenAI consent');
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO openai_approvals VALUES(?,?,?,?,?,?)').run(consent.id, consent.taskId, consent.fingerprint, consent.grantedAt, consent.expiresAt, 'APPROVED');
      this.audit(consent.taskId, 'APPROVED');
    });
  }
  authorize(request: TaskRequest): boolean {
    if (request.kind !== 'OPENAI_TEXT' || request.projectRoot !== undefined || !request.approvalId || !validOpenAiPayload(request.cloud)
      || this.now() >= OPENAI_RATES_EXPIRE) return false;
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM openai_approvals WHERE id = ?').get(request.approvalId!);
      if (!row || row.state !== 'APPROVED' || row.task_id !== request.id || Number(row.expires_at) <= this.now()
        || row.fingerprint !== cloudFingerprint(request.id, request.cloud!)) return false;
      this.db.prepare('UPDATE openai_approvals SET state = ? WHERE id = ?').run('CONSUMED', request.approvalId!);
      this.audit(request.id, 'CONSUMED');
      return true;
    });
  }
  /** Persist the full uncertainty reserve before touching the network. Unique task prevents replay. */
  dispatch(request: TaskRequest): void {
    if (request.kind !== 'OPENAI_TEXT' || request.projectRoot !== undefined || !validOpenAiPayload(request.cloud)
      || this.now() >= OPENAI_RATES_EXPIRE) throw new Error('OpenAI scope invalid');
    this.db.transaction(() => {
      const scope = cloudFingerprint(request.id, request.cloud!);
      const approval = this.db.prepare('SELECT * FROM openai_approvals WHERE id = ?').get(request.approvalId ?? '');
      if (!approval || approval.state !== 'CONSUMED' || approval.task_id !== request.id || approval.fingerprint !== scope
        || Number(approval.expires_at) <= this.now()) throw new Error('OpenAI consent missing');
      const state = this.state(false);
      const reserve = request.cloud!.quotedMicros;
      if (reserve > request.cloud!.maxCostMicros || reserve > OPENAI_LIMITS.taskMicros
        || state.dayChargedMicros + reserve > OPENAI_LIMITS.dayMicros
        || state.monthChargedMicros + reserve > OPENAI_LIMITS.monthMicros) throw new Error('OpenAI budget exhausted');
      const day = new Date(this.now()).toISOString().slice(0, 10);
      this.db.prepare('INSERT INTO openai_calls VALUES(?,?,?,?,?,?)').run(request.id, scope, day, day.slice(0, 7), reserve, 'UNCERTAIN');
      this.audit(request.id, 'DISPATCHED');
    });
  }
  settle(taskId: string, chargedMicros: number): void {
    if (!Number.isSafeInteger(chargedMicros) || chargedMicros < 0) throw new Error('Invalid OpenAI usage');
    this.db.transaction(() => {
      const result = this.db.prepare("UPDATE openai_calls SET charged_micros = ?, state = 'SETTLED' WHERE task_id = ? AND state = 'UNCERTAIN'").run(chargedMicros, taskId);
      if (result.changes !== 1) throw new Error('OpenAI call not unsettled');
      this.audit(taskId, 'SETTLED');
    });
  }
  revoke(taskId: string): void {
    this.db.transaction(() => {
      const result = this.db.prepare("UPDATE openai_approvals SET state = 'REVOKED' WHERE task_id = ? AND state != 'REVOKED'").run(taskId);
      if (result.changes) this.audit(taskId, 'REVOKED');
    });
  }
  invalidateSession(): void {
    this.db.transaction(() => {
      for (const row of this.db.prepare("SELECT task_id FROM openai_approvals WHERE state != 'REVOKED'").all()) this.revoke(String(row.task_id));
    });
  }
  state(keyConfigured: boolean): OpenAiCloudState {
    const day = new Date(this.now()).toISOString().slice(0, 10);
    const sum = (period: 'day' | 'month', value: string) => {
      const total = Number(this.db.prepare(`SELECT COALESCE(SUM(charged_micros),0) AS total FROM openai_calls WHERE ${period} = ?`).get(value)?.total ?? 0);
      if (!Number.isSafeInteger(total) || total < 0) throw new Error('Invalid OpenAI ledger total');
      return total;
    };
    return { keyConfigured, limits: OPENAI_LIMITS, dayChargedMicros: sum('day', day), monthChargedMicros: sum('month', day.slice(0, 7)), ratesExpireAt: OPENAI_RATES_EXPIRE };
  }
  private audit(taskId: string, state: string) {
    this.db.prepare('INSERT INTO openai_audit(task_id,state,at) VALUES(?,?,?)').run(taskId, state, this.now());
  }
}
