# HLS Grabber 開発メモ（複数PC共有）

このリポジトリは複数のPCで編集する。Claude Code はこのファイルを自動で読むので、**重要な決定・注意点はここに追記してコミット**すること。

## 基本情報
- リポジトリ: https://github.com/tamamune/HLS-Grabber （ブランチ: main）
- 内容: m3u8 検出・ダウンロード・ライブ録画をする Chrome 拡張（Manifest V3）。ビルド不要、`chrome://extensions` →「パッケージ化されていない拡張機能を読み込む」でこのフォルダを選ぶ。
- 機能一覧・制限は [README.md](README.md) を参照。

## ファイル構成
- `manifest.json` — 拡張定義
- `background.js` — m3u8/メディア検出（service worker）
- `popup.html` / `popup.js` — 検出一覧UI
- `downloader.html` / `downloader.js` — ダウンロード・録画本体（OPFS一時保存、ffmpeg.wasm連携）
- `mediadl.html` / `mediadl.js` — X/Instagram等の単体メディア保存
- `gallery.html` / `gallery.js` — X/Instagram の画像・動画を大きなサムネで表示して保存する別タブ（ポップアップの「大きく表示」から開く。サイズスライダー、画像一括保存あり）
- `lib/` — 同梱ライブラリ（ffmpeg.wasm 0.12＝音声結合・サムネ用、mux-mp4.min.js＝mux.js 6.3.0、TS→MP4 逐次変換用）

## 作業ルール（PC間の同期）
1. 作業開始前に必ず `git pull`。
2. 作業が終わったら、小さい単位でコミットして `git push`（別PCで続きをやる前に必ず push）。
3. コミットメッセージは日本語でよい（既存履歴に合わせる）。
4. 拡張の動作確認後は `chrome://extensions` でリロード。
5. 他PCで知っておくべきこと（ハマりどころ、未完了タスク、設計判断）は下の「引き継ぎメモ」に追記する。

## 引き継ぎメモ
<!-- 新しいものを上に追記。例: 2026-11-09 (PC名) 内容 -->
- 2026-11-12: TS→MP4 変換を ffmpeg.wasm（1.5GB上限）から mux.js の逐次変換に変更し上限を撤廃（未実機確認）。ffmpeg.wasm は wasm32 のメモリ上限（入力＋出力をメモリに載せる）のため 5GB 等には上げられない。音声結合は引き続き ffmpeg.wasm で 1.5GB まで。
- 2026-11-09: gallery.html/js を追加（未実機確認）。
- 2026-11-09: 共有用に CLAUDE.md を追加。現状 main は v0.1.0 + 機能追加（MP4変換・音声結合・字幕・サムネ・X/Instagram対応）。
