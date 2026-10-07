# Historical archive — 実装要件ではない

この文書は旧 Friend System v1 の原文記録です。廃止済み機能を実装・復活させる根拠にしないでください。
現行要件は [../design.md](../design.md) を参照してください。

# NAVI Friend System — 完成版設計書

> 原設計の記録です。現在は Personal Agent v3.2 を優先します。Tarkov プラグインとその移植計画はユーザー指示により廃止しました。以下に残る記述は現在の実装要件ではありません。

Version: 1.0 / 2026-10-07  
Target: Windows 10/11, Electron + React + TypeScript, Local-first AI  
Primary GPU assumption: NVIDIA RTX 4070 SUPER 12GB

---

# 0. 結論

このシステムの主役は **Escape from Tarkov攻略アプリではない**。

完成版の主役は、

> **PCの画面をナビに共有し、雑談しながらゲーム・作業・ブラウジング等を一緒に過ごせる、ローカルAIの友達アプリ**

である。

Escape from Tarkov は最初の「ゲームプラグイン」として扱う。  
今後ゲームが増えてもコア部分は変更せず、`GamePlugin` を追加するだけで対応できる構造とする。

ナビは単なるチャットボットではない。

- ユーザーのマイク音声を聞く
- 選択した画面 / ウィンドウを見る
- 今何が起きているかを継続的に把握する
- ユーザーが話しかければ短く返す
- 必要なら自分から話題を出す
- 面白い失敗、金の話、ゲームイベントには食いつく
- 興味の薄い話は本当に薄く返す
- 沈黙を埋めるためだけには喋らない
- 音声・表情・目線・口・体の動きを会話内容に合わせる
- Tarkovでは既存のタスク / アイテム / MAP / tarkov.dev 情報を裏で利用する
- 他ゲームではまずVisionだけで対応し、専用プラグインを後から追加できる
- ゲーム以外でも「これどう思う？」に共有画面を見て答えられる

---

# 1. 製品コンセプト

## 1.1 製品名

内部コードネーム:

`NAVI Friend System`

UI上の名称候補:

`NAVI`

「Tarkov」「Assistant」は製品名に含めない。

理由:
Tarkov専用名にすると、ゲーム追加・デスクトップ雑談・動画視聴・買い物相談などへ拡張しづらい。

## 1.2 体験の基準

完成時に達成すべき体験は次の通り。

### 例A: 普通の雑談

ユーザー:
「今日仕事だるかった」

ナビ:
「お疲れさまです。まあ私も今日は何もしたくないですけど」

画面解析はこの返答に不要なら呼ばない。

### 例B: 共有画面を参照

ユーザー:
「これどう思う？」

システム:
1. 直前の発話を取得
2. 最新フレームを高優先で取得
3. 現在アクティブな画面をVision解析
4. 「これ」の対象を画面から推定
5. ナビ人格で返答

ナビ:
「右のやつですか。私はそっちですね。左は高いわりに微妙です」

### 例C: Tarkov

ユーザー:
「これいる？」

システム:
1. Visionでアイテム候補を認識
2. TarkovPluginへ候補を渡す
3. ローカルItem DB / task DB / hideout用途を検索
4. 現在のプロフィール・タスク進行を参照
5. ナビ用の短文へ変換

ナビ:
「それ後で使います。売らない方がいいです」

### 例D: 自発発言

ゲーム中に大きな失敗を検知。

ナビ:
「……今のはだいぶ嫌ですね」

その後に質問を付けない。

### 例E: 無言

移動しているだけ。
イベントなし。
ユーザーも喋っていない。

ナビ:
**何も言わない。**

これも正しい挙動。

---

# 2. 設計変更点

以前の設計から次を変更する。

## 2.1 Tarkov中心 → 汎用Friend Core中心

旧:
`Tarkov Assistant -> AI追加`

新:
`NAVI Friend Core -> Game / Screen Plugin`

```
NAVI
├─ Friend Core
│  ├─ Conversation
│  ├─ Vision
│  ├─ Voice
│  ├─ Memory
│  ├─ Initiative
│  └─ Avatar
│
├─ Generic Screen Context
│
└─ Plugins
   ├─ EscapeFromTarkov
   ├─ Minecraft
   ├─ Palworld
   └─ ...
```

