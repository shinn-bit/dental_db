"""
dental-image-processor-dev  (バッチ処理対応版)

PDFをページ単位でバッチ処理し、タイムアウト前に自己呼び出しで続きを実行。
任意のページ数に対応（500ページ、1000ページでも完走できる）。

バッチ設計:
  - タイムアウト残り TIMEOUT_BUFFER_MS 秒になったら処理を中断
  - 未処理ページが残っていれば自分自身を非同期呼び出し（startPage を引き継ぎ）
  - スタック検知: startPage が前回から進んでいなければ異常終了
  - 終了条件は「全ページ完了」のみ。呼び出し回数に上限なし

既存システムへの影響:
  - dental-summary-worker-dev は一切変更しない
  - metadata.images[] に途中結果も随時保存（ページをまたぐ）
  - KB追記は最終バッチ完了時のみ実行（重複追記防止）
"""

import base64
import json
import os
import tempfile
from datetime import datetime, timezone

import boto3
from botocore.config import Config

# pymupdf 同梱ライブラリを ctypes で先にロードしておく（LD_LIBRARY_PATH より確実）
import ctypes as _ctypes
_pymupdf_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pymupdf")
if os.path.isdir(_pymupdf_dir):
    for _lib in ["libmupdf.so.24.2", "libmupdfcpp.so.24.2", "_mupdf.so"]:
        _lib_path = os.path.join(_pymupdf_dir, _lib)
        if os.path.exists(_lib_path):
            try:
                _ctypes.CDLL(_lib_path)
            except OSError:
                pass

try:
    import fitz  # PyMuPDF
    FITZ_AVAILABLE = True
except (ImportError, OSError):
    FITZ_AVAILABLE = False

# ── 設定 ──────────────────────────────────────────────────────────────────────

AWS_REGION            = os.environ.get("APP_AWS_REGION") or "ap-northeast-1"
S3_BUCKET             = os.environ.get("S3_BUCKET_NAME", "")
S3_METADATA_PREFIX    = os.environ.get("S3_METADATA_PREFIX", "metadata/")
BEDROCK_MODEL_ARN     = os.environ.get("BEDROCK_MODEL_ARN", "")
BEDROCK_VISION_MODEL_ARN = os.environ.get("BEDROCK_VISION_MODEL_ARN") or BEDROCK_MODEL_ARN

THUMBNAIL_WIDTH       = 400

MIN_CAPTION_CHARS     = 15
SKIP_DESCRIPTION_WORDS = [
    "表紙", "目次", "はじめに", "前書き", "まえがき", "序文",
    "Contents", "Table of", "索引", "奥付",
]
IMAGE_HEAVY_THRESHOLD = 0.05
MIN_IMAGE_DIMENSION   = 50
MAX_IMAGE_BYTES       = 4 * 1024 * 1024
MAX_VISION_CALLS      = 30        # 1バッチあたりのVision呼び出し上限
TIMEOUT_BUFFER_MS     = 90000     # 残り90秒で中断して自己呼び出し

# ── AWS クライアント ──────────────────────────────────────────────────────────

s3 = boto3.client("s3", region_name=AWS_REGION)
bedrock = boto3.client(
    "bedrock-runtime",
    region_name=AWS_REGION,
    config=Config(connect_timeout=10, read_timeout=120, retries={"max_attempts": 1}),
)
lambda_client = boto3.client("lambda", region_name=AWS_REGION)

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
    tmp = tempfile.NamedTemporaryFile(suffix=".pdf", delete=False)
    tmp.close()
    s3.download_file(S3_BUCKET, s3_key, tmp.name)
    return tmp.name


def get_kb_key(file_id: str) -> str:
    return f"kb/{file_id}.md"


def _fail_metadata(file_id: str, error: str):
    try:
        metadata = get_metadata(file_id)
        metadata["imageProcessingStatus"] = "failed"
        metadata["imageProcessingError"] = error
        save_metadata(metadata)
    except Exception:
        pass

# ── PyMuPDF ユーティリティ ────────────────────────────────────────────────────

