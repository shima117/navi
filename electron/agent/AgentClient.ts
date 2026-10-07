import { app, utilityProcess, type UtilityProcess } from 'electron';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { initialTask, TASK_TERMINAL, type AgentCommand, type AgentEvent, type TaskControl, type TaskKind } from '../../src/core/tasks/TaskProtocol';
import type { TaskSnapshotPublisher } from '../../src/core/tasks/TaskSnapshotPublisher';
import type { EventBus } from '../../src/core/events/EventBus';

/** Main holds only cached snapshots. Task DB and work execute in the utility process. */
export class AgentClient {
  private child: UtilityProcess | null = null;
  private ready = false;
  private stopped = false;
  private pending: AgentCommand[] = [];
  private startupTimer: ReturnType<typeof setTimeout> | null = null;
  private failure: string | null = null;
  private pid: number | null = null;
  constructor(private readonly tasks: TaskSnapshotPublisher, private readonly bus: EventBus) {}

  status() { return { ready: this.ready, pid: this.pid, error: this.failure }; }
  start(): void {
    if (this.child || this.stopped) return;
    try {
      const child = utilityProcess.fork(path.join(__dirname, 'worker.js'), [], {
        serviceName: 'NAVI Agent', stdio: 'pipe',
        env: { NAVI_AGENT_DATA: app.getPath('userData'), SYSTEMROOT: process.env.SYSTEMROOT ?? '', TEMP: process.env.TEMP ?? '' },
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
  enqueue(kind: TaskKind, projectRoot?: string, idempotencyKey: string = randomUUID(), turnId?: string): string {
    if (this.stopped || this.failure) throw new Error(this.failure ?? '作業サービスは終了しています。');
    const existing = this.tasks.read(idempotencyKey);
    if (existing) return existing.id;
    if (this.pending.length >= 64 || this.tasks.list().filter((t) => !TASK_TERMINAL.has(t.status)).length >= 64) throw new Error('待っている作業が多すぎます。');
    const request = { id: idempotencyKey, idempotencyKey, kind, projectRoot, traceId: randomUUID(), turnId, createdAt: Date.now() };
    const initial = initialTask(request);
    this.tasks.update(initial.snapshot);
    this.send({ type: 'enqueue', request });
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
      for (const snapshot of event.snapshots) this.tasks.update(snapshot, snapshot.lastReport);
      for (const command of this.pending.splice(0)) this.child?.postMessage(command);
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
