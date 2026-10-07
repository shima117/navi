import { app, utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROJECT_CONSENT_TTL, type ApprovalRecord, type ProjectConsent } from '../../src/core/tasks/ApprovalStore';
import { initialTask, TASK_TERMINAL, type AgentCommand, type AgentEvent, type TaskControl, type TaskKind } from '../../src/core/tasks/TaskProtocol';
import type { TaskSnapshotPublisher } from '../../src/core/tasks/TaskSnapshotPublisher';
import type { EventBus } from '../../src/core/events/EventBus';
import { OPENAI_LIMITS, OPENAI_RATES_EXPIRE, type OpenAiCloudState } from '../../src/core/cloud/OpenAiOptions';
import { CLOUD_CONSENT_TTL, cloudFingerprint, type OpenAiPayload } from '../../src/core/cloud/OpenAiScope';

/** Main holds only cached snapshots. Task DB and work execute in the utility process. */
export class AgentClient {
  private child: UtilityProcess | null = null;
  private ready = false;
  private stopped = false;
  private pending: AgentCommand[] = [];
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private failure: string | null = null;
  private pid: number | null = null;
  private approvals: ApprovalRecord[] = [];
  private cloud: OpenAiCloudState = { keyConfigured: false, limits: OPENAI_LIMITS, dayChargedMicros: 0, monthChargedMicros: 0, ratesExpireAt: OPENAI_RATES_EXPIRE };
  constructor(private readonly tasks: TaskSnapshotPublisher, private readonly bus: EventBus) {}

