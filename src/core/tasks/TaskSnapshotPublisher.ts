import { isVerifiedSuccess, type OperationReport } from './OperationReport';

export interface TaskSnapshot {
  id: string;
  title: string;
  status: 'PLANNING' | 'RUNNING' | 'WAITING' | 'VERIFYING' | 'PAUSED' | 'DONE' | 'FAILED' | 'CANCELLED' | 'NEEDS_APPROVAL';
  phase: string;
  currentAction: string;
  progress: number | null;
  eta: { minSeconds: number; maxSeconds: number; confidence: 'LOW' | 'MEDIUM' | 'HIGH' } | null;
  lastUpdateAt: number;
  blocker?: string;
  lastReport?: OperationReport;
}

const TERMINAL = new Set<TaskSnapshot['status']>(['DONE', 'FAILED', 'CANCELLED']);

/** Store NOW, publish later. A per-task latest-wins buffer, never an unbounded log queue. */
export class TaskSnapshotPublisher {
  private snapshots = new Map<string, TaskSnapshot>();
  private pending = new Map<string, TaskSnapshot>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly send: (snapshot: TaskSnapshot) => void, private readonly intervalMs = 150, private readonly limit = 128) {}

  update(snapshot: TaskSnapshot, report?: OperationReport): void {
    if (snapshot.status === 'DONE' && !isVerifiedSuccess(report, snapshot.id)) throw new Error('Completion requires verified evidence');
    if (!Number.isFinite(snapshot.lastUpdateAt) || (snapshot.progress !== null && !Number.isFinite(snapshot.progress))) throw new Error('Invalid task snapshot');
    const prev = this.snapshots.get(snapshot.id);
    if (prev && (snapshot.lastUpdateAt < prev.lastUpdateAt || TERMINAL.has(prev.status))) return;
    if (!prev && this.snapshots.size >= this.limit) {
      const evict = [...this.snapshots.values()].find((s) => TERMINAL.has(s.status));
      if (!evict) throw new Error('Task snapshot capacity reached');
      this.snapshots.delete(evict.id);
      this.pending.delete(evict.id);
    }
    const next = structuredClone(snapshot);
    next.lastReport = report ? structuredClone(report) : prev?.lastReport ? structuredClone(prev.lastReport) : undefined;
    next.progress = snapshot.progress === null ? null : Math.min(1, Math.max(0, snapshot.progress));
    this.snapshots.set(next.id, next);
    const critical = !prev || prev.status !== next.status || prev.blocker !== next.blocker
      || report?.state === 'PARTIAL' || report?.state === 'WAITING_USER' || report?.state === 'FAILED';
    if (critical) {
      this.pending.delete(next.id);
      this.deliver(next);
    } else {
      this.pending.set(next.id, next);
      this.timer ??= setTimeout(() => this.flush(), this.intervalMs);
    }
  }

  read(id: string): TaskSnapshot | null {
    const s = this.snapshots.get(id);
    return s ? structuredClone(s) : null;
  }

  list(): TaskSnapshot[] { return structuredClone([...this.snapshots.values()]); }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  private flush(): void {
    this.timer = null;
    const batch = [...this.pending.values()];
    this.pending.clear();
    for (const s of batch) this.deliver(s);
  }

  private deliver(s: TaskSnapshot): void {
    try { this.send(structuredClone(s)); } catch (err) { console.error('[snapshot] publication failed', err); }
  }
}

export function formatTaskSnapshots(tasks: TaskSnapshot[]): string {
  if (!tasks.length) return '今は裏で動いている作業はありません。';
  const names: Record<TaskSnapshot['status'], string> = {
    PLANNING: '進め方を確認中', RUNNING: '作業中', WAITING: '待機中', VERIFYING: '確認中',
    PAUSED: '一時停止中', DONE: '完了', FAILED: '失敗', CANCELLED: '中止', NEEDS_APPROVAL: '許可待ち',
  };
  return tasks.map((s) => {
    const percent = s.progress === null ? '' : ` (${Math.round(s.progress * 100)}%)`;
    const eta = s.eta ? `\n残りの目安: ${Math.ceil(s.eta.minSeconds / 60)}〜${Math.ceil(s.eta.maxSeconds / 60)}分${s.eta.confidence === 'LOW' ? '（不確か）' : ''}` : '\n残り時間はまだ見積もれません。';
    const partial = s.lastReport?.state === 'PARTIAL' ? `\n一部だけ終わっています: ${s.lastReport.summary}${s.lastReport.nextAction ? `\n次は: ${s.lastReport.nextAction}` : ''}` : '';
    return `${s.title} — ${names[s.status]}${percent}\n${s.currentAction}${s.blocker ? `\n止まっている理由: ${s.blocker}` : ''}${partial}${TERMINAL.has(s.status) ? '' : eta}`;
  }).join('\n\n');
}
