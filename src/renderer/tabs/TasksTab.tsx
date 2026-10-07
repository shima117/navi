import { useEffect, useState } from 'react';
import { formatTaskSnapshots, type TaskSnapshot } from '../../core/tasks/TaskSnapshotPublisher';
import { TASK_TERMINAL, type TaskControl } from '../../core/tasks/TaskProtocol';
import type { ApprovalRecord } from '../../core/tasks/ApprovalStore';

export function TasksTab() {
  const [tasks, setTasks] = useState<TaskSnapshot[]>([]);
  const [error, setError] = useState('');
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [state, setState] = useState<{ ready: boolean; pid: number | null; error: string | null } | null>(null);
  useEffect(() => {
    let active = true;
    const off = window.navi.tasks.onSnapshot((s) => {
      if (active) setTasks((previous) => [...previous.filter((t) => t.id !== s.id), s].slice(-128));
    });
    void window.navi.tasks.list().then((list) => { if (active) setTasks((prev) => {
      const merged = new Map(list.map((s) => [s.id, s]));
      for (const s of prev) if (!merged.has(s.id) || merged.get(s.id)!.lastUpdateAt <= s.lastUpdateAt) merged.set(s.id, s);
      return [...merged.values()];
    }); });
    const refresh = () => {
      void window.navi.tasks.agentState().then((s) => { if (active) setState(s); });
      void window.navi.tasks.approvals().then((records) => { if (active) setApprovals(records); });
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => { active = false; off(); clearInterval(timer); };
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    setError('');
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };
  const control = (command: TaskControl, id?: string) => run(() => window.navi.tasks.control(command, id));
  return <div className="panel">
    <h2>裏作業</h2>
    <p className="hint">会話・アバターとは別のプロセスで確認します。コード変更や任意のコマンド実行はまだ行いません。</p>
    <p data-testid="agent-state">{state?.ready ? '作業サービス稼働中' : state?.error ?? '作業サービス起動中'} {state?.pid ? `(PID ${state.pid})` : ''}</p>
    <div className="row">
      <button onClick={() => void run(() => window.navi.tasks.startHealth())}>NAVIの環境を確認</button>
      <button onClick={() => void run(() => window.navi.tasks.inspectProject())}>プロジェクトを選んで確認</button>
      <button onClick={() => void control('CANCEL')}>裏作業を全部中止</button>
      <button onClick={() => void run(() => window.navi.desktopText.show(formatTaskSnapshots(tasks), 'TASK_STATUS'))}>進捗を文字で表示</button>
    </div>
    {error && <p role="alert">{error}</p>}
    <p className="hint">プロジェクト確認は、対象を選んだ後の確認画面で許可した1作業だけです。中止すると承認も撤回します。再起動後は改めて選び直してください。</p>
    {!!approvals.length && <details data-testid="approval-history"><summary>読み取り承認の記録</summary>
      {approvals.slice(0, 10).map((a) => <p key={a.id}>{a.projectRoot} — {a.state === 'REVOKED' ? '撤回・失効' : a.expiresAt <= Date.now() ? '期限切れ' : a.state === 'CONSUMED' ? 'この作業に使用済み' : '許可済み'}（内容の外部送信なし）</p>)}
    </details>}
    {!tasks.length && <p>今は裏作業はありません。</p>}
    {[...tasks].sort((a, b) => b.lastUpdateAt - a.lastUpdateAt).map((t) => <section key={t.id} data-task-id={t.id}>
      <h3>{t.title}</h3>
      <p style={{ whiteSpace: 'pre-wrap' }}>{formatTaskSnapshots([t])}</p>
      {t.lastReport && <p style={{ whiteSpace: 'pre-wrap' }}>{t.lastReport.summary}{t.lastReport.nextAction ? `\n次は: ${t.lastReport.nextAction}` : ''}</p>}
      {!TASK_TERMINAL.has(t.status) && <div className="row">
        <button onClick={() => void control(t.status === 'PAUSED' || t.status === 'WAITING' ? 'RESUME' : 'PAUSE', t.id)}>{t.status === 'PAUSED' || t.status === 'WAITING' ? '再開' : '一時停止'}</button>
        <button onClick={() => void control('CANCEL', t.id)}>中止</button>
      </div>}
    </section>)}
  </div>;
}
