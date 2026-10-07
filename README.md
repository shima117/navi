# NAVI Friend System

画面を共有しながら雑談できる、ローカルAIの友達アプリ。
設計書: [`docs/design.md`](docs/design.md)

Electron + React + TypeScript / Ollama / VOICEVOX / faster-whisper。すべて `127.0.0.1` で動作します。

## セットアップ (Windows 10/11)

```powershell
# 1. Ollama モデル
ollama pull dolphin3:8b
ollama pull qwen3-vl:4b
ollama pull qwen3:8b       # 任意: 日本語重視の代替会話モデル
ollama pull qwen3-vl:8b    # 任意: DESKTOP_CHAT 時の高精度 Vision

# 2. VOICEVOX ENGINE を起動 (http://127.0.0.1:50021, CPU モード推奨)

# 3. 音声サービス (VAD + faster-whisper)
cd voice-service
python -m venv .venv; .venv\Scripts\activate
pip install -r requirements.txt
python -m navi_voice.server          # ws://127.0.0.1:17650/ws
#   VRAM が厳しい場合: $env:NAVI_STT_DEVICE="cpu"

# 4. アプリ
npm install
npm start                            # build して起動
# 開発: 別ターミナルで `npm run dev` → `npm run electron:dev`
```

どのサービスが落ちていてもアプリは起動します (AI offline → 表示のみ / TTS 停止 → 字幕のみ / STT 停止 → テキスト入力 / Vision 停止 → 「見えない」と正直に言う)。

「診断」タブ: サービス状態, 応答速度 (発話 → ナビ発話開始の p50/p95, 目標 2 秒), 直近のエラー, リソースモードと VRAM, 自発発言の発言/見送り回数を表示し、「診断情報を書き出す」で JSON に保存できます (文字起こし・画像は含みません)。
音声サービス / VOICEVOX ENGINE / `ollama serve` はここで有効にしたものだけ NAVI が起動・監視します (落ちたら 1, 2, 5, 10, 30 秒で再起動、続けば停止して報告。既に起動済みならそのまま使います)。
指標はすべてローカルのみで、`指標をファイルにも記録する` をオンにした時だけ `userData/logs/telemetry.jsonl` (ローテーション) に数値だけを書きます。

## 構成

```
electron/            main プロセス (ウィンドウ, IPC §17, サービス配線) と最小 preload
src/core/            Friend Core — ゲーム固有ロジックを置かない
  events/            EventBus (§16) — ハンドラ障害を隔離
  orchestrator/      FriendOrchestrator — 発言の唯一の決定点 (§6.1)
  conversation/      人格プロンプト, JSON 応答パーサ, 話量の強制 (§8.3), 会話状態/トピック疲労
  initiative/        自発発言スコアリング (§10.1) — 定期発言しない
  supervisor/        ProcessWatchdog — ユーザーが設定した補助プロセスの起動 / バックオフ再起動 / 停止 (PR-10)
  telemetry/         ローカル専用の指標 (応答遅延 p50/p95, 自発発言, エラー), JSONL ログ, 診断レポート — 外部送信なし
  screen/            dHash フレーム差分, 20 秒リングバッファ, 「これ/今の」検出, VisionService
  ai/                OllamaClient, ModelRouter, HealthMonitor (再接続 1,2,5,10,30 秒)
  voice/             VOICEVOX クライアント, AudioQuery → 口パク, barge-in 状態機械
  resource/          ResourceGovernor (GAME_PRIORITY / BALANCED / DESKTOP_CHAT)
  memory/            MemoryStore (SQLite + インメモリ退避), MemoryWriter, SessionSummarizer, 秘密情報の伏せ字化
  plugins/           GamePlugin IF (§15), PluginHost — プラグイン障害は Generic に退避
src/avatar/          AvatarDirector — cue → 60fps パラメータ (表情/ジェスチャ/まばたき/呼吸/口パク/眼鏡追従)
src/plugins/tarkov/  TarkovPlugin (骨組み; 既存資産の移植は PR-08)
src/renderer/        FriendShell UI, 画面ストリーム, マイク → 音声サービス, 音声再生, アバター窓
voice-service/       Python: WebRTC VAD + faster-whisper (localhost のみ bind)
```

データフロー:

```
画面 ─ getDisplayMedia ─▶ ScreenStreamManager (renderer, RAM のみ)
                            │ FrameSummary (ハッシュ/変化量のみ)
                            ▼
マイク ─▶ voice-service ─▶ main: EventBus ─▶ FriendOrchestrator ─▶ Ollama (JSON)
                            ▲                     │  必要時のみ Vision に 1 フレーム要求
                            │                     ▼
                       PluginHost          friend.speak ─▶ VOICEVOX ─▶ 再生 + 口パク ─▶ AvatarWindow
```

## テスト

```
npm test                                                   # TS (vitest)
cd voice-service && python -m unittest discover -s tests -t .   # Python
npm run typecheck
npm run test:e2e         # build → Electron e2e (Playwright, 偽 Ollama/VOICEVOX; ディスプレイが無い Linux では xvfb-run)
npm run eval:character   # 実 Ollama で 100 ターンのキャラ回帰評価 (受入テスト D)。Ollama 不在ならスキップ (exit 0)
```

e2e は 11434 / 50021 番ポートに偽サービスを立てるので、本物の Ollama / VOICEVOX は止めてから実行してください。
`eval:character` は `--model <name>` / `--turns <n>` / `--verbose` / `--json <file>` を受け付けます。

## 実装状況 (設計書 §24 / 実装指示順)

| PR | 内容 | 状態 |
|---|---|---|
| PR-01 | FriendShell, PluginHost, Generic モード | ✅ |
| PR-02 | 継続画面共有, ソース選択, 一時停止, リングバッファ, フレーム差分 | ✅ (OCR は未実装) |
| PR-03 | 音声サービス, VAD, faster-whisper, barge-in, VOICEVOX | ✅ |
| PR-04 | OllamaClient, ModelRouter, Orchestrator, 応答スキーマ, 話量強制, ヘルスチェック | ✅ |
| PR-05 | Vision (qwen3-vl), 参照語検出, 「今の」バッファ取得, 8B エスカレーション | ✅ |
| PR-06 | EventBus, InitiativeScheduler, トピック疲労, 集中時抑制 | ✅ |
| PR-07 | Avatar Runtime | 🟡 AvatarDirector と透過/クリック透過窓まで。PuppetJS (PSD/WebGL) の移植は未着手 — 現在は仮の描画 |
| PR-08 | Tarkov Plugin | 🟡 IF とツール定義のみ。既存 Tarkov Assistant のドメイン/データ移植は未着手 |
| PR-09 | Memory (SQLite) | ✅ `userData/navi.sqlite` (node:sqlite, FTS5 bigram 検索), セッション/長期の昇格, MemoryWriter, セッション要約, Memory タブ (検索・編集・削除・全消去)。発言ログは既定で保存しない (設定でオン, 保存期間つき)。開けない場合はインメモリに退避 |
| PR-10 | Hardening | ✅ プロセス監視, 再接続, リソースモード自動切替 (+VRAM 表示), 診断タブ, ローカル専用テレメトリ, 受入テスト (B 沈黙 / C 割り込み / D キャラ評価 / G 障害 e2e) |

既存の Tarkov Assistant / PuppetJS のコードはこのリポジトリに含まれていないため、PR-07 / PR-08 はそれらを取り込んだ後に進めます。