def page_text_density(page) -> float:
    text = page.get_text().strip()
    area = page.rect.width * page.rect.height
    return len(text) / area if area > 0 else 0.0


def nearby_text(page, img_rect, margin: int = 60) -> str:
    search = fitz.Rect(
        img_rect.x0 - margin, img_rect.y0 - margin,
        img_rect.x1 + margin, img_rect.y1 + margin,
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

# ── 画像抽出（バッチ対応） ────────────────────────────────────────────────────

def generate_thumbnail(pdf_path: str, file_id: str) -> str | None:
    """PDFのページ1をJPEGサムネイルとしてS3に保存する。キーを返す。失敗時はNone。"""
    try:
        doc = fitz.open(pdf_path)
        page = doc[0]
        zoom = THUMBNAIL_WIDTH / page.rect.width
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), alpha=False)
        img_bytes = pix.tobytes("jpeg", jpg_quality=85)
        doc.close()
        key = f"thumbnails/{file_id}.jpeg"
        s3.put_object(Bucket=S3_BUCKET, Key=key, Body=img_bytes, ContentType="image/jpeg")
        print(f"[thumbnail] 生成完了: {key} ({len(img_bytes) // 1024}KB)")
        return key
    except Exception as e:
        print(f"[thumbnail] 生成失敗: {e}")
        return None


def extract_images(
    pdf_path: str,
    file_id: str,
    context=None,
    start_page: int = 0,
    image_index_offset: int = 0,
) -> tuple[list[dict], int]:
    """
    start_page ページ目から抽出を開始する。
    タイムアウト直前に中断し、最後に処理したページ番号を返す。

    Returns:
        (新規抽出した画像リスト, 最後に処理したページ番号)
        最後のページ番号は「次のバッチの startPage 計算」に使う。
        1ページも処理できなかった場合は start_page - 1 を返す。
    """
    doc = fitz.open(pdf_path)
    total_pages = len(doc)
    results = []
    image_index = image_index_offset
    vision_call_count = 0
    last_processed_page = start_page - 1  # まだ何も処理していない

    for page_num in range(start_page, total_pages):
        # タイムアウト残り TIMEOUT_BUFFER_MS 秒で中断
        if context and context.get_remaining_time_in_millis() < TIMEOUT_BUFFER_MS:
            print(
                f"[batch] タイムアウト直前につき中断: p{page_num + 1}/{total_pages} "
                f"(残り {context.get_remaining_time_in_millis()}ms)"
            )
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

            if w < MIN_IMAGE_DIMENSION or h < MIN_IMAGE_DIMENSION:
                continue
            if len(img_bytes) > MAX_IMAGE_BYTES:
                continue
            if ext not in ("jpeg", "jpg", "png", "gif", "webp"):
                ext = "jpeg"

            media_type = "image/jpeg" if ext in ("jpeg", "jpg") else f"image/{ext}"

            rects = page.get_image_rects(xref)
            img_rect = rects[0] if rects else fitz.Rect(0, 0, w, h)
            caption = nearby_text(page, img_rect)

            if len(caption) >= MIN_CAPTION_CHARS:
                description = caption
                source = "caption"
            elif is_image_heavy and vision_call_count < MAX_VISION_CALLS:
                try:
                    description = describe_with_vision(img_bytes, media_type)
                    source = "vision"
                    vision_call_count += 1
                except Exception as e:
                    print(f"Vision失敗 p{page_num + 1}: {e}")
                    description = ""
                    source = "error"
            elif is_image_heavy and vision_call_count >= MAX_VISION_CALLS:
                print(f"Vision上限到達のためスキップ p{page_num + 1}")
                continue
            else:
                continue

            if not description:
                continue

            if any(w in description for w in SKIP_DESCRIPTION_WORDS):
                print(f"スキップ（表紙/目次等）: p{page_num + 1}")
                continue

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

        # このページは処理完了
        last_processed_page = page_num

    doc.close()
    return results, last_processed_page


