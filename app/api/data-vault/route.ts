import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextResponse } from "next/server";
import pdfParse from "pdf-parse";
import { apiErrorResponse } from "@/lib/api-error";
import { createS3Client } from "@/lib/aws";
import { getS3Bytes, getS3Text, putS3Text } from "@/lib/s3-json";
import {
  formatFileSize,
  readCatalog,
  vaultBucket,
  vaultOutputKey,
  vaultTextKey,
  vaultUploadKey,
  writeCatalog,
  type VaultFolder,
  type VaultItem,
  type VaultTextStatus
} from "@/lib/data-vault";

export const dynamic = "force-dynamic";

/** テキストPDFかスキャンPDFかの判定しきい値（文字数） */
const MIN_USABLE_TEXT_LENGTH = 100;

type ActionBody =
  | { action: "get-upload-url"; fileName: string; contentType: string }
  | {
      action: "register-document";
      id: string;
      fileName: string;
      s3Key: string;
      contentType: string;
      size: number;
      folderId: string | null;
      /** アップロード時に付け直したタイトル。省略時はファイル名から生成 */
      title?: string;
    }
  | { action: "update-item"; id: string; title?: string; folderId?: string | null }
  | { action: "delete-item"; id: string }
  | { action: "get-download-url"; s3Key: string }
  | { action: "get-output"; itemId: string }
  | {
      action: "save-analysis";
      title: string;
      folderId: string | null;
      sourceIds: string[];
      instruction: string;
      model: string;
      content: string;
    }
  | { action: "create-folder"; name: string; parentId: string | null }
  | { action: "rename-folder"; id: string; name: string }
  | { action: "move-folder"; id: string; parentId: string | null }
  | { action: "delete-folder"; id: string };

export async function GET() {
  try {
    const catalog = await readCatalog();
    return NextResponse.json(catalog, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiErrorResponse(error, "データ保管庫を読み込めませんでした");
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as ActionBody;
    const bucket = vaultBucket();
    const s3 = createS3Client();

    // ── 事前処理系（カタログを読まないもの） ──
    if (body.action === "get-upload-url") {
      const id = crypto.randomUUID();
      const s3Key = vaultUploadKey(id, body.fileName);
      const uploadUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: bucket, Key: s3Key, ContentType: body.contentType }),
        { expiresIn: 900 }
      );
      return NextResponse.json({ id, uploadUrl, s3Key });
    }

    if (body.action === "get-download-url") {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: bucket, Key: body.s3Key }),
        { expiresIn: 3600 }
      );
      return NextResponse.json({ url });
    }

    if (body.action === "get-output") {
      const catalog = await readCatalog();
      const item = catalog.items.find(i => i.id === body.itemId);
      if (!item?.outputKey) {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
      const content = await getS3Text(bucket, item.outputKey);
      return NextResponse.json({ content, item });
    }

    const catalog = await readCatalog();

    switch (body.action) {
      case "register-document": {
        // アップロード直後に同期でテキスト抽出する。RAGを使わないためOCRもLambdaも走らせない。
        let textStatus: VaultTextStatus = "failed";
        let textKey: string | undefined;
        let textLength = 0;

        if (body.contentType.includes("pdf")) {
          try {
            const bytes = await getS3Bytes(bucket, body.s3Key);
            const parsed = await pdfParse(Buffer.from(bytes));
            const text = (parsed.text || "").trim();
            if (text.length >= MIN_USABLE_TEXT_LENGTH) {
              textKey = vaultTextKey(body.id);
              await putS3Text(bucket, textKey, text, "text/plain; charset=utf-8");
              textStatus = "ready";
              textLength = text.length;
            } else {
              // 画像だけのPDF。分析時はPDF原本をそのままBedrockへ渡す
              textStatus = "scanned";
            }
          } catch {
            textStatus = "failed";
          }
        } else {
          textStatus = "failed";
        }

        const item: VaultItem = {
          id: body.id,
          title: body.title?.trim() || body.fileName.replace(/\.[^.]+$/, ""),
          folderId: body.folderId,
          kind: "document",
          savedAt: new Date().toISOString(),
          fileName: body.fileName,
          s3Key: body.s3Key,
          contentType: body.contentType,
          size: body.size,
          sizeLabel: formatFileSize(body.size),
          textKey,
          textStatus,
          textLength
        };
        catalog.items.push(item);
        await writeCatalog(catalog);
        return NextResponse.json({ item });
      }

      case "save-analysis": {
        const id = crypto.randomUUID();
        const outputKey = vaultOutputKey(id);
        await putS3Text(bucket, outputKey, body.content, "text/markdown; charset=utf-8");
        const item: VaultItem = {
          id,
          title: body.title,
          folderId: body.folderId,
          kind: "analysis",
          savedAt: new Date().toISOString(),
          outputKey,
          sourceIds: body.sourceIds,
          instruction: body.instruction,
          model: body.model,
          sizeLabel: formatFileSize(Buffer.byteLength(body.content, "utf-8"))
        };
        catalog.items.push(item);
        await writeCatalog(catalog);
        return NextResponse.json({ item });
      }

      case "update-item": {
        const item = catalog.items.find(i => i.id === body.id);
        if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });
        if (body.title !== undefined) item.title = body.title;
        if ("folderId" in body) item.folderId = body.folderId ?? null;
        await writeCatalog(catalog);
        return NextResponse.json({ ok: true });
      }

      case "delete-item": {
        const item = catalog.items.find(i => i.id === body.id);
        if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });
        for (const key of [item.s3Key, item.textKey, item.outputKey]) {
          if (!key) continue;
          await s3
            .send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
            .catch(() => {});
        }
        catalog.items = catalog.items.filter(i => i.id !== body.id);
        await writeCatalog(catalog);
        return NextResponse.json({ ok: true });
      }

      case "create-folder": {
        const folder: VaultFolder = {
          id: crypto.randomUUID(),
          name: body.name,
          parentId: body.parentId
        };
        catalog.folders.push(folder);
        await writeCatalog(catalog);
        return NextResponse.json({ folder });
      }

      case "rename-folder": {
        const folder = catalog.folders.find(f => f.id === body.id);
        if (!folder) return NextResponse.json({ error: "not found" }, { status: 404 });
        folder.name = body.name;
        await writeCatalog(catalog);
        return NextResponse.json({ ok: true });
      }

      case "move-folder": {
        const folder = catalog.folders.find(f => f.id === body.id);
        if (!folder) return NextResponse.json({ error: "not found" }, { status: 404 });
        folder.parentId = body.parentId;
        await writeCatalog(catalog);
        return NextResponse.json({ ok: true });
      }

      case "delete-folder": {
        const toDelete = new Set<string>();
        const collect = (id: string) => {
          toDelete.add(id);
          catalog.folders.filter(f => f.parentId === id).forEach(f => collect(f.id));
        };
        collect(body.id);
        catalog.folders = catalog.folders.filter(f => !toDelete.has(f.id));
        // 中身は消さずルート直下へ退避する
        catalog.items = catalog.items.map(i =>
          i.folderId && toDelete.has(i.folderId) ? { ...i, folderId: null } : i
        );
        await writeCatalog(catalog);
        return NextResponse.json({ ok: true });
      }

      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (error) {
    return apiErrorResponse(error, "データ保管庫の操作に失敗しました");
  }
}
