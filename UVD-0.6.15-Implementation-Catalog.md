# Universal Video Detector 0.6.15 Implementation Catalog

- Base: Universal-Video-Detector-0.6.11.zipのみ。現行最新版を唯一の開発ベースとして0.6.15へ更新。
- Version: 0.6.15（常にx.y.zの3要素）。

## 今回の変更

### 1. バージョン管理の固定
- 正式バージョン表記を常に3要素 `x.y.z` とするルールを追加。
- 本体、CoApp、manifest、更新判定、成果物名を0.6.15へ統一。
- 旧2要素表記を正式な現行バージョンとして扱う新規互換変換は追加しない。

### 2. 設定画面の並び順
設定グループを次の順に固定した。
1. ダウンロード設定
2. 検出
3. 外観
4. サイトアクセス
5. 広告
6. プレビュー
7. 設定

CoApp更新確認はダウンロード設定内に残し、サイトアクセス制御から独立させた。

### 3. プレビュー欄のエラーログ集積
- `diagnostics.js` を追加し、Popup / Background / Contentの各拡張コンテキストで共通利用。
- `console.error`、未捕捉error、unhandled promise rejectionを共通エラーログへ集積。
- `storage.local`へ最大500件を保存。
- プレビュー欄から更新・コピー・削除を実行できる。
- ログには時刻、発生コンテキスト、メッセージ、ページURL、必要時のファイル位置を表示。
- ログ収集自体が新たな例外を発生させないよう安全化。
- 「あらゆる」はFirefox内部やOS側がUVDへ通知しないエラーまで意味せず、UVDが捕捉可能なエラーを対象とする。

### 4. 設定責務の整理
- 外観からプレビュー設定を分離せず、既存仕様どおりプレビュー選択は外観へ配置。
- 一般動作の「元の位置へ戻す」「完了通知」は独立した設定へ移動。

### 5. main-hookのエラー収集
- page contextで動作するmain-hookの未捕捉error / unhandled promise rejectionをカスタムイベントでcontent scriptへ転送し、共通エラーログへ集積する。

## 検証状況
- manifest JSON: P
- JavaScript syntax: P（diagnostics.js / popup.js / background/service.js / content/detector.js / content/main-hook.js / adapters/generic-adapter.js）
- ZIP root: P（manifest.jsonがZIP直下、バージョン親フォルダーなし）
- version consistency: P（manifest / CoApp metadata / C# / UI）
- Runtime: H
- CoApp compile: H（環境にdotnetなし）

## Phase status
- Phase 1: 実装継続。今回の変更はUI/診断/設定整理で、Phase 2/3の重量解析処理は有効化しない。
- Phase 2: 未着手
- Phase 3: 未着手
- 次Phase移行: 不可。Phase 1の実機検証完了が必要。


## 0.6.15 追加変更
- 最新ベースは0.6.13。0.6.13以前へ戻していない。
- `settings/` フォルダーを新設し、`detection-tuning.js` と `diagnostics.js` を移動。
- ManifestおよびPopupの読み込み先を `settings/` に更新。
- Content側Diagnosticsは、外部ページ由来の匿名 `Script error.` をUVDエラーとして収集しない。
- `main-hook.js` はmain-hook自身のエラーだけをDiagnosticsへ転送し、ページ側の無関係なエラーを二重収集しない。
- バージョン形式は `0.6.15` のx.y.zを維持。

## 0.6.15 追加修正
- 0.6.14でmanifestが0.6.14へ更新された一方、`background/service.js` と `ui/popup.js` の内部 `UVD_VERSION` が0.6.13のまま残っていた不整合を修正。
- Popup起動時のバージョン一致チェックで `0.6.14 != 0.6.13`（0.6.14時点の不整合） が発生し、UI初期化がCoApp確認・rawCandidates確定処理へ進まないことで「一件も取得されない」状態になっていた。
- `background/service.js` / `ui/popup.js` の正式バージョンを0.6.15へ統一。
- CoApp、manifest、UI表示、成果物名も0.6.15へ統一。
- 0.6.14で追加した `settings/` 構成を維持。
