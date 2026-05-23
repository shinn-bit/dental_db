import { PutObjectCommand } from "@aws-sdk/client-s3";
import { StartExecutionCommand } from "@aws-sdk/client-sfn";
import { NextResponse } from "next/server";
import { createS3Client, createStepFunctionsClient } from "@/lib/aws";
import { appEnv, requireEnv } from "@/lib/env";
import {
  createKnowledgeBaseS3Key,
  createMetadataS3Key,
  createSummaryS3Key,
  normalizeFileMetadata,
  type FileMetadataInput,
  type StoredFileMetadata
} from "@/lib/file-assets";
import { getS3Text, parseS3Json, putS3Text } from "@/lib/s3-json";

export const runtime = "nodejs";

async function getMetadata(id: string) {
  const bucket = requireEnv(appEnv.s3BucketName, "S3_BUCKET_NAME");
  const text = await getS3Text(bucket, createMetadataS3Key(appEnv.s3MetadataPrefix, id));
  return normalizeFileMetadata(parseS3Json<FileMetadataInput>(text));
}

async function saveMetadata(metadata: StoredFileMetadata) {
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

function createKnowledgeBaseDocument(summary: string) {
  const normalized = summary
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();

  return normalized.slice(0, 1800);
}

function createExecutionName(fileId: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `summary-${fileId}-${suffix}`.replace(/[^A-Za-z0-9-_]/g, "-").slice(0, 80);
}

async function startSummaryWorkflow(fileId: string) {
  const stateMachineArn = requireEnv(appEnv.summaryStateMachineArn, "SUMMARY_STATE_MACHINE_ARN");
  await createStepFunctionsClient().send(
    new StartExecutionCommand({
      stateMachineArn,
      name: createExecutionName(fileId),
      input: JSON.stringify({ fileId })
    })
  );
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bucket = requireEnv(appEnv.s3BucketName, "S3_BUCKET_NAME");
  const metadata = await getMetadata(id);

  if (metadata.summaryKey) {
    const summary = await getS3Text(bucket, metadata.summaryKey);
    return NextResponse.json({ summary, file: { ...metadata, summary } });
  }

  return NextResponse.json({ summary: metadata.summary || "", file: metadata });
}

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bucket = requireEnv(appEnv.s3BucketName, "S3_BUCKET_NAME");
  let metadata: StoredFileMetadata | null = null;

  try {
    metadata = await getMetadata(id);

    if (metadata.summaryStatus === "processing") {
      return NextResponse.json({ summary: metadata.summary || "", file: metadata }, { status: 202 });
    }

    if (metadata.summaryKey) {
      const summary = await getS3Text(bucket, metadata.summaryKey);
      return NextResponse.json({ summary, file: { ...metadata, summary } });
    }

    const nextMetadata: StoredFileMetadata = {
      ...metadata,
      summaryStatus: "processing",
      summaryError: "",
      textExtractionStatus:
        metadata.textExtractionStatus === "failed" && !metadata.extractedTextKey
          ? "not_started"
          : metadata.textExtractionStatus || "not_started",
      textractJobId: metadata.textExtractionStatus === "failed" ? "" : metadata.textractJobId
    };

    await saveMetadata(nextMetadata);
    await startSummaryWorkflow(id);

    return NextResponse.json({ summary: "", file: nextMetadata }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "要約作成に失敗しました。";
    console.error("summary start failed", {
      fileId: id,
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage: message
    });

    if (!metadata) {
      return NextResponse.json({ error: message }, { status: 500 });
    }

    const nextMetadata: StoredFileMetadata = {
      ...metadata,
      summaryStatus: "failed",
      summaryError: message,
      textExtractionStatus:
        metadata.textExtractionStatus === "processing" ? "failed" : metadata.textExtractionStatus
    };

    try {
      await saveMetadata(nextMetadata);
    } catch (saveError) {
      console.error("summary failure metadata save failed", {
        fileId: id,
        errorName: saveError instanceof Error ? saveError.name : "UnknownError",
        errorMessage: saveError instanceof Error ? saveError.message : "メタデータ保存に失敗しました。"
      });
    }

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
  const nextMetadata: StoredFileMetadata = {
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

