# NAVI Friend System

画面を共有しながら雑談できる、ローカルAIの友達アプリ。
設計書: [`docs/design.md`](docs/design.md)
追加再設計の進捗: [Personal Agent v3.2](docs/personal-agent-v3.2-status.md)

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

# 3.1 フルデュプレックス音声を使う場合
# Voicemeeter Potatoで PC/Game=B2、Discord等の通話相手=B3、NAVI出力=VAIO3 を用意。
# NAVIの Settings > 音声・Voicemeeter から現在設定を保存して適用する。
# NAVIはVAIO3 Gainを変更しないため、右端フェーダーをNAVI専用音量として使えます。
# 手動起動の場合、復元ジャーナルの保存先は既定で %USERPROFILE%\.navi です。
# NAVIから音声サービスを起動すると、同じデータはアプリのuserDataに保存されます。

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

デスクトップ文字表示: 「文字で見せて」で直前の返答を背景なしの別窓に表示。
質問に「文字で出して」を付けると読み上げなし、「読み上げて」も付けると音声も出します。
「進捗をテキストで出して」は最新のローカル状態から回答し、作業がなければそう伝えます。
「次」「前」「消して」「文字を大きくして」「文字を固定して」に対応します。
Settings の「デスクトップの文字表示」で見た目・位置・クリック透過を変更できます。
「NAVIの環境を確認して」で固定ローカルサービスを、「プロジェクトを確認して」で選択したフォルダの package.json を裏で読み取り確認します。
「作業」タブから状態・結果・個別停止・再開・全体中止を操作できます。「やめて」で裏作業を中止します。
プロジェクトはフォルダ選択後、読む対象・行わない操作を確認して「この作業だけ許可」を押すと開始します。
承認は対象と1作業に限定し15分で期限切れ、中止・再起動で失効します。作業タブで承認記録も見られます。
作業は別プロセスで実行し、履歴は `userData/tasks.sqlite` にローカル保存します（選択したパス・確認結果を含みます）。
アプリ再起動後の未完了作業は保留され、勝手には再実行しません。任意のコード修正・PC操作・インストール・Cloud 使用はまだ無効です。

現行仕様は [docs/design.md](docs/design.md)、旧設計は [docs/archive/design-v1-tarkov.md](docs/archive/design-v1-tarkov.md) です。
継続開発は `codex/v3-2-agent-foundation`（PR #3）と後継を基準にし、古いOverlayブランチで上書きしないでください。