## 2.2 PuppetJSのWebカメラ追跡を主役にしない

PuppetJSに既にあるMediaPipe顔追跡は残してもよいが、NAVI本体では既定OFF。

ナビの動きは:

```
LLM response
 ↓
PerformanceCue
 ↓
AvatarDirector
 ↓
PuppetJS parameters
 ↓
60fps procedural animation
```

口は:

```
VOICEVOX AudioQuery / generated audio
 ↓
mora / vowel / amplitude timeline
 ↓
LipSync
 ↓
ParamMouthOpenY / ParamMouthForm
```

とする。

ローカルAIを毎フレーム呼ばない。
LLMは数秒単位の高レベル演技だけ決める。

---

# 3. 推奨ローカルAI構成

RTX 4070 SUPER 12GBで、ゲームのGPUリソースも残す必要があるため、
「一番大きいモデルを常駐」が正解ではない。

## 3.1 会話モデル

第一候補:
`dolphin3:8b` (Ollama)

用途:
- ナビ本人
- 雑談
- 自発話題
- personality
- structured output
- performance cue生成

理由:
- 8Bクラスで低遅延
- system promptで強く操縦しやすい
- 長い会話でも比較的扱いやすい
- アプリ側で独自の話題禁止フィルタを追加しない構成に向く

注意:
「完全に何でも必ず答える」ことを保証するものではない。
モデル重み自体の挙動は残る。
本アプリ設計では **独自の一般会話用ブラックリスト / 話題フィルタは挟まない**。

代替:
`qwen3:8b`
- 日本語と構造化出力を優先したい場合
- Dolphinの日本語品質が不足する場合の切替先

ModelRouterで実行時切替可能にする。

## 3.2 Visionモデル

第一候補:
`qwen3-vl:4b`

用途:
- 共有画面の意味理解
- UI / ゲーム画面認識
- 「これ」の指示対象特定
- 画面内文字の補助読解
- scene summary
- generic screen understanding

重要:
常時1fpsでLLM Visionを回さない。

軽量変化検出:
`FrameDiff + OCR + region hash`

重要イベント時だけVisionを呼ぶ。

高精度モード:
`qwen3-vl:8b`

ゲームを止めて相談する場合や、
4Bで認識信頼度が低い場合のみ8Bへエスカレーションできる。

## 3.3 STT

`faster-whisper`

推奨:
`large-v3-turbo` または `distil-large-v3.5`

通常:
GPU `int8_float16`

VRAMが厳しい場合:
CPU `int8`

VAD:
Silero VAD あるいは WebRTC VAD

ユーザーが喋っていない時間はSTTへ音声を送らない。

## 3.4 TTS

既存の `VOICEVOX ENGINE` を第一候補とする。

通信:
`http://127.0.0.1:50021`

GPUはゲームとLLMへ譲るため、
初期値はCPUモード。

VoiceAdapterを抽象化し、
今後別のローカルTTSに交換できる。

## 3.5 画像生成

ナビとの通常会話には使用しない。
既存ComfyUIは必要時のみ別ジョブとして起動する。

---

# 4. VRAM設計

12GB VRAMですべてを常駐させるとゲームと競合する。

目標:
NAVIがゲームFPSを大きく落とさない。

推奨常駐:

- Chat LLM: Dolphin3 8B Q4 約5GB級
- Vision: 通常は未ロード、必要時4B
- STT: GPUまたはCPUを負荷状況で切替
- TTS: CPU
- PuppetJS: WebGLだが軽量

`ResourceGovernor`を用意する。

状態例:

### GAME_PRIORITY

- Chat: 8B keep alive
- Vision: 4B on-demand, keepAlive=30s
- STT: CPU INT8 または軽量GPU
- TTS: CPU
- screen sampling: 2fps
- Vision max: 0.2 req/sec

### BALANCED

- Chat: 8B
- Vision: 4B keepAlive=120s
- STT: GPU
- TTS: CPU
- screen sampling: 4fps

### DESKTOP_CHAT

- Chat: 8B
- Vision: 8B利用可
- STT: GPU
- Vision max: 1 req/sec

---

# 5. 全体アーキテクチャ

