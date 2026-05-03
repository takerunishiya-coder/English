# 英タンゴ復習するンゴ

Obsidian でまとめた英単語ファイルを、スマホで読み上げて聞ける PWA です。

- **完全無料 / ランニング費用ゼロ**: GitHub Pages + ブラウザ内蔵の Web Speech API + OSS TTS (espeak-ng) で事前生成
- **PWA**: スマホのホーム画面に追加すれば普通のアプリのように使えます
- **オフライン対応**: 一度開けば電波がなくても再生できます
- **バックグラウンド / ロック画面再生対応**: CI が事前生成した MP3 を `<audio>` + MediaSession で再生（音質は機械的だが画面OFFでも継続）
- **md ファイルを置くだけ**: `vocab/` に `.md` を追加して push するだけで自動反映
- **読み上げ順**: 英単語 → 日本語の意味 → 英語例文 → 日本語訳

---

## 📱 スマホへのインストール (QRコード)

下のQRコードをスマホのカメラで読み取ると、デプロイ済みのアプリが直接開きます。
そのまま「ホーム画面に追加」（iPhone Safari）または「アプリをインストール」（Android Chrome）してください。

![Install QR](icons/install-qr.png)

URL: <https://takerunishiya-coder.github.io/English/>

> URLが変わった場合は `python3 scripts/generate_qr.py` で再生成できます。
> 別URL用は `APP_URL=https://example.com python3 scripts/generate_qr.py`

---

## 1. 単語ファイルのフォーマット

`vocab/*.md` に以下の書式で書いてください。

```
**daintily**：上品に、お淑やかに

例）Women tend to eat daintily.
訳）女性は上品に食べる傾向がある。

**diligent**：勤勉な、熱心な

例）She is a diligent student who studies every day.
訳）彼女は毎日勉強する勤勉な学生だ。
```

書式の許容範囲:

| 要素 | 認識される書き方 |
| --- | --- |
| 単語の見出し | `**word**` |
| 区切り | `：`（全角） / `:`（半角） |
| 例文 | `例）` `例)` `例文)` `例1）` `Example:` `Ex:` |
| 例文の訳 | `訳）` `和訳）` `Translation:` `Tr:` / `(日本語訳)` 同行カッコ書き / 例文の直後の和文行 |
| 章見出し | `# 見出し` `## 見出し`（読み上げには影響しません） |

---

## 2. 単語ファイルの追加・更新方法

### Obsidian で書いた md を反映する

```powershell
# Obsidian Vault から English リポジトリにコピー
Copy-Item "C:\Vaults\Obsidian Vault\英会話_重要単語フレーズまとめ_20260503.md" `
          "C:\Users\nsyte\English\vocab\"

# コミット & push
cd C:\Users\nsyte\English
git add vocab/
git commit -m "Add vocab: 20260503"
git push
```

push すると GitHub Actions が自動で:
1. `vocab/index.json` に新しいファイルを追加
2. GitHub Pages にデプロイ

1〜2分後にアプリで新しい単語ファイルが選べるようになります。

> ファイル一覧 (`vocab/index.json`) は手動編集不要です。Actions が `vocab/*.md` を見て自動生成します。

### 既存ファイルを更新する場合

同じファイル名で上書きコピーして push するだけで OK です。アプリは Service Worker で **vocab ファイルだけは network-first** にしているため、起動時に最新が取得されます。

---

## 3. 操作方法

| ボタン | 動作 |
| --- | --- |
| ▶ / ⏸ | 再生 / 停止 |
| ⏮ ⏭ | 前 / 次の単語 |
| リピート | 最後まで再生したら最初に戻る |
| シャッフル | 順序をランダム化 |
| 自動送り | OFF にすると 1 単語ずつ手動で進める |
| 設定 (⚙) | 速度、間のポーズ、声、リピート回数、訳の読み上げ ON/OFF |

---

## 4. 仕組み

```
English/
├── index.html              # 画面
├── app.js                  # 再生ロジック + パーサー + MediaSession 統合
├── style.css
├── manifest.webmanifest    # PWA 定義
├── sw.js                   # オフライン対応の Service Worker (音声 mp3 もキャッシュ)
├── icons/
│   ├── icon-192.png 等     # アプリアイコン
│   └── install-qr.png      # インストール用 QR
├── vocab/
│   ├── index.json          # ← Actions が自動生成
│   ├── *.md                # ← 単語まとめ md ファイル
│   └── audio/              # ← Actions が事前生成 (espeak-ng + ffmpeg)
│       └── <basename>/
│           ├── manifest.json
│           └── eNNNN/word.mp3 / meaning.mp3 / exN_en.mp3 / exN_ja.mp3
├── scripts/
│   ├── generate_icons.py   # アイコン再生成
│   ├── generate_qr.py      # QR 再生成
│   └── generate_audio.py   # 音声 mp3 を事前生成 (espeak-ng + ffmpeg)
└── .github/workflows/
    └── deploy.yml          # Pages デプロイ + index.json 生成 + 音声生成
```

### 音声ソースは 2 系統

| モード | エンジン | バックグラウンド再生 | 音質 |
| --- | --- | --- | --- |
| **事前生成 (デフォルト)** | espeak-ng で生成した MP3 を `<audio>` + MediaSession で再生 | ✅ 画面OFF / ロック画面 / 別アプリ中も継続 | 機械的・低め |
| **端末TTS (フォールバック)** | Web Speech API (`speechSynthesis`) | ❌ 画面OFFで停止する端末あり | OS依存（高品質） |

**設定 → 「音声ソース」** で切替可能（`auto` / `事前生成のみ` / `端末TTSのみ`）。
manifest が見つからない単語ファイルは自動で端末TTSに落ちます。

### ローカルで音声を再生成する

```bash
sudo apt-get install -y espeak-ng ffmpeg     # 初回のみ
python3 scripts/generate_audio.py            # vocab/audio/ に出力
python3 scripts/generate_audio.py --force    # キャッシュを無視して全再生成
```

各 md の SHA-256 を `manifest.json` に持つので、未変更ファイルは自動でスキップされます。

- 設定（速度・声・訳の読み上げなど）はブラウザの `localStorage` に保存

---

## 5. ローカル動作確認

```bash
cd english-vocab-pwa
python3 -m http.server 8080
# http://localhost:8080 をブラウザで開く
```

---

## 6. 注意事項 / 既知の制約

- **声の品質**:
  - 事前生成モードは **espeak-ng** の機械音声 (`en-us+f3` / `ja+f3`)。聞き取りには問題ないがロボット声
  - 端末TTSモードは OS 依存。iOS の Siri 系・Android の Google TTS が高品質。PC では Edge / Chrome の Online Voice が綺麗
- **iOS Safari**: 初回は再生ボタンを 1 回タップしないと音声が起動しません（仕様）
- **バックグラウンド再生**: 事前生成モードのみ対応。端末TTSモードは画面OFFで停止する端末があります
- **オフライン時**: 一度再生した単語ファイルの mp3 は SW がキャッシュするので、以後は通信不要
- **Wake Lock**: 端末TTSモードのみ意味があります（事前生成モードは画面OFFでも継続）

---

## 7. アイコン / QR を差し替えたい場合

```bash
# アイコン
python3 scripts/generate_icons.py

# QRコード（URL変更時）
APP_URL=https://your-new-url/ python3 scripts/generate_qr.py
```

または `icons/` 以下の PNG を直接置き換えてください。
