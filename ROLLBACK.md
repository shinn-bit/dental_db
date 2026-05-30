# ロールバック手順

image-processing 機能実装前の安定状態への戻し方。
Claude へは「ROLLBACK.md を読んでロールバックして」と伝えれば対応できる。

## 安定ポイント

| 対象 | 識別子 |
|---|---|
| git コミット（画像機能完成版） | `3a53023` (Auto-trigger image processing + clean up UI) |
| ブランチ | `main` |
| 作業ブランチ | `feature/batch-image-processing` |
| image-processor Lambda バージョン | `1` (stable-before-batch-processing-2026-05-30) |
| 記録日 | 2026-05-30 |

## フロントエンド（Next.js / Amplify）のロールバック

```powershell
# 特定コミット以降の変更をまとめて取り消す
git revert --no-commit 7b3a7d2..HEAD
git commit -m "revert: rollback to stable state before image-processing"
git push origin main
# → Amplify が自動デプロイ（約5分）
```

または作業ブランチをそのまま捨てる場合：
```powershell
git checkout main
git branch -D feature/image-processing
git push origin main
```

## Lambda のロールバック

dental-summary-worker-dev は **触れない方針** のため基本不要。

**dental-image-processor-dev のロールバック（バッチ処理実装失敗時）：**
```powershell
# Lambda バージョン1（バッチ処理前の安定版）のコードURLを取得
aws lambda get-function --function-name dental-image-processor-dev:1 `
  --profile dental-dev --region ap-northeast-1 --query "Code.Location"

# feature/batch-image-processing ブランチを捨ててmainに戻す
git checkout main
git branch -D feature/batch-image-processing
git push origin --delete feature/batch-image-processing
```
もし万が一変更してしまった場合はバージョン `1` に戻す：

```powershell
# バージョン1のコードARNを確認
aws lambda get-function --function-name dental-summary-worker-dev:1 `
  --profile dental-dev --region ap-northeast-1 `
  --query "Code.Location"

# バージョン1のコードをダウンロードして再デプロイ
# （Lambda コンソール → dental-summary-worker-dev → バージョン → 1 → コードを展開して再デプロイ）
```

新規作成した `dental-image-processor-dev` だけを削除すれば既存は無傷：
```powershell
aws lambda delete-function `
  --function-name dental-image-processor-dev `
  --profile dental-dev --region ap-northeast-1
```

## S3 のロールバック

既存キーは一切変更しないため基本不要。
追加したファイルだけ削除したい場合：
```powershell
# images/ プレフィックスのオブジェクトをすべて削除
aws s3 rm s3://dental-manuals-dev-392749559673-apne1/images/ `
  --recursive --profile dental-dev
```

## metadata の images[] フィールド削除

既存コードは未知フィールドを無視するため削除不要。
ただし明示的に消したい場合は該当 metadata/{id}.json を手動編集。

## 確認コマンド

```powershell
# git の状態確認
git log --oneline -5
git status

# Lambda の状態確認
aws lambda get-function-configuration `
  --function-name dental-summary-worker-dev `
  --profile dental-dev --region ap-northeast-1 `
  --query "{LastModified:LastModified,CodeSha256:CodeSha256}"
```
