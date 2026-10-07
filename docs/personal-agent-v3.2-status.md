# NAVI Personal Agent v3.2 — 実装引き継ぎ

ユーザー提供の「NAVI_Personal_Agent_統合再設計指示書_v3.2.md」を採用する。
これは全項目の完成報告ではない。音声版 PR #1 を残し、別 worktree / branch で最初の実装区切りを追加した。

## 今回の区切り: 独立文字窓と進捗配信の土台

- DesktopTextOverlay は独立 BrowserWindow / renderer。透過・背景なし・枠なし・タスクバー非表示・最前面。
- 既定は白文字、黒い縁、影。フォント・サイズ・色・縁・影・透明度・位置・行間・幅・行数を設定できる。
- 「文字で見せて」だけなら直前の返答を表示。「進捗をテキストで出して」はローカル状態から直接表示。
- 質問に「文字で出して」を付けると、そのターンだけ音声を出さず文字で返す。「読み上げて」も付けると両方。
- 「文字を大きくして / 小さくして / 右に / 固定して」、表示中の「次 / 前 / 消して」に対応。
- 実フォント幅で改行・ページ分割。短い返答は自動消去、長い返答・結果・メモ・作業状況は保持。
- クリック透過、ドラッグ時の位置保存、画面キャプチャ除外設定。除外の実効性は録画ソフトごとに要確認。
- 窓の終了・レンダラ障害を会話とアバターから隔離。次の表示で再作成する。
- 文字 renderer の公開 API は表示専用。Node 無効、sandbox / contextIsolation、IPC 送信元確認、内容は textContent で描画。
- TaskSnapshotPublisher は内部状態を即時更新、進捗 IPC だけを 150 ms ごとに最新値へ集約。状態変化・blocker 変化・PARTIAL 等は即時送信。
- タスク保持数は最大 128。終了済みを先に退避し、稼働中だけで上限なら拒否する。過去の進捗が終了状態を巻き戻さない。
- DONE は対応する OperationReport の検証方法・成功結果・証拠を必要とする。これは入力契約であり、独立 verifier / Protected Core の実装ではない。
- ETA が未設定なら見積もれないと返す。作業が登録されていなければ作業なしと返す。架空の作業・進捗・ETA は作らない。

TaskSnapshot は現時点では RAM のみ。AgentService / Task DB / CodingWorker はまだなく、
自然文からコード修正や PC 操作を実行する機能は有効にしていない。
信頼できる worker から EventBus の task.snapshot に { snapshot, report? } を渡す入口と、
renderer への読み取り専用 tasks.list / onSnapshot は用意した。

## 検証

最終確認: TypeScript テスト 345 / 345、追加 Windows Electron E2E 5 / 5、production build 成功。

- TypeScript 型チェックと production build。
- 単体・結合: テキスト意図、ターンごとの音声抑制、明示した両出力、古い合成の無効化、
  10,000 件の進捗集約、即時の重要状態、未検証完了の拒否、容量制限、表示障害の隔離。
- Windows の実 Electron: 表示・ページ・サイズと位置・ドラッグ位置保存・消去・固定・窓再作成・進捗文字表示。
- 白・暗色・模様背景のスクリーンショットを目視確認。
- 既存 Memory テストの SQLite 接続を後片付けで閉じ、Windows の一時データ削除エラーを修正。製品の Memory 動作は変更していない。

まだ未確認: 実ゲーム・写真・OBS での視認性と除外、複数モニターの実機切替、
大量 worker ログ中の Avatar 60 fps / 実マイク割り込み。音声版の 30 分実機運用試験も未実施。
既存の固定ポート fake-service E2E は、起動中の Ollama を止めないため今回再実行していない。

## 次に実装する順序

1. Task DB / TaskRegistry / AgentService を Electron main の外に置き、まず読み取り・診断など限定作業から実行する。
2. FailureBudget / CircuitBreaker / ResourceLock / idempotency / 全体キャンセルと子プロセス停止を worker の前提条件にする。
3. PolicyEngine / ApprovalStore / cloud budget / data classification。API 使用や install / privileged 操作は未承認のまま実行しない。
4. 検証と実行を分けた OperationReport、安全な CodingWorker、ブラウザ隔離、差分 deploy / rollback。
5. GPU lease / speech preemption / trace 指標 / 独立 supervisor と、負荷下の実機性能確認。
6. Avatar / Tarkov の参照移植も別の作業区切りで続ける。現在の Avatar は仮描画、Tarkov は骨組みのまま。

音声と Avatar を止めないことが最優先。自動 PC 操作・自己更新・インストールを UI だけで完成扱いしない。
