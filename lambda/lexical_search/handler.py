"""
dental-lexical-search-dev

ハイブリッド検索のうち「キーワード検索（BM25）」を担当するLambda。

- search : 質問文をBM25で検索し、上位チャンクを返す（AIチャットから同期呼び出し）
- rebuild: S3 Vectors（Bedrock KBと同じチャンク）からSQLite FTS5索引を作り直し、S3に保存する

索引の更新はオンデマンド（A案）:
  search のたびに「最新のKB取り込み完了時刻 > 索引の作成基準時刻」を確認し、
  古ければ rebuild を非同期起動する。その回の検索は既存の索引で答える。

日本語は形態素解析を使わず、漢字・カタカナの連続部分を2文字ずつ（bigram）に分割する。
ひらがなは区切りとして扱う（助詞・送り仮名のノイズを避けるため）。
チャンクIDはS3 Vectorsのキー（= Retrieve結果の x-amz-bedrock-kb-chunk-id）なので、
意味検索の結果とそのまま突き合わせられる。
"""

import gzip
import json
import os
import re
import shutil
import sqlite3
import time
import unicodedata
from datetime import datetime, timezone

import boto3
from botocore.exceptions import ClientError

REGION = os.environ.get("APP_AWS_REGION", "ap-northeast-1")
S3_BUCKET = os.environ["S3_BUCKET_NAME"]
VECTOR_BUCKET = os.environ["VECTOR_BUCKET_NAME"]
VECTOR_INDEX = os.environ["VECTOR_INDEX_NAME"]
KNOWLEDGE_BASE_ID = os.environ["BEDROCK_KNOWLEDGE_BASE_ID"]
DATA_SOURCE_ID = os.environ["BEDROCK_DATA_SOURCE_ID"]

INDEX_KEY = "search-index/lexical-v1.sqlite.gz"
MANIFEST_KEY = "search-index/lexical-v1.json"
LOCK_KEY = "search-index/rebuild.lock"
LOCK_TTL_SECONDS = 20 * 60
STALE_CHECK_INTERVAL_SECONDS = 60
MAX_QUERY_TOKENS = 64
LOCAL_DB_PATH = "/tmp/lexical.sqlite"

s3 = boto3.client("s3", region_name=REGION)
s3vectors = boto3.client("s3vectors", region_name=REGION)
bedrock_agent = boto3.client("bedrock-agent", region_name=REGION)
lambda_client = boto3.client("lambda", region_name=REGION)

# ウォームコンテナ間で使い回す状態
_state = {"conn": None, "builtAt": None, "manifest": None, "checkedAt": 0.0, "stale": False}

# NFKC＋小文字化後に、英数字の連続 / 漢字・カタカナの連続を取り出す（ひらがな・記号は区切り）
TOKEN_RUN = re.compile(
    r"[0-9a-z]+|[゠-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿々〆ヵヶ]+"
)


def tokenize(text: str) -> list[str]:
    normalized = unicodedata.normalize("NFKC", text or "").lower()
    tokens: list[str] = []
    for run in TOKEN_RUN.findall(normalized):
        if run[0].isascii():
            if len(run) >= 2:
                tokens.append(run)
        elif len(run) >= 2:
            tokens.extend(run[i : i + 2] for i in range(len(run) - 1))
    return tokens


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


# ── 取り込み状態 ─────────────────────────────────────────────────────────────


def latest_ingestion_marker() -> str:
    """直近で完了したKB取り込みの完了時刻（ISO文字列）。無ければ空文字。"""
    resp = bedrock_agent.list_ingestion_jobs(
        knowledgeBaseId=KNOWLEDGE_BASE_ID,
        dataSourceId=DATA_SOURCE_ID,
        sortBy={"attribute": "STARTED_AT", "order": "DESCENDING"},
        maxResults=10,
    )
    completed = [
        job["updatedAt"]
        for job in resp.get("ingestionJobSummaries", [])
        if job.get("status") == "COMPLETE"
    ]
    if not completed:
        return ""
    return max(completed).astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def read_manifest() -> dict | None:
    try:
        body = s3.get_object(Bucket=S3_BUCKET, Key=MANIFEST_KEY)["Body"].read()
        return json.loads(body)
    except ClientError as error:
        if error.response["Error"]["Code"] in ("NoSuchKey", "404"):
            return None
        raise


# ── rebuild ──────────────────────────────────────────────────────────────────


def acquire_lock() -> bool:
    body = json.dumps({"lockedAt": now_iso()}).encode("utf-8")
    try:
        s3.put_object(Bucket=S3_BUCKET, Key=LOCK_KEY, Body=body, IfNoneMatch="*")
        return True
    except ClientError as error:
        if error.response["Error"]["Code"] not in ("PreconditionFailed", "ConditionalRequestConflict"):
            raise
    # 既存ロックが古ければ（前回の異常終了など）奪い取る
    try:
        head = s3.head_object(Bucket=S3_BUCKET, Key=LOCK_KEY)
    except ClientError:
        return False
    age = (datetime.now(timezone.utc) - head["LastModified"]).total_seconds()
    if age < LOCK_TTL_SECONDS:
        return False
    s3.delete_object(Bucket=S3_BUCKET, Key=LOCK_KEY)
    try:
        s3.put_object(Bucket=S3_BUCKET, Key=LOCK_KEY, Body=body, IfNoneMatch="*")
        return True
    except ClientError:
        return False


