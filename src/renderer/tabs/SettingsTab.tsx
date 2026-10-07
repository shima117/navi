import type { NaviSettings } from '../../../electron/ipc';
import { OcrSettingsFields } from '../ocr/OcrSettingsFields';
import { useNavi } from '../state/NaviContext';

export function SettingsTab() {
  const { settings, updateSettings, health } = useNavi();
  if (!settings) return null;
  return (
    <div className="panel">
      <h2>Settings</h2>
      <label className="field">
        あなたの名前
        <input value={settings.userName} onChange={(e) => void updateSettings({ userName: e.target.value })} />
      </label>
      <label className="field">
        リソースモード
        <select
          value={settings.resourceMode}
          disabled={settings.autoResourceMode}
          onChange={(e) => void updateSettings({ resourceMode: e.target.value as NaviSettings['resourceMode'] })}
        >
          <option value="GAME_PRIORITY">GAME_PRIORITY (ゲーム優先)</option>
          <option value="BALANCED">BALANCED</option>
          <option value="DESKTOP_CHAT">DESKTOP_CHAT (高精度Vision)</option>
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.autoResourceMode} onChange={(e) => void updateSettings({ autoResourceMode: e.target.checked })} />
        リソースモードを状況に合わせて自動で切り替える
      </label>
      <label className="field">
        VOICEVOX 話者ID
        <input type="number" value={settings.speakerId} onChange={(e) => void updateSettings({ speakerId: Number(e.target.value) })} />
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.quiet} onChange={(e) => void updateSettings({ quiet: e.target.checked })} />
        静かめ (自分から話しかける頻度を下げる)
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.useAlternateChatModel}
          onChange={(e) => void updateSettings({ useAlternateChatModel: e.target.checked })}
        />
        会話モデルを qwen3:8b に切り替える
      </label>
      <OcrSettingsFields />
      <h3>サービス状態</h3>
      <ul className="health">
        {(['chat', 'vision', 'stt', 'tts'] as const).map((s) => (
          <li key={s} className={health[s] ? 'ok' : 'bad'}>
            {s}: {health[s] ? 'OK' : 'offline'}
          </li>
        ))}
      </ul>
    </div>
  );
}
