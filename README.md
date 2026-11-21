# セリフテイク

ショートドラマの撮影素材を台本のセリフ単位に整理し、Final Cut Pro 用の FCPXML を書き出すアプリ。
ブラウザ（Mac の Safari / Chrome）で動き、動画・音声・台本は端末の中だけで処理する。

公開ページ：https://arumonwizard-star.github.io/serifu-take/

## 構成
- `index.html` / `style.css` / `js/app.js`：画面と全体の流れ
- `js/media.js`：MOV/MP4/WAV の解析（moov だけ読む・音声だけ抜き出す。動画本体は読み込まない）
- `js/analysis.js`：包絡線・発話区間・カメラ間の音声同期
- `js/text.js`：台本の読み込み、読み変換（kuromoji）、セリフの分解
- `js/align.js`：台本と文字起こしの照合（読みでの局所アライメント）
- `js/organize.js`：同期グループ、テイク、セリフ別クリップ、NG候補、アドリブ
- `js/asr-worker.js`：文字起こし（Whisper を WebGPU/WASM で端末内実行。初回にモデルを取得してブラウザに保存）
- `js/fcpxml.js`：FCPXML 1.10 書き出し
- `vendor/`：transformers.js / onnxruntime-web / kuromoji（外部 CDN を使わない）
- `sw.js` / `version.json`：自動更新

## テスト
```
pip install playwright numpy   # 初回のみ
python3 tests/gen_media.py      # テスト素材（A/Bカメ＋外部音声、2テイク）を作成
python3 -m http.server 8765     # リポジトリ直下で
python3 tests/e2e.py            # 文字起こしは模擬。解析・同期・照合・画面操作・FCPXML まで確認
xmllint --noout tests/out.fcpxml
```

## 反映
`main` に push すると GitHub Pages に自動反映される。
版を上げるときは `js/app.js` の `VERSION` と `version.json` を同じ番号にする（開いている画面が自動で入れ替わる）。
`vendor/` を差し替えたときは `sw.js` の `CACHE` の名前も変える。
