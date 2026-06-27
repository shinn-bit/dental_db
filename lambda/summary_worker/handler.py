import io
import json
import os
import time
from datetime import datetime, timezone

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError


SUMMARY_TEMPLATE = """
以下のPDF本文を、歯科医院の院内教育・診療補助に使えるように、目次・章・節ごとのMarkdown要約にしてください。
本文中に「【ページ N】」形式のページマーカーが含まれます。

出力形式:
- 資料名が読み取れる場合は最初に `# 資料名` を置く
- 以降は本文内の目次、章、節、見出し、番号付き項目に沿って `## 見出し名` で区切る
- 各見出しの本文は2000字以内
- 各見出しの本文は箇条書きを基本にする（項目数の制限なし、内容に応じて必要な分だけ書く）
- 章や節の見出しが不明な場合は、内容のまとまりから自然な見出しを付ける
- ページ番号や「第○章」「1-1」などが読み取れる場合は見出しに残す
- 各見出しの末尾に `（p.N〜p.M）` 形式でページ範囲を必ず記載する（ページマーカーがない場合は省略可）

内容ルール:
- 資料に書かれている内容だけを書く
- 推測、一般知識、外部知識で補わない
- 「病気の解説」「原因」「病態」「治療法」などの固定9項目には分類しない
- 本文に出てくる目次、章、節、見出しごとの要約だけを書く
- 手順、判断基準、禁忌、注意点、器材名、数値、患者説明に使える表現を優先する
- 画像・図表由来と思われる箇所で本文根拠が不足する場合は「資料内では確認できません」と書く
- 文字化けやOCR不良で読めない章は「OCR結果からは判読困難です」と書く
"""

MIN_EXTRACTED_TEXT_LENGTH = 100
SUMMARY_CHUNK_SIZE = 25000
SUMMARY_CHUNK_OVERLAP = 1500

CHUNK_MATERIAL_TEMPLATE = """
以下は歯科資料本文の一部です。最終的には資料全体の「目次・章・節ごとの2000字以内要約」に統合します。
本文中に「【ページ N】」形式のページマーカーが含まれます。
この段階では、対象範囲に含まれる章・節・見出し候補と、その要約材料をMarkdownで抽出してください。

出力ルール:
- 日本語で出力
- 資料に書かれている内容だけを書く
- 推測で補わない
- 「病気の解説」「原因」「病態」「治療法」などの固定9項目には分類しない
- この範囲にない内容は書かない
- 章・節・見出しが読み取れる場合は必ず残す
- 見出しが不明な場合は、内容のまとまりから仮見出しを付ける
- 各見出しの要約材料は2000字以内
- 数値、手順、分類、注意点、器材名、診断基準など具体情報を優先する
- 各見出しの末尾に `（p.N〜p.M）` 形式でページ範囲を記載する（ページマーカーがない場合は省略可）

出力形式:
## 見出し候補
- 要約材料...
（p.N〜p.M）
"""

def env(name, default=""):
    value = os.environ.get(name, default)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


AWS_REGION = os.environ.get("APP_AWS_REGION") or os.environ.get("AWS_REGION") or "ap-northeast-1"

GCP_PROJECT_ID    = os.environ.get("GCP_PROJECT_ID", "")
GCP_DOCAI_LOCATION = os.environ.get("GCP_DOCAI_LOCATION", "us")
GCP_PROCESSOR_ID  = os.environ.get("GCP_DOCAI_PROCESSOR_ID", "")
GCP_SECRET_NAME   = os.environ.get("GCP_CREDENTIALS_SECRET_NAME", "dental/gcp-docai-key")
DOCAI_BATCH_SIZE  = 15

s3 = boto3.client("s3", region_name=AWS_REGION)
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


def get_gcp_credentials():
    """AWS Secrets Manager から GCP サービスアカウントキーを取得して認証情報を返す。"""
    from google.oauth2 import service_account
    sm = boto3.client("secretsmanager", region_name=AWS_REGION)
    response = sm.get_secret_value(SecretId=GCP_SECRET_NAME)
    key_data = json.loads(response["SecretString"])
    return service_account.Credentials.from_service_account_info(
        key_data,
        scopes=["https://www.googleapis.com/auth/cloud-platform"],
    )


