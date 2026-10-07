// Fake Ollama (:11434) and VOICEVOX (:50021) for manual runs and the e2e suite.
// Run directly (`node e2e/fakeServices.cjs`) to start both until killed, or
// require it and start/stop each one per test. Binds 127.0.0.1 only.
const http = require('http');

const OLLAMA_PORT = 11434;
const VOICEVOX_PORT = 50021;

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function handle(server, stats) {
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return {
    stats,
    close() {
      return new Promise((resolve) => {
        // Health checks keep connections alive; drop them so close() resolves now.
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      });
    },
  };
}

function chatReply(messages) {
  const last = messages[messages.length - 1].content;
  return last.includes('仕事')
    ? 'お疲れさまです。まあ私も今日は何もしたくないですけど'
    : '不愉快です。他に何かお手伝いできることはありますか？';
}

/** Fake Ollama: /api/version, /api/chat (JSON companion reply), anything else → {}. */
async function startFakeOllama(port = OLLAMA_PORT) {
  const stats = { chat: 0, requests: 0 };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      stats.requests++;
      if (req.url === '/api/version') return res.end(JSON.stringify({ version: 'fake' }));
      if (req.url === '/api/chat') {
        stats.chat++;
        const text = chatReply(JSON.parse(body).messages);
        const content = JSON.stringify({ speak: true, text, emotion: 'unimpressed', intensity: 0.8, gaze: 'user', gesture: 'tilt_right', memory_write: [], topic_action: 'continue', needs_vision: false, needs_tool: null });
        return res.end(JSON.stringify({ message: { content } }));
      }
      res.end('{}');
    });
  });
  await listen(server, port);
  return handle(server, stats);
}

// Short silent wav.
function wav(ms) {
  const n = Math.floor(24000 * ms / 1000), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); return b;
}

/** Fake VOICEVOX ENGINE: /version, /audio_query, /synthesis. */
async function startFakeVoicevox(port = VOICEVOX_PORT) {
  const stats = { synthesis: 0, requests: 0 };
  const server = http.createServer((req, res) => {
    stats.requests++;
    if (req.url.startsWith('/version')) return res.end('"0.0.0"');
    if (req.url.startsWith('/audio_query')) return res.end(JSON.stringify({ accent_phrases: [{ moras: [{ text: 'ア', vowel: 'a', vowel_length: 0.3, pitch: 5 }, { text: 'イ', vowel: 'i', vowel_length: 0.3, pitch: 5 }] }], speedScale: 1, prePhonemeLength: 0.1, postPhonemeLength: 0.1 }));
    if (req.url.startsWith('/synthesis')) { stats.synthesis++; res.setHeader('Content-Type', 'audio/wav'); return res.end(wav(800)); }
    res.end('{}');
  });
  await listen(server, port);
  return handle(server, stats);
}

module.exports = { startFakeOllama, startFakeVoicevox, OLLAMA_PORT, VOICEVOX_PORT };

if (require.main === module) {
  Promise.all([startFakeOllama(), startFakeVoicevox()]).then(
    () => console.log(`fake Ollama :${OLLAMA_PORT} and VOICEVOX :${VOICEVOX_PORT} running`),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
