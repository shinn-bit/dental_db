# dental-image-processor-dev のデプロイスクリプト
# 既存の dental-summary-worker-dev には一切触れない
#
# 使い方:
#   cd dental_database
#   .\lambda\deploy_image_processor.ps1

$ErrorActionPreference = "Stop"
$FunctionName = "dental-image-processor-dev"
$Region = "ap-northeast-1"
$Profile = "dental-dev"
$S3Bucket = "dental-manuals-dev-392749559673-apne1"
$AccountId = "392749559673"
$BedrockModelArn = "arn:aws:bedrock:ap-northeast-1:392749559673:inference-profile/jp.anthropic.claude-sonnet-4-6"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HandlerDir = Join-Path $ScriptDir "image_processor"
$PackageDir = Join-Path $HandlerDir "package"
$ZipPath = Join-Path $HandlerDir "image_processor.zip"

Write-Host "=== dental-image-processor-dev デプロイ ===" -ForegroundColor Cyan

# 1. パッケージディレクトリをクリーン
if (Test-Path $PackageDir) {
    Remove-Item -Recurse -Force $PackageDir
}
New-Item -ItemType Directory -Path $PackageDir | Out-Null

# 2. PyMuPDF を Amazon Linux 2 (x86_64) 向けにインストール
# Windows からでも --platform オプションでクロスコンパイル可能
Write-Host "PyMuPDF を Linux x86_64 向けにインストール中..." -ForegroundColor Yellow
pip install PyMuPDF==1.24.5 `
    --platform manylinux2014_x86_64 `
    --target $PackageDir `
    --only-binary :all: `
    --python-version 3.12 `
    --quiet

if ($LASTEXITCODE -ne 0) {
    Write-Host "pip install 失敗" -ForegroundColor Red
    exit 1
}

# 3. handler.py をパッケージにコピー
Copy-Item (Join-Path $HandlerDir "handler.py") $PackageDir

# 4. ZIP 作成
if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }
Compress-Archive -Path "$PackageDir\*" -DestinationPath $ZipPath -Force
Write-Host "ZIP 作成完了: $ZipPath" -ForegroundColor Green

# 5. Lambda が存在するか確認
$FunctionExists = $true
try {
    aws lambda get-function --function-name $FunctionName --profile $Profile --region $Region 2>&1 | Out-Null
} catch {
    $FunctionExists = $false
}

$LambdaExists = (aws lambda get-function --function-name $FunctionName --profile $Profile --region $Region 2>&1) -notmatch "Function not found"

if ($LambdaExists) {
    # 6a. 既存関数のコードを更新
    Write-Host "Lambda コードを更新中..." -ForegroundColor Yellow
    aws lambda update-function-code `
        --function-name $FunctionName `
        --zip-file "fileb://$ZipPath" `
        --profile $Profile `
        --region $Region | Out-Null
} else {
    # 6b. 新規作成（IAMロールは dental-summary-worker-dev と同じものを使用）
    Write-Host "Lambda 関数を新規作成中..." -ForegroundColor Yellow

    # 既存 Lambda の IAM ロールを取得
    $ExistingRole = aws lambda get-function-configuration `
        --function-name dental-summary-worker-dev `
        --profile $Profile --region $Region `
        --query "Role" --output text

    Write-Host "使用する IAM ロール: $ExistingRole"

    aws lambda create-function `
        --function-name $FunctionName `
        --runtime python3.12 `
        --role $ExistingRole `
        --handler handler.handler `
        --zip-file "fileb://$ZipPath" `
        --timeout 600 `
        --memory-size 512 `
        --environment "Variables={
            APP_AWS_REGION=$Region,
            S3_BUCKET_NAME=$S3Bucket,
            S3_METADATA_PREFIX=metadata/,
            BEDROCK_MODEL_ARN=$BedrockModelArn,
            BEDROCK_VISION_MODEL_ARN=$BedrockModelArn
        }" `
        --profile $Profile `
        --region $Region | Out-Null
}

# 7. デプロイ完了確認
Write-Host "デプロイ確認中..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

aws lambda get-function-configuration `
    --function-name $FunctionName `
    --profile $Profile `
    --region $Region `
    --query "{LastUpdateStatus:LastUpdateStatus,LastModified:LastModified,Runtime:Runtime,Timeout:Timeout,MemorySize:MemorySize}"

# 8. ZIP クリーンアップ
Remove-Item -Force $ZipPath
Remove-Item -Recurse -Force $PackageDir
Write-Host "=== デプロイ完了 ===" -ForegroundColor Green
Write-Host ""
Write-Host "テスト実行:" -ForegroundColor Cyan
Write-Host "aws lambda invoke --function-name $FunctionName --payload '{`"fileId`":`"<FILE_ID>`"}' out.json --profile $Profile --region $Region"
