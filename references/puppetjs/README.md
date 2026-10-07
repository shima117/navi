# PuppetJS reference

ユーザー提供 `ナビ(1).zip` の `vtuber_prototype.html` を基にした参照資料です。

本番のNAVI Avatar Runtimeで特に引き継ぐもの:
- PSDレイヤー名からの自動role判定
- 顔 / 目 / 眉 / 口 / 頬 / 体パラメータ
- 髪の節ごとの遅延物理
- idleの呼吸・視線・まばたき
- expressionをtracking/idleの上にblendする順序
- physics適用後にrenderするフレーム順序

注意: 元HTMLのbundled third-party parser部分は参照コードとして重複保存しません。本体では既に導入済みの `ag-psd` 等へ置換可能です。
