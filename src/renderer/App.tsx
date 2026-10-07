import { useState } from 'react';
import { NaviProvider, useNavi } from './state/NaviContext';
import { TABS } from './tabs/registry';

/** FriendShell: the main window. Game UIs live under Games (design doc §14). */
export function App() {
  return (
    <NaviProvider>
      <Shell />
    </NaviProvider>
  );
}

function Shell() {
  const navi = useNavi();
  const [tab, setTab] = useState(TABS[0]!.id);
  const { health, sharing, paused, micOn, voiceConnected, plugin, settings } = navi;
  const aiOnline = health.chat === true;
  const Active = (TABS.find((t) => t.id === tab) ?? TABS[0]!).component;

  return (
    <div className="shell">
      <header>
        <span className="brand">NAVI</span>
        <span className={`pill ${aiOnline ? 'ok' : 'bad'}`}>{aiOnline ? '● LOCAL' : 'AI offline'}</span>
        <span className={`pill ${micOn ? (voiceConnected ? 'ok' : 'warn') : ''}`}>
          🎙 {micOn ? (voiceConnected ? 'ON' : 'STT offline') : 'OFF'}
        </span>
        <span className={`pill ${sharing.on && !paused ? 'share' : ''}`} title={sharing.name ?? ''}>
          👁 {sharing.on ? (paused ? 'PAUSED' : `SHARING: ${sharing.name}`) : 'NOT SHARING'}
        </span>
      </header>

      <nav>
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>

      <main>
        <Active goTo={setTab} />
      </main>

      <footer>
        <div className="status">
          mode: {plugin ?? 'Generic'} · Vision: {health.vision ? 'ready' : 'offline'} · TTS:{' '}
          {health.tts ? 'ready' : 'subtitles only'} · AI: {aiOnline ? 'ready' : 'offline'}
        </div>
        <div className="controls">
          <button onClick={() => void navi.toggleMic()}>🎙 {micOn ? 'mute' : 'unmute'}</button>
          <button onClick={navi.togglePause} disabled={!sharing.on}>
            👁 {paused ? 'resume share' : 'pause share'}
          </button>
          <button onClick={() => void window.navi.friend.interrupt()}>🔇 stop voice</button>
          <button
            onClick={() =>
              void window.navi.avatar.setVisible(!(settings?.avatarVisible ?? true)).then(navi.refreshSettings)
            }
          >
            👓 avatar
          </button>
          <button onClick={() => void navi.stopShare()} disabled={!sharing.on}>
            ■ end share
          </button>
        </div>
      </footer>
    </div>
  );
}
