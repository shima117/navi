import { useCallback, useEffect, useState } from 'react';
import type { CaptureSource } from '../../../electron/ipc';
import { useNavi } from '../state/NaviContext';

export function SharedScreenTab({ goTo }: { goTo?: (id: string) => void }) {
  const { sharing, startShare } = useNavi();
  const [sources, setSources] = useState<CaptureSource[]>([]);
  const refresh = useCallback(() => void window.navi.capture.listSources().then(setSources), []);
  useEffect(refresh, [refresh]);
  return (
    <div className="picker">
      <div className="row">
        <h2>共有する画面 / ウィンドウ</h2>
        <button onClick={refresh}>更新</button>
      </div>
      <p className="hint">選んだ対象だけをナビが見ます。画像はメモリ上にのみ保持され、ディスクには保存されません。</p>
      <div className="grid">
        {sources.map((s) => (
          <button
            key={s.id}
            className={`source ${sharing.name === s.name ? 'active' : ''}`}
            onClick={() => void startShare(s).then(() => goTo?.('friend'))}
          >
            <img src={s.thumbnailDataUrl} alt="" />
            <span>
              {s.kind === 'screen' ? '🖥 ' : '🪟 '}
              {s.name}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
