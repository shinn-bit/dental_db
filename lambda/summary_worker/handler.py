import json
import os
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError


SUMMARY_TEMPLATE = """
以下のPDF本文を、歯科医院の院内教育・診療補助に使えるようにMarkdownで要約してください。
必ず次の9項目をこの順番で見出しとして出力してください。本文に根拠がない項目は「資料内では確認できません」と書いてください。

## 1. 病気の解説
## 2. 原因
## 3. 病態、所見
## 4. 患者の訴えること、症状
## 5. 当日の処置（応急処置）
## 6. 治療法
## 7. 治療の具体的なステップ
## 8. 予防、術後のメンテナンス
## 9. その他注意すべきこと

条件:
- 日本語で出力
- 現場スタッフが読んで使える具体性にする
- 資料にない内容を推測で補わない
- 箇条書きを適度に使う
"""

MIN_EXTRACTED_TEXT_LENGTH = 100


def env(name, default=""):
    value = os.environ.get(name, default)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


AWS_REGION = os.environ.get("APP_AWS_REGION") or os.environ.get("AWS_REGION") or "ap-northeast-1"
TEXTRACT_REGION = os.environ.get("APP_TEXTRACT_REGION") or os.environ.get("TEXTRACT_REGION") or "ap-northeast-2"

s3 = boto3.client("s3", region_name=AWS_REGION)
textract_s3 = boto3.client("s3", region_name=TEXTRACT_REGION)
textract = boto3.client("textract", region_name=TEXTRACT_REGION)
bedrock = boto3.client("bedrock-runtime", region_name=AWS_REGION)


def metadata_key(file_id):
    return f"{os.environ.get('S3_METADATA_PREFIX', 'metadata/')}{file_id}.json"


def textract_input_key(file_id):
    return f"textract-input/{file_id}.pdf"


def ocr_text_key(file_id):
    return f"summaries/ocr-text/{file_id}.txt"


def summary_key(file_id):
    return f"summaries/{file_id}.md"


def knowledge_base_key(file_id):
    return f"kb/{file_id}.md"


def get_metadata(file_id):
    response = s3.get_object(Bucket=env("S3_BUCKET_NAME"), Key=metadata_key(file_id))
    return json.loads(response["Body"].read().decode("utf-8-sig"))


def save_metadata(metadata):
    s3.put_object(
        Bucket=env("S3_BUCKET_NAME"),
        Key=metadata_key(metadata["id"]),
        Body=json.dumps(metadata, ensure_ascii=False, indent=2).encode("utf-8"),
        ContentType="application/json; charset=utf-8",
    )


def put_text(bucket, key, text, content_type):
    s3.put_object(
        Bucket=bucket,
        Key=key,
        Body=text.encode("utf-8"),
        ContentType=content_type,
    )


def get_text(bucket, key):
    response = s3.get_object(Bucket=bucket, Key=key)
    return response["Body"].read().decode("utf-8")


def fail_metadata(metadata, message, text_status=None):
    metadata["summaryStatus"] = "failed"
    metadata["summaryError"] = message
    if text_status:
        metadata["textExtractionStatus"] = text_status
    save_metadata(metadata)
    return {"fileId": metadata["id"], "status": "FAILED", "error": message}


def start_ocr(event):
    file_id = event["fileId"]
    bucket = env("S3_BUCKET_NAME")
    staging_bucket = env("APP_TEXTRACT_BUCKET_NAME")
    metadata = get_metadata(file_id)

    if metadata.get("summaryStatus") == "completed" and metadata.get("summaryKey"):
        return {"fileId": file_id, "status": "ALREADY_COMPLETED"}

    if metadata.get("extractedTextKey"):
        return {"fileId": file_id, "status": "TEXT_READY"}

    if metadata.get("textractJobId") and metadata.get("textExtractionStatus") == "processing":
        return {"fileId": file_id, "status": "OCR_STARTED", "textractJobId": metadata["textractJobId"]}

    staging_key = textract_input_key(file_id)
    source = s3.get_object(Bucket=bucket, Key=metadata["s3Key"])
    textract_s3.put_object(
        Bucket=staging_bucket,
        Key=staging_key,
        Body=source["Body"].read(),
        ContentType=metadata.get("contentType") or "application/pdf",
    )

    response = textract.start_document_text_detection(
        DocumentLocation={"S3Object": {"Bucket": staging_bucket, "Name": staging_key}}
    )
    job_id = response.get("JobId")
    if not job_id:
        return fail_metadata(metadata, "Textract OCRジョブを開始できませんでした。", "failed")

    metadata.update(
        {
            "summaryStatus": "processing",
            "summaryError": "",
            "textExtractionStatus": "processing",
            "textExtractionSource": "ocr",
            "extractedTextLength": 0,
            "textractJobId": job_id,
        }
    )
    save_metadata(metadata)

    return {"fileId": file_id, "status": "OCR_STARTED", "textractJobId": job_id}


