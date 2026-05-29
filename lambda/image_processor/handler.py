"""
dental-image-processor-dev

既存の dental-summary-worker-dev とは完全に独立した Lambda。
PDF から画像を抽出し、近傍テキストをキャプションとして関連付ける。

ハイブリッド方式:
  - キャプション/近傍テキストあり (>=15文字) → そのまま使用
  - キャプションなし + 画像中心ページ          → Claude Vision で説明生成
  - キャプションなし + 通常ページ              → スキップ（アイコン等）

既存システムへの影響:
  - 既存メタデータフィールドは一切変更しない（images[] を追記するのみ）
  - kb/{id}.md の末尾に画像セクションを追記（既存内容は変更しない）
  - S3 に images/{id}/{page}_{n}.jpg を新規保存
"""

import base64
import json
import os
import tempfile

import boto3
from botocore.config import Config

try:
    import fitz  # PyMuPDF
    FITZ_AVAILABLE = True
except ImportError:
    FITZ_AVAILABLE = False

# ── 設定 ──────────────────────────────────────────────────────────────────────

AWS_REGION = os.environ.get("APP_AWS_REGION") or "ap-northeast-1"
S3_BUCKET = os.environ.get("S3_BUCKET_NAME", "")
S3_METADATA_PREFIX = os.environ.get("S3_METADATA_PREFIX", "metadata/")
BEDROCK_MODEL_ARN = os.environ.get("BEDROCK_MODEL_ARN", "")
BEDROCK_VISION_MODEL_ARN = os.environ.get("BEDROCK_VISION_MODEL_ARN") or BEDROCK_MODEL_ARN

MIN_CAPTION_CHARS = 15       # キャプションとみなす最小文字数
IMAGE_HEAVY_THRESHOLD = 0.05 # テキスト密度がこれ未満 → 画像中心ページ
MIN_IMAGE_DIMENSION = 50     # px 未満の画像（アイコン等）をスキップ
MAX_IMAGE_BYTES = 4 * 1024 * 1024  # 4MB 超はスキップ
MAX_VISION_CALLS = 30        # 1実行あたりのVision呼び出し上限（コスト・時間制御）
TIMEOUT_BUFFER_MS = 60000    # Lambdaタイムアウト60秒前に処理を打ち切る

# ── AWS クライアント ──────────────────────────────────────────────────────────

s3 = boto3.client("s3", region_name=AWS_REGION)
bedrock = boto3.client(
    "bedrock-runtime",
    region_name=AWS_REGION,
    config=Config(connect_timeout=10, read_timeout=120, retries={"max_attempts": 1}),
)

# ── ユーティリティ ────────────────────────────────────────────────────────────

def get_metadata(file_id: str) -> dict:
    key = f"{S3_METADATA_PREFIX}{file_id}.json"
    body = s3.get_object(Bucket=S3_BUCKET, Key=key)["Body"].read()
    return json.loads(body.decode("utf-8-sig"))


def save_metadata(metadata: dict):
    key = f"{S3_METADATA_PREFIX}{metadata['id']}.json"
    s3.put_object(
        Bucket=S3_BUCKET,
        Key=key,
        Body=json.dumps(metadata, ensure_ascii=False, indent=2).encode("utf-8"),
        ContentType="application/json; charset=utf-8",
    )


def download_pdf(s3_key: str) -> str:
    """S3 から PDF を /tmp にダウンロードしてパスを返す"""
    tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    tmp.close()
    s3.download_file(S3_BUCKET, s3_key, tmp.name)
    return tmp.name


def get_kb_key(file_id: str) -> str:
    return f"kb/{file_id}.md"

# ── PyMuPDF ユーティリティ ────────────────────────────────────────────────────

def page_text_density(page) -> float:
    """テキスト文字数 / ページ面積（小さいほど画像中心）"""
    text = page.get_text().strip()
    area = page.rect.width * page.rect.height
    return len(text) / area if area > 0 else 0.0


def nearby_text(page, img_rect, margin: int = 60) -> str:
    """画像の上下左右 margin px 以内のテキストブロックを連結して返す"""
    search = fitz.Rect(
        img_rect.x0 - margin,
        img_rect.y0 - margin,
        img_rect.x1 + margin,
        img_rect.y1 + margin,
    )
    parts = []
    for block in page.get_text("blocks"):
        bx0, by0, bx1, by1 = block[0], block[1], block[2], block[3]
        text = block[4].strip() if len(block) > 4 else ""
        if text and search.intersects(fitz.Rect(bx0, by0, bx1, by1)):
            parts.append(text)
    return " ".join(parts).strip()


