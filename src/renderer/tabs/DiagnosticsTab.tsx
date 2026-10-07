import { useCallback, useEffect, useRef, useState } from 'react';
import type { TimingKind } from '../../core/events/EventBus';
import type { ResourceReason } from '../../core/resource/ResourcePolicy';
import type { ProcessState } from '../../core/supervisor/ProcessWatchdog';
import {
  normalizeManagedProcesses,
  type ManagedProcessId,
  type ManagedProcessesSettings,
} from '../../core/supervisor/processSpecs';
import type { DiagnosticsSnapshot, ManagedProcessEntry } from '../../core/telemetry/DiagnosticsReport';
import { useNavi } from '../state/NaviContext';

/** Diagnostics (PR-10): everything here is local; nothing is sent anywhere. */
const REFRESH_MS = 2_000;

const SERVICE_LABELS: Record<string, string> = {
  chat: '会話 AI (Ollama)',
  vision: 'Vision',
  stt: '音声認識 (STT)',
  tts: '音声合成 (VOICEVOX)',
  avatar: 'アバター',
};

const LATENCY_ROWS: Array<{ kind: TimingKind; label: string }> = [
  { kind: 'response', label: 'ユーザー発話 → ナビ発話開始' },
  { kind: 'chat', label: '会話 LLM' },
  { kind: 'vision', label: 'Vision' },
  { kind: 'tts', label: '音声合成 (発話決定 → 再生開始)' },
];

const STATE_LABELS: Record<ProcessState, string> = {
  stopped: '停止中',
  starting: '起動中',
  running: '稼働中',
  backoff: '再起動待ち',
  external: '外部で起動済み',
  failed: '停止 (異常終了が続いたため)',
};

const REASON_LABELS: Record<ResourceReason, string> = {
  manual: '手動設定',
  game: 'ゲームプラグイン有効',
  sharing: 'ゲーム以外を共有中',
  idle: '画面共有なし',
};

const INITIATIVE_REASONS: Record<string, string> = {
  speak: '発言',
  below_threshold: 'スコア不足',
  focus: '集中中 (戦闘など)',
  user_speaking: 'ユーザー発話中',
  no_candidates: '話題なし',
  busy: '応答中',
  ai_offline: 'AI オフライン',
  superseded: '別の発話が優先',
  model_chose_silence: 'モデルが沈黙を選択',
};

const SETTINGS_KEY: Record<ManagedProcessId, keyof ManagedProcessesSettings> = {
  'voice-service': 'voiceService',
  voicevox: 'voicevox',
  ollama: 'ollama',
};

