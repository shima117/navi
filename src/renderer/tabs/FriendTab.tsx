import { useEffect, useRef, useState } from 'react';
import { useNavi } from '../state/NaviContext';

export function FriendTab() {
  const { lines, sharing, stream, submitText } = useNavi();
  const [input, setInput] = useState('');
  const previewRef = useRef<HTMLVideoElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (previewRef.current) previewRef.current.srcObject = stream;
  }, [stream, sharing.on]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [lines]);

  return (
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
            const text = input;
            setInput('');
            void submitText(text);
          }}
        >
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="ナビに話しかける…" />
          <button type="submit">送信</button>
        </form>
      </section>
    </div>
  );
}