def run_docai_ocr(pdf_bytes):
    """Google Document AI でPDFをOCR処理してテキストを返す（15ページバッチ）。
    ページ境界に「【ページ N】」マーカーを挿入して返す。
    """
    from google.cloud import documentai
    from pypdf import PdfReader, PdfWriter

    credentials = get_gcp_credentials()
    client = documentai.DocumentProcessorServiceClient(credentials=credentials)
    name = client.processor_path(GCP_PROJECT_ID, GCP_DOCAI_LOCATION, GCP_PROCESSOR_ID)

    reader = PdfReader(io.BytesIO(pdf_bytes))
    total = len(reader.pages)
    all_parts = []

    for start in range(0, total, DOCAI_BATCH_SIZE):
        end = min(start + DOCAI_BATCH_SIZE, total)
        writer = PdfWriter()
        for page in reader.pages[start:end]:
            writer.add_page(page)
        buf = io.BytesIO()
        writer.write(buf)

        raw_doc = documentai.RawDocument(content=buf.getvalue(), mime_type="application/pdf")
        req = documentai.ProcessRequest(name=name, raw_document=raw_doc)
        result = client.process_document(request=req)

        full_text = result.document.text
        for i, page in enumerate(result.document.pages):
            actual_page_num = start + i + 1
            segs = (
                page.layout.text_anchor.text_segments
                if page.layout and page.layout.text_anchor
                else []
            )
            page_text = "".join(
                full_text[seg.start_index:seg.end_index] for seg in segs
            ).strip()
            all_parts.append(f"【ページ {actual_page_num}】\n{page_text}")

        if end < total:
            time.sleep(0.5)

    return "\n\n".join(all_parts)


def start_ocr(event):
    """Document AI でOCRを同期実行して抽出テキストをS3に保存する。"""
    file_id = event["fileId"]
    bucket = env("S3_BUCKET_NAME")
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

    next_values = {
        "textExtractionStatus": "processing",
        "textExtractionSource": "docai",
        "extractedTextLength": 0,
        "textractJobId": "",
    }
    if is_prepare:
        next_values.update({"preparationStatus": "processing", "preparationError": ""})
    else:
        next_values.update({"summaryStatus": "processing", "summaryError": ""})
    metadata.update(next_values)
    save_metadata(metadata)

    try:
        source = s3.get_object(Bucket=bucket, Key=metadata["s3Key"])
        pdf_bytes = source["Body"].read()
        text = run_docai_ocr(pdf_bytes)
    except Exception as exc:
        msg = f"Document AI OCRに失敗しました: {exc}"
        if is_prepare:
            return fail_preparation(metadata, msg, "failed")
        return fail_metadata(metadata, msg, "failed")

    key = ocr_text_key(file_id)
    put_text(bucket, key, text, "text/plain; charset=utf-8")
    metadata.update({
        "textExtractionStatus": "completed",
        "textExtractionSource": "docai",
        "extractedTextKey": key,
        "extractedTextLength": len(text),
        "textractJobId": "",
    })
    save_metadata(metadata)
    return {"fileId": file_id, "status": "TEXT_READY"}


def check_ocr(event):
    """Document AI はstart_ocr内で同期完了するためパススルー。"""
    return {"fileId": event["fileId"], "ocrStatus": "SUCCEEDED"}


def create_knowledge_base_document(summary):
    normalized = "\n".join(line.rstrip() for line in summary.replace("\r\n", "\n").split("\n"))
    while "\n\n\n" in normalized:
        normalized = normalized.replace("\n\n\n", "\n\n")
    return normalized.strip()


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
    # フォルダフィルタ用のメタデータサイドカーを生成（folderId未設定時は __none__）
    write_kb_metadata_sidecar(bucket, kb_s3_key, metadata.get("folderId") or "__none__")
    metadata.update(
        {
            "knowledgeBaseKey": kb_s3_key,
            "preparationStatus": "completed",
            "preparationError": "",
            "ragSyncStatus": "not_started",
            "ragSyncJobId": "",
        }
    )
    save_metadata(metadata)
    return {"fileId": file_id, "status": "KB_DOCUMENT_CREATED", "knowledgeBaseKey": kb_s3_key}


