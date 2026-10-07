import { useNavi } from '../state/NaviContext';

/** OCR toggles shown in the Settings tab. */
export function OcrSettingsFields() {
  const { settings, updateSettings } = useNavi();
  if (!settings) return null;
  return (
    <>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.ocrEnabled}
          onChange={(e) => void updateSettings({ ocrEnabled: e.target.checked })}
        />
        画面の文字を読む (OCR: 値札やセール表示に反応。文字はメモリ上だけで保存しない)
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.ocrInGamePriority}
          disabled={!settings.ocrEnabled}
          onChange={(e) => void updateSettings({ ocrInGamePriority: e.target.checked })}
        />
        GAME_PRIORITY 中も OCR する (CPU を少し使う)
      </label>
    </>
  );
}
