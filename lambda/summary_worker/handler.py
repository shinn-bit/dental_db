import json
import os
import time
from datetime import datetime, timezone

import boto3
from botocore.config import Config
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
SUMMARY_CHUNK_SIZE = 25000
SUMMARY_CHUNK_OVERLAP = 1500

CHUNK_MATERIAL_TEMPLATE = """
以下は歯科資料本文の一部です。最終的には院内教育・診療補助用の9項目要約に統合します。
この段階では9項目の完成形に無理に当てはめず、最終要約に使える材料をMarkdownで抽出してください。

出力ルール:
- 日本語で出力
- 資料に書かれている内容だけを書く
- 推測で補わない
- 重複はできるだけ避ける
- この範囲にない内容は「この範囲では確認できません」と書く
- 数値、手順、分類、注意点、器材名、診断基準など具体情報を優先する

見出しは次の順番にしてください。

## この範囲の主題
## 重要概念・定義
## 疾患・病態に関する情報
## 原因・リスク因子
## 症状・所見・診断
## 当日の対応・処置
## 治療法・具体的手順
## 予防・メンテナンス
## 注意点・禁忌・失敗しやすい点
## 最終9項目要約に残すべき具体情報
"""

FINAL_SUMMARY_FROM_MATERIALS_TEMPLATE = """
以下はPDF全文を分割して抽出した材料メモです。
これらを統合し、歯科医院の院内教育・診療補助に使えるMarkdown要約を作成してください。

必ず次の9項目をこの順番で見出しとして出力してください。材料メモに根拠がない項目は「資料内では確認できません」と書いてください。

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
- 重複する内容は統合する
- 箇条書きや表を適度に使う
"""


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
bedrock = boto3.client(
    "bedrock-runtime",
    region_name=AWS_REGION,
    config=Config(connect_timeout=10, read_timeout=240, retries={"max_attempts": 1}),
)
bedrock_agent = boto3.client("bedrock-agent", region_name=AWS_REGION)


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


def chunk_materials_key(file_id):
    return f"summaries/chunk-materials/{file_id}.json"


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


def fail_preparation(metadata, message, text_status=None):
    metadata["preparationStatus"] = "failed"
    metadata["preparationError"] = message
    if metadata.get("ragSyncStatus") == "syncing":
        metadata["ragSyncStatus"] = "failed"
    if text_status:
        metadata["textExtractionStatus"] = text_status
    save_metadata(metadata)
    return {"fileId": metadata["id"], "status": "FAILED", "error": message}


def start_ocr(event):
    file_id = event["fileId"]
    bucket = env("S3_BUCKET_NAME")
    staging_bucket = env("APP_TEXTRACT_BUCKET_NAME")
    metadata = get_metadata(file_id)
    is_prepare = event.get("workflow") == "prepare"

    if not is_prepare and metadata.get("summaryStatus") == "completed" and metadata.get("summaryKey"):
        return {"fileId": file_id, "status": "ALREADY_COMPLETED"}

    if metadata.get("extractedTextKey"):
        if is_prepare:
            metadata["preparationStatus"] = "processing"
            metadata["preparationError"] = ""
            save_metadata(metadata)
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
        if is_prepare:
            return fail_preparation(metadata, "Textract OCRジョブを開始できませんでした。", "failed")
        return fail_metadata(metadata, "Textract OCRジョブを開始できませんでした。", "failed")

    next_values = {
        "textExtractionStatus": "processing",
        "textExtractionSource": "ocr",
        "extractedTextLength": 0,
        "textractJobId": job_id,
    }
    if is_prepare:
        next_values.update({"preparationStatus": "processing", "preparationError": ""})
    else:
        next_values.update({"summaryStatus": "processing", "summaryError": ""})
    metadata.update(next_values)
    save_metadata(metadata)

    return {"fileId": file_id, "status": "OCR_STARTED", "textractJobId": job_id}


def check_ocr(event):
    file_id = event["fileId"]
    bucket = env("S3_BUCKET_NAME")
    staging_bucket = env("APP_TEXTRACT_BUCKET_NAME")
    metadata = get_metadata(file_id)
    is_prepare = event.get("workflow") == "prepare"

    if metadata.get("extractedTextKey"):
        return {"fileId": file_id, "ocrStatus": "SUCCEEDED"}

    job_id = metadata.get("textractJobId")
    if not job_id:
        if is_prepare:
            return fail_preparation(metadata, "Textract OCRジョブIDが見つかりません。", "failed")
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
            if is_prepare:
                return fail_preparation(metadata, message, "failed")
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