def write_kb_metadata_sidecar(bucket, kb_s3_key, folder_id):
    """Bedrock KB用のメタデータサイドカー（kb/{id}.md.metadata.json）を書き込む。
    folderId属性でフォルダ単位のretrievalフィルタを可能にする。"""
    sidecar = {"metadataAttributes": {"folderId": folder_id or "__none__"}}
    s3.put_object(
        Bucket=bucket,
        Key=f"{kb_s3_key}.metadata.json",
        Body=json.dumps(sidecar, ensure_ascii=False).encode("utf-8"),
        ContentType="application/json; charset=utf-8",
    )


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


def run_batch_kb_sync(event):
    """準備完了済みで未同期のファイルをまとめてKB同期する。UIまたは自動トリガーから呼ばれる。"""
    bucket = env("S3_BUCKET_NAME")
    metadata_prefix = os.environ.get("S3_METADATA_PREFIX", "metadata/")

    # 同期待ちファイルを収集
    pending_ids = []
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=metadata_prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if not key.endswith(".json"):
                continue
            file_id = key[len(metadata_prefix):][:-5]  # "metadata/" と ".json" を除去
            # UUID形式（8-4-4-4-12のハイフン区切り）以外はスキップ
            if not file_id or len(file_id) < 32 or "-" not in file_id:
                continue
            try:
                raw = s3.get_object(Bucket=bucket, Key=key)["Body"].read().decode("utf-8-sig")
                meta = json.loads(raw)
                if meta.get("preparationStatus") == "completed" and meta.get("ragSyncStatus") in ("not_started", "failed", ""):
                    pending_ids.append(file_id)
            except Exception:
                continue

    if not pending_ids:
        return {"status": "NOTHING_TO_SYNC"}

    print(f"[batch_kb_sync] 同期対象: {len(pending_ids)}件")

    # KB同期ジョブを開始（実行中なら既存ジョブを使う）
    job_id = None
    try:
        resp = bedrock_agent.start_ingestion_job(
            knowledgeBaseId=env("BEDROCK_KNOWLEDGE_BASE_ID"),
            dataSourceId=env("BEDROCK_DATA_SOURCE_ID"),
            description=f"Batch KB sync ({len(pending_ids)} files)",
        )
        job_id = resp["ingestionJob"]["ingestionJobId"]
        print(f"[batch_kb_sync] 新規ジョブ開始: {job_id}")
    except Exception as e:
        if "ConflictException" not in str(e):
            print(f"[batch_kb_sync] ジョブ開始失敗: {e}")
            return {"status": "FAILED", "error": str(e)}
        # 実行中ジョブを取得して相乗り
        try:
            jobs = bedrock_agent.list_ingestion_jobs(
                knowledgeBaseId=env("BEDROCK_KNOWLEDGE_BASE_ID"),
                dataSourceId=env("BEDROCK_DATA_SOURCE_ID"),
                filters=[{"attribute": "STATUS", "operator": "EQ", "values": ["STARTING", "IN_PROGRESS"]}],
            )
            running = jobs.get("ingestionJobSummaries", [])
            if running:
                job_id = running[0]["ingestionJobId"]
                print(f"[batch_kb_sync] 既存ジョブに合流: {job_id}")
            else:
                # 極まれに完了タイミングが重なった場合は再試行
                resp = bedrock_agent.start_ingestion_job(
                    knowledgeBaseId=env("BEDROCK_KNOWLEDGE_BASE_ID"),
                    dataSourceId=env("BEDROCK_DATA_SOURCE_ID"),
                    description=f"Batch KB sync retry ({len(pending_ids)} files)",
                )
                job_id = resp["ingestionJob"]["ingestionJobId"]
                print(f"[batch_kb_sync] 再試行ジョブ開始: {job_id}")
        except Exception as e2:
            print(f"[batch_kb_sync] ジョブ取得/再試行失敗: {e2}")
            return {"status": "FAILED", "error": str(e2)}

    # 対象ファイルを "syncing" にマーク
    for file_id in pending_ids:
        try:
            meta = get_metadata(file_id)
            if meta.get("ragSyncStatus") in ("not_started", "failed", ""):
                meta.update({"ragSyncStatus": "syncing", "ragSyncJobId": job_id})
                save_metadata(meta)
        except Exception:
            pass

    # 完了までポーリング（15秒間隔、最大50回 = 最大12.5分）
    for _ in range(50):
        time.sleep(15)
        try:
            job_resp = bedrock_agent.get_ingestion_job(
                knowledgeBaseId=env("BEDROCK_KNOWLEDGE_BASE_ID"),
                dataSourceId=env("BEDROCK_DATA_SOURCE_ID"),
                ingestionJobId=job_id,
            )
            status = job_resp.get("ingestionJob", {}).get("status")
        except Exception as e:
            print(f"[batch_kb_sync] ジョブ確認エラー: {e}")
            continue

        if status == "COMPLETE":
            now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            completed = 0
            for file_id in pending_ids:
                try:
                    meta = get_metadata(file_id)
                    if meta.get("ragSyncJobId") == job_id and meta.get("ragSyncStatus") == "syncing":
                        meta.update({"ragSyncStatus": "completed", "ragSyncedAt": now})
                        save_metadata(meta)
                        completed += 1
                except Exception:
                    pass
            print(f"[batch_kb_sync] 完了: {completed}件更新")
            return {"status": "COMPLETED", "jobId": job_id, "count": completed}

        if status in ("FAILED", "STOPPED"):
            for file_id in pending_ids:
                try:
                    meta = get_metadata(file_id)
                    if meta.get("ragSyncJobId") == job_id and meta.get("ragSyncStatus") == "syncing":
                        meta.update({"ragSyncStatus": "failed"})
                        save_metadata(meta)
                except Exception:
                    pass
            print(f"[batch_kb_sync] ジョブ失敗: {status}")
            return {"status": "FAILED", "jobId": job_id}

    print("[batch_kb_sync] タイムアウト")
    return {"status": "TIMEOUT", "jobId": job_id}


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
    return invoke_bedrock(prompt, max_tokens=16000)


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
    return invoke_bedrock(prompt, max_tokens=8000)


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
                "summaryMode": "section",
                "chunkSize": SUMMARY_CHUNK_SIZE,
                "chunkOverlap": SUMMARY_CHUNK_OVERLAP,
                "chunks": materials,
            },
            ensure_ascii=False,
            indent=2,
        ),
        "application/json; charset=utf-8",
    )
    return "\n\n".join(material.strip() for material in materials if material.strip()), materials


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
            "summaryMode": "section",
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
    if action == "run_batch_kb_sync":
        return run_batch_kb_sync(event)
    if action == "backfill_kb_metadata":
        return backfill_kb_metadata(event)
    raise ValueError(f"Unknown action: {action}")