def check_ocr(event):
    file_id = event["fileId"]
    bucket = env("S3_BUCKET_NAME")
    staging_bucket = env("APP_TEXTRACT_BUCKET_NAME")
    metadata = get_metadata(file_id)

    if metadata.get("extractedTextKey"):
        return {"fileId": file_id, "ocrStatus": "SUCCEEDED"}

    job_id = metadata.get("textractJobId")
    if not job_id:
        return fail_metadata(metadata, "Textract OCRジョブIDが見つかりません。", "failed")

    lines = []
    next_token = None
    while True:
        request = {"JobId": job_id}
        if next_token:
            request["NextToken"] = next_token
        response = textract.get_document_text_detection(**request)
        job_status = response.get("JobStatus")

        if job_status == "IN_PROGRESS":
            return {"fileId": file_id, "ocrStatus": "IN_PROGRESS"}

        if job_status in ("FAILED", "PARTIAL_SUCCESS"):
            message = response.get("StatusMessage") or f"Textract OCRジョブが{job_status}で終了しました。"
            return fail_metadata(metadata, message, "failed")

        for block in response.get("Blocks", []):
            if block.get("BlockType") == "LINE" and block.get("Text"):
                lines.append(block["Text"])

        next_token = response.get("NextToken")
        if not next_token:
            break

    text = "\n".join(lines).strip()
    key = ocr_text_key(file_id)
    put_text(bucket, key, text, "text/plain; charset=utf-8")
    metadata.update(
        {
            "textExtractionStatus": "completed",
            "textExtractionSource": "ocr",
            "extractedTextKey": key,
            "extractedTextLength": len(text),
            "textractJobId": "",
        }
    )
    save_metadata(metadata)

    try:
        textract_s3.delete_object(Bucket=staging_bucket, Key=textract_input_key(file_id))
    except ClientError:
        pass

    return {"fileId": file_id, "ocrStatus": "SUCCEEDED"}


def create_knowledge_base_document(summary):
    normalized = "\n".join(line.rstrip() for line in summary.replace("\r\n", "\n").split("\n"))
    while "\n\n\n" in normalized:
        normalized = normalized.replace("\n\n\n", "\n\n")
    return normalized.strip()[:1800]


def invoke_bedrock_summary(text):
    prompt = f"{SUMMARY_TEMPLATE}\n\nPDF本文:\n{text[:180000]}"
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 4096,
        "temperature": 0.2,
        "messages": [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
    }
    response = bedrock.invoke_model(
        modelId=env("BEDROCK_MODEL_ARN"),
        body=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        contentType="application/json",
        accept="application/json",
    )
    payload = json.loads(response["body"].read().decode("utf-8"))
    return "\n".join(item.get("text", "") for item in payload.get("content", []) if item.get("type") == "text").strip()


def generate_summary(event):
    file_id = event["fileId"]
    bucket = env("S3_BUCKET_NAME")
    metadata = get_metadata(file_id)

    if metadata.get("summaryStatus") == "completed" and metadata.get("summaryKey"):
        return {"fileId": file_id, "status": "ALREADY_COMPLETED"}

    extracted_key = metadata.get("extractedTextKey")
    if not extracted_key:
        return fail_metadata(metadata, "OCR結果の保存先が見つかりません。")

    extracted_text = get_text(bucket, extracted_key)
    if len(extracted_text) < MIN_EXTRACTED_TEXT_LENGTH:
        return fail_metadata(metadata, "OCR後もPDFから十分なテキストを抽出できませんでした。")

    summary = invoke_bedrock_summary(extracted_text)
    if not summary:
        return fail_metadata(metadata, "Bedrockから要約本文が返りませんでした。")

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    summary_s3_key = summary_key(file_id)
    kb_s3_key = knowledge_base_key(file_id)

    put_text(bucket, summary_s3_key, summary, "text/markdown; charset=utf-8")
    put_text(bucket, kb_s3_key, create_knowledge_base_document(summary), "text/markdown; charset=utf-8")
    metadata.update(
        {
            "summary": summary,
            "summaryStatus": "completed",
            "summaryError": "",
            "summaryKey": summary_s3_key,
            "knowledgeBaseKey": kb_s3_key,
            "summaryUpdatedAt": now,
        }
    )
    save_metadata(metadata)

    return {"fileId": file_id, "status": "COMPLETED"}


def handler(event, _context):
    action = event.get("action")
    if action == "start_ocr":
        return start_ocr(event)
    if action == "check_ocr":
        return check_ocr(event)
    if action == "generate_summary":
        return generate_summary(event)
    raise ValueError(f"Unknown action: {action}")
