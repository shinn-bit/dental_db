# AWS runtime authentication

このアプリはAWS SDK for JavaScriptの標準認証チェーンを使う。

## ローカル開発

ローカルでは `.env.local` に `AWS_PROFILE=dental-dev` を設定してよい。この場合はSSOキャッシュに依存するため、期限切れ時は再ログインが必要。

```powershell
aws sso login --profile dental-dev
aws sts get-caller-identity --profile dental-dev
aws s3 ls s3://dental-manuals-dev-392749559673-apne1/metadata/ --profile dental-dev
```

## Amplify / CI / サービス実行

サービス実行環境では `AWS_PROFILE` を設定しない。実行ロール、またはOIDCでAssumeRoleした一時クレデンシャルを環境から渡す。

Amplify Hosting SSRでは、アプリ実行ロールに `infra/app-runtime-role-policy.json` 相当の権限を付与する。環境変数には以下だけを設定する。

```text
APP_AWS_REGION=ap-northeast-1
APP_TEXTRACT_REGION=ap-northeast-2
APP_TEXTRACT_BUCKET_NAME=dental-manuals-ocr-dev-392749559673-apne2
S3_BUCKET_NAME=dental-manuals-dev-392749559673-apne1
S3_MANUAL_PREFIX=manuals/
S3_METADATA_PREFIX=metadata/
BEDROCK_KNOWLEDGE_BASE_ID=DSRZ1WUOS5
BEDROCK_DATA_SOURCE_ID=U64XPQTAS2
BEDROCK_MODEL_ARN=arn:aws:bedrock:ap-northeast-1:392749559673:inference-profile/jp.amazon.nova-2-lite-v1:0
APP_SHARE_PASSWORD=...
APP_AUTH_SECRET=...
```

GitHub ActionsなどのCIからAWSを操作する場合は、長期アクセスキーではなくGitHub OIDCで専用IAMロールをAssumeRoleする。

## スキャンPDFのOCR

PDF本文を `pdf-parse` で十分に抽出できない場合は、AWS Textractの `StartDocumentTextDetection` / `GetDocumentTextDetection` にフォールバックする。TextractはS3上のPDFを読むため、Amplify SSR Compute roleにはS3読み取り権限とTextract実行権限の両方が必要。Textract入力用には `APP_TEXTRACT_BUCKET_NAME` の別バケットを使い、PDFをいったんそこへコピーしてからOCRする。

`pdf-parse` がページ番号や区切りだけを返すPDFもあるため、抽出文字数だけでなく、ページ数に対して十分な本文があるかを見てOCR要否を判定する。

要約作成は同期完了待ちではなく、状態保存型で進める。APIは最初にPDF本文抽出またはTextractジョブ開始を行い、以後の状態確認でOCR完了確認、OCRテキスト保存、要約生成を進める。OCRテキストは `manuals/ocr-text/` に保存し、Bedrock Knowledge BaseのS3データソース同期対象に含める。