```
┌────────────────────────────────────────────────────┐
│                  Electron Application              │
│                                                    │
│  ┌─────────────────────┐   ┌────────────────────┐ │
│  │ Main UI / React     │   │ Avatar Window      │ │
│  │                     │   │ PuppetJS renderer  │ │
│  │ Screen selector     │   │ transparent HUD    │ │
│  │ Chat transcript     │   └─────────▲──────────┘ │
│  │ Settings            │             │ IPC         │
│  └──────────▲──────────┘             │             │
│             │                         │             │
│  ┌──────────┴─────────────────────────┴──────────┐ │
│  │             Friend Orchestrator               │ │
│  │                                               │ │
│  │ Conversation │ Initiative │ Memory │ Plugins  │ │
│  └─────▲────────────▲──────────▲────────▲────────┘ │
│        │            │          │        │          │
│  ┌─────┴────┐ ┌─────┴────┐ ┌──┴────┐ ┌─┴───────┐ │
│  │ Vision   │ │ Voice    │ │ Ollama│ │ Plugins │ │
│  │ Pipeline │ │ Pipeline │ │ Router│ │         │ │
│  └────▲─────┘ └────▲─────┘ └───────┘ └─────────┘ │
│       │            │                               │
│  screen stream   microphone                        │
└───────┼────────────┼───────────────────────────────┘
        │            │
        ▼            ▼
   selected app   user voice
```

---

# 6. コアサービス

## 6.1 FriendOrchestrator

唯一の会話意思決定の入口。

入力:
- user utterance
- screen observation
- plugin context
- memory
- recent events
- silence state

出力:
`CompanionResponse`

重要:
VisionやTarkovPluginが直接ユーザーへ発言してはいけない。
最終的な言い方は必ずFriendOrchestratorを通す。

## 6.2 ScreenObserver

責務:
- 選択された画面だけ取得
- 最新フレームを保持
- ring buffer 15〜20秒
- frame diff
- OCR
- 高優先スナップショット
- Vision request scheduling

保存:
デフォルトではディスクに保存しない。
RAMのみ。

## 6.3 ConversationManager

保持:
- 直近会話
- 現在話題
- topic fatigue
- ナビ温度
- lastSpeakAt
- interruption state

## 6.4 InitiativeScheduler

ナビから勝手に話す仕組み。

禁止:
一定時間ごとに機械的に喋ること。

候補生成トリガ:
- 画面上の面白い変化
- ゲームイベント
- 長い沈黙
- 前回の話題に関連する画面
- 過去会話から自然に出せる話
- 金額・値札
- 共通ゲームの状況

抑制:
- 戦闘中
- ユーザーが喋っている
- 直近15〜60秒以内にナビが喋った
- 同じトピックが続いている
- 画面変化が大きく集中が必要
- ユーザーが「静かめ」に設定

## 6.5 MemoryStore

SQLiteを使用。

テーブル:
- `sessions`
- `utterances`
- `memories`
- `topics`
- `screen_events`
- `plugin_state`
- `preferences`

メモリ階層:

### Working Memory
数十秒〜数分。

### Session Memory
今日のプレイ単位。

### Long-term Memory
何度も再利用価値のあるものだけ。

例:
- 好きなゲーム
- いつも売って後悔するアイテム
- Tarkovで進めているタスク
- 話したくない話題ではなく、会話の好み
- 過去のゲーム内ネタ

すべての発言を永続保存しない設定も用意する。

---

# 7. 画面共有

## 7.1 画面選択

ユーザーが:
- ディスプレイ
- 特定ウィンドウ

から明示選択。

Electron `desktopCapturer` と `getDisplayMedia` を利用。

Tarkovの場合もゲームプロセスへ注入しない。

## 7.2 フレームパイプライン

```
MediaStream
 ↓
Video element
 ↓
requestVideoFrameCallback
 ↓
Canvas / OffscreenCanvas
 ↓
downscale 1280x720 max
 ↓
FrameDiff
 ├─ low change → metadata only
 └─ high change
      ↓
      OCR / Vision candidate
```

## 7.3 RingBuffer

20秒を上限。

保存内容:
- timestamp
- JPEG/WebP compressed frame in RAM
- perceptual hash
- OCR summary
- scene score