# ── Bedrock Vision ────────────────────────────────────────────────────────────

def describe_with_vision(img_bytes: bytes, media_type: str = "image/jpeg") -> str:
    """Claude Vision で画像の説明文を生成する（フォールバック用）"""
    prompt = (
        "この歯科医療資料の画像・図を見て、内容を日本語で簡潔に説明してください。"
        "手順図・解剖図・X線・処置写真など、何を示しているかと重要な情報を100字以内でまとめてください。"
    )
    body = {
        "anthropic_version": "bedrock-2023-05-31",
        "max_tokens": 300,
        "temperature": 0.1,
        "messages": [{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": base64.b64encode(img_bytes).decode("utf-8"),
                    },
                },
                {"type": "text", "text": prompt},
            ],
        }],
    }
    resp = bedrock.invoke_model(
        modelId=BEDROCK_VISION_MODEL_ARN,
        body=json.dumps(body).encode("utf-8"),
        contentType="application/json",
        accept="application/json",
    )
    payload = json.loads(resp["body"].read().decode("utf-8"))
    return "".join(
        item.get("text", "") for item in payload.get("content", []) if item.get("type") == "text"
    ).strip()


# ── 画像抽出メイン ────────────────────────────────────────────────────────────

def extract_images(pdf_path: str, file_id: str, context=None) -> list[dict]:
    """
    PDF から画像を抽出し、各画像に説明文を関連付ける。
    戻り値: images[] フィールドに格納するリスト
    """
    doc = fitz.open(pdf_path)
    results = []
    image_index = 0
    vision_call_count = 0

    for page_num in range(len(doc)):
        # Lambda タイムアウト直前に安全停止
        if context and context.get_remaining_time_in_millis() < TIMEOUT_BUFFER_MS:
            print(f"タイムアウト直前のため {page_num + 1} ページ以降をスキップ（処理済み: {image_index} 枚）")
            break

        page = doc[page_num]
        density = page_text_density(page)
        is_image_heavy = density < IMAGE_HEAVY_THRESHOLD

        for img_info in page.get_images(full=True):
            xref = img_info[0]

            try:
                img_data = doc.extract_image(xref)
            except Exception:
                continue

            img_bytes = img_data.get("image", b"")
            ext = img_data.get("ext", "jpeg").lower()
            w = img_data.get("width", 0)
            h = img_data.get("height", 0)

            # 小さすぎる / 大きすぎる / 対応外フォーマットをスキップ
            if w < MIN_IMAGE_DIMENSION or h < MIN_IMAGE_DIMENSION:
                continue
            if len(img_bytes) > MAX_IMAGE_BYTES:
                continue
            if ext not in ("jpeg", "jpg", "png", "gif", "webp"):
                ext = "jpeg"

            media_type = "image/jpeg" if ext in ("jpeg", "jpg") else f"image/{ext}"

            # 画像のページ上の位置を取得
            rects = page.get_image_rects(xref)
            img_rect = rects[0] if rects else fitz.Rect(0, 0, w, h)

            # キャプション / 近傍テキストを取得
            caption = nearby_text(page, img_rect)

            if len(caption) >= MIN_CAPTION_CHARS:
                description = caption
                source = "caption"
            elif is_image_heavy and vision_call_count < MAX_VISION_CALLS:
                # 画像中心ページ → Claude Vision フォールバック（上限あり）
                try:
                    description = describe_with_vision(img_bytes, media_type)
                    source = "vision"
                    vision_call_count += 1
                except Exception as e:
                    print(f"Vision失敗 p{page_num + 1} img{image_index}: {e}")
                    description = ""
                    source = "error"
            elif is_image_heavy and vision_call_count >= MAX_VISION_CALLS:
                # Vision上限超過 → 画像中心ページでもスキップ
                print(f"Vision上限({MAX_VISION_CALLS}回)到達のためスキップ p{page_num + 1}")
                continue
            else:
                # キャプションなし + 通常ページ → スキップ
                continue

            if not description:
                continue

            # S3 に画像保存
            s3_key = f"images/{file_id}/{page_num + 1}_{image_index}.{ext}"
            s3.put_object(
                Bucket=S3_BUCKET,
                Key=s3_key,
                Body=img_bytes,
                ContentType=media_type,
            )

            results.append({
                "index": image_index,
                "page": page_num + 1,
                "s3Key": s3_key,
                "width": w,
                "height": h,
                "description": description,
                "descriptionSource": source,
            })
            image_index += 1

    doc.close()
    return results


