# 歯科医院向け 院内ナレッジ管理・AIチャットアプリ

[English version → README.en.md](./README.en.md)

歯科医院スタッフが院内資料を一元管理し、AIに質問できるWebアプリです。  
PDF・Word・画像をアップロードするだけで、自動OCR・AI要約・RAGチャットが利用できます。

---

## スクリーンショット

| AIチャット | AI要約表示 |
|---|---|
| ![AIチャット](./screenshots/chat.png) | ![AI要約](./screenshots/summary.png) |

| 資料庫 | 解説書作成（スライド生成） |
|---|---|
| ![資料庫](./screenshots/repository.png) | ![解説書作成](./screenshots/manual.png) |

---

## 主な機能

| 機能 | 概要 |
|---|---|
| **資料アップロード** | PDF / Word / 画像 / 動画をS3へ保存 |
| **OCR自動処理** | スキャンPDFをAWS Textractで文字起こし |
| **AI要約生成** | 章・節・見出し単位でAIが400字以内に要約 |
| **RAGチャット** | Bedrock Knowledge Baseを参照してAIが回答 |
| **資料指定チャット** | 特定資料を絞り込んでAIに質問 |
| **マニュアル生成** | AIチャットからWord形式のマニュアルを出力 |

---

## アーキテクチャ

```
ブラウザ (Next.js SSR on Amplify Hosting)
    │
    ├─ アップロード ──→ Amazon S3
    │                      │
    │               Amazon SQS キュー
    │                      │
    │               Consumer Lambda
    │                      │
    │               AWS Step Functions (Prepare)
    │                 ├─ OCR (AWS Textract)
    │                 └─ Bedrock Knowledge Base 同期
    │
    ├─ 要約リクエスト ──→ AWS Step Functions (Summary)
    │                         └─ Lambda (Claude で章別要約生成)
    │
    └─ AIチャット ──→ Amazon Bedrock (RetrieveAndGenerate)
                          └─ Bedrock Knowledge Base (RAG)
```

---

## 技術スタック

**フロントエンド**
- Next.js 15 (App Router / SSR)
- TypeScript

**インフラ / バックエンド**
- AWS Amplify Hosting (Git連携 SSRデプロイ)
- Amazon S3 (資料・メタデータ・要約の保存)
- Amazon SQS (アップロードキュー)
- AWS Lambda (OCR・要約・KB同期ワーカー)
- AWS Step Functions (処理ワークフロー)
- Amazon Bedrock / Bedrock Knowledge Base (RAG・LLM)
- AWS Textract (スキャンPDFのOCR)

**開発補助**
- Claude Code (AIコーディングエージェント)

---

## セットアップ

### 前提条件

- Node.js 24 LTS
- AWS CLI（`dental-dev` プロファイル設定済み）
- AWS アカウント（Bedrock / Textract / Lambda / S3 利用権限）

### ローカル起動

```bash
# 依存パッケージインストール
npm install

# 環境変数を設定（.env.example を参考に実値を入力）
cp .env.example .env.local
# .env.local を編集して各AWSリソースの値を設定

# 開発サーバー起動
npm run dev
```

### 環境変数

`.env.example` を参照してください。主な設定項目：

| 変数名 | 説明 |
|---|---|
| `S3_BUCKET_NAME` | 資料・メタデータ保存用S3バケット |
| `APP_TEXTRACT_BUCKET_NAME` | OCR処理用S3バケット |
| `BEDROCK_KNOWLEDGE_BASE_ID` | Bedrock Knowledge Base ID |
| `BEDROCK_MODEL_ARN` | 使用するBedrockモデルのARN |
| `APP_PREPARE_STATE_MACHINE_ARN` | OCR・KB同期ワークフローのARN |
| `APP_SUMMARY_STATE_MACHINE_ARN` | 要約生成ワークフローのARN |
| `PREPARE_QUEUE_URL` | アップロードキューのSQS URL |
| `APP_SHARE_PASSWORD` | 共有認証パスワード |
| `APP_AUTH_SECRET` | セッション署名用シークレット |

### インフラ構成ファイル

`infra/` 以下にIAMポリシー・Step Functions・Bedrock設定のJSONテンプレートがあります。  
各ファイル内の `YOUR_ACCOUNT_ID` 等を実際の値に置き換えてAWS CLIで適用してください。

---

## Lambda のデプロイ

Lambda のコードは `lambda/` 以下で管理しています。Git push では更新されないため、変更後は個別にデプロイが必要です。

```bash
# 例: summary_worker の更新
Compress-Archive -LiteralPath .\lambda\summary_worker\handler.py -DestinationPath .\lambda\summary_worker_docai.zip -Force
aws lambda update-function-code --function-name dental-summary-worker-dev --zip-file fileb://lambda/summary_worker_docai.zip --profile dental-dev --region ap-northeast-1
Remove-Item -LiteralPath .\lambda\summary_worker_docai.zip -Force
```

依存パッケージはLambda Layerで管理しているため、`handler.py` のみのzipでデプロイできます。

---

## ライセンス

Private