def create_knowledge_base_document_from_text(metadata, text):
    normalized = "\n".join(line.rstrip() for line in text.replace("\r\n", "\n").split("\n")).strip()
    header = [
        f"# {metadata.get('fileName') or '院内資料'}",
        "",
        f"- タグ: {', '.join(metadata.get('tags') or []) or '未設定'}",
    ]
    if metadata.get("version"):
        header.append(f"- 版: {metadata.get('version')}")
    if metadata.get("memo"):
        header.extend(["", f"## メモ\n{metadata.get('memo')}"])
    header.extend(["", "## 抽出本文", normalized])
    return "\n".join(header).strip()


def create_kb_document(event):
    file_id = event["fileId"]
    bucket = env("S3_BUCKET_NAME")
    metadata = get_metadata(file_id)
    extracted_key = metadata.get("extractedTextKey")
    if not extracted_key:
        return fail_preparation(metadata, "OCR結果の保存先が見つかりません。")

    extracted_text = get_text(bucket, extracted_key)
    if len(extracted_text) < MIN_EXTRACTED_TEXT_LENGTH:
        return fail_preparation(metadata, "OCR後もPDFから十分なテキストを抽出できませんでした。")

    kb_s3_key = knowledge_base_key(file_id)
    put_text(
        bucket,
        kb_s3_key,
        create_knowledge_base_document_from_text(metadata, extracted_text),
        "text/markdown; charset=utf-8",
    )
    metadata.update(
        {
            "knowledgeBaseKey": kb_s3_key,
            "preparationStatus": "syncing",
            "preparationError": "",
            "ragSyncStatus": "not_started",
            "ragSyncJobId": "",
        }
    )
    save_metadata(metadata)
    return {"fileId": file_id, "status": "KB_DOCUMENT_CREATED", "knowledgeBaseKey": kb_s3_key}


def start_kb_sync(event):
    file_id = event["fileId"]
    metadata = get_metadata(file_id)
    try:
        response = bedrock_agent.start_ingestion_job(
            knowledgeBaseId=env("BEDROCK_KNOWLEDGE_BASE_ID"),
            dataSourceId=env("BEDROCK_DATA_SOURCE_ID"),
            description=f"Prepare repository file {file_id}",
        )
    except Exception as error:
        return fail_preparation(metadata, f"Bedrock KB同期ジョブを開始できませんでした: {error}")

    job = response.get("ingestionJob") or {}
    job_id = job.get("ingestionJobId", "")
    metadata.update(
        {
            "preparationStatus": "syncing",
            "preparationError": "",
            "ragSyncStatus": "syncing",
            "ragSyncJobId": job_id,
        }
    )
    save_metadata(metadata)
    return {"fileId": file_id, "status": "SYNC_STARTED", "ingestionJobId": job_id}


def check_kb_sync(event):
    file_id = event["fileId"]
    metadata = get_metadata(file_id)
    job_id = event.get("ingestionJobId") or metadata.get("ragSyncJobId")
    if not job_id:
        return fail_preparation(metadata, "Bedrock KB同期ジョブIDが見つかりません。")

    response = bedrock_agent.get_ingestion_job(
        knowledgeBaseId=env("BEDROCK_KNOWLEDGE_BASE_ID"),
        dataSourceId=env("BEDROCK_DATA_SOURCE_ID"),
        ingestionJobId=job_id,
    )
    job = response.get("ingestionJob") or {}
    status = job.get("status")
    if status in ("STARTING", "IN_PROGRESS"):
        return {"fileId": file_id, "syncStatus": "IN_PROGRESS", "ingestionJobId": job_id}
    if status == "COMPLETE":
        metadata.update(
            {
                "preparationStatus": "completed",
                "preparationError": "",
                "ragSyncStatus": "completed",
                "ragSyncJobId": job_id,
                "ragSyncedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            }
        )
        save_metadata(metadata)
        return {"fileId": file_id, "syncStatus": "COMPLETE", "ingestionJobId": job_id}

    message = job.get("failureReasons") or f"Bedrock KB同期ジョブが{status or 'UNKNOWN'}で終了しました。"
    return fail_preparation(metadata, str(message))


def invoke_bedrock(prompt, max_tokens=4096):
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": max_tokens,
        "temperature": 0.2,
        "messages": [{"role": "user", "content": [{"type": "text", "text": prompt}]}],
    }

    last_error = None
    for attempt in range(2):
        try:
            response = bedrock.invoke_model(
                modelId=env("BEDROCK_MODEL_ARN"),
                body=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                contentType="application/json",
                accept="application/json",
            )
            break
        except Exception as error:
            last_error = error
            if attempt == 1:
                raise
            time.sleep(3)

    if last_error and "response" not in locals():
        raise last_error

    payload = json.loads(response["body"].read().decode("utf-8"))
    return "\n".join(item.get("text", "") for item in payload.get("content", []) if item.get("type") == "text").strip()


