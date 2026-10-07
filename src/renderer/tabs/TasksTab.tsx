import { useEffect, useState } from 'react';
import { formatTaskSnapshots, type TaskSnapshot } from '../../core/tasks/TaskSnapshotPublisher';
import { TASK_TERMINAL, type TaskControl } from '../../core/tasks/TaskProtocol';
import type { ApprovalRecord } from '../../core/tasks/ApprovalStore';
import { OPENAI_MODELS, OPENAI_INPUT_BYTE_LIMIT, quoteOpenAi, usd, type OpenAiTier, type OpenAiCloudState } from '../../core/cloud/OpenAiOptions';

export function TasksTab() {
  const [tasks, setTasks] = useState<TaskSnapshot[]>([]);
  const [error, setError] = useState('');
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [cloud, setCloud] = useState<OpenAiCloudState | null>(null);
  const [text, setText] = useState('');
  const [tier, setTier] = useState<OpenAiTier>('ECONOMY');
  const [dataClass, setDataClass] = useState<'PUBLIC' | 'PRIVATE'>('PRIVATE');
  const [cap, setCap] = useState('0.25');
  const [sending, setSending] = useState(false);
  const input = { text, tier, dataClass, maxCostMicros: Math.round(Number(cap) * 1e6) };
  let estimate = '文章を入力してください。';
  try { estimate = `安全側の概算予約額: ${usd(quoteOpenAi(input))}`; } catch { /* Native validates again. */ }
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
      void window.navi.tasks.cloudState().then((s) => { if (active) setCloud(s); });
    };
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => { active = false; off(); clearInterval(timer); };
  }, []);
  const run = async (action: () => Promise<unknown>) => {
    setError('');
    try { await action(); } catch (err) { setError((err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': Error: /, '')); }
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
    <section className="openai-task" data-testid="openai-task">
      <h3>OpenAI APIに文章を相談</h3>
      <p data-testid="openai-state">{cloud?.keyConfigured ? 'APIキー設定済み（接続は未確認）' : 'APIキー未設定：起動環境のOPENAI_API_KEYを設定して再起動してください。チャットには貼らないでください。'}</p>
      <p className="hint">ここに入力した文章だけを、毎回確認して送ります。雑談・記憶・画面・音声・ファイルは自動送信しません。機密・秘密情報は入力しないでください。</p>
      <label>送信する文章<textarea aria-label="OpenAIに送信する文章" value={text} onChange={(e) => setText(e.target.value)} rows={5} style={{ width: '100%' }} /></label>
      <p className="hint">{new TextEncoder().encode(text).length} / {OPENAI_INPUT_BYTE_LIMIT} bytes、最大24行。{estimate}</p>
      <div className="row">
        <label>モデル<select aria-label="OpenAIモデル" value={tier} onChange={(e) => setTier(e.target.value as OpenAiTier)}>{Object.entries(OPENAI_MODELS).map(([key, value]) => <option key={key} value={key}>{value.label} / {value.model}</option>)}</select></label>
        <label>内容の分類<select aria-label="内容の分類" value={dataClass} onChange={(e) => setDataClass(e.target.value as 'PUBLIC' | 'PRIVATE')}><option value="PRIVATE">個人用</option><option value="PUBLIC">公開情報</option></select></label>
        <label>この作業の上限（USD）<input aria-label="OpenAI料金上限" type="number" min="0.000001" max="0.25" step="0.001" value={cap} onChange={(e) => setCap(e.target.value)} /></label>
        <button disabled={sending || !state?.ready} onClick={() => void run(async () => {
          setSending(true);
          try { const id = await window.navi.tasks.openAiText(input); if (id) setText(''); }
          finally { setSending(false); }
        })}>送信内容と料金を確認</button>
      </div>
      {cloud && <p className="hint">NAVI内の利用概算（未確定額を含む）：今日 {usd(cloud.dayChargedMicros)} / {usd(cloud.limits.dayMicros)}、今月 {usd(cloud.monthChargedMicros)} / {usd(cloud.limits.monthMicros)}。料金表期限 {new Date(cloud.ratesExpireAt).toLocaleDateString()}。請求上限の保証ではありません。</p>}
    </section>
    {!tasks.length && <p>今は裏作業はありません。</p>}
    {[...tasks].sort((a, b) => b.lastUpdateAt - a.lastUpdateAt).map((t) => <section key={t.id} data-task-id={t.id}>
      <h3>{t.title}</h3>
      <p style={{ whiteSpace: 'pre-wrap' }}>{formatTaskSnapshots([t])}</p>
      {t.lastReport && <p style={{ whiteSpace: 'pre-wrap' }}>{t.lastReport.summary}{t.lastReport.nextAction ? `\n次は: ${t.lastReport.nextAction}` : ''}</p>}
      {t.lastReport && <button onClick={() => void run(() => window.navi.desktopText.show(t.lastReport!.summary, 'RESULT'))}>結果を文字で表示</button>}
      {!TASK_TERMINAL.has(t.status) && <div className="row">
        <button onClick={() => void control(t.status === 'PAUSED' || t.status === 'WAITING' ? 'RESUME' : 'PAUSE', t.id)}>{t.status === 'PAUSED' || t.status === 'WAITING' ? '再開' : '一時停止'}</button>
        <button onClick={() => void control('CANCEL', t.id)}>中止</button>
      </div>}
    </section>)}
  </div>;
}
