import { useNavi } from '../state/NaviContext';

export function AvatarTab() {
  const { settings, refreshSettings } = useNavi();
  if (!settings) return null;
  return (
    <div className="panel">
      <h2>Avatar</h2>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.avatarVisible}
          onChange={(e) => void window.navi.avatar.setVisible(e.target.checked).then(refreshSettings)}
        />
        アバターを表示
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.avatarClickThrough}
          onChange={(e) => void window.navi.avatar.setClickThrough(e.target.checked).then(refreshSettings)}
        />
        クリック透過 (ゲーム入力を奪わない)
      </label>
    </div>
  );
}