```
electron/            main プロセス (ウィンドウ, IPC §17, サービス配線) と最小 preload
src/core/            Friend Core — ゲーム固有ロジックを置かない
  events/            EventBus (§16) — ハンドラ障害を隔離
  orchestrator/      FriendOrchestrator — 発言の唯一の決定点 (§6.1)
  conversation/      人格プロンプト, JSON 応答パーサ, 話量の強制 (§8.3), 会話状態/トピック疲労
  initiative/        自発発言スコアリング (§10.1) — 定期発言しない
  supervisor/        ProcessWatchdog — ユーザーが設定した補助プロセスの起動 / バックオフ再起動 / 停止 (PR-10)
  telemetry/         ローカル専用の指標 (応答遅延 p50/p95, 自発発言, エラー), JSONL ログ, 診断レポート — 外部送信なし
  screen/            dHash フレーム差分, 4x4 領域ハッシュ (変化した領域: 右下 等), 20 秒リングバッファ, 「これ/今の」検出, OCR 値札/セール解析, VisionService
  ai/                OllamaClient, ModelRouter, HealthMonitor (再接続 1,2,5,10,30 秒)
  voice/             FloorManager, 相槌/割り込み/継続/エコー判定, VOICEVOX, AudioQuery → 口パク
  resource/          ResourceGovernor (GAME_PRIORITY / BALANCED / DESKTOP_CHAT)
  memory/            MemoryStore (SQLite + インメモリ退避), MemoryWriter, SessionSummarizer, 秘密情報の伏せ字化
  tasks/             TaskRegistry / SQLite / Scheduler / 停止 / 失敗予算 / ResourceLock / CircuitBreaker / 固定読み取り能力
  plugins/           GamePlugin IF (§15), PluginHost — プラグイン障害は Generic に退避
src/avatar/          AvatarDirector — cue → 60fps パラメータ (表情/ジェスチャ/まばたき/呼吸/口パク/眼鏡追従)
src/renderer/        FriendShell UI, 画面ストリーム, マイク → 音声サービス, 音声再生, アバター窓
voice-service/       Python: USER/SYSTEM/REMOTE分離, WebRTC VAD + faster-whisper, Voicemeeter Remote (localhost のみ bind)
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
| PR-02 | 継続画面共有, ソース選択, 一時停止, リングバッファ, フレーム差分, 4x4 領域ハッシュ, OCR | ✅ OCR は tesseract.js (jpn+eng, 同梱データ・CDN 不使用) をレンダラの Web Worker で、変化の大きいフレームだけ実行 (GAME_PRIORITY では既定 OFF)。main へは 300 文字以内の要約のみ。文字はログ/ディスクに出さない |
| PR-03 | 音声サービス, VAD, faster-whisper, barge-in, VOICEVOX | ✅ |
| PR-04 | OllamaClient, ModelRouter, Orchestrator, 応答スキーマ, 話量強制, ヘルスチェック | ✅ |
| PR-05 | Vision (qwen3-vl), 参照語検出, 「今の」バッファ取得, 8B エスカレーション | ✅ |
| PR-06 | EventBus, InitiativeScheduler, トピック疲労, 集中時抑制 | ✅ |
| PR-07 | Avatar Runtime | 🟡 AvatarDirector と透過/クリック透過窓まで。PuppetJS (PSD/WebGL) の移植は未着手 — 現在は仮の描画 |
| PR-08 | Tarkov Plugin | 対象外。ユーザー指示によりプラグインと参照コードを削除 |
| PR-09 | Memory (SQLite) | ✅ `userData/navi.sqlite` (node:sqlite, FTS5 bigram 検索), セッション/長期の昇格, MemoryWriter, セッション要約, Memory タブ (検索・編集・削除・全消去)。発言ログは既定で保存しない (設定でオン, 保存期間つき)。開けない場合はインメモリに退避 |
| PR-10 | Hardening | ✅ プロセス監視, 再接続, リソースモード自動切替 (+VRAM 表示), 診断タブ, ローカル専用テレメトリ, 受入テスト (B 沈黙 / C 割り込み / D キャラ評価 / G 障害 e2e) |
| PR-11 | Full-Duplex Audio / Voicemeeter | 🟡 B2/B3/VAIO3分離, 差分復元, FloorManager, 双方向相槌/割り込み, SpeechChunk, EchoGuard, 音声設定UIまで実装。実マイク + Voicemeeter Potato + VAIO3での30分運用試験と、任意のVoicemod後段統合は未完了 |
| v3.2 第1区切り | 独立文字窓 / TaskSnapshotPublisher | 🟡 文字表示・音声抑制・設定・Windows E2Eまで。Task DB / AgentService / worker / Protected Coreは次の区切り |
| v3.2 第2区切り | AgentService / Task DB / 安全な確認作業 | 🟡 別プロセスの実確認・保存・停止・再開・失敗制御まで。任意の書き換え / Cloud承認 / Job Object / Protected Coreは未実装 |
| v3.2 第3区切り | 現行設計整理 / PolicyEngine / 読み取り承認 | 🟡 読み取りTask境界の権限判定・対象限定承認・SQLite監査まで。Cloud用承認/予算、OS隔離、Protected Coreは未実装 |

PR-11のSYSTEM音声は、直前6秒のRAMバッファから「突発音の候補」を拾えます。音の種類（銃声など）はまだ判定しません。Voicemodの設定欄は接続実装まで無効です。

PuppetJS の参照コードは `references/puppetjs/` にあります。Avatar の参照ロジック移植と実描画検証は未完了です。Tarkov は対象から除外しました。
