# NAVI Personal Agent — 現行設計 v3.2

更新日: 2026-10-07。対象: Windows / Electron / React / TypeScript、Local-first。
これは現行の仕様と実装範囲の整理であり、全機能の完成報告ではありません。

## 1. 基準と履歴

ユーザー提供の Personal Agent 統合再設計指示書 v3.2 と、その後の明示指示を採用します。
Tarkov 専用プラグイン・参照コード・移植計画は廃止。復活・再移植は行いません。
旧設計は [archive/design-v1-tarkov.md](archive/design-v1-tarkov.md) に隔離した記録であり、実装要件ではありません。

継続開発の基準は `codex/v3-2-agent-foundation`（PR #3）とその後継です。
古い `codex/v3-2-desktop-text-overlay` を正として開発を戻さないでください。
後継の変更は前進方向に統合し、旧ブランチの内容で現行状態を上書きしません。

## 2. 目的と優先順位

NAVIはユーザーの会話・画面共有・作業に付き添う常駐AIです。
会話、音声割込み、Avatar、文字表示を裏作業の待ち時間や障害から守ります。
依頼には短く応答し、重い処理は別プロセスで実行します。
成功・進捗・ETAを推測で作らず、実処理と検証の結果から報告します。

## 3. プロセスと責務

| 領域 | 現在の責務 | 未完成の範囲 |
| --- | --- | --- |
| Realtime | FriendOrchestrator、会話・音声、キャッシュ済みTaskSnapshot参照 | 負荷下の遅延保証、GPU優先制御 |
| Avatar renderer | 独立透明Window、AvatarDirector、口パク・まばたき・仮描画 | PuppetJS参照移植、PSD/WebGL本番描画 |
| Text renderer | 独立透明Window、背景なしの文字、ページ・位置・外観設定 | OBS等の除外実効性、複数モニター実機受入 |
| Agent Utility Process | TaskEngine、SQLite、2つの固定読み取り能力、承認付きOpenAI文章相談 | Coding/Research/Browser/Media/PC操作 |
| Control & Safety | ネイティブ権限判定、Task単位承認、OpenAI利用概算管理、停止、失敗予算、ロック、回路遮断 | 汎用Cloud分類、Job Object、OS隔離、PrivilegedBroker、独立Supervisor/rollback |
| Data | Task DB、承認記録、Memory、ローカル監査 | Tool Registry、Research Cache、Artifact Manifest |

プロセス分離はOS権限サンドボックスではありません。任意の子プロセスはまだ起動しません。

## 4. 実行できる裏作業

`LOCAL_HEALTH`: 固定された localhost の Ollama、VOICEVOX、音声認識サービスへのHTTP確認。
リダイレクト禁止。接続成功は推論やマイクの正常動作を保証しません。

`PROJECT_INSPECT`: ネイティブのフォルダ選択と確認を経た対象の `package.json` だけを読む。
ファイル形式の確認のみ。scripts・依存コードは実行せず、再帰スキャン・書き換えをしません。
内容をモデルやCloudへ送りません。承認は対象・タスク・操作・期限に固定します。

`OPENAI_TEXT`: 作業タブに明示入力した短い文章を、ネイティブ確認を経てOpenAI Responses APIへ1回だけ送る。
Provider・モデル/Tier・本文ハッシュ・分類・料金上限・Task ID・期限に承認を固定。
PUBLIC/PRIVATEだけを許可し、機密・秘密・既知のキーらしい文字列を拒否する。
雑談・記憶・画面・音声・ファイルの自動送信、Web検索・ツール実行は行わない。
キーは起動環境のOPENAI_API_KEYをmain/Agentだけで使用し、公開IPC・ログ・SQLiteに渡さない。ローカル補助サービスにも継承しない。
API回答の受信と、回答内容の事実確認は区別する。詳細は [openai-api.md](openai-api.md)。

任意Shell、install、未承認Cloud API、self update、任意PC操作は無効です。
承認記録が存在するだけで、未実装の能力を有効にしてはいけません。

## 5. Taskと安全制御

Task履歴・idempotency・試行回数・状態監査は `userData/tasks.sqlite` に保存します。
DB処理はAgent内で行い、Realtimeは軽量なキャッシュだけを読みます。
未完了作業は再起動時に保留し、自動再実行しません。
一時停止・再開・中止を実処理へ伝え、中止後の遅い成功通知で状態を戻しません。

既定のFailureBudgetは3試行、同じエラー2回、稼働時間30秒。
OpenAIは例外として自動再試行なし。送信前に未確定額をSQLiteへ予約し、利用量が確認できたときだけ精算する。
再開・再起動は送信権限を復活させない。中止はローカル停止であり、API側の処理終了や返金を保証しない。
ResourceLockで同じ対象の確認を直列化し、CircuitBreakerで連続失敗を遮断します。
Task登録後の実行時と各試行直前にネイティブPolicyEngineを通します。
承認不足・期限切れ・撤回は保留とし、モデルが許可を決めることはありません。
停止はAbortSignalとAgent終了時の強制停止まで対応。将来の子プロセス木制御は未実装です。

## 6. 結果・進捗・表示

証拠・検証方法・PASSが揃わないSUCCESSはDONEにしません。
通常進捗の通知はworker側で150ms集約し、重要状態は即時送信します。
Realtime側でさらに150ms待たせません。内部状態自体は遅延更新しません。
ETAは同じ種類で3件以上成功した実績から算出し、不明なら不明と答えます。
完了通知は通常の会話の空隙で短く、ユーザー発話中へ割り込みません。

DesktopTextOverlayはAvatarと別Window/rendererです。
白文字・黒縁・影が既定で、背景ボックス・カード・枠を出しません。
「文字で見せて」は原則音声なし。「消して」「次」「前」「大きくして」「固定して」に対応します。
文字表示rendererのAPIは表示専用で、Task実行・承認付与・Nodeへの入口を持ちません。

## 7. 会話・画面・Memory・汎用拡張

会話は短い自然な日本語を基本とし、見ていない画面や未実行の操作を実行済みと答えません。
共有対象はユーザーが明示選択し、画像は既定でRAMのみです。
音声はUSER/SYSTEM/REMOTEを分離し、REMOTEは会話文脈のみです。
Memoryは保存設定と検索・編集・削除を提供します。

`GamePlugin` / `PluginHost` は汎用ゲーム拡張機構として残します。
現在の登録済みゲームはありません。Genericモードはプラグインなしで動作します。
将来の専用認識はこの境界へ追加し、Friend Coreへゲーム固有ロジックを書き込みません。

## 8. 未完成と受入条件

OpenAIの明示文章相談と概算管理を追加。料金表の更新・実キーでの任意の接続確認は残っている。
次はOS権限制限とプロセス木制御、安全なCoding/Research Worker、検証・deploy/rollback、
GPU leaseとRealtime優先制御、Avatarの参照移植です。
承認と隔離なしに外部送信・インストール・特権操作へ広げません。

通常テスト、失敗試験、実Electron試験、権限レビューを各区切りで実施します。
描画の継続試験は60fpsを保証しません。実マイク・30分運用・負荷下の60fpsは未確認です。
検証結果と残件は [personal-agent-v3.2-status.md](personal-agent-v3.2-status.md) を参照してください。