def append_images_to_kb(file_id: str, images: list[dict]):
    """
    既存の kb/{id}.md の末尾に画像セクションを追記。
    既存内容は一切変更しない。
    """
    if not images:
        return

    kb_key = get_kb_key(file_id)
    try:
        existing = s3.get_object(Bucket=S3_BUCKET, Key=kb_key)["Body"].read().decode("utf-8")
    except Exception:
        existing = ""

    # KB チャンクの metadata サイズ制限（S3 Vectors: 2048 bytes）に収めるため
    # 説明文は 80 文字以内に短縮して登録する（全文は metadata.images[] に保存済み）
    section_lines = ["\n\n## 資料内の画像・図\n"]
    for img in images:
        short_desc = img['description'][:80].rstrip()
        if len(img['description']) > 80:
            short_desc += "…"
        section_lines.append(
            f"- 【{img['page']}ページ 画像{img['index'] + 1}】{short_desc}"
        )
    section_lines.append("")

    updated = existing.rstrip() + "\n".join(section_lines)
    s3.put_object(
        Bucket=S3_BUCKET,
        Key=kb_key,
        Body=updated.encode("utf-8"),
        ContentType="text/markdown; charset=utf-8",
    )


# ── エントリーポイント ────────────────────────────────────────────────────────

def handler(event, _context):
    file_id = event.get("fileId")
    if not file_id:
        return {"status": "FAILED", "error": "fileId is required"}

    if not FITZ_AVAILABLE:
        _fail_metadata(file_id, "PyMuPDF (fitz) is not installed in this Lambda")
        return {"status": "FAILED", "error": "PyMuPDF (fitz) is not installed in this Lambda"}

    # メタデータ取得
    try:
        metadata = get_metadata(file_id)
    except Exception as e:
        return {"status": "FAILED", "fileId": file_id, "error": f"メタデータ取得失敗: {e}"}

    # PDF のみ対応（DOCX は将来対応）
    content_type = metadata.get("contentType", "")
    if "pdf" not in content_type.lower():
        metadata["imageProcessingStatus"] = "failed"
        metadata["imageProcessingError"] = "PDF以外はスキップ（将来対応予定）"
        save_metadata(metadata)
        return {"status": "SKIPPED", "fileId": file_id, "reason": "PDF以外はスキップ（将来対応予定）"}

    # PDF ダウンロード
    try:
        pdf_path = download_pdf(metadata["s3Key"])
    except Exception as e:
        metadata["imageProcessingStatus"] = "failed"
        metadata["imageProcessingError"] = f"PDFダウンロード失敗: {e}"
        save_metadata(metadata)
        return {"status": "FAILED", "fileId": file_id, "error": f"PDFダウンロード失敗: {e}"}

    # 画像抽出・ラベル付け（context を渡してタイムアウト直前に安全停止）
    try:
        images = extract_images(pdf_path, file_id, context=_context)
    except Exception as e:
        metadata["imageProcessingStatus"] = "failed"
        metadata["imageProcessingError"] = f"画像抽出失敗: {e}"
        save_metadata(metadata)
        return {"status": "FAILED", "fileId": file_id, "error": f"画像抽出失敗: {e}"}
    finally:
        try:
            os.unlink(pdf_path)
        except Exception:
            pass

    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    if not images:
        metadata["imageProcessingStatus"] = "completed"
        metadata["imageProcessingError"] = ""
        metadata["imageProcessedAt"] = now
        save_metadata(metadata)
        return {
            "status": "COMPLETED",
            "fileId": file_id,
            "imageCount": 0,
            "message": "抽出できる画像がありませんでした",
        }

    # KB ドキュメントに画像説明を追記
    try:
        append_images_to_kb(file_id, images)
    except Exception as e:
        print(f"KB追記失敗（処理は続行）: {e}")

    # メタデータ更新
    metadata["images"] = images
    metadata["imageProcessingStatus"] = "completed"
    metadata["imageProcessingError"] = ""
    metadata["imageProcessedAt"] = now
    save_metadata(metadata)

    caption_count = sum(1 for img in images if img["descriptionSource"] == "caption")
    vision_count = sum(1 for img in images if img["descriptionSource"] == "vision")

    return {
        "status": "COMPLETED",
        "fileId": file_id,
        "imageCount": len(images),
        "captionCount": caption_count,
        "visionCount": vision_count,
    }


def _fail_metadata(file_id: str, error: str):
    """エラー時にメタデータを更新（メタデータが取得できなかった場合は無視）"""
    try:
        metadata = get_metadata(file_id)
        metadata["imageProcessingStatus"] = "failed"
        metadata["imageProcessingError"] = error
        save_metadata(metadata)
    except Exception:
        pass