function fmtMs(ms: number | null): string {
  if (ms === null) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} 秒`;
}

function fmtTime(at: number | null): string {
  return at === null ? '—' : new Date(at).toLocaleTimeString('ja-JP');
}

export function DiagnosticsTab() {
  const { settings, updateSettings } = useNavi();
  const [snap, setSnap] = useState<DiagnosticsSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exportMsg, setExportMsg] = useState<string | null>(null);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      setSnap(await window.navi.diagnostics.get());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const doExport = async () => {
    setExportMsg('書き出し中…');
    const res = await window.navi.diagnostics.export();
    if (res.saved) setExportMsg(`保存しました: ${res.path}`);
    else setExportMsg(res.error ? `保存できませんでした: ${res.error}` : 'キャンセルしました');
  };

  if (!settings) return null;
  const processes = normalizeManagedProcesses(settings.managedProcesses);

  return (
    <div className="panel diag">
      <div className="diag-head">
        <h2>診断</h2>
        <button onClick={() => void doExport()}>診断情報を書き出す</button>
        {exportMsg && <span className="hint diag-export-msg">{exportMsg}</span>}
      </div>
      <p className="hint">
        すべてこの PC 内の情報です。外部には送信しません。会話の文字起こしや画面の画像は含みません。
      </p>
      {loadError && <p className="diag-bad">診断情報を取得できません: {loadError}</p>}
      {!snap ? (
        <p className="hint">読み込み中…</p>
      ) : (
        <>
          <section>
            <h3>サービス</h3>
            <table className="diag-table">
              <thead>
                <tr>
                  <th>サービス</th>
                  <th>状態</th>
                  <th>最終変化</th>
                </tr>
              </thead>
              <tbody>
                {snap.services.map((s) => (
                  <tr key={s.name} data-service={s.name}>
                    <td>{SERVICE_LABELS[s.name] ?? s.name}</td>
                    <td className={s.ok === null ? 'diag-muted' : s.ok ? 'diag-ok' : 'diag-bad'}>
                      {s.ok === null ? '確認中' : s.ok ? 'OK' : 'offline'}
                    </td>
                    <td>{fmtTime(s.changedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h3>応答速度</h3>
            <table className="diag-table">
              <thead>
                <tr>
                  <th>指標</th>
                  <th>p50</th>
                  <th>p95</th>
                  <th>件数</th>
                </tr>
              </thead>
              <tbody>
                {LATENCY_ROWS.map(({ kind, label }) => {
                  const l = snap.metrics.latency[kind];
                  const slow = kind === 'response' && l.p95 !== null && l.p95 > snap.responseTargetMs;
                  return (
                    <tr key={kind} data-latency={kind}>
                      <td>
                        {label}
                        {kind === 'response' && <span className="hint"> (目標 {snap.responseTargetMs / 1000} 秒以内)</span>}
                      </td>
                      <td>{fmtMs(l.p50)}</td>
                      <td className={slow ? 'diag-warn' : ''}>{fmtMs(l.p95)}</td>
                      <td className="diag-count">{l.count}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section>
            <h3>リソース</h3>
            <p>
              モード: <strong data-testid="resource-mode">{snap.resource.mode}</strong>{' '}
              <span className="hint">({snap.resource.auto ? `自動: ${REASON_LABELS[snap.resource.reason]}` : '手動設定'})</span>
            </p>
            <p>
              VRAM:{' '}
              {snap.resource.vram
                ? `${snap.resource.vram.usedMiB.toLocaleString()} / ${snap.resource.vram.totalMiB.toLocaleString()} MiB`
                : '取得できません (NVIDIA GPU / nvidia-smi なし)'}
            </p>
            <label className="check">
              <input
                type="checkbox"
                checked={settings.autoResourceMode}
                onChange={(e) => void updateSettings({ autoResourceMode: e.target.checked })}
              />
              状況に合わせて自動で切り替える (ゲーム → GAME_PRIORITY / 共有中 → BALANCED / 共有なし → DESKTOP_CHAT)
            </label>
          </section>

          <section>
            <h3>自発発言</h3>
            <p>
              発言 <strong>{snap.metrics.initiative.speak}</strong> 回 / 見送り <strong>{snap.metrics.initiative.silent}</strong> 回
            </p>
            <ul className="diag-reasons">
              {Object.entries(snap.metrics.initiative.byReason)
                .sort((a, b) => b[1] - a[1])
                .map(([reason, n]) => (
                  <li key={reason}>
                    {INITIATIVE_REASONS[reason] ?? reason}: {n}
                  </li>
                ))}
            </ul>
          </section>

          <section>
            <h3>管理プロセス</h3>
            <p className="hint">ここで有効にしたものだけを NAVI が起動し、落ちたら自動で再起動します (1, 2, 5, 10, 30 秒間隔)。</p>
            {snap.processes.map((p) => (
              <ProcessCard
                key={p.id}
                entry={p}
                config={processes[SETTINGS_KEY[p.id]]}
                onRestart={async () => {
                  await window.navi.diagnostics.restartProcess(p.id);
                  await refresh();
                }}
                onSave={async (next) => {
                  await updateSettings({ managedProcesses: { ...processes, [SETTINGS_KEY[p.id]]: next } });
                  await refresh();
                }}
              />
            ))}
          </section>

          <section>
            <h3>最近のエラー</h3>
            {snap.metrics.errors.recent.length === 0 ? (
              <p className="hint">エラーはありません</p>
            ) : (
              <table className="diag-table diag-errors">
                <thead>
                  <tr>
                    <th>時刻</th>
                    <th>対象</th>
                    <th>内容</th>
                  </tr>
                </thead>
                <tbody>
                  {[...snap.metrics.errors.recent].reverse().map((e, i) => (
                    <tr key={`${e.at}-${i}`}>
                      <td>{fmtTime(e.at)}</td>
                      <td>{SERVICE_LABELS[e.service] ?? e.service}</td>
                      <td>{e.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section>
            <h3>記録</h3>
            <label className="check">
              <input
                type="checkbox"
                checked={settings.telemetryToFile}
                onChange={(e) => void updateSettings({ telemetryToFile: e.target.checked })}
              />
              指標をファイルにも記録する (数値と状態のみ)
            </label>
            {snap.telemetry.logDir && <p className="hint">保存先: {snap.telemetry.logDir}</p>}
          </section>
        </>
      )}
    </div>
  );
}

type ProcessConfig = ManagedProcessesSettings[keyof ManagedProcessesSettings];

function ProcessCard(props: {
  entry: ManagedProcessEntry;
  config: ProcessConfig;
  onRestart: () => Promise<void>;
  onSave: (next: ProcessConfig) => Promise<void>;
}) {
  const { entry, config } = props;
  const st = entry.status;
  const [draft, setDraft] = useState<ProcessConfig>(config);
  const savedKey = JSON.stringify(config);
  useEffect(() => setDraft(JSON.parse(savedKey) as ProcessConfig), [savedKey]);
  const dirty = JSON.stringify(draft) !== savedKey;
  const field = (key: string, label: string, placeholder: string) => (
    <label className="field">
      {label}
      <input
        value={String((draft as Record<string, unknown>)[key] ?? '')}
        placeholder={placeholder}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value } as ProcessConfig)}
      />
    </label>
  );

  return (
    <div className="diag-proc" data-process={entry.id}>
      <div className="diag-proc-head">
        <strong>{entry.label}</strong>
        <span className={`pill diag-state-${st?.state ?? 'off'}`}>
          {st ? STATE_LABELS[st.state] : entry.enabled ? '未起動' : '無効'}
        </span>
        <button disabled={!st} onClick={() => void props.onRestart()}>
          再起動
        </button>
      </div>
      {entry.problem && <p className="diag-bad">{entry.problem}</p>}
      {st && (
        <div className="diag-proc-info">
          <span>コマンド: <code>{st.commandLine}</code></span>
          <span>PID: {st.pid ?? '—'}</span>
          <span>自動再起動: {st.restarts} 回</span>
          {st.lastExit && (
            <span>
              最後の終了: {fmtTime(st.lastExit.at)}{' '}
              {st.lastExit.error ? `(起動失敗: ${st.lastExit.error})` : `(code ${st.lastExit.code ?? '—'}${st.lastExit.signal ? `, ${st.lastExit.signal}` : ''})`}
            </span>
          )}
          {st.nextRestartAt !== null && <span>次の再起動: {fmtTime(st.nextRestartAt)}</span>}
          {st.failedReason && <span className="diag-bad">停止理由: {st.failedReason}</span>}
        </div>
      )}
      {st && st.stderr.length > 0 && (
        <details>
          <summary>直近のエラー出力 ({st.stderr.length} 行)</summary>
          <pre className="diag-stderr">{st.stderr.join('\n')}</pre>
        </details>
      )}
      <details className="diag-proc-config">
        <summary>設定</summary>
        <label className="check">
          <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} />
          NAVI から起動して監視する
        </label>
        {entry.id === 'voice-service' && (
          <>
            {field('python', 'Python 実行ファイル', 'python (例: voice-service\\.venv\\Scripts\\python.exe)')}
            {field('cwd', '作業フォルダ', '空欄 = アプリ同梱の voice-service フォルダ')}
          </>
        )}
        {entry.id === 'voicevox' && (
          <>
            {field('executable', 'VOICEVOX ENGINE 実行ファイル (run.exe)', 'C:\\...\\vv-engine\\run.exe')}
            {field('args', '引数', '--host 127.0.0.1 --port 50021')}
          </>
        )}
        {entry.id === 'ollama' && field('executable', 'Ollama 実行ファイル', 'ollama')}
        <button disabled={!dirty} onClick={() => void props.onSave(draft)}>
          保存して適用
        </button>
      </details>
    </div>
  );
}
