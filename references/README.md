# Reference inputs

このディレクトリは、NAVI本体へ直接組み込むコードではなく、既存実装を移植・比較するための参照資料です。

## Tarkov Assistant reference

元データ: ユーザー提供 `タルコフ(1).zip`

元ZIPには portable EXE、dist、Electron userData/cache、API cache、大量の生成物が含まれているため、それらをそのままリポジトリへ入れません。NAVIへ移植価値の高いソースだけを `references/tarkov-assistant/` に保存します。

主な参照対象:
- Tarkov API / Electron bridge
- screenshot watcher
- task progression / requirements
- map registry
- item utilities / shared types

実装時はコピー前提にせず、`src/plugins/tarkov/` の GamePlugin 境界へ移植してください。

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
