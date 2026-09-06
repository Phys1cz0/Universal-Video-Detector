# Universal Video Detector 0.6.12 Implementation Catalog

- Base: Universal-Video-Detector-0.6.10.zipのみ。現行最新版を唯一の開発ベースとして0.6.12へ更新。
- Version: 0.6.12（数字のみ）。

## 0.6.12 修正内容
- UI完全表示前はCoApp接続・更新確認・リスト処理を開始しない。ページ側は受動DOM/Network検出とrawCandidates収集を継続。
- UI完全表示後にCoAppバージョン確認を最優先で実行。
- CoApp更新完了後、Native Messaging pingを明示的に再実行し、更新後CoAppバージョンを確認してからrawCandidates確定処理へ進む。
- CoApp更新開始失敗時は更新ロック状態をUI側で解除する。
- 大型fetchレスポンスを全体文字列へclone/text化せず、cloneのReaderから上限付きストリームで動画URLだけを軽量抽出。
- 小型候補レスポンスのみJSON/object解析し、重い再帰解析対象を縮小。
- Mutation処理で同一変更subtreeを複数の祖先から再走査しない。
- Generic Adapterの受動Mutation処理は最近傍semantic cardを最大1つだけ利用し、検出経路を維持。
- 受動属性解析は動画URL候補を示す値だけscanTextへ渡す。
- 検出回帰対策として、direct media / data-video / script / video.twimg.com / HLS / DASH の既存経路を維持。

## ルール適合
- Adapter削除なし。
- UI前CoApp連携なし。
- rawCandidatesと内部リストを分離。
- CoApp更新中の候補をrawCandidatesへ保持。
- ZIPルートにバージョン親フォルダーを作らない。
- Phase 2/3のduplicate index、storage batching等は未実装。

## 検証状況
- JS構文検証: 実施対象。
- JSON検証: 実施対象。
- ZIP構造確認: 0.6.12作成時に確認。
- Firefox実機負荷: 未確認。
- 実サイト検出回帰: 未確認。
- Native Messaging/CoApp更新後再接続: 静的実装確認済み、実機確認待ち。

## Phase進捗
- Phase 1: 実装完了。0.6.12で残存負荷・検出回帰・統合チューニング設定・診断を実装。実機検証待ち。
- Phase 2: 未着手。Phase 1検証完了まで開始しない。
- Phase 3: 未着手。


## 0.6.12 追加実装
- 検出設定・検出詳細設定・性能調整設定を `detection-tuning.js` の共通スキーマへ統合。
- 低負荷 / 標準 / 高検出 / 最大検出の組み込みプリセットを追加し、関連値を一括変更。
- ユーザー定義プリセットの保存・名前変更・削除・JSON Export/ImportをFirefox `storage.local`中心で実装。
- 絶対安全上限を共通スキーマで強制。
- Phase 1実処理としてDOM/Network有効状態、Mutation対象上限、大レスポンスのstream有効状態を接続。
- 拡張子なしURLは明示された動画typeがある場合のみ受け入れる経路を追加。
- Generic Adapterの候補属性を拡張し、既存の対象範囲内で検出回帰を修正。
- BackgroundのwebRequest候補もUI起動ゲート前はrawCandidatesへ保持するよう統一。
- 検出診断カウンターを追加。
- コード品質ルール258～262を追加し、責務分離・可読性・変数用途の明示を正式ルール化。

## Phase境界
- Phase 1: 本版で実装対象を完了。実機検証は別途必要。
- Phase 2: 解析深度・ノード・時間予算の実処理、巨大JSON詳細解析最適化、解析キャッシュはUI/保存のみ準備し、まだ有効化しない。
- Phase 3: duplicate index、ad-filter index、storage batching、不要Browser API削減は未着手。

## コード品質確認
- 新規共通設定を単独ファイルへ分離し、設定定義の重複を削減。
- 長大な設定ロジックを共通関数へ集約。
- 未使用の `STREAM_CHUNK_BYTES` を削除。
- 既存Adapterは削除していない。

## 0.6.12 追加修正
- 旧形式の2要素版と新形式の3要素版 が比較時に混在しないよう、2要素の旧表記を `0.6.8` として比較する互換処理を追加。
- 設定保存をlocal storage先行に変更。
- 広告フィルター初期値OFF。
- 待機150ms/試行2回/最大検出15秒を初期値化。
- プレビューを画像/なしへ限定し画像を初期値化。
- ホワイトリスト/ブラックリストを追加。CoApp接続・更新はサイト制御の対象外。
- 詳細設定チェック項目のクリック領域を縮小。
- 0.6.9からの変更であるため本版は `0.6.12`。


## 0.6.12 CoApp更新修正
- 原因特定: 旧CoAppの2要素バージョンをC# `System.Version`でそのまま比較していたため、旧形式の6.8が0.6.10より新しいと判定され、更新処理自体が拒否されていた。
- 新しいCoAppでは2要素版を0.x.yとして比較する互換処理を追加。
- 更新子プロセスから実行中のNative Messagingホスト自身を `taskkill` しない方式へ変更。ホストが現在のNative Messaging応答を完了して自然終了した後に差し替える。
- 更新子プロセスをJob/親プロセス終了の影響を受けにくいDetached Processとして起動。
- 更新後の検証待機を15秒から30秒へ延長し、旧ホスト切断→新ホスト起動の遷移を許容。
- 旧形式2要素CoAppを0.6.12拡張から直接自動更新できないケースは、誤って「更新済み」と扱わず再セットアップが必要であることを明示する。これは旧バイナリ側に互換修正が存在しないため。

## 検証状況
- JS構文検証: 実施対象。
- JSON検証: 実施対象。
- C#コンパイル: 開発環境にdotnet/Windows C#コンパイラがないため未実行。
- Native Messaging実機更新: 未確認。
- 旧形式CoAppからの移行: 現行0.6.10旧バイナリ側の制約により、0.6.12側で自動完結できるかは未確認。

## Phase進捗
- Phase 1: 実装完了。今回のCoApp更新経路修正を追加。実機検証待ち。
- Phase 2: 未着手。Phase 1検証完了まで開始しない。
- Phase 3: 未着手。
