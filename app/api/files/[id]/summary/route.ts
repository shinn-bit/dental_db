import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  GetDocumentTextDetectionCommand,
  StartDocumentTextDetectionCommand
} from "@aws-sdk/client-textract";
import { NextResponse } from "next/server";
import { join } from "path";
import { PDFParse } from "pdf-parse";
import { pathToFileURL } from "url";
import {
  createBedrockRuntimeClient,
  createS3Client,
  createTextractClient,
  createTextractS3Client
} from "@/lib/aws";
import { appEnv, requireEnv } from "@/lib/env";
import {
  createMetadataS3Key,
  createExtractedTextS3Key,
  createOcrTextS3Key,
  createTextractInputS3Key,
  createKnowledgeBaseS3Key,
  createSummaryS3Key,
  type ManualMetadata
} from "@/lib/manuals";
import { getS3Bytes, getS3Text, putS3Text } from "@/lib/s3-json";

export const runtime = "nodejs";

const summaryTemplate = `
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
`;

const MIN_EXTRACTED_TEXT_LENGTH = 100;
const MIN_MEANINGFUL_TEXT_LENGTH = 1000;
const MIN_MEANINGFUL_CHARS_PER_PAGE = 20;

async function getMetadata(id: string) {
  const bucket = requireEnv(appEnv.s3BucketName, "S3_BUCKET_NAME");
  const text = await getS3Text(bucket, createMetadataS3Key(appEnv.s3MetadataPrefix, id));
  return JSON.parse(text) as ManualMetadata;
}

async function saveMetadata(metadata: ManualMetadata) {
  const bucket = requireEnv(appEnv.s3BucketName, "S3_BUCKET_NAME");
  await createS3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: createMetadataS3Key(appEnv.s3MetadataPrefix, metadata.id),
      Body: JSON.stringify(metadata, null, 2),
      ContentType: "application/json; charset=utf-8"
    })
  );
}

function getTextractSourceBucket() {
  return requireEnv(appEnv.textractBucketName, "APP_TEXTRACT_BUCKET_NAME");
}

function configurePdfWorker() {
  const workerPath = join(
    process.cwd(),
    "node_modules",
    "pdf-parse",
    "dist",
    "worker",
    "pdf.worker.mjs"
  );
  PDFParse.setWorker(pathToFileURL(workerPath).toString());
}

