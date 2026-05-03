# 英タンゴ復習するンゴ

Obsidian でまとめた英単語ファイルを、スマホで読み上げて聞ける PWA です。

- **完全無料 / ランニング費用ゼロ**: GitHub Pages + ブラウザ内蔵の Web Speech API
- **PWA**: スマホのホーム画面に追加すれば普通のアプリのように使えます
- **オフライン対応**: 一度開けば電波がなくても再生できます
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
├── app.js                  # 読み上げロジック + パーサー
├── style.css
├── manifest.webmanifest    # PWA 定義
├── sw.js                   # オフライン対応の Service Worker
├── icons/
│   ├── icon-192.png 等     # アプリアイコン
│   └── install-qr.png      # インストール用 QR
├── vocab/
│   ├── index.json          # ← Actions が自動生成
│   └── *.md                # ← 単語まとめ md ファイル
├── scripts/
│   ├── generate_icons.py   # アイコン再生成
│   └── generate_qr.py      # QR 再生成
└── .github/workflows/
    └── deploy.yml          # Pages デプロイ + index.json 生成
```

- 読み上げは **Web Speech API** (`speechSynthesis`)。サーバー不要・完全無料
- 英語 / 日本語の声はブラウザ・OS にインストール済みのものを使用
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

- **声の品質は OS 依存**: iOS の Siri 系・Android の Google TTS が高品質。PC では Edge / Chrome の Online Voice が綺麗
- **iOS Safari**: 初回は再生ボタンを 1 回タップしないと TTS が起動しません（仕様）
- **オフライン時**: 一度ロードしたファイルのみ再生可能。新規 .md は通信が必要
- **Wake Lock**: 再生中は画面を点けたままにしますが、対応していない端末では効きません

---

## 7. アイコン / QR を差し替えたい場合

```bash
# アイコン
python3 scripts/generate_icons.py

# QRコード（URL変更時）
APP_URL=https://your-new-url/ python3 scripts/generate_qr.py
```

または `icons/` 以下の PNG を直接置き換えてください。
