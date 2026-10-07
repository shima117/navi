import type { OperationReport } from './OperationReport';
import { PolicyEngine } from './PolicyEngine';
import { TaskSnapshotPublisher } from './TaskSnapshotPublisher';
import { TaskDatabase } from './TaskDatabase';
import { checkTaskPolicy, CircuitBreaker, FailureBudget, ResourceLock } from './TaskSafety';
import { initialTask, TASK_TERMINAL, validTaskRequest, type AgentEvent, type TaskControl, type TaskRecord, type TaskRequest } from './TaskProtocol';

export interface TaskOutcome {
  state: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  summary: string;
  reason?: string;
  nextAction?: string;
  verification: NonNullable<OperationReport['verification']>;
}
export type TaskRunner = (request: TaskRequest, signal: AbortSignal, progress: (action: string, fraction: number) => void) => Promise<TaskOutcome>;

/** Agent-plane scheduler. No model decides retries, locks, success or cancellation. */
export class TaskEngine {
  private records = new Map<string, TaskRecord>();
  private active = new Map<string, AbortController>();
  private activeRuns = new Map<string, Promise<void>>();
  private budgets = new Map<string, FailureBudget>();
  private circuits = new Map<string, CircuitBreaker>();
  private locks = new ResourceLock();
  private closing = false;
  private publisher: TaskSnapshotPublisher;
  constructor(private readonly db: TaskDatabase, private readonly runner: TaskRunner, private readonly send: (event: AgentEvent) => void,
    private readonly now = Date.now, private readonly maxConcurrent = 2, private readonly policy = new PolicyEngine()) {
    this.publisher = new TaskSnapshotPublisher((snapshot) => send({ type: 'snapshot', snapshot, report: snapshot.lastReport }));
    for (const r of db.recover(now())) this.records.set(r.request.id, r);
  }
  list() { return [...this.records.values()].map((r) => structuredClone(r.snapshot)); }
  enqueue(request: TaskRequest): string {
    if (this.closing) throw new Error('作業サービスは終了中です。');
    if (!validTaskRequest(request)) throw new Error('Invalid task request');
    checkTaskPolicy(request.kind);
    if (!this.db.hasIdempotencyKey(request.idempotencyKey) && [...this.records.values()].filter((r) => !TASK_TERMINAL.has(r.snapshot.status)).length >= 64) throw new Error('作業の待ち数が上限です。');
    const r = this.db.create(initialTask(request));
    if (!this.records.has(r.request.id)) {
      if (this.records.size >= 128) {
        const old = [...this.records.values()].find((t) => TASK_TERMINAL.has(t.snapshot.status));
        if (old) this.records.delete(old.request.id);
      }
      this.records.set(r.request.id, r);
      this.publish(r);
    }
    this.pump();
    return r.request.id;
  }
  control(command: TaskControl, id?: string): number {
    let count = 0;
    const targets = id ? [this.records.get(id)].filter((r): r is TaskRecord => !!r) : [...this.records.values()];
    for (const r of targets) {
      if (TASK_TERMINAL.has(r.snapshot.status)) continue;
      if (command === 'CANCEL') {
        this.policy.cancel(r.request);
        if (r.request.cloud) delete r.request.cloud.inputText;
        r.snapshot.lastReport = undefined;
        this.change(r, 'CANCELLED', '中止しました。', 'cancelled');
        r.endedAt = this.now();
        this.persist(r);
        this.active.get(r.request.id)?.abort(new Error('USER_CANCEL'));
      } else if (command === 'PAUSE') {
        if (r.snapshot.status === 'PAUSED') continue;
        if (r.request.cloud) delete r.request.cloud.inputText;
        this.budgets.get(r.request.id)?.pause(this.now());
        this.change(r, 'PAUSED', '一時停止しました。', 'paused');
        this.persist(r);
        this.active.get(r.request.id)?.abort(new Error('USER_PAUSE'));
      } else if (command === 'RESUME') {
        if (r.snapshot.status !== 'PAUSED' && r.snapshot.status !== 'WAITING') continue;
        this.budgets.get(r.request.id)?.resume(this.now());
        if (r.attempts >= 3 || (r.lastFailure?.consecutive ?? 0) >= 2 || (!this.budgets.get(r.request.id)?.canAttempt(this.now()) && this.budgets.has(r.request.id))) continue;
        this.change(r, 'PLANNING', '順番を待っています。', 'queue');
        this.persist(r);
      } else {
        if (r.snapshot.status !== 'PLANNING') continue;
        this.records.delete(r.request.id);
        if (command === 'PRIORITIZE') this.records = new Map([[r.request.id, r], ...this.records]);
        else this.records.set(r.request.id, r);
      }
      count++;
    }
    this.pump();
    return count;
  }
  async stop(): Promise<void> {
    this.closing = true;
    this.control('PAUSE');
    for (const controller of this.active.values()) controller.abort();
    this.publisher.dispose();
    await Promise.allSettled([...this.activeRuns.values()]);
  }
  private pump(): void {
    if (this.closing) return;
    for (const r of this.records.values()) {
      if (this.active.size >= this.maxConcurrent) return;
      if (r.snapshot.status !== 'PLANNING' || this.active.has(r.request.id)) continue;
      const root = process.platform === 'win32' ? r.request.projectRoot?.toLowerCase() : r.request.projectRoot;
      const key = r.request.kind === 'LOCAL_HEALTH' ? 'system:local-health' : r.request.kind === 'OPENAI_TEXT' ? 'cloud:openai' : `project:${root}`;
      const release = this.locks.acquire(r.request.id, [key]);
      if (!release) continue;
      const controller = new AbortController();
      this.active.set(r.request.id, controller);
      const running = this.run(r, controller).finally(() => {
        if (r.request.cloud) delete r.request.cloud.inputText;
        release();
        this.active.delete(r.request.id);
        this.activeRuns.delete(r.request.id);
        this.pump();
      });
      this.activeRuns.set(r.request.id, running);
      void running.catch(() => { this.closing = true; this.send({ type: 'unavailable', reason: '作業の状態を保存できなかったため停止しました。保存先を確認してください。' }); });
    }
  }
  private async run(r: TaskRecord, controller: AbortController): Promise<void> {
    const id = r.request.id;
    const budget = this.budgets.get(id) ?? new FailureBudget(this.now());
    if (!this.budgets.has(id)) budget.restore(r.attempts, r.lastFailure?.signature, r.lastFailure?.consecutive);
    this.budgets.set(id, budget);
    const circuit = this.circuits.get(r.request.kind) ?? new CircuitBreaker();
    this.circuits.set(r.request.kind, circuit);
    r.startedAt ??= this.now();
    while (!controller.signal.aborted && budget.canAttempt(this.now())) {
      const decision = this.policy.authorize(r.request);
      if (decision.state !== 'ALLOW') { this.wait(r, decision.reason); return; }
      if (!circuit.enter(this.now())) {
        this.wait(r, '同じ確認で失敗が続いているため、しばらく待っています。');
        return;
      }
      budget.begin(this.now());
      r.attempts++;
      r.snapshot.lastReport = undefined;
      this.change(r, 'RUNNING', '確認を進めています。', 'execute');
      this.persist(r);
      const timeout = setTimeout(() => controller.abort(new Error('作業時間の上限です。')), budget.remainingMs(this.now()));
      try {
        const outcome = await this.runner(r.request, controller.signal, (action, progress) => {
          if (controller.signal.aborted || r.snapshot.status !== 'RUNNING') return;
          r.snapshot = { ...r.snapshot, currentAction: action.slice(0, 500), progress: Math.min(1, Math.max(0, progress)),
            eta: this.db.estimate(r.request.kind, 1 - progress), lastUpdateAt: this.now() };
          this.persist(r);
        });
        if (controller.signal.aborted) return this.finishAbort(r, controller);
        this.change(r, 'VERIFYING', '確認結果を検証しています。', 'verify');
        this.persist(r);
        const verified = outcome.verification.result === 'PASS' && typeof outcome.verification.evidence === 'string'
          && outcome.verification.evidence.trim().length > 0 && ['EXIT_CODE', 'BUILD', 'FILE', 'HTTP', 'CHECKSUM'].includes(outcome.verification.method);
        const report: OperationReport = { taskId: id, action: r.request.kind, state: outcome.state === 'SUCCESS' && !verified ? 'FAILED' : outcome.state,
          summary: outcome.summary, reason: outcome.reason, nextAction: outcome.nextAction, verified, verification: outcome.verification, timestamp: this.now() };
        r.snapshot.lastReport = report;
        if (outcome.state === 'SUCCESS' && verified) {
          circuit.success();
          this.change(r, 'DONE', outcome.summary, 'complete');
          r.snapshot.progress = 1;
          r.endedAt = this.now();
        } else {
          circuit.failure(this.now());
          this.change(r, 'WAITING', outcome.summary, 'waiting');
          r.snapshot.blocker = outcome.reason ?? '最終確認が通っていません。';
        }
        this.persist(r);
        return;
      } catch (err) {
        if (controller.signal.aborted) return this.finishAbort(r, controller);
        if (r.request.kind === 'OPENAI_TEXT') { this.wait(r, 'OpenAIとの通信を確認できませんでした。課金済みの可能性があるため自動再送しません。'); return; }
        const reason = err instanceof Error ? err.message.slice(0, 300) : '確認処理でエラーが発生しました。';
        budget.failed(reason);
        r.lastFailure = { signature: reason, consecutive: r.lastFailure?.signature === reason ? r.lastFailure.consecutive + 1 : 1 };
        circuit.failure(this.now());
        this.persist(r);
        if (!budget.canAttempt(this.now())) { this.wait(r, reason); return; }
        await new Promise<void>((resolve) => {
          const finish = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', finish); resolve(); };
          const timer = setTimeout(finish, 250);
          controller.signal.addEventListener('abort', finish, { once: true });
        });
      } finally {
        clearTimeout(timeout);
        if (controller.signal.aborted) circuit.releaseProbe();
      }
    }
    if (controller.signal.aborted) this.finishAbort(r, controller);
    else this.wait(r, '再試行の上限に達しました。');
  }
  private finishAbort(r: TaskRecord, controller: AbortController): void {
    if (controller.signal.reason instanceof Error && /^USER_/.test(controller.signal.reason.message)) return;
    if (r.snapshot.status === 'CANCELLED' || r.snapshot.status === 'PAUSED') return;
    this.wait(r, '作業時間の上限に達しました。');
  }
  private wait(r: TaskRecord, reason: string): void {
    this.change(r, 'WAITING', 'ここで一旦止めています。', 'waiting');
    r.snapshot.blocker = reason;
    r.snapshot.lastReport = { taskId: r.request.id, action: r.request.kind, state: 'WAITING_USER', summary: '確認が通らず、一旦止めています。',
      reason, verified: false, nextAction: '原因を確認して、必要なら新しい確認作業を依頼してください。', timestamp: this.now() };
    this.persist(r);
  }
  private change(r: TaskRecord, status: TaskRecord['snapshot']['status'], action: string, phase: string): void {
    r.snapshot = { ...r.snapshot, status, currentAction: action, phase, blocker: undefined, lastUpdateAt: this.now() };
  }
  private persist(r: TaskRecord): void { this.db.save(r); this.publish(r); }
  private publish(r: TaskRecord): void { this.publisher.update(r.snapshot, r.snapshot.lastReport); }
}
