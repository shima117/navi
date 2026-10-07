# OpenAI API — 明示文章相談の実装

2026-10-07、agent-foundation → policy-approvals の後継。通常の会話はローカルのまま。
これはResearch/Coding Agentの完成や、実キーによるAPI接続成功の報告ではない。

## 使い方

1. 自分のOpenAI APIプロジェクトでAPIキー・利用権限・支払い設定を用意する。
2. NAVIを起動するプロセスの環境変数 `OPENAI_API_KEY` にキーを安全に設定してから再起動する。
   キーをチャット、コード、設定JSON、Gitへ貼り付けない。Windows環境変数は秘密保管庫ではない。
   アプリにはキー入力欄・キー表示・キー取得IPCがない。「設定済み」は存在確認だけで接続確認ではない。
3. 作業タブに短い文章を入力し、モデル・公開/個人用分類・作業料金上限を選ぶ。
4. 「送信内容と料金を確認」で別のネイティブ確認画面を開く。本文全文と固定指示、モデル、分類、概算予約額、保存条件を確認する。
5. 既定は「送らない」。明示的に「この1回だけ送信を許可」を選んだ場合だけ実行する。

実キーの接続確認は未実施。自動で料金を発生させるテストは行っていない。
この利用経路にWeb検索・コード実行・ファイル読み取り・PC操作は付かない。

## API・モデル

固定送信先は `POST https://api.openai.com/v1/responses`。
通常の雑談、Memory、スクリーンショット、音声、選択プロジェクトの内容は添付しない。
固定指示と入力文章のみ。`store:false`、`service_tier:default`、`tools:[]`、`tool_choice:none`、
`reasoning.effort:low`、`max_output_tokens:1024`。継続ID・background・自動Tier変更はない。
参照: [Responses API](https://developers.openai.com/api/reference/cli/resources/responses/methods/create)。

モデルはユーザーが作業ごとに選択する。Economyが既定。実アカウントの利用可否は未確認。

| Tier | 固定モデル | 入力 / 出力 USD（100万token） |
| --- | --- | --- |
| Economy | gpt-6-luna | 0.10 / 0.50 |
| Standard | gpt-6.1-sol | 2.00 / 10.00 |
| Expert | gpt-6-astra | 10.00 / 50.00 |

確認元: [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)、
[Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)、[Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)。
料金カードは2026-10-07版、2026-11-06 UTCに失効。公式料金・対応パラメータを再確認し、
モデル定義・料金・期限・テストを一緒に更新するまでは期限後の送信を拒否する。

## 利用額の管理と限界

- 上限はNAVIの同じ保存先で1作業 $0.25、1日 $1、1月 $10。作業上限はUIから低く設定できる。日/月はUTC基準。
- 整数のUSD百万分の1で管理する。本文UTF-8 byte数＋固定指示＋4096の余裕を入力tokenの安全側見積もりとする。正確なtokenizerではない。
- 見積もり・実績には入力cache-write 1.25倍と地域価格の1.1倍を安全側の余裕として含める。Astraの1.1倍は保守的な仮定。税・為替・他アプリ・別プロフィールの利用は管理対象外。
- HTTP送信前にSQLite `synchronous=FULL` で概算予約額を保存する。承認・Task・送信fingerprintの照合と予算確認・予約はネイティブのtransactionで処理する。
- 正常応答のinput/output token実績が確認できた場合だけ概算を精算する。reasoningを含むoutput総量を使い、二重加算しない。
- HTTPエラー・タイムアウト・壊れた応答・中止・Agent終了で利用量が不明なら予約額を残す。自動で返金扱いや再送にしない。
- 請求明細そのものではなく、ローカルの概算ゲート。OpenAI側の請求・価格変更・OS障害に対する厳密な請求上限保証ではない。実費はOpenAIの利用画面で確認する。

## データ・承認・停止

本文はUTF-8で2048 byte、24行まで。PUBLIC/PRIVATEだけ送信可、CONFIDENTIAL/SECRETは拒否。
既知のキー形式やpassword/tokenの代入を検出して拒否するが、万能な秘密情報検出ではない。
機密情報を人が入れないことも必要。分類・送信内容をモデルに決めさせない。

キーはnative main → Agentの起動環境だけへ明示的に渡し、公開IPC・Task DB・ログに載せない。
VOICEVOX/音声認識/Ollamaなどのローカル補助サービスにはOpenAIキーを継承しない。
入力本文はAgentのRAMのみで、作業終了時に破棄。Task DBには本文ハッシュと送信範囲を保存する。
**API回答は作業履歴に保存するため、回答が入力内容を引用した場合は引用部分が保存されうる。**
公開IPCには回答とキー設定有無・利用額だけを返す。エラー本文や任意の例外文字列を表示・記録しない。

承認はProvider・endpoint・モデル/Tier・本文ハッシュ・分類・料金上限・料金版・Task ID・出力上限に固定。
10分で期限切れ、1回だけ消費。再開・再起動・別Task・別文章・別モデルに使い回せない。
確認中に停止/中止した場合、後から「許可」が返ってきてもキューへ入れない。
中止はAbortSignalで伝え、遅い回答を完了通知にしない。API側が処理を続けたり課金したりする可能性があり、返金・遠隔処理中止は保証しない。
通信後の再開は再送にならない。再送したい場合は新しい作業として改めて確認する。

`store:false` はすべての保持をゼロにする設定ではない。OpenAIの不正利用監視ログには通常最大30日保持される場合がある。
参照: [API data controls](https://developers.openai.com/api/docs/guides/your-data)。
承認台帳・プロセス分離はOSの権限サンドボックスや、DBの悪意ある直接改変への防御ではない。

## 成功判定と検証

completed、対象モデル、文章出力、token実績、HTTP証拠が揃った場合だけ「回答受信」のTaskをDONEにする。
未完了、refusal、ツール出力、応答サイズ超過、使用量超過は保留にする。API回答の事実性・コードの正しさは検証していない。
回答画面・音声通知にもその区別を残す。結果は背景なし文字窓にも表示できる。

自動テストはHTTP応答を注入し、外部APIへ接続しない。全Electron試験はキーを空にして起動する。
承認スコープ、予算、秘密情報拒否、再送防止、キーの非公開、期限失効、中止競合、壊れた応答・料金不確実性を検証する。
実キー、実モデル応答、ネットワーク遅延、実際の請求との照合、手動の承認画面操作はまだ受入未実施。