def append_images_to_kb(file_id: str, images: list[dict]):
    """最終バッチ完了時のみ呼び出す。全画像をまとめてKBに追記。"""
    if not images:
        return

    kb_key = get_kb_key(file_id)
    try:
        existing = s3.get_object(Bucket=S3_BUCKET, Key=kb_key)["Body"].read().decode("utf-8")
    except Exception:
        existing = ""

    # KB Vectors の 2048 バイト制限のため 80 文字以内に短縮
    section_lines = ["\n\n## 資料内の画像・図\n"]
    for img in images:
        short_desc = img["description"][:80].rstrip()
        if len(img["description"]) > 80:
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

def handler_thumbnail_only(file_id: str) -> dict:
    """PDFのページ1サムネイルのみを生成する。画像抽出はスキップ。"""
    try:
        metadata = get_metadata(file_id)
    except Exception as e:
        return {"status": "FAILED", "fileId": file_id, "error": str(e)}

    if metadata.get("thumbnailKey"):
        return {"status": "SKIPPED", "fileId": file_id, "reason": "already exists"}

    if "pdf" not in metadata.get("contentType", "").lower():
        return {"status": "SKIPPED", "fileId": file_id, "reason": "not a PDF"}

    pdf_path = None
    try:
        pdf_path = download_pdf(metadata["s3Key"])
        key = generate_thumbnail(pdf_path, file_id)
        if key:
            metadata["thumbnailKey"] = key
            save_metadata(metadata)
            return {"status": "COMPLETED", "fileId": file_id, "thumbnailKey": key}
        return {"status": "FAILED", "fileId": file_id, "error": "thumbnail generation failed"}
    except Exception as e:
        return {"status": "FAILED", "fileId": file_id, "error": str(e)}
    finally:
        if pdf_path:
            try:
                os.unlink(pdf_path)
            except Exception:
                pass


