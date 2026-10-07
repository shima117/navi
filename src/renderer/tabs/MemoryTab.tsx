import { useNavi } from '../state/NaviContext';

export function MemoryTab() {
  const { settings, updateSettings } = useNavi();
  if (!settings) return null;
  return (
    <div className="panel">
      <h2>Memory</h2>
      <label className="check">
        <input type="checkbox" checked={settings.persistMemory} onChange={(e) => void updateSettings({ persistMemory: e.target.checked })} />
        会話から覚えたことをセッションをまたいで保持する
      </label>
      <p className="hint">オフの場合、覚えた内容はアプリ終了時に消去されます。</p>
    </div>
  );
}