def release_lock():
    try:
        s3.delete_object(Bucket=S3_BUCKET, Key=LOCK_KEY)
    except ClientError as error:
        print(f"[rebuild] failed to release lock: {error}")


def lock_is_held() -> bool:
    try:
        head = s3.head_object(Bucket=S3_BUCKET, Key=LOCK_KEY)
    except ClientError:
        return False
    age = (datetime.now(timezone.utc) - head["LastModified"]).total_seconds()
    return age < LOCK_TTL_SECONDS


def iter_chunks():
    """S3 Vectorsからこのデータソースのチャンクをすべて取り出す。"""
    token = None
    while True:
        kwargs = {
            "vectorBucketName": VECTOR_BUCKET,
            "indexName": VECTOR_INDEX,
            "maxResults": 1000,
            "returnMetadata": True,
            "returnData": False,
        }
        if token:
            kwargs["nextToken"] = token
        resp = s3vectors.list_vectors(**kwargs)
        for vector in resp.get("vectors", []):
            metadata = vector.get("metadata") or {}
            if metadata.get("x-amz-bedrock-kb-data-source-id") != DATA_SOURCE_ID:
                continue
            text = metadata.get("AMAZON_BEDROCK_TEXT") or ""
            if not text:
                continue
            source = ""
            try:
                bedrock_meta = json.loads(metadata.get("AMAZON_BEDROCK_METADATA") or "{}")
                source = (bedrock_meta.get("source") or {}).get("sourceLocation") or ""
            except (TypeError, ValueError):
                pass
            yield vector["key"], source, str(metadata.get("folderId") or "__none__"), text
        token = resp.get("nextToken")
        if not token:
            break


def rebuild() -> dict:
    if not acquire_lock():
        return {"status": "SKIPPED", "reason": "rebuild already running"}
    try:
        # 取り込み完了時刻を先に控える（作り直し中に完了した取り込みは次回拾う）
        marker = latest_ingestion_marker()
        manifest = read_manifest()
        if manifest and manifest.get("ingestionMarker") and manifest["ingestionMarker"] >= marker:
            return {"status": "SKIPPED", "reason": "index is up to date"}

        started = time.time()
        build_path = "/tmp/lexical-build.sqlite"
        if os.path.exists(build_path):
            os.remove(build_path)
        conn = sqlite3.connect(build_path)
        conn.execute("PRAGMA journal_mode=OFF")
        conn.execute("PRAGMA synchronous=OFF")
        conn.execute(
            "CREATE TABLE chunks (id INTEGER PRIMARY KEY, vkey TEXT NOT NULL, source TEXT, folder TEXT, text TEXT)"
        )
        conn.execute("CREATE VIRTUAL TABLE fts USING fts5(tokens, content='', tokenize='unicode61')")

        count = 0
        batch_chunks, batch_fts = [], []
        for vkey, source, folder, text in iter_chunks():
            count += 1
            batch_chunks.append((count, vkey, source, folder, text))
            batch_fts.append((count, " ".join(tokenize(text))))
            if len(batch_chunks) >= 2000:
                conn.executemany("INSERT INTO chunks VALUES (?,?,?,?,?)", batch_chunks)
                conn.executemany("INSERT INTO fts(rowid, tokens) VALUES (?,?)", batch_fts)
                batch_chunks, batch_fts = [], []
        if batch_chunks:
            conn.executemany("INSERT INTO chunks VALUES (?,?,?,?,?)", batch_chunks)
            conn.executemany("INSERT INTO fts(rowid, tokens) VALUES (?,?)", batch_fts)
        conn.execute("INSERT INTO fts(fts) VALUES('optimize')")
        conn.commit()
        conn.execute("VACUUM")
        conn.close()

        gz_path = build_path + ".gz"
        with open(build_path, "rb") as src, gzip.open(gz_path, "wb", compresslevel=6) as dst:
            shutil.copyfileobj(src, dst)
        built_at = now_iso()
        s3.upload_file(gz_path, S3_BUCKET, INDEX_KEY, ExtraArgs={"ContentType": "application/gzip"})
        new_manifest = {
            "builtAt": built_at,
            "ingestionMarker": marker,
            "chunkCount": count,
            "sizeBytes": os.path.getsize(build_path),
            "buildSeconds": round(time.time() - started, 1),
        }
        # マニフェストは索引の後に書く（検索側はマニフェストを見て索引を取りに行く）
        s3.put_object(
            Bucket=S3_BUCKET,
            Key=MANIFEST_KEY,
            Body=json.dumps(new_manifest).encode("utf-8"),
            ContentType="application/json",
        )
        os.remove(build_path)
        os.remove(gz_path)
        print(f"[rebuild] done {new_manifest}")
        return {"status": "REBUILT", **new_manifest}
    finally:
        release_lock()


