import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaptureSource, FriendPush, NaviSettings } from '../../electron/ipc';
import { PROFILES } from '../core/resource/ResourceGovernor';
import { ScreenStreamManager } from './ScreenStreamManager';
import { SpeechPlayer } from './SpeechPlayer';
import { VoiceClient } from './VoiceClient';

type Tab = 'friend' | 'screen' | 'games' | 'memory' | 'avatar' | 'settings';

interface Line {
  role: 'user' | 'navi';
  text: string;
  at: number;
}

const TABS: Array<[Tab, string]> = [
  ['friend', 'Friend'],
  ['screen', 'Shared Screen'],
  ['games', 'Games'],
  ['memory', 'Memory'],
  ['avatar', 'Avatar'],
  ['settings', 'Settings'],
];

/** FriendShell: the main window. Game UIs live under Games (design doc §14). */
export function App() {
  const [tab, setTab] = useState<Tab>('friend');
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState('');
  const [health, setHealth] = useState<Record<string, boolean>>({});
  const [sharing, setSharing] = useState<{ on: boolean; name: string | null }>({ on: false, name: null });
  const [paused, setPaused] = useState(false);
  const [micOn, setMicOn] = useState(false);
  const [voiceConnected, setVoiceConnected] = useState(false);
  const [plugin, setPlugin] = useState<string | null>(null);
  const [settings, setSettings] = useState<NaviSettings | null>(null);

  const screenRef = useRef<ScreenStreamManager>(null);
  const playerRef = useRef<SpeechPlayer>(null);
  const voiceRef = useRef<VoiceClient>(null);
  screenRef.current ??= new ScreenStreamManager();
  playerRef.current ??= new SpeechPlayer();
  voiceRef.current ??= new VoiceClient(setVoiceConnected);

  const previewRef = useRef<HTMLVideoElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.navi.settings.get().then(setSettings);
    // Health/plugin changes may have been pushed before this window subscribed.
    void window.navi.friend.getState().then((s) => {
      const state = s as { health: Record<string, boolean>; plugin: string | null };
      setHealth(state.health);
      setPlugin(state.plugin);
    });
    const off = window.navi.friend.onEvent((p: FriendPush) => {
      switch (p.type) {
        case 'transcript':
          setLines((ls) => [...ls.slice(-200), { role: p.role, text: p.text, at: p.at }]);
          break;
        case 'speech':
          if (p.audio) void playerRef.current!.play(p.audio, p.lipsync).catch((e) => console.error('[speech]', e));
          break;
        case 'stopSpeech':
          playerRef.current!.stop();
          break;
        case 'health':
          setHealth(p.services);
          break;
        case 'capture':
          setSharing({ on: p.sharing, name: p.sourceName });
          break;
        case 'plugin':
          setPlugin(p.active);
          break;
      }
    });
    return off;
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines]);

  const submit = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    playerRef.current!.stop();
    await window.navi.friend.submitText(text);
  }, [input]);

  const startShare = useCallback(
    async (src: CaptureSource) => {
      const fps = PROFILES[settings?.resourceMode ?? 'BALANCED'].sampleFps;
      const stream = await screenRef.current!.start(src.id, src.name, src.kind, fps);
      setPaused(false);
      if (previewRef.current) previewRef.current.srcObject = stream;
      setTab('friend');
    },
    [settings],
  );

  const stopShare = useCallback(async () => {
    await screenRef.current!.stop();
    if (previewRef.current) previewRef.current.srcObject = null;
  }, []);

  const togglePause = useCallback(() => {
    const next = !paused;
    screenRef.current!.setPaused(next);
    setPaused(next);
  }, [paused]);

  const toggleMic = useCallback(async () => {
    if (micOn) {
      await voiceRef.current!.stop();
      setMicOn(false);
    } else {
      try {
        await voiceRef.current!.start(settings?.micDeviceId ?? null);
        setMicOn(true);
      } catch (e) {
        console.error('[mic]', e);
      }
    }
  }, [micOn, settings]);

  useEffect(() => {
    if (previewRef.current) previewRef.current.srcObject = screenRef.current!.mediaStream;
  }, [tab]);

  const updateSettings = async (patch: Partial<NaviSettings>) => setSettings(await window.navi.settings.set(patch));

  const aiOnline = health.chat === true;
  return (
    <div className="shell">
      <header>
        <span className="brand">NAVI</span>
        <span className={`pill ${aiOnline ? 'ok' : 'bad'}`}>{aiOnline ? '● LOCAL' : 'AI offline'}</span>
        <span className={`pill ${micOn ? (voiceConnected ? 'ok' : 'warn') : ''}`}>🎙 {micOn ? (voiceConnected ? 'ON' : 'STT offline') : 'OFF'}</span>
        <span className={`pill ${sharing.on && !paused ? 'share' : ''}`} title={sharing.name ?? ''}>
          👁 {sharing.on ? (paused ? 'PAUSED' : `SHARING: ${sharing.name}`) : 'NOT SHARING'}
        </span>
      </header>

      <nav>
        {TABS.map(([id, label]) => (
          <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>

      <main>
        {tab === 'friend' && (
          <div className="friend">
            <section className="preview">
              {sharing.on ? <video ref={previewRef} autoPlay muted /> : <div className="empty">画面を共有していません</div>}
            </section>
            <section className="chat">
              <div className="log" ref={logRef}>
                {lines.map((l, i) => (
                  <div key={i} className={`line ${l.role}`}>
                    <div className="who">{l.role === 'navi' ? 'NAVI' : 'YOU'}</div>
                    <div className="text">「{l.text}」</div>
                  </div>
                ))}
              </div>
              <form
                className="input"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="ナビに話しかける…" />
                <button type="submit">送信</button>
              </form>
            </section>
          </div>
        )}
        {tab === 'screen' && <SourcePicker onPick={startShare} current={sharing.name} />}
        {tab === 'games' && <Games active={plugin} />}
        {tab === 'memory' && <MemoryTab settings={settings} onChange={updateSettings} />}
        {tab === 'avatar' && <AvatarTab settings={settings} onChange={updateSettings} />}
        {tab === 'settings' && <SettingsTab settings={settings} onChange={updateSettings} health={health} />}
      </main>

      <footer>
        <div className="status">
          mode: {plugin ?? 'Generic'} · Vision: {health.vision ? 'ready' : 'offline'} · TTS: {health.tts ? 'ready' : 'subtitles only'} · AI:{' '}
          {aiOnline ? 'ready' : 'offline'}
        </div>
        <div className="controls">
          <button onClick={() => void toggleMic()}>🎙 {micOn ? 'mute' : 'unmute'}</button>
          <button onClick={togglePause} disabled={!sharing.on}>
            👁 {paused ? 'resume share' : 'pause share'}
          </button>
          <button onClick={() => void window.navi.friend.interrupt()}>🔇 stop voice</button>
          <button onClick={() => void window.navi.avatar.setVisible(!(settings?.avatarVisible ?? true)).then(() => window.navi.settings.get().then(setSettings))}>
            👓 avatar
          </button>
          <button onClick={() => void stopShare()} disabled={!sharing.on}>
            ■ end share
          </button>
        </div>
      </footer>
    </div>
  );
}

function SourcePicker({ onPick, current }: { onPick: (s: CaptureSource) => void; current: string | null }) {
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
          <button key={s.id} className={`source ${current === s.name ? 'active' : ''}`} onClick={() => onPick(s)}>
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

function Games({ active }: { active: string | null }) {
  const [list, setList] = useState<Array<{ id: string; displayName: string; active: boolean }>>([]);
  useEffect(() => void window.navi.plugin.list().then(setList), [active]);
  return (
    <div className="panel">
      <h2>Games</h2>
      <p className="hint">共有したウィンドウから自動で選ばれます。手動で固定もできます。</p>
      <label className="radio">
        <input type="radio" checked={active === null} onChange={() => void window.navi.plugin.activate(null)} /> Generic (プラグインなし)
      </label>
      {list.map((p) => (
        <label key={p.id} className="radio">
          <input type="radio" checked={active === p.id} onChange={() => void window.navi.plugin.activate(p.id)} /> {p.displayName}
        </label>
      ))}
    </div>
  );
}

interface TabProps {
  settings: NaviSettings | null;
  onChange: (patch: Partial<NaviSettings>) => void;
}

function MemoryTab({ settings, onChange }: TabProps) {
  if (!settings) return null;
  return (
    <div className="panel">
      <h2>Memory</h2>
      <label className="check">
        <input type="checkbox" checked={settings.persistMemory} onChange={(e) => onChange({ persistMemory: e.target.checked })} />
        会話から覚えたことをセッションをまたいで保持する
      </label>
      <p className="hint">オフの場合、覚えた内容はアプリ終了時に消去されます。</p>
    </div>
  );
}

function AvatarTab({ settings, onChange }: TabProps) {
  if (!settings) return null;
  return (
    <div className="panel">
      <h2>Avatar</h2>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.avatarVisible}
          onChange={(e) => {
            void window.navi.avatar.setVisible(e.target.checked);
            onChange({ avatarVisible: e.target.checked });
          }}
        />
        アバターを表示
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.avatarClickThrough}
          onChange={(e) => {
            void window.navi.avatar.setClickThrough(e.target.checked);
            onChange({ avatarClickThrough: e.target.checked });
          }}
        />
        クリック透過 (ゲーム入力を奪わない)
      </label>
    </div>
  );
}

function SettingsTab({ settings, onChange, health }: TabProps & { health: Record<string, boolean> }) {
  if (!settings) return null;
  return (
    <div className="panel">
      <h2>Settings</h2>
      <label className="field">
        あなたの名前
        <input value={settings.userName} onChange={(e) => onChange({ userName: e.target.value })} />
      </label>
      <label className="field">
        リソースモード
        <select value={settings.resourceMode} onChange={(e) => onChange({ resourceMode: e.target.value as NaviSettings['resourceMode'] })}>
          <option value="GAME_PRIORITY">GAME_PRIORITY (ゲーム優先)</option>
          <option value="BALANCED">BALANCED</option>
          <option value="DESKTOP_CHAT">DESKTOP_CHAT (高精度Vision)</option>
        </select>
      </label>
      <label className="field">
        VOICEVOX 話者ID
        <input type="number" value={settings.speakerId} onChange={(e) => onChange({ speakerId: Number(e.target.value) })} />
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.quiet} onChange={(e) => onChange({ quiet: e.target.checked })} />
        静かめ (自分から話しかける頻度を下げる)
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.useAlternateChatModel}
          onChange={(e) => onChange({ useAlternateChatModel: e.target.checked })}
        />
        会話モデルを qwen3:8b に切り替える
      </label>
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
