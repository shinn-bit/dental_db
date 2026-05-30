export type StoredFileMetadata = {
  id: string;
  fileName: string;
  s3Key: string;
  contentType: string;
  mediaType: "document" | "image" | "video" | "other";
  size: number;
  sizeLabel: string;
  thumbnailLabel: string;
  folderId?: string;
  tags: string[];
  version: string;
  memo: string;
  summary?: string;
  summaryStatus?: "not_started" | "processing" | "completed" | "failed";
  summaryError?: string;
  summaryKey?: string;
  knowledgeBaseKey?: string;
  summaryUpdatedAt?: string;
  summaryMode?: "section" | "manual" | "legacy";
  summaryChunkCount?: number;
  summaryChunkMaterialsKey?: string;
  preparationStatus?: "not_started" | "processing" | "syncing" | "completed" | "failed";
  preparationError?: string;
  ragSyncStatus?: "not_started" | "syncing" | "completed" | "failed";
  ragSyncJobId?: string;
  ragSyncedAt?: string;
  textExtractionStatus?: "not_started" | "processing" | "completed" | "failed" | "ocr_required";
  textExtractionSource?: "pdf" | "ocr";
  extractedTextKey?: string;
  extractedTextLength?: number;
  textractJobId?: string;
  uploadedAt: string;
  catId?: string;
  subId?: string | null;
  imageProcessingStatus?: "processing" | "completed" | "failed";
  imageProcessingError?: string;
  imageProcessedAt?: string;
  images?: Array<{
    index: number;
    page: number;
    s3Key: string;
    width?: number;
    height?: number;
    description: string;
    descriptionSource: "caption" | "vision" | "error";
  }>;
};

export type FileMetadataInput = Partial<StoredFileMetadata> & Record<string, unknown>;

export function formatFileSize(size: number) {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function getThumbnailLabel(fileName: string) {
  const extension = fileName.split(".").pop()?.toUpperCase();
  if (!extension || extension === fileName.toUpperCase()) {
    return "FILE";
  }
  return extension.slice(0, 4);
}

export function getMediaType(contentType: string, fileName = ""): StoredFileMetadata["mediaType"] {
  const normalizedContentType = contentType.toLowerCase();
  const normalizedFileName = fileName.toLowerCase();
  if (normalizedContentType.startsWith("image/")) {
    return "image";
  }
  if (normalizedContentType.startsWith("video/")) {
    return "video";
  }
  if (
    normalizedContentType.includes("pdf") ||
    normalizedContentType.includes("text") ||
    normalizedContentType.includes("word") ||
    normalizedFileName.endsWith(".pdf") ||
    normalizedFileName.endsWith(".doc") ||
    normalizedFileName.endsWith(".docx") ||
    normalizedFileName.endsWith(".txt") ||
    normalizedFileName.endsWith(".md")
  ) {
    return "document";
  }
  return "other";
}

export function supportsAutomatedTextPreparation(metadata: Pick<StoredFileMetadata, "mediaType">) {
  return metadata.mediaType === "document" || metadata.mediaType === "image";
}

export function normalizeFileMetadata(input: FileMetadataInput): StoredFileMetadata {
  const id = input.id || crypto.randomUUID();
  const fileName = input.fileName || "名称未設定";
  const contentType = input.contentType || "application/octet-stream";
  const size = input.size || 0;

  return {
    id,
    fileName,
    s3Key: input.s3Key || "",
    contentType,
    mediaType: input.mediaType || getMediaType(contentType, fileName),
    size,
    sizeLabel: input.sizeLabel || formatFileSize(size),
    thumbnailLabel: input.thumbnailLabel || getThumbnailLabel(fileName),
    folderId: input.folderId || "",
    tags: input.tags || [],
    version: input.version || "",
    memo: input.memo || "",
    summary: input.summary || "",
    summaryStatus: input.summaryStatus || "not_started",
    summaryError: input.summaryError || "",
    summaryKey: input.summaryKey || "",
    knowledgeBaseKey: input.knowledgeBaseKey || "",
    summaryUpdatedAt: input.summaryUpdatedAt || "",
    summaryMode: input.summaryMode || "legacy",
    summaryChunkCount: input.summaryChunkCount || 0,
    summaryChunkMaterialsKey: input.summaryChunkMaterialsKey || "",
    preparationStatus: input.preparationStatus || "not_started",
    preparationError: input.preparationError || "",
    ragSyncStatus: input.ragSyncStatus || "not_started",
    ragSyncJobId: input.ragSyncJobId || "",
    ragSyncedAt: input.ragSyncedAt || "",
    textExtractionStatus: input.textExtractionStatus || "not_started",
    textExtractionSource: input.textExtractionSource,
    extractedTextKey: input.extractedTextKey || "",
    extractedTextLength: input.extractedTextLength || 0,
    textractJobId: input.textractJobId || "",
    uploadedAt: input.uploadedAt || new Date().toISOString(),
    catId: input.catId,
    subId: input.subId,
    imageProcessingStatus: input.imageProcessingStatus,
    imageProcessingError: input.imageProcessingError || "",
    imageProcessedAt: input.imageProcessedAt,
    images: input.images,
  };
}

export function sanitizeFileName(fileName: string) {
  return fileName.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/\s+/g, "_");
}

export function createFileAssetS3Key(prefix: string, id: string, fileName: string, date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${prefix}${year}/${month}/${id}-${sanitizeFileName(fileName)}`;
}

export function createMetadataS3Key(prefix: string, id: string) {
  return `${prefix}${id}.json`;
}

export function createSummaryS3Key(id: string) {
  return `summaries/${id}.md`;
}

export function createKnowledgeBaseS3Key(id: string) {
  return `kb/${id}.md`;
}

export function createExtractedTextS3Key(id: string) {
  return `summaries/extracted-text/${id}.txt`;
}

export function createOcrTextS3Key(id: string) {
  return `summaries/ocr-text/${id}.txt`;
}

export function createTextractInputS3Key(id: string) {
  return `textract-input/${id}.pdf`;
}