「今の何？」では過去2〜6秒から代表フレームを抽出。

## 7.4 Visionを呼ぶ条件

次のいずれか:

1. ユーザーが画面参照語を使う
   - これ
   - こっち
   - 今の
   - この画面
   - 右
   - 左
   - これどう思う

2. plugin detector confidence > threshold

3. InitiativeSchedulerが画面について話す候補を必要とする

4. OCRだけで判定不能

5. high-interest scene

---

# 8. 会話処理

## 8.1 入力

ユーザー発話:
`UserUtterance`

画面:
`ScreenObservation`

ゲーム:
`PluginContext`

## 8.2 LLM出力

LLMから自由文だけ返させない。

JSON structured output:

```json
{
  "speak": true,
  "text": "それ後で使います。売らない方がいいです",
  "temperature": "normal",
  "emotion": "concerned",
  "intensity": 0.45,
  "gaze": "screen",
  "gesture": "small_nod",
  "memory_write": [],
  "topic_action": "continue",
  "needs_vision": false,
  "needs_tool": null
}
```

レンダラーへ送るのは必要部分だけ。

## 8.3 話量

キャラクター仕様をハード制約として後処理する。

- 原則 1〜2文
- 最大3文
- 180文字を超えたら再生成
- 普通の返事では質問を強制しない
- 接客型定型句を禁止
- 「他に何か」は削除
- ユーザー長文でも全点に返さない

## 8.4 温度

`thin | normal | dense`

LLMに任せきらず、
topic interest scoreも入力する。

同一トピック連続回数でfatigueを加算。

---

# 9. ナビ人格

キャラ:
- 名前: ナビ
- 20代半ば女性
- ゲーム仲間
- 一人称「私」
- ユーザーは名前呼び捨て
- 丁寧語ベース
- 弱気気味
- 丁寧なまま容赦ない
- 極度の貧乏性
- 割引シールが好き
- 安い酒
- バナナ
- 赤フレーム眼鏡
- 眼鏡だけは金をかける

モデルへ特定作品の固有台詞は渡さない。
「特定キャラクターになりきれ」ではなく、
性格要素を独立指定する。

## 9.1 ナビ会話ルール

重要順:
1. 人間の友達として自然か
2. 短いか
3. 今本当に喋る必要があるか
4. 画面情報と矛盾しないか
5. キャラクターが崩れていないか

---

# 10. 自発会話

## 10.1 Initiation Score

```
score =
  eventImportance * 0.30
+ novelty         * 0.20
+ userInterest    * 0.15
+ screenRelevance * 0.15
+ callbackValue   * 0.10
+ randomness      * 0.10
- focusPenalty
- recentSpeechPenalty
- fatiguePenalty
```

閾値未満なら黙る。

## 10.2 無関係な雑談の開始

沈黙中でも毎回画面の話をする必要はない。

候補:
- 前の会話の続き
- ナビ自身のどうでもいい話
- 今日安かったものの話
- ゲームの変な出来事
- 画面上で見えたもの

ただし頻度は低め。

デフォルト:
90秒未満の沈黙では「沈黙を理由に」話し始めない。

以降もランダムではなく状況スコアで決める。

---

# 11. 音声

## 11.1 VAD

音声ストリームを常時STTしない。

```
mic PCM
 ↓
VAD
 ↓ speech start
buffer
 ↓ speech end
faster-whisper
```

## 11.2 Barge-in

ナビ発話中にユーザーが話したら:

1. VAD検知
2. TTS音声を100〜180ms fade out
3. Avatarの口パク停止
4. ユーザー音声を優先
5. unfinished assistant turnを`interrupted=true`で記録

ナビ:
長い返答を再開しない。
新しい入力へ普通に返す。

## 11.3 TTSキャラクター

声の設計:
- 若い女性
- 少し高め
- 細め
- 声量小さめ
- 普段は抑揚控えめ
- 食いついた時だけ速くなる
- 照れは小さくなる
- ジト目時は平板になる

特定声優の声そのものを複製する前提にはしない。

---

# 12. VTuber / PuppetJS

現在のPuppetJSには:
- PSDパース
- レイヤー自動分類
- WebGL描画
- 顔角度
- 目
- 眉
- 口
- 頬
- 呼吸
- 髪物理
- 表情プリセット
- MediaPipe追跡