def invoke_bedrock_summary(text):
    prompt = f"{SUMMARY_TEMPLATE}\n\nPDF本文:\n{text[:180000]}"
    return invoke_bedrock(prompt, max_tokens=4096)


def split_text_for_summary(text):
    normalized = text.replace("\r\n", "\n").strip()
    if len(normalized) <= SUMMARY_CHUNK_SIZE:
        return [normalized]

    chunks = []
    start = 0
    text_length = len(normalized)

    while start < text_length:
        hard_end = min(start + SUMMARY_CHUNK_SIZE, text_length)
        if hard_end == text_length:
            chunks.append(normalized[start:hard_end].strip())
            break

        search_start = max(start + int(SUMMARY_CHUNK_SIZE * 0.7), start)
        window = normalized[search_start:hard_end]
        split_offset = max(window.rfind("\n\n"), window.rfind("\n"), window.rfind("。"))
        end = hard_end if split_offset < 0 else search_start + split_offset + 1

        chunks.append(normalized[start:end].strip())
        next_start = max(end - SUMMARY_CHUNK_OVERLAP, start + 1)
        if next_start <= start:
            next_start = end
        start = next_start

    return [chunk for chunk in chunks if chunk]


def summarize_chunk(chunk, index, total):
    prompt = (
        f"{CHUNK_MATERIAL_TEMPLATE}\n\n"
        f"対象範囲: チャンク {index + 1}/{total}\n\n"
        f"PDF本文の一部:\n{chunk}"
    )
    return invoke_bedrock(prompt, max_tokens=2200)


def generate_summary_from_materials(materials):
    joined_materials = "\n\n".join(
        f"# 分割材料 {index + 1}\n{material}" for index, material in enumerate(materials)
    )
    prompt = f"{FINAL_SUMMARY_FROM_MATERIALS_TEMPLATE}\n\n分割材料メモ:\n{joined_materials}"
    return invoke_bedrock(prompt, max_tokens=4096)


def generate_chunked_summary(bucket, file_id, extracted_text):
    chunks = split_text_for_summary(extracted_text)
    if len(chunks) == 1:
        return invoke_bedrock_summary(extracted_text), []

    materials = []
    for index, chunk in enumerate(chunks):
        materials.append(summarize_chunk(chunk, index, len(chunks)))

    put_text(
        bucket,
        chunk_materials_key(file_id),
        json.dumps(
            {
                "fileId": file_id,
                "chunkSize": SUMMARY_CHUNK_SIZE,
                "chunkOverlap": SUMMARY_CHUNK_OVERLAP,
                "chunks": materials,
            },
            ensure_ascii=False,
            indent=2,
        ),
        "application/json; charset=utf-8",
    )
    return generate_summary_from_materials(materials), materials


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

    try:
        summary, materials = generate_chunked_summary(bucket, file_id, extracted_text)
    except Exception as error:
        return fail_metadata(metadata, f"Bedrock要約生成に失敗しました: {error}")
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
            "summaryChunkCount": len(materials) if materials else 1,
            "summaryChunkMaterialsKey": chunk_materials_key(file_id) if materials else "",
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
    if action == "create_kb_document":
        return create_kb_document(event)
    if action == "start_kb_sync":
        return start_kb_sync(event)
    if action == "check_kb_sync":
        return check_kb_sync(event)
    raise ValueError(f"Unknown action: {action}")
