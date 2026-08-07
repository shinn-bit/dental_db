import { getS3Text, putS3Text, parseS3Json } from "@/lib/s3-json";
import { appEnv, requireEnv } from "@/lib/env";

// ── S3 layout ────────────────────────────────────────────────────
// data-vault/_index.json        カタログ（フォルダ＋アイテム）
// data-vault/uploads/{id}.pdf   原本
// data-vault/text/{id}.txt      抽出テキスト
// data-vault/outputs/{id}.md    分析結果（手動保存時のみ）
export const VAULT_PREFIX = "data-vault/";
export const VAULT_INDEX_KEY = `${VAULT_PREFIX}_index.json`;
export const VAULT_UPLOADS_PREFIX = `${VAULT_PREFIX}uploads/`;
export const VAULT_TEXT_PREFIX = `${VAULT_PREFIX}text/`;
export const VAULT_OUTPUTS_PREFIX = `${VAULT_PREFIX}outputs/`;

export type VaultFolder = {
  id: string;
  name: string;
  parentId: string | null;
};

/** 抽出テキストの状態。scanned = 画像PDFでテキストを取れなかった */
export type VaultTextStatus = "ready" | "scanned" | "failed";

export type VaultItem = {
  id: string;
  title: string;
  folderId: string | null;
  kind: "document" | "analysis";
  savedAt: string;
  // kind: "document"
  fileName?: string;
  s3Key?: string;
  contentType?: string;
  size?: number;
  sizeLabel?: string;
  textKey?: string;
  textStatus?: VaultTextStatus;
  textLength?: number;
  // kind: "analysis"
  outputKey?: string;
  sourceIds?: string[];
  instruction?: string;
  model?: string;
};

export type VaultCatalog = {
  folders: VaultFolder[];
  items: VaultItem[];
};

export function vaultBucket() {
  return requireEnv(appEnv.s3BucketName, "S3_BUCKET_NAME");
}

export function vaultUploadKey(id: string, fileName: string) {
  const ext = fileName.includes(".") ? fileName.split(".").pop()! : "bin";
  return `${VAULT_UPLOADS_PREFIX}${id}.${ext.toLowerCase()}`;
}

export function vaultTextKey(id: string) {
  return `${VAULT_TEXT_PREFIX}${id}.txt`;
}

export function vaultOutputKey(id: string) {
  return `${VAULT_OUTPUTS_PREFIX}${id}.md`;
}

export async function readCatalog(): Promise<VaultCatalog> {
  try {
    const text = await getS3Text(vaultBucket(), VAULT_INDEX_KEY);
    if (!text) return { folders: [], items: [] };
    const catalog = parseS3Json<Partial<VaultCatalog>>(text);
    return {
      folders: catalog.folders ?? [],
      items: (catalog.items ?? []).map(i => (i.kind ? i : { ...i, kind: "document" as const }))
    };
  } catch {
    // 初回はオブジェクトが存在しないので空カタログを返す
    return { folders: [], items: [] };
  }
}

export async function writeCatalog(catalog: VaultCatalog): Promise<void> {
  await putS3Text(vaultBucket(), VAULT_INDEX_KEY, JSON.stringify(catalog), "application/json");
}

/** 指定フォルダとその子孫のIDを集める */
export function collectDescendantFolderIds(folders: VaultFolder[], id: string): Set<string> {
  const result = new Set<string>();
  const walk = (fid: string) => {
    result.add(fid);
    folders.filter(f => f.parentId === fid).forEach(f => walk(f.id));
  };
  walk(id);
  return result;
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