が既にある。

完成版ではこれを「NAVI Avatar Runtime」へ昇格する。

## 12.1 追加するパラメータ

```
ParamAngleX
ParamAngleY
ParamAngleZ
ParamEyeLOpen
ParamEyeROpen
ParamEyeLSmile
ParamEyeRSmile
ParamEyeBallX
ParamEyeBallY
ParamBrowLY
ParamBrowRY
ParamMouthOpenY
ParamMouthForm
ParamCheek
ParamBodyAngleX
ParamBodyAngleY
ParamBodyAngleZ
ParamBreath
ParamBaseX
ParamBaseY

追加:
ParamGlassesBounce
ParamGlassesTilt
ParamShoulderY
ParamShoulderX
ParamHeadBob
ParamIdleEnergy
ParamEmotionWeight
```

## 12.2 表情

既存6表情から拡張:

- neutral
- smile
- happy
- embarrassed
- worried
- unimpressed
- annoyed
- tired
- sad
- smug
- surprised
- focused
- confused
- relieved

## 12.3 動作

- still
- small_nod
- nod
- small_shake
- shake
- tilt_left
- tilt_right
- look_screen
- look_user
- look_away
- lean_forward
- recoil
- sigh
- tiny_shrug

## 12.4 AIの仕事

LLMは:

```json
{
  "emotion": "unimpressed",
  "intensity": 0.8,
  "gaze": "user",
  "gesture": "tilt_right"
}
```

まで。

60fps座標生成をLLMにさせない。

## 12.5 Motion Planner

`AvatarDirector`でBezier/Spring補間。

例:

```
tilt_right
0ms    AngleZ = 0
220ms  AngleZ = +7
900ms  AngleZ = +5
1500ms AngleZ = 0
```

髪・眼鏡は物理で遅れて追従。

## 12.6 Idle

会話していない間:

- 1.8〜6秒ランダムまばたき
- 呼吸
- 微小な首の揺れ
- 数秒ごとの小さい視線移動
- たまに眼鏡位置を気にする仕草は将来拡張

ただし派手に動き続けない。

---

# 13. PSD完成版仕様

PSDは「見た目だけ」ではなく、動作単位で分離する。

推奨レイヤー:

```
00_GUIDE
01_EFFECT
  blush_extra
  sweat
  shadow_emotion

10_ACCESSORY_FRONT
  glasses_frame_front
  glasses_highlight
  glasses_lens_L
  glasses_lens_R

20_HAIR_FRONT
  hair_front_center
  hair_front_L_01
  hair_front_L_02
  hair_front_R_01
  hair_front_R_02
  ahoge

30_FACE
  brow_L
  brow_R

  lash_L_up
  lid_L_up
  eye_L_white
  eye_L_iris
  eye_L_pupil
  eye_L_highlight
  lid_L_down
  lash_L_down

  lash_R_up
  lid_R_up
  eye_R_white
  eye_R_iris
  eye_R_pupil
  eye_R_highlight
  lid_R_down
  lash_R_down

  nose
  cheek_L
  cheek_R

  mouth_upper
  mouth_lower
  mouth_inner
  teeth_upper
  tongue

  face_shadow
  face_base

40_EAR
  ear_L
  ear_R

50_HAIR_SIDE
  hair_side_L_01
  hair_side_L_02
  hair_side_R_01
  hair_side_R_02

60_BODY
  neck
  neck_shadow
  collar
  body
  sleeve_L
  sleeve_R
  arm_L
  arm_R

70_HAIR_BACK
  hair_back_L_01
  hair_back_L_02
  hair_back_center
  hair_back_R_01
  hair_back_R_02

80_ACCESSORY_BACK
```

眼鏡を1枚絵に統合しない。
左右レンズ、フレーム、ハイライトを分離する。

---

# 14. UI

メイン画面:

