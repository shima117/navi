import { useEffect, useState } from 'react';
import type { AudioDevice, AudioRuntimeState, NaviSettings } from '../../../electron/ipc';
import { OcrSettingsFields } from '../ocr/OcrSettingsFields';
import { useNavi } from '../state/NaviContext';

export function SettingsTab() {
  const { settings, updateSettings, health, audioOutput } = useNavi();
  const [devices, setDevices] = useState<AudioDevice[]>([]);
  const [audioState, setAudioState] = useState<AudioRuntimeState | null>(null);
  const [audioMessage, setAudioMessage] = useState('');

  useEffect(() => {
    let active = true;
    const load = async () => {
      const browserDevices = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
      const local: AudioDevice[] = browserDevices
        .filter((d) => d.kind === 'audioinput' || d.kind === 'audiooutput')
        .map((d) => ({ id: d.deviceId, name: d.label || `${d.kind} (${d.deviceId.slice(0, 8)})`, kind: d.kind === 'audioinput' ? 'input' : 'output' }));
      const service = await window.navi.audio.listDevices().catch(() => [] as AudioDevice[]);
      const state = await window.navi.audio.getState().catch(() => null);
      if (active) {
        setDevices([...local, ...service.filter((d) => !local.some((x) => x.kind === d.kind && x.name === d.name))]);
        setAudioState(state);
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  if (!settings) return null;
  const updateAudio = (patch: Partial<NaviSettings['audio']>) =>
    updateSettings({ audio: { ...settings.audio, ...patch } });
  const runRouting = async (operation: 'snapshot' | 'apply' | 'restore') => {
    setAudioMessage('処理中…');
    try {
      if (operation === 'snapshot') {
        await window.navi.audio.snapshotRouting();
        setAudioMessage('現在のVoicemeeter設定を保存しました');
      } else if (operation === 'apply') {
        const result = await window.navi.audio.applyRouting();
        setAudioMessage(`NAVI用ルーティングを適用しました（変更 ${result.changed?.length ?? 0} 件）`);
      } else {
        const result = await window.navi.audio.restoreRouting();
        setAudioMessage(`元に戻しました（復元 ${result.restored} / 保留 ${result.skipped}）`);
      }
      setAudioState(await window.navi.audio.getState());
    } catch (err) {
      setAudioMessage(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <div className="panel settings">
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
      <section className="audio-settings">
        <h3>音声・Voicemeeter</h3>
        <p className="hint">NAVIの声は VAIO3 へ出力します。NAVIはVAIO3の音量フェーダーを変更しません。</p>
        <div className="audio-status row">
          <span className={`pill ${audioState?.voiceService ? 'ok' : 'bad'}`}>音声サービス {audioState?.voiceService ? 'OK' : 'offline'}</span>
          <span className={`pill ${audioState?.voicemeeter && audioState.voicemeeterType === 'potato' ? 'ok' : 'warn'}`}>
            Voicemeeter {audioState?.voicemeeterType ?? 'unknown'}
          </span>
          <span className={`pill ${audioOutput.status === 'connected' ? 'ok' : 'warn'}`}>
            NAVI出力 {audioOutput.status === 'connected' ? 'VAIO3' : audioOutput.status}
          </span>
        </div>
        {audioState?.warning && <p className="audio-warning">{audioState.warning}</p>}
        <label className="field">
          ユーザーマイク
          <select value={settings.audio.userMicDeviceId ?? ''} onChange={(e) => void updateAudio({ userMicDeviceId: e.target.value || null })}>
            <option value="">OSの既定</option>
            {devices.filter((d) => d.kind === 'input').map((d) => <option key={`in-${d.id}-${d.name}`} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <label className="field">
          NAVI出力先（優先名）
          <input value={settings.audio.naviOutputDeviceName} onChange={(e) => void updateAudio({ naviOutputDeviceName: e.target.value })} />
        </label>
        <label className="field">
          VAIO3がない場合の出力先
          <select value={settings.audio.fallbackOutputDeviceId ?? ''} onChange={(e) => void updateAudio({ fallbackOutputDeviceId: e.target.value || null })}>
            <option value="">OSの既定</option>
            {devices.filter((d) => d.kind === 'output').map((d) => <option key={`out-${d.id}-${d.name}`} value={d.id}>{d.name}</option>)}
          </select>
        </label>
        <div className="audio-grid">
          <label className="check"><input type="checkbox" checked={settings.audio.fullDuplex} onChange={(e) => void updateAudio({ fullDuplex: e.target.checked })} />フルデュプレックス会話</label>
          <label className="check"><input type="checkbox" checked={settings.audio.userBackchannelRecognition} onChange={(e) => void updateAudio({ userBackchannelRecognition: e.target.checked })} />ユーザーの相槌を認識</label>
          <label className="check"><input type="checkbox" checked={settings.audio.naviBackchannel} onChange={(e) => void updateAudio({ naviBackchannel: e.target.checked })} />NAVIの相槌</label>
          <label className="check"><input type="checkbox" checked={settings.audio.naviInterruptions} onChange={(e) => void updateAudio({ naviInterruptions: e.target.checked })} />NAVIのやわらかい割り込み</label>
          <label className="check"><input type="checkbox" checked={settings.audio.listenSystemAudio} onChange={(e) => void updateAudio({ listenSystemAudio: e.target.checked })} />SYSTEMをB2から聞く</label>
          <label className="check"><input type="checkbox" checked={settings.audio.listenRemoteAudio} onChange={(e) => void updateAudio({ listenRemoteAudio: e.target.checked })} />REMOTEをB3から聞く</label>
          <label className="check"><input type="checkbox" checked={settings.audio.remoteConversationContext} onChange={(e) => void updateAudio({ remoteConversationContext: e.target.checked })} />通話相手を会話文脈に使う</label>
          <label className="check"><input type="checkbox" checked={settings.audio.voicemeeterRestoreOnExit} onChange={(e) => void updateAudio({ voicemeeterRestoreOnExit: e.target.checked })} />終了時に変更分だけ戻す</label>
        </div>
        <label className="field">
          NAVI割り込み頻度
          <select value={settings.audio.naviInterruptionLevel} onChange={(e) => void updateAudio({ naviInterruptionLevel: e.target.value as NaviSettings['audio']['naviInterruptionLevel'] })}>
            <option value="LOW">控えめ</option><option value="NORMAL">標準</option><option value="HIGH">多め</option>
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={settings.audio.voicemeeterAutoConfigure} onChange={(e) => void updateAudio({ voicemeeterAutoConfigure: e.target.checked })} />起動時に安全なNAVI用ルーティングを適用</label>
        <label className="check"><input type="checkbox" checked={settings.audio.voicemodEnabled} onChange={(e) => void updateAudio({ voicemodEnabled: e.target.checked })} />Voicemodを最後段で使う（未接続時は自動で素通し）</label>
        <div className="row audio-actions">
          <button onClick={() => void runRouting('snapshot')}>現在設定を保存</button>
          <button onClick={() => void runRouting('apply')}>NAVI用設定を適用</button>
          <button onClick={() => void runRouting('restore')}>変更分を元に戻す</button>
        </div>
        {audioMessage && <p className="hint">{audioMessage}</p>}
      </section>
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
