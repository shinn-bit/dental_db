# One-time setup for dental-lexical-search-dev (ASCII only: Windows PowerShell 5.1 reads BOM-less files as Shift-JIS)
#   1. Create IAM role for the Lambda (search-index/ rw, kb/ read, S3 Vectors read, ingestion status, self-invoke)
#   2. Create the Lambda function
#   3. Allow the Amplify SSR role to invoke it (adds one ARN to the existing LambdaInvoke statement)
#   4. Build the initial index
# Later code updates: zip handler.py only and run update-function-code.
$ErrorActionPreference = "Stop"
$Profile_ = "dental-dev"
$Region = "ap-northeast-1"
$Account = "392749559673"
$Bucket = "dental-manuals-dev-392749559673-apne1"
$Fn = "dental-lexical-search-dev"
$Role = "DentalLexicalSearchRoleDev"
$SsrRole = "AmplifySSRLoggingRole-97467dde-d1c0-41ec-ae2b-6d8bc69be439"
$SsrPolicy = "DentalDatabaseRuntimeAccess"
$Work = Join-Path $env:TEMP "lexical-setup"
New-Item -ItemType Directory -Force $Work | Out-Null

# --- 1. IAM role ---
@'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}
'@ | Out-File -Encoding ascii "$Work\trust.json"

@"
{"Version":"2012-10-17","Statement":[
 {"Sid":"IndexObjects","Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject"],"Resource":"arn:aws:s3:::$Bucket/search-index/*"},
 {"Sid":"KbDocumentsRead","Effect":"Allow","Action":"s3:GetObject","Resource":"arn:aws:s3:::$Bucket/kb/*"},
 {"Sid":"BucketList","Effect":"Allow","Action":"s3:ListBucket","Resource":"arn:aws:s3:::$Bucket","Condition":{"StringLike":{"s3:prefix":["kb/*","search-index/*"]}}},
 {"Sid":"VectorsRead","Effect":"Allow","Action":["s3vectors:ListVectors","s3vectors:GetVectors"],"Resource":"arn:aws:s3vectors:${Region}:${Account}:bucket/dental-manuals-kb-dev-392749559673/index/dental-manuals-index-dev-v2"},
 {"Sid":"IngestionStatus","Effect":"Allow","Action":"bedrock:ListIngestionJobs","Resource":"arn:aws:bedrock:${Region}:${Account}:knowledge-base/PUQQYKIB70"},
 {"Sid":"SelfInvoke","Effect":"Allow","Action":"lambda:InvokeFunction","Resource":"arn:aws:lambda:${Region}:${Account}:function:$Fn"}
]}
"@ | Out-File -Encoding ascii "$Work\policy.json"

$RoleArn = aws iam create-role --role-name $Role --assume-role-policy-document "file://$Work/trust.json" --profile $Profile_ --query Role.Arn --output text
aws iam attach-role-policy --role-name $Role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole --profile $Profile_
aws iam put-role-policy --role-name $Role --policy-name dental-lexical-search-access --policy-document "file://$Work/policy.json" --profile $Profile_
Write-Host "Role: $RoleArn (waiting 15s for IAM propagation)"
Start-Sleep -Seconds 15

# --- 2. Lambda function ---
Compress-Archive -LiteralPath (Join-Path $PSScriptRoot "handler.py") -DestinationPath "$Work\lexical_search.zip" -Force
aws lambda create-function `
  --function-name $Fn `
  --runtime python3.13 `
  --handler handler.handler `
  --role $RoleArn `
  --zip-file "fileb://$Work/lexical_search.zip" `
  --memory-size 1536 `
  --timeout 300 `
  --ephemeral-storage Size=2048 `
  --environment "Variables={S3_BUCKET_NAME=$Bucket,VECTOR_BUCKET_NAME=dental-manuals-kb-dev-392749559673,VECTOR_INDEX_NAME=dental-manuals-index-dev-v2,BEDROCK_KNOWLEDGE_BASE_ID=PUQQYKIB70,BEDROCK_DATA_SOURCE_ID=ONYVATT73Q}" `
  --profile $Profile_ --region $Region `
  --query "{State:State,FunctionArn:FunctionArn}"
aws lambda wait function-active-v2 --function-name $Fn --profile $Profile_ --region $Region

# --- 3. Allow Amplify SSR role to invoke the function ---
aws iam get-role-policy --role-name $SsrRole --policy-name $SsrPolicy --profile $Profile_ --query PolicyDocument --output json | Out-File -Encoding ascii "$Work\ssr-before.json"
python -c @"
import json, sys
p = json.load(open(r'$Work\ssr-before.json'))
arn = 'arn:aws:lambda:${Region}:${Account}:function:$Fn'
for s in p['Statement']:
    if s.get('Sid') == 'LambdaInvoke':
        res = s['Resource'] if isinstance(s['Resource'], list) else [s['Resource']]
        if arn not in res: res.append(arn)
        s['Resource'] = res
        break
else:
    sys.exit('LambdaInvoke statement not found')
json.dump(p, open(r'$Work\ssr-after.json', 'w'), indent=1)
"@
aws iam put-role-policy --role-name $SsrRole --policy-name $SsrPolicy --policy-document "file://$Work/ssr-after.json" --profile $Profile_
Write-Host "Added InvokeFunction permission to SSR role (backup: $Work\ssr-before.json)"

# --- 4. Initial index build (1-2 min) ---
'{"action":"rebuild"}' | Out-File -Encoding ascii "$Work\rebuild-payload.json"
aws lambda invoke --function-name $Fn --payload "fileb://$Work/rebuild-payload.json" --cli-read-timeout 310 --profile $Profile_ --region $Region "$Work\rebuild-out.json" | Out-Null
Get-Content "$Work\rebuild-out.json"
