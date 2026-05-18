import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import {
  GetDocumentTextDetectionCommand,
  StartDocumentTextDetectionCommand
} from "@aws-sdk/client-textract";
import { NextResponse } from "next/server";
import { setTimeout as sleep } from "node:timers/promises";
import { join } from "path";
import { PDFParse } from "pdf-parse";
import { pathToFileURL } from "url";
import { createBedrockRuntimeClient, createS3Client, createTextractClient } from "@/lib/aws";
import { appEnv, requireEnv } from "@/lib/env";
import {
  createMetadataS3Key,
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
const TEXTRACT_POLL_INTERVAL_MS = 2000;
const TEXTRACT_MAX_POLLS = 90;

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

async function extractTextWithPdfParse(fileBytes: Uint8Array) {
  configurePdfWorker();
  const parser = new PDFParse({ data: Buffer.from(fileBytes) });

  try {
    const parsed = await parser.getText();
    return parsed.text.trim();
  } finally {
    await parser.destroy();
  }
}

async function extractTextWithTextract(bucket: string, key: string) {
  const textract = createTextractClient();
  const started = await textract.send(
    new StartDocumentTextDetectionCommand({
      DocumentLocation: {
        S3Object: {
          Bucket: bucket,
          Name: key
        }
      }
    })
  );

  if (!started.JobId) {
    throw new Error("Textract OCRジョブを開始できませんでした。");
  }

  for (let attempt = 0; attempt < TEXTRACT_MAX_POLLS; attempt += 1) {
    await sleep(TEXTRACT_POLL_INTERVAL_MS);

    const lines: string[] = [];
    let nextToken: string | undefined;
    let jobStatus: string | undefined;
    let statusMessage: string | undefined;

    do {
      const response = await textract.send(
        new GetDocumentTextDetectionCommand({
          JobId: started.JobId,
          NextToken: nextToken
        })
      );

      jobStatus = response.JobStatus;
      statusMessage = response.StatusMessage;

      if (jobStatus === "FAILED" || jobStatus === "PARTIAL_SUCCESS") {
        throw new Error(statusMessage || `Textract OCRジョブが${jobStatus}で終了しました。`);
      }

      if (jobStatus === "SUCCEEDED") {
        lines.push(
          ...(response.Blocks || [])
            .filter((block) => block.BlockType === "LINE" && block.Text)
            .map((block) => block.Text || "")
        );
      }

      nextToken = response.NextToken;
    } while (jobStatus === "SUCCEEDED" && nextToken);

    if (jobStatus === "SUCCEEDED") {
      return lines.join("\n").trim();
    }
  }

  throw new Error("Textract OCRジョブが時間内に完了しませんでした。");
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const metadata = await getMetadata(id);

  if (metadata.summaryKey) {
    const bucket = requireEnv(appEnv.s3BucketName, "S3_BUCKET_NAME");
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
    const fileBytes = await getS3Bytes(bucket, metadata.s3Key);
    const parsedText = await extractTextWithPdfParse(fileBytes);
    const extractedText =
      parsedText.length >= MIN_EXTRACTED_TEXT_LENGTH
        ? parsedText
        : await extractTextWithTextract(bucket, metadata.s3Key);

    if (extractedText.length < MIN_EXTRACTED_TEXT_LENGTH) {
      const nextMetadata: ManualMetadata = {
        ...metadata,
        summaryStatus: "failed",
        textExtractionStatus: "ocr_required",
        extractedTextLength: extractedText.length
      };
      await saveMetadata(nextMetadata);
      return NextResponse.json(
        {
          error: "OCR後もPDFから十分なテキストを抽出できませんでした。",
          file: nextMetadata
        },
        { status: 422 }
      );
    }

    const summary = await generateSummary(extractedText.slice(0, 180000));
    const summaryKey = createSummaryS3Key(id);
    const now = new Date().toISOString();
    const nextMetadata: ManualMetadata = {
      ...metadata,
      summary,
      summaryStatus: "completed",
      summaryError: "",
      summaryKey,
      summaryUpdatedAt: now,
      textExtractionStatus: "completed",
      extractedTextLength: extractedText.length
    };

    await putS3Text(bucket, summaryKey, summary, "text/markdown; charset=utf-8");
    await saveMetadata(nextMetadata);

    return NextResponse.json({ summary, file: nextMetadata });
  } catch (error) {
    const message = error instanceof Error ? error.message : "要約作成に失敗しました。";
    const nextMetadata: ManualMetadata = {
      ...metadata,
      summaryStatus: "failed",
      summaryError: message,
      textExtractionStatus:
        metadata.textExtractionStatus === "ocr_required" ? "ocr_required" : "failed"
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
  const nextMetadata: ManualMetadata = {
    ...metadata,
    summary,
    summaryStatus: "completed",
    summaryError: "",
    summaryKey,
    summaryUpdatedAt: new Date().toISOString()
  };

  await putS3Text(bucket, summaryKey, summary, "text/markdown; charset=utf-8");
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