def handler(event, _context):
    if event.get("action") == "generate_thumbnail_only":
        return handler_thumbnail_only(event.get("fileId", ""))

    file_id = event.get("fileId")
    if not file_id:
        return {"status": "FAILED", "error": "fileId is required"}

    if not FITZ_AVAILABLE:
        _fail_metadata(file_id, "PyMuPDF (fitz) is not installed in this Lambda")
        return {"status": "FAILED", "error": "PyMuPDF (fitz) is not installed"}

    # バッチ継続パラメータ
    start_page          = event.get("startPage", 0)          # 0 = 初回
    prev_processed_up_to = event.get("prevProcessedUpTo", -1) # スタック検知用

    # スタック検知: 前回と同じ startPage なら処理が進んでいない
    if start_page > 0 and start_page <= prev_processed_up_to:
        msg = f"処理が進んでいません (startPage={start_page}, prev={prev_processed_up_to})"
        print(f"[batch] ERROR: {msg}")
        _fail_metadata(file_id, msg)
        return {"status": "FAILED", "fileId": file_id, "error": msg}

    # メタデータ取得
    try:
        metadata = get_metadata(file_id)
    except Exception as e:
        return {"status": "FAILED", "fileId": file_id, "error": f"メタデータ取得失敗: {e}"}

    # PDF のみ対応
    content_type = metadata.get("contentType", "")
    if "pdf" not in content_type.lower():
        metadata["imageProcessingStatus"] = "failed"
        metadata["imageProcessingError"] = "PDF以外はスキップ"
        save_metadata(metadata)
        return {"status": "SKIPPED", "fileId": file_id}

    # 継続バッチ: 前回までの images[] を引き継ぐ
    existing_images: list[dict] = metadata.get("images", []) if start_page > 0 else []
    image_index_offset = len(existing_images)

    # PDF ダウンロード
    pdf_path = None
    try:
        pdf_path = download_pdf(metadata["s3Key"])
    except Exception as e:
        metadata["imageProcessingStatus"] = "failed"
        metadata["imageProcessingError"] = f"PDFダウンロード失敗: {e}"
        save_metadata(metadata)
        return {"status": "FAILED", "fileId": file_id, "error": str(e)}

    # ページ数を取得（PDFを軽くオープンしてすぐ閉じる）
    try:
        _doc = fitz.open(pdf_path)
        total_pages = len(_doc)
        _doc.close()
    except Exception as e:
        os.unlink(pdf_path)
        metadata["imageProcessingStatus"] = "failed"
        metadata["imageProcessingError"] = f"PDF解析失敗: {e}"
        save_metadata(metadata)
        return {"status": "FAILED", "fileId": file_id, "error": str(e)}

    # サムネイル生成（最初のバッチのみ・未生成の場合）
    if start_page == 0 and not metadata.get("thumbnailKey"):
        thumb_key = generate_thumbnail(pdf_path, file_id)
        if thumb_key:
            metadata["thumbnailKey"] = thumb_key
            save_metadata(metadata)

    # 画像抽出（このバッチ分のみ）
    try:
        new_images, last_processed_page = extract_images(
            pdf_path, file_id, _context,
            start_page=start_page,
            image_index_offset=image_index_offset,
        )
    except Exception as e:
        metadata["imageProcessingStatus"] = "failed"
        metadata["imageProcessingError"] = f"画像抽出失敗: {e}"
        save_metadata(metadata)
        return {"status": "FAILED", "fileId": file_id, "error": str(e)}
    finally:
        try:
            os.unlink(pdf_path)
        except Exception:
            pass

    all_images = existing_images + new_images
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    print(
        f"[batch] p{start_page}〜{last_processed_page}/{total_pages - 1} 完了 "
        f"(このバッチ {len(new_images)}枚 / 累計 {len(all_images)}枚)"
    )

    # ── 次のバッチへ継続 ─────────────────────────────────────────────────────
    if last_processed_page < total_pages - 1:
        next_start = last_processed_page + 1

        # 途中結果をメタデータに保存
        metadata["images"] = all_images
        metadata["imageProcessingStatus"] = "processing"
        metadata["imageProcessingError"] = ""
        metadata["imageProcessingCheckpoint"] = {
            "totalPages": total_pages,
            "processedUpTo": last_processed_page,
            "nextStartPage": next_start,
        }
        save_metadata(metadata)

        # 自分自身を非同期で再起動（次のバッチ）
        try:
            lambda_client.invoke(
                FunctionName=_context.function_name,
                InvocationType="Event",
                Payload=json.dumps({
                    "fileId": file_id,
                    "startPage": next_start,
                    "prevProcessedUpTo": last_processed_page,
                }).encode(),
            )
            print(f"[batch] 次のバッチを起動: startPage={next_start}")
        except Exception as e:
            # 自己呼び出し失敗は致命的
            metadata["imageProcessingStatus"] = "failed"
            metadata["imageProcessingError"] = f"次のバッチ起動失敗: {e}"
            save_metadata(metadata)
            return {"status": "FAILED", "fileId": file_id, "error": str(e)}

        return {
            "status": "PARTIAL",
            "fileId": file_id,
            "processedUpTo": last_processed_page,
            "totalPages": total_pages,
            "imagesSoFar": len(all_images),
        }

    # ── 全ページ完了 ──────────────────────────────────────────────────────────
    # KB追記は最終バッチのみ（途中バッチでは追記しない）
    try:
        append_images_to_kb(file_id, all_images)
    except Exception as e:
        print(f"KB追記失敗（処理は続行）: {e}")

    metadata["images"] = all_images
    metadata["imageProcessingStatus"] = "completed"
    metadata["imageProcessingError"] = ""
    metadata["imageProcessedAt"] = now
    metadata.pop("imageProcessingCheckpoint", None)
    save_metadata(metadata)

    caption_count = sum(1 for img in all_images if img["descriptionSource"] == "caption")
    vision_count  = sum(1 for img in all_images if img["descriptionSource"] == "vision")

    print(f"[batch] 完了: 全{total_pages}ページ / {len(all_images)}枚 (caption={caption_count} vision={vision_count})")

    return {
        "status": "COMPLETED",
        "fileId": file_id,
        "totalPages": total_pages,
        "imageCount": len(all_images),
        "captionCount": caption_count,
        "visionCount": vision_count,
    }