```
┌────────────────────────────────────────────────────────┐
│ NAVI                     ● LOCAL   🎙 ON   👁 SHARING │
├───────────────┬────────────────────────────────────────┤
│               │                                        │
│ SHARE PREVIEW │  NAVI                                  │
│               │                                        │
│               │  「それ高くないですか」                │
│               │                                        │
│               │  YOU                                   │
│               │  「まあ3万くらい」                     │
│               │                                        │
│               │  NAVI                                  │
│               │  「不愉快です」                        │
│               │                                        │
├───────────────┴────────────────────────────────────────┤
│ mode: Generic / Tarkov      Vision: idle      AI: ready│
├────────────────────────────────────────────────────────┤
│ 🎙 mute   👁 pause share   🔊 voice   👓 avatar   ■ end│
└────────────────────────────────────────────────────────┘
```

タブ:
- Friend
- Shared Screen
- Games
- Memory
- Avatar
- Settings

TarkovのTask/MAP/Itemは:
`Games > Escape from Tarkov`
の中へ移動。

---

# 15. ゲームプラグイン

共通IF:

```ts
export interface GamePlugin {
  id: string;
  displayName: string;

  matchWindow(window: SharedWindow): number;
  onSessionStart(ctx: PluginSessionContext): Promise<void>;
  onFrame(frame: FrameSummary): Promise<PluginEvent[]>;
  enrichVision(observation: ScreenObservation): Promise<PluginContext>;
  resolveTool(name: string, args: unknown): Promise<unknown>;
  getPromptContext(): Promise<string>;
  onSessionEnd(): Promise<void>;
}
```

GenericモードではGamePluginなしで動く。

## 15.1 TarkovPlugin

既存資産を流用:

- tarkov.dev catalog
- task progression
- item usage
- maps
- screenshot filename location
- profile
- game mode PvP/PvE
- trader loyalty
- OCR correction

UIは削除しない。
「ナビの裏の道具」に位置づける。

---

# 16. イベントバス

すべてを直接呼び合わない。

EventBus:

```
screen.frame
screen.changed
screen.observed

voice.speech_started
voice.transcript
voice.interrupted

plugin.event
plugin.context

friend.response
friend.speak
friend.silent

avatar.performance
avatar.lipsync

memory.write
session.started
session.ended
```

---

# 17. IPC

Electron IPC:

```
capture:listSources
capture:start
capture:stop
capture:getState

friend:submitText
friend:getState
friend:interrupt

voice:start
voice:stop
voice:setDevice

avatar:setVisible
avatar:setClickThrough
avatar:performance

plugin:list
plugin:activate
plugin:getState

settings:get
settings:set
```

preloadは最小APIだけ公開。
rendererからNode APIへ直接アクセスさせない。

---

# 18. localhostサービス

Python:
`navi-voice-service`

用途:
- VAD
- faster-whisper
- optional audio classification

HTTP/WS:
`127.0.0.1:17650`

外部NICへbindしない。

Ollama:
`127.0.0.1:11434`

VOICEVOX:
`127.0.0.1:50021`

---

# 19. エラー時

## Ollama停止

ナビ:
UIに小さく「AI offline」
ゲーム共有は継続。
勝手にエラー音声を再生しない。

自動再接続:
指数バックオフ 1,2,5,10,30秒。

## Vision停止

音声会話だけ継続。
「画面が見えている」と嘘をつかない。

## STT停止

テキスト入力は継続。

## TTS停止

字幕のみ継続。
Avatarは発話用口パクをしない。

## Avatar停止

会話は継続。

モジュール障害を他へ伝播させない。

---

# 20. セキュリティ / プライバシー

これは「会話規制」とは別問題。

初期状態:
- localhost only
- screen frameはRAMのみ
- API keyをrendererへ渡さない
- 共有対象を明示表示
- ワンクリックで共有停止
- パスワード画面等を自動保存しない
- ログへ画像base64を出さない

一般会話へ独自の話題ブラックリストを設ける設計にはしない。

---

# 21. Tarkov既存コードからの移行

現在の構成:
- `src/App.tsx`
- `electron/main.ts`
- `electron/screenshot.ts`
- task/item/map domain
- overlay
- F8 capture
- tarkov.dev API

残す:
- domainロジック
- API
- task progression
- map data
- screenshot watcher
- backup
- current user state migration

移動:
- Tarkov UI → `plugins/tarkov/ui`
- Tarkov data → `plugins/tarkov/data`
- Tarkov domain → `plugins/tarkov/domain`