  status() { return { ready: this.ready, pid: this.pid, error: this.failure }; }
  listApprovals() { return structuredClone(this.approvals); }
  cloudState() { return structuredClone(this.cloud); }
  /** Only native confirmation may call this; no credential or receipt reaches the renderer. */
  enqueueOpenAi(cloud: OpenAiPayload): string {
    if (!this.ready || this.stopped || this.failure) throw new Error('作業サービスが利用できません。');
    if (this.tasks.list().filter((t) => !TASK_TERMINAL.has(t.status)).length >= 64) throw new Error('作業の待ち数が上限です。');
    const id = randomUUID(); const now = Date.now();
    const consent = { id: randomUUID(), taskId: id, fingerprint: cloudFingerprint(id, cloud), grantedAt: now, expiresAt: now + CLOUD_CONSENT_TTL };
    const request = { id, idempotencyKey: id, kind: 'OPENAI_TEXT' as const, cloud, approvalId: consent.id, traceId: randomUUID(), createdAt: now };
    this.tasks.update(initialTask(request).snapshot);
    this.send({ type: 'enqueue', request, cloudConsent: consent });
    return id;
  }
  /** Call only after native folder selection AND native explicit confirmation. */
  enqueueProject(projectRoot: string): string {
    const id = randomUUID();
    const now = Date.now();
    const consent: ProjectConsent = { id: randomUUID(), taskId: id, projectRoot, grantedAt: now, expiresAt: now + PROJECT_CONSENT_TTL };
    return this.enqueue('PROJECT_INSPECT', projectRoot, id, undefined, consent);
  }
  start(): void {
    if (this.child || this.stopped) return;
    try {
      const child = utilityProcess.fork(path.join(__dirname, 'worker.js'), [], {
        serviceName: 'NAVI Agent', stdio: 'pipe',
        env: { NAVI_AGENT_DATA: app.getPath('userData'), SYSTEMROOT: process.env.SYSTEMROOT ?? '', TEMP: process.env.TEMP ?? '',
          OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '' },
      });
      this.child = child;
      child.on('message', (event: AgentEvent) => {
        if (this.child !== child || this.stopped) return;
        try { this.receive(event); } catch { this.unavailable('裏作業から不正な状態通知が届いたため、止めています。'); }
      });
      child.on('exit', () => {
        if (this.child !== child) return;
        this.child = null;
        this.pid = null;
        if (!this.stopped && !this.failure) this.unavailable('裏作業のプロセスが終了しました。会話は続けられます。');
      });
      // Worker never emits logs; discard any runtime warning bytes so pipes cannot back up.
      child.stdout?.on('data', () => undefined);
      child.stderr?.on('data', () => undefined);
      this.startupTimer = setTimeout(() => {
        if (this.ready) return;
        child.kill();
        this.unavailable('裏作業の起動に時間がかかりすぎています。');
      }, 10000);
    } catch { this.unavailable('裏作業のプロセスを起動できませんでした。'); }
  }
  enqueue(kind: TaskKind, projectRoot?: string, idempotencyKey: string = randomUUID(), turnId?: string, consent?: ProjectConsent): string {
    if (this.stopped || this.failure) throw new Error(this.failure ?? '作業サービスは終了しています。');
    const existing = this.tasks.read(idempotencyKey);
    if (existing) return existing.id;
    if (this.pending.length >= 64 || this.tasks.list().filter((t) => !TASK_TERMINAL.has(t.status)).length >= 64) throw new Error('待っている作業が多すぎます。');
    const request = { id: idempotencyKey, idempotencyKey, kind, projectRoot, approvalId: consent?.id, traceId: randomUUID(), turnId, createdAt: Date.now() };
    const initial = initialTask(request);
    this.tasks.update(initial.snapshot);
    this.send({ type: 'enqueue', request, consent });
    return request.id;
  }
  control(command: TaskControl, id?: string): void {
    if (this.stopped || this.failure) throw new Error(this.failure ?? '作業サービスは終了しています。');
    // Cancellation takes precedence over commands not sent to the worker yet.
    if (command === 'CANCEL' || command === 'PAUSE') {
      for (const s of this.tasks.list()) {
        if ((id && s.id !== id) || TASK_TERMINAL.has(s.status)) continue;
        this.tasks.update({ ...s, status: command === 'CANCEL' ? 'CANCELLED' : 'PAUSED', currentAction: command === 'CANCEL' ? '中止を指示しました。' : '一時停止を指示しました。', lastUpdateAt: Date.now() });
      }
    }
    this.send({ type: 'control', command, id });
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.pending = [];
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { child.kill(); resolve(); }, 2000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
      try { child.postMessage({ type: 'shutdown' } satisfies AgentCommand); } catch { child.kill(); }
    });
    this.child = null;
  }
  private send(command: AgentCommand): void {
    if (this.ready && this.child) this.child.postMessage(command);
    else this.pending.push(command);
  }
  private receive(event: AgentEvent): void {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'ready') {
      if (this.startupTimer) clearTimeout(this.startupTimer);
      this.ready = true;
      this.pid = event.pid;
      this.approvals = event.approvals;
      if (event.cloud) this.cloud = event.cloud;
      for (const snapshot of event.snapshots) this.tasks.update(snapshot, snapshot.lastReport);
      for (const command of this.pending.splice(0)) this.child?.postMessage(command);
    } else if (event.type === 'cloud') {
      this.cloud = event.state;
    } else if (event.type === 'approvals') {
      this.approvals = event.records;
    } else if (event.type === 'snapshot') {
      this.tasks.update(event.snapshot, event.report);
      if (['DONE', 'WAITING', 'FAILED'].includes(event.snapshot.status) && event.report) this.bus.emit('task.report', event.snapshot);
    } else if (event.type === 'unavailable') this.unavailable(event.reason);
  }
  private unavailable(reason: string): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.startupTimer = null;
    this.failure = reason;
    this.ready = false;
    this.pending = [];
    this.child?.kill();
    for (const s of this.tasks.list()) {
      if (TASK_TERMINAL.has(s.status) || s.status === 'PAUSED') continue;
      this.tasks.update({ ...s, status: 'WAITING', currentAction: '裏作業が止まっています。', blocker: reason, lastUpdateAt: Date.now() });
    }
    this.bus.emit('metrics.error', { service: 'agent', message: reason, at: Date.now() });
  }
}
