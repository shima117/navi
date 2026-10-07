const http = require('http');
// Fake Ollama
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/api/version') return res.end(JSON.stringify({ version: 'fake' }));
    if (req.url === '/api/chat') {
      const msgs = JSON.parse(body).messages;
      const last = msgs[msgs.length - 1].content;
      const text = last.includes('仕事') ? 'お疲れさまです。まあ私も今日は何もしたくないですけど' : '不愉快です。他に何かお手伝いできることはありますか？';
      return res.end(JSON.stringify({ message: { content: JSON.stringify({ speak: true, text, emotion: 'unimpressed', intensity: 0.8, gaze: 'user', gesture: 'tilt_right', memory_write: [], topic_action: 'continue', needs_vision: false, needs_tool: null }) } }));
    }
    res.end('{}');
  });
}).listen(11434, '127.0.0.1');
// Fake VOICEVOX (short silent wav)
function wav(ms) {
  const n = Math.floor(24000 * ms / 1000), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); return b;
}
http.createServer((req, res) => {
  if (req.url.startsWith('/version')) return res.end('"0.0.0"');
  if (req.url.startsWith('/audio_query')) return res.end(JSON.stringify({ accent_phrases: [{ moras: [{ text: 'ア', vowel: 'a', vowel_length: 0.3, pitch: 5 }, { text: 'イ', vowel: 'i', vowel_length: 0.3, pitch: 5 }] }], speedScale: 1, prePhonemeLength: 0.1, postPhonemeLength: 0.1 }));
  if (req.url.startsWith('/synthesis')) { res.setHeader('Content-Type', 'audio/wav'); return res.end(wav(800)); }
  res.end('{}');
}).listen(50021, '127.0.0.1');
