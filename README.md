# 英単語リスナー (English Vocab Listener PWA)

Obsidian でまとめた英単語ファイルを、スマホで読み上げて聞ける PWA です。

- **完全無料 / ランニング費用ゼロ**: GitHub Pages + ブラウザ内蔵の Web Speech API
- **PWA**: スマホのホーム画面に追加すれば普通のアプリのように使えます
- **オフライン対応**: 一度開けば電波がなくても再生できます
- **md ファイルを置くだけ**: `vocab/` に `.md` を追加して push するだけで自動反映

---

## 1. 想定する単語ファイルのフォーマット

`vocab/*.md` に以下の書式で書いてください（行間は空けてください）。

```
**daintily**：上品に、お淑やかに

例）Women tend to eat daintily.

**diligent**：勤勉な、熱心な

例）She is a diligent student who studies every day.
```

書式の許容範囲:

- 区切り文字は `：`（全角）でも `:`（半角）でも OK
- 例文は `例）` `例)` `例文)` `例1）` `Example:` `Ex:` を認識
- 1単語に複数の例文を書いて OK
- `# 見出し` `## 見出し` を入れるとセクション分けできます（読み上げには影響しません）
- `**word**` の次の行に意味、その次の空行のあとに `例）...` でも OK

---

## 2. 公開リポジトリへの設置手順 (`takerunishiya-coder/English`)

### A. このフォルダを English リポジトリにコピー

このリポジトリの `english-vocab-pwa/` 以下のファイル一式を、`English` リポジトリのルートにコピーして push します。

```bash
# ローカルで
git clone https://github.com/takerunishiya-coder/English.git
cd English

# このリポジトリ (lawsregulationsnotice) からコピー
cp -r ../LawsRegulationsNotice/english-vocab-pwa/. .

git add .
git commit -m "Add English vocab listener PWA"
git push
```

### B. GitHub Pages を有効化

1. `https://github.com/takerunishiya-coder/English/settings/pages` を開く
2. **Source** で **GitHub Actions** を選択
3. push 済みなら `Actions` タブで `Deploy to GitHub Pages` ワークフローが走ります
4. 完了後、URL が表示されます: `https://takerunishiya-coder.github.io/English/`

### C. スマホのホーム画面に追加

- **iPhone (Safari)**: 共有ボタン → 「ホーム画面に追加」
- **Android (Chrome)**: 右上メニュー → 「ホーム画面に追加」/ 「アプリをインストール」

---

## 3. 単語ファイルの追加・更新方法

### Obsidian 側で書いたファイルを公開リポジトリに反映する

1. Obsidian で `英会話_重要単語フレーズまとめ_20260503.md` を編集
2. ファイルを `English/vocab/` にコピー（または同期）
   ```bash
   cp "C:/Vaults/Obsidian Vault/英会話_重要単語フレーズまとめ_20260503.md" English/vocab/
   ```
3. push する
   ```bash
   cd English
   git add vocab/
   git commit -m "Add vocab: 20260503"
   git push
   ```
4. 1〜2分で GitHub Pages に反映されます（GitHub Actions が `vocab/index.json` を自動生成）

> ファイル一覧 (`vocab/index.json`) はワークフローが自動生成するため、手動編集は不要です。

### 自動コピーしたい場合 (Windows のみ)

`English` リポジトリのローカルクローンを Obsidian Vault と同じディスクに置いて、PowerShell の同期スクリプトをタスクスケジューラに登録する方法もありますが、最初は手動コピーで十分です。

---

## 4. 操作方法

| ボタン | 動作 |
| --- | --- |
| ▶ / ⏸ | 再生 / 停止 |
| ⏮ ⏭ | 前 / 次の単語 |
| リピート | 最後まで再生したら最初に戻る |
| シャッフル | 順序をランダム化 |
| 自動送り | OFF にすると 1 単語ずつ手動で進める |
| 設定 (⚙) | 速度、間のポーズ、声、リピート回数など |

---

## 5. 仕組み

```
English/
├── index.html              # 画面
├── app.js                  # 読み上げロジック + パーサー
├── style.css
├── manifest.webmanifest    # PWA 定義
├── sw.js                   # オフライン対応の Service Worker
├── icons/                  # アプリアイコン
├── vocab/
│   ├── index.json          # ← Actions が自動生成
│   └── *.md                # ← 単語まとめ md ファイル
└── .github/workflows/
    └── deploy.yml          # Pages デプロイ + index.json 生成
```

- 読み上げは **Web Speech API** (`speechSynthesis`)。サーバー不要・完全無料
- 英語と日本語の声はブラウザ / OS にインストール済みのものを使用
- 設定はブラウザの `localStorage` に保存

---

## 6. ローカル動作確認

```bash
cd english-vocab-pwa
python3 -m http.server 8080
# http://localhost:8080 をブラウザで開く
```

スマホ実機で確認したい場合は、同じ Wi-Fi 上で PC の IP に直接アクセスするか、GitHub Pages 上で確認してください（`file://` だと PWA 機能と一部の Speech 機能が制限されます）。

---

## 7. 注意事項 / 既知の制約

- **声の品質は OS 依存**: iOS の Siri 系・Android の Google TTS が高品質。PC では Edge / Chrome の Online Voice が綺麗
- **iOS Safari**: 初回は再生ボタンを 1 回タップしないと TTS が起動しません（仕様）
- **オフライン時**: 一度ロードしたファイルのみ再生可能。新規 .md は通信が必要
- **Wake Lock**: 再生中は画面を点けたままにしますが、対応していない端末では効きません

---

## 8. アイコンを差し替えたい場合

```bash
python3 scripts/generate_icons.py
```

または `icons/` 以下の PNG (192/512px) を直接置き換えてください。
