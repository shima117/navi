import type { DesktopTextSettings, TextPosition } from '../../core/desktopText/DesktopText';
import { useNavi } from '../state/NaviContext';

export function TextSettingsFields() {
  const { settings, updateSettings } = useNavi();
  if (!settings) return null;
  const s = settings.desktopText;
  const update = (patch: Partial<DesktopTextSettings>) => void updateSettings({ desktopText: { ...s, ...patch } });
  return <section className="audio-settings">
    <h3>デスクトップの文字表示</h3>
    <p className="hint">背景なしの文字だけを、アバターとは別の窓に出します。「文字で見せて」は読み上げなし、「声でも」で両方です。</p>
    <label className="field">フォント<input value={s.fontFamily} onChange={(e) => update({ fontFamily: e.target.value })} /></label>
    <label className="field">文字サイズ<input type="number" min="16" max="72" value={s.fontSize} onChange={(e) => update({ fontSize: Number(e.target.value) })} /></label>
    <label className="field">文字色<input type="color" value={s.color} onChange={(e) => update({ color: e.target.value })} /></label>
    <label className="field">黒い縁の太さ<input type="number" min="0" max="4" step="0.5" value={s.strokeWidth} onChange={(e) => update({ strokeWidth: Number(e.target.value) })} /></label>
    <label className="field">不透明度<input type="range" min="0.2" max="1" step="0.01" value={s.opacity} onChange={(e) => update({ opacity: Number(e.target.value) })} /></label>
    <label className="field">行の高さ<input type="number" min="1.1" max="2" step="0.1" value={s.lineHeight} onChange={(e) => update({ lineHeight: Number(e.target.value) })} /></label>
    <label className="field">最大幅<input type="number" min="240" max="1600" value={s.maxWidth} onChange={(e) => update({ maxWidth: Number(e.target.value) })} /></label>
    <label className="field">1ページの最大行数<input type="number" min="2" max="16" value={s.maxLines} onChange={(e) => update({ maxLines: Number(e.target.value) })} /></label>
    <label className="field">表示位置<select value={s.position} onChange={(e) => update({ position: e.target.value as TextPosition })}>
      <option value="AVATAR_SIDE">アバターの横</option><option value="TOP_CENTER">上中央</option><option value="BOTTOM_CENTER">下中央</option>
      <option value="TOP_LEFT">左上</option><option value="TOP_RIGHT">右上</option><option value="FREE">自由位置</option>
    </select></label>
    {s.position === 'FREE' && <>
      <label className="field">横位置<input type="number" value={s.x} onChange={(e) => update({ x: Number(e.target.value) })} /></label>
      <label className="field">縦位置<input type="number" value={s.y} onChange={(e) => update({ y: Number(e.target.value) })} /></label>
    </>}
    <label className="check"><input type="checkbox" checked={s.shadow} onChange={(e) => update({ shadow: e.target.checked })} />文字に影を付ける</label>
    <label className="check"><input type="checkbox" checked={s.clickThrough} onChange={(e) => update({ clickThrough: e.target.checked })} />クリックを背後のアプリに通す（オフで文字の窓をドラッグ）</label>
    <label className="check"><input type="checkbox" checked={s.captureIncluded} onChange={(e) => update({ captureIncluded: e.target.checked })} />画面キャプチャに文字を含める</label>
    <div className="row">
      <button onClick={() => void window.navi.desktopText.show('NAVIの文字表示です。\n白い文字と黒い縁で表示します。', 'MEMO')}>文字表示を試す</button>
      <button onClick={() => void window.navi.desktopText.command('hide')}>文字を消す</button>
    </div>
    <p className="hint">長い表示は「次」「前」で切り替え、「消して」で閉じられます。画面キャプチャからの除外は、使用する録画ソフトでも確認してください。</p>
  </section>;
}
