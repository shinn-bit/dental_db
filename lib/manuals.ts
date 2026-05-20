export type ManualMetadata = {
  id: string;
  fileName: string;
  s3Key: string;
  contentType: string;
  size: number;
  sizeLabel: string;
  thumbnailLabel: string;
  categoryIds: string[];
  categories: string[];
  clinicalAreaIds: string[];
  clinicalAreas: string[];
  roleIds: string[];
  roles: string[];
  tags: string[];
  version: string;
  memo: string;
  summary?: string;
  summaryStatus?: "not_started" | "processing" | "completed" | "failed";
  summaryError?: string;
  summaryKey?: string;
  knowledgeBaseKey?: string;
  summaryUpdatedAt?: string;
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
};

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

export function sanitizeFileName(fileName: string) {
  return fileName.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").replace(/\s+/g, "_");
}

export function createManualS3Key(prefix: string, id: string, fileName: string, date = new Date()) {
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
