import { useEffect, useState } from 'react';
import { PLUGIN_UIS } from '../plugin-ui/registry';
import { useNavi } from '../state/NaviContext';

export function GamesTab() {
  const { plugin: active } = useNavi();
  const [list, setList] = useState<Array<{ id: string; displayName: string; active: boolean }>>([]);
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => void window.navi.plugin.list().then(setList), [active]);
  useEffect(() => setSelected((s) => s ?? active), [active]);

  const Panel = selected ? PLUGIN_UIS[selected] : undefined;
  return (
    <div className="games">
      <aside className="panel">
        <h2>Games</h2>
        <p className="hint">共有したウィンドウから自動で選ばれます。手動で固定もできます。</p>
        <label className="radio">
          <input type="radio" checked={active === null} onChange={() => void window.navi.plugin.activate(null)} /> Generic (プラグインなし)
        </label>
        {list.map((p) => (
          <div key={p.id} className="game-row">
            <label className="radio">
              <input type="radio" checked={active === p.id} onChange={() => void window.navi.plugin.activate(p.id)} /> {p.displayName}
            </label>
            {PLUGIN_UIS[p.id] && (
              <button className={selected === p.id ? 'active' : ''} onClick={() => setSelected(p.id)}>
                開く
              </button>
            )}
          </div>
        ))}
      </aside>
      <section className="game-panel">{Panel ? <Panel /> : <div className="empty">ゲームを選ぶと詳細が表示されます</div>}</section>
    </div>
  );
}
