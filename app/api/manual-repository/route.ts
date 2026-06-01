import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextResponse } from "next/server";
import { createS3Client } from "@/lib/aws";
import { appEnv } from "@/lib/env";
import { getS3Text, putS3Text, parseS3Json } from "@/lib/s3-json";

export const dynamic = "force-dynamic";

const BUCKET = appEnv.s3BucketName;
const INDEX_KEY = "manual-repository/_index.json";
const UPLOADS_PREFIX = "manual-repository/uploads/";

export type RepoFolder = { id: string; name: string; parentId: string | null };
export type RepoItem = {
  id: string;
  title: string;
  folderId: string | null;
  savedAt: string;
  source: "generated" | "uploaded";
  // generated only
  sessionId?: string;
  type?: "word" | "slide";
  docMode?: "summary" | "procedure" | "free";
  firstSlideHtml?: string;
  // uploaded only
  s3Key?: string;
  contentType?: string;
  sizeLabel?: string;
  fileName?: string;
};
export type RepoCatalog = { folders: RepoFolder[]; items: RepoItem[] };

async function readCatalog(): Promise<RepoCatalog> {
  try {
    const text = await getS3Text(BUCKET, INDEX_KEY);
    if (!text) return { folders: [], items: [] };
    const catalog = parseS3Json<RepoCatalog>(text);
    // Back-compat: items without source field are generated
    catalog.items = catalog.items.map(i => (i.source ? i : { ...i, source: "generated" as const }));
    return catalog;
  } catch {
    return { folders: [], items: [] };
  }
}

async function writeCatalog(catalog: RepoCatalog): Promise<void> {
  await putS3Text(BUCKET, INDEX_KEY, JSON.stringify(catalog), "application/json");
}

export async function GET() {
  const catalog = await readCatalog();
  return NextResponse.json(catalog, { headers: { "Cache-Control": "no-store" } });
}

type ActionBody =
  | { action: "save-item"; item: Omit<RepoItem, "id" | "savedAt"> }
  | { action: "overwrite-item"; id: string; firstSlideHtml?: string }
  | { action: "update-item"; id: string; title?: string; folderId?: string | null }
  | { action: "delete-item"; id: string }
  | { action: "get-upload-url"; fileName: string; contentType: string }
  | { action: "get-download-url"; s3Key: string }
  | { action: "create-folder"; name: string; parentId: string | null }
  | { action: "rename-folder"; id: string; name: string }
  | { action: "move-folder"; id: string; parentId: string | null }
  | { action: "delete-folder"; id: string };

export async function POST(req: Request) {
  const body = (await req.json()) as ActionBody;
  const s3 = createS3Client();

  if (body.action === "get-upload-url") {
    const ext = body.fileName.includes(".") ? `.${body.fileName.split(".").pop()}` : "";
    const id = crypto.randomUUID();
    const s3Key = `${UPLOADS_PREFIX}${id}${ext}`;
    const url = await getSignedUrl(
      s3,
      new PutObjectCommand({ Bucket: BUCKET, Key: s3Key, ContentType: body.contentType }),
      { expiresIn: 300 }
    );
    return NextResponse.json({ uploadUrl: url, s3Key, id });
  }

  if (body.action === "get-download-url") {
    const url = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET, Key: body.s3Key }),
      { expiresIn: 3600 }
    );
    return NextResponse.json({ url });
  }

  const catalog = await readCatalog();

  switch (body.action) {
    case "save-item": {
      const item: RepoItem = {
        ...body.item,
        id: crypto.randomUUID(),
        savedAt: new Date().toISOString(),
      };
      catalog.items.push(item);
      await writeCatalog(catalog);
      return NextResponse.json({ id: item.id });
    }
    case "overwrite-item": {
      const item = catalog.items.find(i => i.id === body.id);
      if (!item) return NextResponse.json({ error: "not found" }, { status: 404 });
      item.savedAt = new Date().toISOString();
      if (body.firstSlideHtml !== undefined) item.firstSlideHtml = body.firstSlideHtml;
      await writeCatalog(catalog);
      return NextResponse.json({ ok: true });
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
      // If uploaded, also remove from S3
      if (item?.source === "uploaded" && item.s3Key) {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: item.s3Key })).catch(() => {});
      }
      catalog.items = catalog.items.filter(i => i.id !== body.id);
      await writeCatalog(catalog);
      return NextResponse.json({ ok: true });
    }
    case "create-folder": {
      const folder: RepoFolder = { id: crypto.randomUUID(), name: body.name, parentId: body.parentId };
      catalog.folders.push(folder);
      await writeCatalog(catalog);
      return NextResponse.json({ id: folder.id });
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
      catalog.items = catalog.items.map(i =>
        i.folderId && toDelete.has(i.folderId) ? { ...i, folderId: null } : i
      );
      await writeCatalog(catalog);
      return NextResponse.json({ ok: true });
    }
    default:
      return NextResponse.json({ error: "unknown action" }, { status: 400 });
  }
}
