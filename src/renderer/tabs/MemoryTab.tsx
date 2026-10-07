import { useCallback, useEffect, useRef, useState } from 'react';
import type { MemoryClearScope } from '../../../electron/ipc';
import type { MemoryItem, MemoryStats, MemoryTier } from '../../core/memory/MemoryStore';
import { useNavi } from '../state/NaviContext';

const RETENTION_CHOICES = [7, 14, 30, 90, 180, 365];

const FILTERS: Array<{ id: MemoryTier | 'all'; label: string }> = [
  { id: 'all', label: 'すべて' },
  { id: 'long', label: '長期' },
  { id: 'session', label: 'セッション' },
];

const CLEAR: Record<MemoryClearScope, { button: string; confirm: string }> = {
  session: { button: 'セッション記憶を消す', confirm: 'セッション記憶をすべて消します。' },
  long: { button: '長期記憶を消す', confirm: '長期記憶をすべて消します。' },
  all: { button: '全部消す', confirm: '覚えたこと・会話ログ・画面メモ・話題の記録をすべて消します。' },
};

function formatAt(at: number): string {
  const d = new Date(at);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function describeStats(s: MemoryStats): string {
  const where = s.backend === 'sqlite' ? (s.fts ? 'SQLite (全文検索)' : 'SQLite') : 'メモリのみ';
  return (
    `長期 ${s.long}件 · セッション ${s.session}件 · 会話ログ ${s.utterances}件 · ` +
    `画面メモ ${s.screenEvents}件 · 話題 ${s.topics}件 · 保存先: ${where}`
  );
}

/** What Navi remembers, and the switches for how much she may keep (§6.5). */
export function MemoryTab() {
  const { settings, updateSettings } = useNavi();
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<MemoryTier | 'all'>('all');
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [confirm, setConfirm] = useState<MemoryClearScope | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Typing fires overlapping searches; only the latest may update the list.
  const requestSeq = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++requestSeq.current;
    const tier = filter === 'all' ? undefined : filter;
    try {
      const [list, st] = await Promise.all([
        query.trim() ? window.navi.memory.search(query, tier) : window.navi.memory.list(tier),
        window.navi.memory.stats(),
      ]);
      if (seq !== requestSeq.current) return;
      setItems(list);
      setStats(st);
      setError(null);
    } catch (e) {
      console.error('[memory]', e);
      if (seq === requestSeq.current) setError('記憶を読み込めませんでした。');
    }
  }, [query, filter]);

  useEffect(() => {
    const t = setTimeout(() => void reload(), query ? 200 : 0);
    return () => clearTimeout(t);
  }, [reload, query]);

  const run = async (action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (e) {
      console.error('[memory]', e);
      setError('操作に失敗しました。');
      return;
    }
    await reload();
  };

  const saveEdit = () => {
    if (!editing || !editing.text.trim()) return;
    const { id, text } = editing;
    setEditing(null);
    void run(() => window.navi.memory.update(id, text));
  };

  if (!settings) return null;
  return (
    <div className="panel memory">
      <h2>Memory</h2>

      <section className="memory-settings">
        <label className="check">
          <input type="checkbox" checked={settings.persistMemory} onChange={(e) => void updateSettings({ persistMemory: e.target.checked })} />
          会話から覚えたことをセッションをまたいで保持する
        </label>
        <p className="hint">
          {'オフの場合、覚えた内容はアプリ終了時に消去されます。' +
            'オンのときは、何度も出てきた記憶を長期記憶に移し、セッションの終わりに会話を短い事実にまとめて覚えます。'}
        </p>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.persistUtterances}
            onChange={(e) => void updateSettings({ persistUtterances: e.target.checked })}
          />
          会話ログ (発言と画面の要約) を保存する
        </label>
        <p className="hint">既定はオフです。画像は保存しません。APIキーやパスワードらしき文字列は伏せ字にして保存します。</p>
        <label className="field">
          保存期間
          <select
            value={settings.utteranceRetentionDays}
            onChange={(e) => void updateSettings({ utteranceRetentionDays: Number(e.target.value) })}
          >
            {[...new Set([...RETENTION_CHOICES, settings.utteranceRetentionDays])]
              .sort((a, b) => a - b)
              .map((d) => (
                <option key={d} value={d}>
                  {`${d}日`}
                </option>
              ))}
          </select>
        </label>
        <p className="hint">会話ログと、しばらく使われていないセッション記憶はこの日数で消えます。長期記憶は消すまで残ります。</p>
      </section>

      {stats && <p className="memory-stats">{describeStats(stats)}</p>}
      {stats?.backend === 'memory' && (
        <p className="memory-warning">
          記憶用のデータベースを開けなかったため、今回は記憶をメモリ上だけに保持しています (終了すると消えます)。
        </p>
      )}

      <div className="memory-toolbar">
        <input type="search" placeholder="記憶を検索" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="memory-filter">
          {FILTERS.map((f) => (
            <button key={f.id} className={filter === f.id ? 'active' : ''} onClick={() => setFilter(f.id)}>
              {f.label}
            </button>
          ))}
        </div>
        <button onClick={() => void reload()}>更新</button>
      </div>
      {error && <p className="memory-error">{error}</p>}

      <ul className="memory-list">
        {items.length === 0 && (
          <li className="empty">{query.trim() ? '見つかりませんでした' : 'まだ何も覚えていません'}</li>
        )}
        {items.map((m) => (
          <li key={m.id} className="memory-item">
            <div className="memory-head">
              <span className={`memory-tier ${m.tier}`}>{m.tier === 'long' ? '長期' : 'セッション'}</span>
              {m.source === 'summary' && <span className="memory-source">要約</span>}
              {m.source === 'user' && <span className="memory-source">編集済み</span>}
              <span className="memory-meta">
                {`${formatAt(m.createdAt)} に覚えた · 最後に使った ${formatAt(m.lastUsedAt)} · ${m.uses}回使用`}
              </span>
            </div>
            {editing?.id === m.id ? (
              <div className="memory-edit">
                <textarea
                  autoFocus
                  value={editing.text}
                  maxLength={300}
                  onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) saveEdit();
                    if (e.key === 'Escape') setEditing(null);
                  }}
                />
                <div className="row">
                  <button onClick={saveEdit} disabled={!editing.text.trim()}>
                    保存
                  </button>
                  <button onClick={() => setEditing(null)}>キャンセル</button>
                </div>
              </div>
            ) : (
              <div className="memory-body">
                <p className="memory-text">{m.text}</p>
                <div className="memory-actions">
                  <button onClick={() => setEditing({ id: m.id, text: m.text })}>編集</button>
                  <button onClick={() => void run(() => window.navi.memory.delete(m.id))}>削除</button>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>

      <section className="memory-danger">
        <h3>消去</h3>
        {confirm ? (
          <div className="memory-confirm">
            <span>{CLEAR[confirm].confirm} 元に戻せません。よろしいですか？</span>
            <button
              className="danger"
              onClick={() => {
                const scope = confirm;
                setConfirm(null);
                setEditing(null);
                void run(() => window.navi.memory.clear(scope));
              }}
            >
              消す
            </button>
            <button onClick={() => setConfirm(null)}>やめる</button>
          </div>
        ) : (
          <div className="row">
            {(Object.keys(CLEAR) as MemoryClearScope[]).map((scope) => (
              <button key={scope} className={scope === 'all' ? 'danger' : ''} onClick={() => setConfirm(scope)}>
                {CLEAR[scope].button}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
