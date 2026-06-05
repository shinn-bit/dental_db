# CLAUDE.md

Claude Codeでこのリポジトリを扱うための運用ルール。

## 基本方針

- このアプリは歯科医院向けの院内ナレッジ/資料庫アプリ。
- フロントエンドはNext.js。共有環境はAWS Amplify HostingのGit連携SSRデプロイを使う。
- OCR、要約、RAG同期はAWS上のLambda/Step Functions/Bedrock Knowledge Base/S3で動く。
- Git pushだけではLambdaコードは更新されない。Lambdaは明示的に `aws lambda update-function-code` が必要。

## ローカル環境

- Node.jsは24 LTSを使う。
- Node.js 20系は使わない。
- Pythonは原則としてAnaconda環境を使う。

```powershell
nvm use 24
node --version
npm --version
C:\Users\1107s\anaconda3\python.exe --version
```

## AWS操作

- AWS CLI操作は必ず `dental-dev` プロファイルを使う。
- `default` プロファイルではAWS操作をしない。
- 作業前に必要に応じてアカウント確認を行う。

```powershell
aws sts get-caller-identity --profile dental-dev
```

- SSO期限切れ時は再ログインする。

```powershell
aws sso login --profile dental-dev
```

## 主要AWSリソース

- AWS region: `ap-northeast-1`
- Textract region: `ap-northeast-2`
- メインS3 bucket: `dental-manuals-dev-392749559673-apne1`
- OCR一時S3 bucket: `dental-manuals-ocr-dev-392749559673-apne2`
- Lambda: `dental-summary-worker-dev`
- Lambda ARN: `arn:aws:lambda:ap-northeast-1:392749559673:function:dental-summary-worker-dev`
- Bedrock Knowledge Base ID: `PUQQYKIB70`
- Bedrock Data Source ID: `ONYVATT73Q`
- Bedrock model ARN: `arn:aws:bedrock:ap-northeast-1:392749559673:inference-profile/jp.anthropic.claude-sonnet-4-6`

## 重要な環境変数

`.env.local` またはAmplify環境変数に以下が必要。

```env
AWS_PROFILE=dental-dev
APP_AWS_REGION=ap-northeast-1
APP_TEXTRACT_REGION=ap-northeast-2
S3_BUCKET_NAME=dental-manuals-dev-392749559673-apne1
S3_FILE_PREFIX=manuals/
S3_MANUAL_PREFIX=manuals/
S3_METADATA_PREFIX=metadata/
APP_TEXTRACT_BUCKET_NAME=dental-manuals-ocr-dev-392749559673-apne2
APP_PREPARE_STATE_MACHINE_ARN=...
APP_SUMMARY_STATE_MACHINE_ARN=...
BEDROCK_KNOWLEDGE_BASE_ID=PUQQYKIB70
BEDROCK_DATA_SOURCE_ID=ONYVATT73Q
BEDROCK_MODEL_ARN=arn:aws:bedrock:ap-northeast-1:392749559673:inference-profile/jp.anthropic.claude-sonnet-4-6
APP_SHARE_PASSWORD=...
APP_AUTH_SECRET=...
```

注意:
- `S3_FILE_PREFIX` は新しい名前。既存互換のため `S3_MANUAL_PREFIX` も読める。
- S3上の既存実体キーは `manuals/` のまま維持する。勝手に移動しない。

## 壊してはいけないメタデータ契約

OCR、要約、RAGで以下のキーを使っている。名前や意味を変えない。

- `id`
- `fileName`
- `s3Key`
- `contentType`
- `extractedTextKey`
- `summaryKey`
- `knowledgeBaseKey`
- `textExtractionStatus`
- `textExtractionSource`
- `preparationStatus`
- `summaryStatus`
- `ragSyncStatus`
- `ragSyncJobId`
- `textractJobId`
- `uploadedAt`

旧分類フィールドは廃止済み。

- `categoryIds`
- `categories`
- `clinicalAreaIds`
- `clinicalAreas`
- `roleIds`
- `roles`

既存JSONに旧分類フィールドが残っていても、`normalizeFileMetadata()` で無視する。

## 要約処理の現在仕様

- 要約は9項目固定ではない。
- 要約は目次、章、節、見出しごとに作る。
- 各見出しの本文は400字程度、最大400字以内を目標にする。
- 長文資料ではチャンクごとに章別要約を作り、最後はLLMで再統合しない。
- 最終要約は各チャンクの章別要約を単純連結する。
- 「病気の解説」「原因」「病態」「治療法」などの固定9項目分類に戻さない。

## Lambda Layerアーキテクチャ

依存パッケージはLambda Layerで管理する。**handler.pyのみをzipしてデプロイすればよい。**
パッケージ（google-cloud-documentai、PyMuPDF等）をzipに含めてはいけない。

| Layer ARN | 用途 | アタッチ先 |
|---|---|---|
| `arn:aws:lambda:ap-northeast-1:392749559673:layer:dental-docai-layer:1` | google-cloud-documentai + pypdf | dental-summary-worker-dev |
| `arn:aws:lambda:ap-northeast-1:392749559673:layer:dental-pymupdf-layer:1` | PyMuPDF 1.24.5 | dental-image-processor-dev |

Layerのパッケージを更新する場合は `lambda/layers/` 以下を修正して新バージョンを publish する。

## Lambda更新手順

### dental-summary-worker-dev

```powershell
Compress-Archive -LiteralPath .\lambda\summary_worker\handler.py -DestinationPath .\lambda\summary_worker_docai.zip -Force

aws lambda update-function-code `
  --function-name dental-summary-worker-dev `
  --zip-file fileb://lambda/summary_worker_docai.zip `
  --profile dental-dev `
  --region ap-northeast-1 `
  --query "{LastUpdateStatus:LastUpdateStatus,CodeSha256:CodeSha256}"

Remove-Item -LiteralPath .\lambda\summary_worker_docai.zip -Force
```

### dental-image-processor-dev

```powershell
Compress-Archive -LiteralPath .\lambda\image_processor\handler.py -DestinationPath .\lambda\image_processor.zip -Force

aws lambda update-function-code `
  --function-name dental-image-processor-dev `
  --zip-file fileb://lambda/image_processor.zip `
  --profile dental-dev `
  --region ap-northeast-1 `
  --query "{LastUpdateStatus:LastUpdateStatus,CodeSha256:CodeSha256}"

Remove-Item -LiteralPath .\lambda\image_processor.zip -Force
```

`LastUpdateStatus` が `Successful` になることを確認する。

## 検証コマンド

```powershell
npm run lint
npm run build
C:\Users\1107s\anaconda3\python.exe -m py_compile lambda\summary_worker\handler.py
```

## 作業時の注意

- 既存のS3オブジェクトキーを移動しない。
- `metadata/{id}.json` の必須処理キーを削らない。
- RAG用の `kb/{id}.md`、要約用の `summaries/{id}.md`、OCRテキスト用の `summaries/ocr-text/{id}.txt` の保存先を勝手に変えない。
- Lambda変更をしたら、必ずAWS上のLambdaにも反映する。
- Amplify SSRアプリに手動アップロードデプロイを使わない。