置換:
- `App.tsx`が全機能を握る状態
→ `FriendShell + PluginHost`

現在の`desktopCapturer`は単発F8 capture用途として残してよいが、
継続共有は別の`ScreenStreamManager`を新設する。

---

# 22. PuppetJS既存コードからの移行

既存:
単一 `vtuber_prototype.html`

完成版:
```
avatar-runtime/
├─ renderer/
│  ├─ PsdLoader.ts
│  ├─ LayerClassifier.ts
│  ├─ RigBuilder.ts
│  ├─ WebGLRenderer.ts
│  └─ MeshWarp.ts
├─ motion/
│  ├─ ParameterStore.ts
│  ├─ IdleAnimator.ts
│  ├─ ExpressionMixer.ts
│  ├─ GesturePlanner.ts
│  ├─ HairPhysics.ts
│  ├─ GlassesPhysics.ts
│  └─ LipSync.ts
├─ bridge/
│  └─ AvatarBridge.ts
└─ ui/
   └─ RigEditor.tsx
```

単一HTMLは開発用リグエディタとして残せる。

本番AvatarWindowでは設定UIを読み込まない。

---

# 23. 完成条件

以下を満たして初めて「完成」。

1. 選択した任意ウィンドウを共有できる
2. 共有対象を変えられる
3. ユーザーの音声に2秒以内を目標に反応開始
4. 「これどう思う？」で画面を理解して返答
5. 画面を見て自発発言できる
6. 自発発言しすぎない
7. Tarkov専用情報を裏で使える
8. Tarkov以外でも会話可能
9. 新ゲームをプラグイン追加だけで対応できる
10. ナビの表情が会話と同期
11. 音声と口パクが同期
12. ユーザー割り込みでナビが止まる
13. Vision停止でも音声会話継続
14. LLM停止でもアプリが落ちない
15. ゲームプロセスへ注入しない
16. 共有画像をデフォルトでディスク保存しない
17. キャラ設定が100ターン以上で大崩れしない
18. 無意味な質問返しを連発しない
19. 戦闘中にナビが邪魔をしない
20. Avatarをクリック透過できる

---

# 24. 実装優先順位

## Milestone 1 — Generic Friend
- screen stream
- microphone/VAD/STT
- Ollama chat
- VOICEVOX
- text chat
- interruption
- basic memory

## Milestone 2 — Vision Friend
- ring buffer
- frame diff
- Vision router
- “これ”解決
- proactive screen comments

## Milestone 3 — Navi Avatar
- PuppetJS分割
- AvatarBridge
- expression
- gesture
- lip sync
- transparent overlay

## Milestone 4 — Tarkov Plugin
- 既存資産移植
- item/task/tool
- raid event context
- screenshot location
- Tarkov-specific initiative

## Milestone 5 — Long-term Friend
- durable memory
- topic fatigue
- callbacks
- personality regression tests

## Milestone 6 — Plugin SDK
- manifest
- plugin sandbox
- example generic game plugin
- docs

---

# 25. 実装で絶対に避けるもの

- Visionモデルへ毎フレーム画像を投げる
- LLMに60fpsアニメーション座標を生成させる
- 全モジュールを`App.tsx`へ置く
- Tarkov固有ロジックをFriend Coreへ書く
- ナビの返答を毎回質問で終える
- 沈黙タイマーだけで定期発言
- 共有画面を無断で永続保存
- LLMが見ていない画面を「見た」と言う
- Avatar障害で会話全体を止める
- 12GB VRAMへ複数8Bモデルを無条件常駐

---

# 現在の2プロジェクトとの照合結果

## Tarkov Assistant

確認できた既存要素:
- Electron
- React/TypeScript
- `desktopCapturer`
- `BrowserWindow` overlay
- `setIgnoreMouseEvents`
- Tarkov task/item/map data
- screenshot filename watcher
- OCR
- state backup

### そのまま再利用
- task progression
- tarkov.dev API
- user profile
- map registry
- screenshot watcher
- backup / migration

### 分離する
- Tarkovの画面をアプリ本体ナビゲーションの中心に置かない
- `App.tsx`からTarkovドメインをPluginへ移す
- HUDはNAVI avatar HUDと攻略HUDを別Windowにする