function cleanExtractedText(text: string) {
  return text
    .replace(/^--\s*\d+\s+of\s+\d+\s*--$/gim, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasEnoughMeaningfulText(text: string, pageCount?: number) {
  const compactText = cleanExtractedText(text).replace(/\s+/g, "");
  const minimumLength = Math.max(
    MIN_MEANINGFUL_TEXT_LENGTH,
    (pageCount || 1) * MIN_MEANINGFUL_CHARS_PER_PAGE
  );

  return compactText.length >= minimumLength;
}

async function extractTextWithPdfParse(fileBytes: Uint8Array) {
  configurePdfWorker();
  const parser = new PDFParse({ data: Buffer.from(fileBytes) });

  try {
    const parsed = await parser.getText();
    return {
      pageCount: parsed.total,
      text: cleanExtractedText(parsed.text || "")
    };
  } finally {
    await parser.destroy();
  }
}

async function stagePdfForTextract(sourceBucket: string, sourceKey: string, id: string) {
  const stagingBucket = await getTextractSourceBucket();
  const fileBytes = await getS3Bytes(sourceBucket, sourceKey);
  const stagingKey = createTextractInputS3Key(id);

  await createTextractS3Client().send(
    new PutObjectCommand({
      Bucket: stagingBucket,
      Key: stagingKey,
      Body: fileBytes,
      ContentType: "application/pdf"
    })
  );

  return { bucket: stagingBucket, key: stagingKey };
}

async function getTextractTextIfReady(jobId: string) {
  const textract = createTextractClient();
  const lines: string[] = [];
  let nextToken: string | undefined;
  let jobStatus: string | undefined;
  let statusMessage: string | undefined;

  do {
    const response = await textract.send(
      new GetDocumentTextDetectionCommand({
        JobId: jobId,
        NextToken: nextToken
      })
    );

    jobStatus = response.JobStatus;
    statusMessage = response.StatusMessage;

    if (jobStatus === "IN_PROGRESS") {
      return { status: "IN_PROGRESS" as const, text: "" };
    }

    if (jobStatus === "FAILED" || jobStatus === "PARTIAL_SUCCESS") {
      throw new Error(statusMessage || `Textract OCRジョブが${jobStatus}で終了しました。`);
    }

    lines.push(
      ...(response.Blocks || [])
        .filter((block) => block.BlockType === "LINE" && block.Text)
        .map((block) => block.Text || "")
    );

    nextToken = response.NextToken;
  } while (nextToken);

  return { status: "SUCCEEDED" as const, text: lines.join("\n").trim() };
}

async function startTextractJob(bucket: string, key: string) {
  const response = await createTextractClient().send(
    new StartDocumentTextDetectionCommand({
      DocumentLocation: {
        S3Object: {
          Bucket: bucket,
          Name: key
        }
      }
    })
  );

  if (!response.JobId) {
    throw new Error("Textract OCRジョブを開始できませんでした。");
  }

  return response.JobId;
}

async function saveExtractedText(
  bucket: string,
  metadata: ManualMetadata,
  text: string,
  source: "pdf" | "ocr"
) {
  const textKey = source === "ocr" ? createOcrTextS3Key(metadata.id) : createExtractedTextS3Key(metadata.id);
  await putS3Text(bucket, textKey, text, "text/plain; charset=utf-8");

  return {
    ...metadata,
    textExtractionStatus: "completed" as const,
    textExtractionSource: source,
    extractedTextKey: textKey,
    extractedTextLength: text.length,
    textractJobId: ""
  };
}

function createKnowledgeBaseDocument(summary: string) {
  const normalized = summary
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();

  return normalized.slice(0, 1800);
}

async function generateAndSaveSummary(bucket: string, metadata: ManualMetadata) {
  if (!metadata.extractedTextKey) {
    return metadata;
  }

  const extractedText = await getS3Text(bucket, metadata.extractedTextKey);

  if (extractedText.length < MIN_EXTRACTED_TEXT_LENGTH) {
    return {
      ...metadata,
      summaryStatus: "failed" as const,
      summaryError: "OCR後もPDFから十分なテキストを抽出できませんでした。"
    };
  }

  const summary = await generateSummary(extractedText.slice(0, 180000));
  const summaryKey = createSummaryS3Key(metadata.id);
  const knowledgeBaseKey = createKnowledgeBaseS3Key(metadata.id);
  const now = new Date().toISOString();
  const knowledgeBaseDocument = createKnowledgeBaseDocument(summary || extractedText);
  const nextMetadata: ManualMetadata = {
    ...metadata,
    summary,
    summaryStatus: "completed",
    summaryError: "",
    summaryKey,
    knowledgeBaseKey,
    summaryUpdatedAt: now
  };

  await putS3Text(bucket, summaryKey, summary, "text/markdown; charset=utf-8");
  await putS3Text(bucket, knowledgeBaseKey, knowledgeBaseDocument, "text/markdown; charset=utf-8");
  return nextMetadata;
}

async function advanceSummaryJob(bucket: string, metadata: ManualMetadata) {
  let nextMetadata = metadata;

  if (nextMetadata.textExtractionStatus === "processing" && nextMetadata.textractJobId) {
    const stagingKey = createTextractInputS3Key(nextMetadata.id);
    const stagingBucket = getTextractSourceBucket();
    const ocr = await getTextractTextIfReady(nextMetadata.textractJobId);
    if (ocr.status === "IN_PROGRESS") {
      return nextMetadata;
    }

    nextMetadata = await saveExtractedText(bucket, nextMetadata, ocr.text, "ocr");
    await saveMetadata(nextMetadata);

    try {
      await createTextractS3Client().send(
        new DeleteObjectCommand({
          Bucket: stagingBucket,
          Key: stagingKey
        })
      );
    } catch {
      // OCR staging cleanup is best-effort.
    }
  }

  if (nextMetadata.textExtractionStatus === "completed" && nextMetadata.summaryStatus === "processing") {
    nextMetadata = await generateAndSaveSummary(bucket, nextMetadata);
    await saveMetadata(nextMetadata);
  }

  return nextMetadata;
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bucket = requireEnv(appEnv.s3BucketName, "S3_BUCKET_NAME");
  const metadata = await advanceSummaryJob(bucket, await getMetadata(id));

  if (metadata.summaryKey) {
    const summary = await getS3Text(bucket, metadata.summaryKey);
    return NextResponse.json({ summary, file: { ...metadata, summary } });
  }

  return NextResponse.json({ summary: metadata.summary || "", file: metadata });
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bucket = requireEnv(appEnv.s3BucketName, "S3_BUCKET_NAME");
  const metadata = await getMetadata(id);

  try {
    if (metadata.summaryStatus === "processing") {
      const nextMetadata = await advanceSummaryJob(bucket, metadata);
      return NextResponse.json({ summary: nextMetadata.summary || "", file: nextMetadata }, { status: 202 });
    }

    if (metadata.summaryKey) {
      const summary = await getS3Text(bucket, metadata.summaryKey);
      return NextResponse.json({ summary, file: { ...metadata, summary } });
    }

    const fileBytes = await getS3Bytes(bucket, metadata.s3Key);
    const parsed = await extractTextWithPdfParse(fileBytes);

    if (hasEnoughMeaningfulText(parsed.text, parsed.pageCount)) {
      const extractedMetadata = await saveExtractedText(bucket, metadata, parsed.text, "pdf");
      const processingMetadata: ManualMetadata = {
        ...extractedMetadata,
        summaryStatus: "processing",
        summaryError: ""
      };
      await saveMetadata(processingMetadata);
      return NextResponse.json({ summary: "", file: processingMetadata }, { status: 202 });
    }

    const staged = await stagePdfForTextract(bucket, metadata.s3Key, metadata.id);
    const textractJobId = await startTextractJob(staged.bucket, staged.key);
    const nextMetadata: ManualMetadata = {
      ...metadata,
      summaryStatus: "processing",
      summaryError: "",
      textExtractionStatus: "processing",
      textExtractionSource: "ocr",
      extractedTextLength: 0,
      textractJobId
    };

    await saveMetadata(nextMetadata);
    return NextResponse.json({ summary: "", file: nextMetadata }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "要約作成に失敗しました。";
    const nextMetadata: ManualMetadata = {
      ...metadata,
      summaryStatus: "failed",
      summaryError: message,
      textExtractionStatus:
        metadata.textExtractionStatus === "processing" ? "failed" : metadata.textExtractionStatus
    };
    await saveMetadata(nextMetadata);
    return NextResponse.json({ error: message, file: nextMetadata }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json()) as { summary?: string };
  const summary = body.summary?.trim();

  if (!summary) {
    return NextResponse.json({ error: "summary is required" }, { status: 400 });
  }

  const bucket = requireEnv(appEnv.s3BucketName, "S3_BUCKET_NAME");
  const metadata = await getMetadata(id);
  const summaryKey = metadata.summaryKey || createSummaryS3Key(id);
  const knowledgeBaseKey = metadata.knowledgeBaseKey || createKnowledgeBaseS3Key(id);
  const nextMetadata: ManualMetadata = {
    ...metadata,
    summary,
    summaryStatus: "completed",
    summaryError: "",
    summaryKey,
    knowledgeBaseKey,
    summaryUpdatedAt: new Date().toISOString()
  };

  await putS3Text(bucket, summaryKey, summary, "text/markdown; charset=utf-8");
  await putS3Text(bucket, knowledgeBaseKey, createKnowledgeBaseDocument(summary), "text/markdown; charset=utf-8");
  await saveMetadata(nextMetadata);

  return NextResponse.json({ summary, file: nextMetadata });
}

async function generateSummary(text: string) {
  const modelArn = requireEnv(appEnv.bedrockModelArn, "BEDROCK_MODEL_ARN");
  const response = await createBedrockRuntimeClient().send(
    new ConverseCommand({
      modelId: modelArn,
      messages: [
        {
          role: "user",
          content: [
            {
              text: `${summaryTemplate}\n\nPDF本文:\n${text}`
            }
          ]
        }
      ],
      inferenceConfig: {
        maxTokens: 4096,
        temperature: 0.2
      }
    })
  );

  return response.output?.message?.content
    ?.map((item) => ("text" in item ? item.text || "" : ""))
    .join("\n")
    .trim() || "";
}