# ── search ───────────────────────────────────────────────────────────────────


def trigger_rebuild(context):
    try:
        lambda_client.invoke(
            FunctionName=context.invoked_function_arn,
            InvocationType="Event",
            Payload=json.dumps({"action": "rebuild"}).encode("utf-8"),
        )
        print("[search] index is stale; triggered async rebuild")
    except ClientError as error:
        print(f"[search] failed to trigger rebuild: {error}")


def refresh_state(context):
    """索引の読み込みと鮮度確認。確認はウォームコンテナ内で60秒に1回まで。"""
    now = time.time()
    if _state["conn"] is not None and now - _state["checkedAt"] < STALE_CHECK_INTERVAL_SECONDS:
        return

    manifest = read_manifest()
    _state["checkedAt"] = now
    _state["manifest"] = manifest

    if manifest and manifest.get("builtAt") != _state["builtAt"]:
        tmp_path = LOCAL_DB_PATH + ".download"
        with open(tmp_path, "wb") as dst:
            body = s3.get_object(Bucket=S3_BUCKET, Key=INDEX_KEY)["Body"]
            with gzip.GzipFile(fileobj=body) as src:
                shutil.copyfileobj(src, dst)
        if _state["conn"] is not None:
            _state["conn"].close()
        os.replace(tmp_path, LOCAL_DB_PATH)
        _state["conn"] = sqlite3.connect(LOCAL_DB_PATH, check_same_thread=False)
        _state["builtAt"] = manifest["builtAt"]

    marker = latest_ingestion_marker()
    stale = manifest is None or (marker and marker > (manifest.get("ingestionMarker") or ""))
    _state["stale"] = bool(stale)
    if stale and not lock_is_held():
        trigger_rebuild(context)


def kb_document_state(source_uri: str, cache: dict) -> dict | None:
    """kb/{id}.md が今も存在するか（削除済み資料の除外）と、現在のfolderIdを返す。"""
    if source_uri in cache:
        return cache[source_uri]
    prefix = f"s3://{S3_BUCKET}/"
    state = None
    if source_uri.startswith(prefix):
        key = source_uri[len(prefix) :]
        try:
            s3.head_object(Bucket=S3_BUCKET, Key=key)
            folder = "__none__"
            try:
                sidecar = s3.get_object(Bucket=S3_BUCKET, Key=f"{key}.metadata.json")["Body"].read()
                folder = json.loads(sidecar).get("metadataAttributes", {}).get("folderId") or "__none__"
            except (ClientError, ValueError):
                pass
            state = {"folderId": folder}
        except ClientError:
            state = None
    cache[source_uri] = state
    return state


def search(event, context) -> dict:
    query = (event.get("query") or "").strip()
    top_k = max(1, min(int(event.get("topK") or 20), 50))
    folder_id = event.get("folderId") or ""

    refresh_state(context)
    conn = _state["conn"]
    tokens = list(dict.fromkeys(tokenize(query)))[:MAX_QUERY_TOKENS]
    if conn is None or not tokens:
        return {"results": [], "stale": _state["stale"], "indexBuiltAt": _state["builtAt"], "tokens": tokens}

    match = " OR ".join(f'"{token}"' for token in tokens)
    sql = (
        "SELECT c.vkey, c.source, c.folder, c.text, bm25(fts) AS score "
        "FROM fts JOIN chunks c ON c.id = fts.rowid WHERE fts MATCH ? "
    )
    params: list = [match]
    if folder_id:
        sql += "AND c.folder = ? "
        params.append(folder_id)
    # 削除済み資料を除外した後でも top_k 件残るよう多めに取る
    sql += "ORDER BY score LIMIT ?"
    params.append(top_k * 2)
    rows = conn.execute(sql, params).fetchall()

    results = []
    doc_cache: dict = {}
    for vkey, source, folder, text, score in rows:
        doc = kb_document_state(source, doc_cache)
        if doc is None:
            continue  # 索引作成後に削除された資料
        if folder_id and doc["folderId"] != folder_id:
            continue  # 索引作成後に別フォルダへ移動された資料
        results.append({"key": vkey, "sourceUri": source, "folderId": doc["folderId"], "text": text, "score": -score})
        if len(results) >= top_k:
            break

    return {"results": results, "stale": _state["stale"], "indexBuiltAt": _state["builtAt"], "tokens": tokens}


def handler(event, context):
    action = (event or {}).get("action") or "search"
    if action == "rebuild":
        return rebuild()
    if action == "search":
        return search(event, context)
    raise ValueError(f"unknown action: {action}")
