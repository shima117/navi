# Reference inputs

このディレクトリは、NAVI本体へ直接組み込むコードではなく、既存実装を移植・比較するための参照資料です。

Tarkov の参照コードとプラグインはユーザーの指示により削除済みです。必要な場合は Git 履歴から復元できます。

## PuppetJS reference

元データ: ユーザー提供 `ナビ(1).zip`

単一HTMLに含まれていたPuppetJSのうち、NAVI Avatar Runtimeへ移植価値の高い、
- layer role classification
- parameter contract
- hair physics
- idle animation
- expression mixing
- render loop ordering

を `references/puppetjs/` に参照用として保存します。

本番実装は単一HTMLへ戻さず、`src/avatar/` と AvatarWindow 側へモジュール化してください。