def backfill_kb_metadata(event):
    """既存の全KB文書に対してメタデータサイドカー（folderId）を生成する。
    各ファイルのS3メタデータからfolderIdを読み取り、kb/{id}.md.metadata.json を作る。
    一度実行すればよい。実行後はKB再同期が必要。"""
    bucket = env("S3_BUCKET_NAME")
    metadata_prefix = os.environ.get("S3_METADATA_PREFIX", "metadata/")
    created = 0
    skipped = 0
    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix=metadata_prefix):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if not key.endswith(".json"):
                continue
            file_id = key[len(metadata_prefix):][:-5]
            if not file_id or len(file_id) < 32 or "-" not in file_id:
                continue
            try:
                raw = s3.get_object(Bucket=bucket, Key=key)["Body"].read().decode("utf-8-sig")
                meta = json.loads(raw)
                kb_key = meta.get("knowledgeBaseKey")
                if not kb_key:
                    skipped += 1
                    continue
                write_kb_metadata_sidecar(bucket, kb_key, meta.get("folderId") or "__none__")
                created += 1
            except Exception as e:
                print(f"[backfill] {file_id} 失敗: {e}")
                skipped += 1
    print(f"[backfill] 完了: 生成={created} スキップ={skipped}")
    return {"status": "COMPLETED", "created": created, "skipped": skipped}