### 新規追加
- continuous display media stream
- FriendOrchestrator
- ModelRouter
- Voice pipeline
- Memory
- Initiative
- AvatarBridge
- PluginHost

## PuppetJS

確認できた既存要素:
- PSDレイヤー自動判定
- face/eye/brow/mouth/hair/neck/body分類
- WebGL描画
- mesh変形
- hair physics
- idle blink/breath/gaze
- expression preset
- MediaPipe face landmarker

### そのまま再利用
- PSD parser
- classifier
- mesh renderer
- parameter model
- hair physics
- expression blend
- idle animation

### 変更
- 単一HTMLからモジュールへ分離
- 本番ではWebcam trackingを既定OFF
- LLM performance cueからparameter targetを作る
- glasses roleを正式追加
- AudioQuery / generated audio由来のlip sync追加
- Electron AvatarWindowへ組み込む

### 開発用に残す
`vtuber_prototype.html`はPSDリグ確認ツールとして残す。
本番レンダラーとしては使用しない。

---

# 実装指示順

## PR-01 Friend Shell
- App.tsxをFriendShell化
- Tarkov navをGames配下へ
- PluginHost導入
- GenericScreenPlugin導入

## PR-02 Continuous Screen Share
- `ScreenCaptureMain`
- `ScreenStreamManager`
- source selector
- share pause
- share state indicator
- ring buffer
- frame diff

## PR-03 Voice
- Python voice service
- VAD
- faster-whisper
- text submit
- barge-in state machine
- VOICEVOX client

## PR-04 AI
- OllamaClient
- ModelRouter
- ConversationOrchestrator
- response schema
- style enforcement
- health checks

## PR-05 Vision
- frame candidate selection
- qwen3-vl
- query-reference detection
- latest/high-priority snapshot
- “今の” ring buffer retrieval

## PR-06 Initiative
- event bus
- InitiativeScheduler
- topic fatigue
- combat suppression
- own-topic generation

## PR-07 Avatar Runtime
- PuppetJSをmodule分割
- AvatarWindow
- AvatarDirector
- expressions
- gestures
- LipSync
- glasses physics
- click-through

## PR-08 Tarkov Plugin
- Tarkov domain移動
- knowledge adapter
- item tool
- task tool
- map context
- screenshot watcher
- raid event detector

## PR-09 Memory
- SQLite
- working/session/long-term
- memory writer
- session summarizer
- user-visible memory settings

## PR-10 Hardening
- process watchdog
- reconnect
- resource governor
- diagnostic screen
- telemetry local only
- acceptance tests

---

# 受入テスト

## A. Generic screen
1. Chromeを共有
2. 商品ページを表示
3. 「これどう思う？」
4. 2秒台を目標に、画面対象へ言及する
5. 画面を切り替えた後、前画面を現在画面として扱わない

## B. Silence
1. ゲームを3分無言でプレイ
2. ナビが機械的に30秒ごと等で発言しない
3. 重要イベントがあれば短く発言可

## C. Barge-in
1. ナビが喋る
2. 発話途中にユーザーが話す
3. 180ms程度を目標にナビ音声がフェード停止
4. 新しい発話へ応答

## D. Character
100ターンの自動会話評価:
- 平均文数 <= 2.2
- 3文超過 0
- 「他に何か」0
- 不必要な質問率 <= 35%
- 「不愉快です」の乱用なし
- money topicで反応増加
- boring topicで反応温度低下

## E. Avatar
- TTS音声と口の開閉が視覚的に同期
- embarrassedで頬・目線変化
- unimpressedで半目
- gesture終了後neutralへ滑らかに戻る
- 眼鏡が頭の動きに追従
- クリック透過中にゲーム入力を奪わない

## F. Tarkov
- 「これいる？」でitem toolを呼べる
- 現在タスクに必要なら保持推奨
- 戦闘中は不要な発言を抑える
- ゲームプロセスへのDLL/メモリアクセスなし

## G. Failure
- Ollama終了 → Appクラッシュしない
- VOICEVOX終了 → 字幕会話継続
- STT終了 → テキスト入力継続
- AvatarWindow終了 → 会話継続
- Vision終了 → 見えていると嘘をつかない
