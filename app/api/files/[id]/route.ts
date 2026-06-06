import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { BedrockAgentClient, StartIngestionJobCommand } from "@aws-sdk/client-bedrock-agent";
import { fromIni } from "@aws-sdk/credential-providers";
import { NextResponse } from "next/server";
import { createS3Client, createTextractS3Client } from "@/lib/aws";
import { appEnv, requireEnv } from "@/lib/env";
import {
  createMetadataS3Key,
  createTextractInputS3Key,
  normalizeFileMetadata,
  type FileMetadataInput,
  type StoredFileMetadata
} from "@/lib/file-assets";
import { parseS3Json } from "@/lib/s3-json";

async function bodyToString(body: unknown) {
  if (!body || typeof body !== "object" || !("transformToString" in body)) {
    return "";
  }

  return (body as { transformToString: () => Promise<string> }).transformToString();
}

async function getMetadata(id: string) {
  const bucket = requireEnv(appEnv.s3BucketName, "S3_BUCKET_NAME");
  const s3 = createS3Client();
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: bucket,
      Key: createMetadataS3Key(appEnv.s3MetadataPrefix, id)
    })
  );
  const text = await bodyToString(response.Body);
  return normalizeFileMetadata(parseS3Json<FileMetadataInput>(text));
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const file = await getMetadata(id);

  return NextResponse.json({ file });
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bucket = requireEnv(appEnv.s3BucketName, "S3_BUCKET_NAME");
  const current = await getMetadata(id);
  const body = (await request.json()) as FileMetadataInput;

  const nextMetadata: StoredFileMetadata = {
    ...current,
    folderId: body.folderId ?? current.folderId,
    tags: body.tags || [],
    version: body.version || "",
    memo: body.memo || ""
  };

  const s3 = createS3Client();
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: createMetadataS3Key(appEnv.s3MetadataPrefix, id),
      Body: JSON.stringify(nextMetadata, null, 2),
      ContentType: "application/json; charset=utf-8"
    })
  );

  // folderId が変更され、KB文書が存在する場合はサイドカーを更新してKB再同期
  const folderChanged = body.folderId !== undefined && body.folderId !== current.folderId;
  if (folderChanged && nextMetadata.knowledgeBaseKey) {
    try {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `${nextMetadata.knowledgeBaseKey}.metadata.json`,
          Body: JSON.stringify({ metadataAttributes: { folderId: nextMetadata.folderId || "__none__" } }),
          ContentType: "application/json; charset=utf-8"
        })
      );
      await triggerKbResync();
    } catch (err) {
      console.error("[files PUT] folderId sidecar/resync failed:", err);
    }
  }

  return NextResponse.json({ file: nextMetadata });
}

async function triggerKbResync() {
  const kbId = appEnv.bedrockKnowledgeBaseId;
  const dsId = appEnv.bedrockDataSourceId;
  if (!kbId || !dsId) return;
  const credentials = appEnv.awsProfile ? fromIni({ profile: appEnv.awsProfile }) : undefined;
  const client = new BedrockAgentClient({
    region: appEnv.awsRegion,
    ...(credentials ? { credentials } : {}),
  });
  try {
    await client.send(new StartIngestionJobCommand({
      knowledgeBaseId: kbId,
      dataSourceId: dsId,
      description: "folderId change resync",
    }));
  } catch (err) {
    // ConflictException（既存ジョブ実行中）は無視。次回ジョブが拾う
    if (!(err instanceof Error) || !err.message.includes("ConflictException")) {
      console.error("[files PUT] StartIngestionJob failed:", err);
    }
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const bucket = requireEnv(appEnv.s3BucketName, "S3_BUCKET_NAME");
  const s3 = createS3Client();
  const file = await getMetadata(id);

  await s3.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: file.s3Key
    })
  );
  if (file.summaryKey) {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: file.summaryKey
      })
    );
  }
  if (file.knowledgeBaseKey) {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: file.knowledgeBaseKey
      })
    );
  }
  if (file.extractedTextKey) {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: file.extractedTextKey
      })
    );
  }
  if (file.textExtractionSource === "ocr") {
    const textractBucket = requireEnv(appEnv.textractBucketName, "APP_TEXTRACT_BUCKET_NAME");
    await createTextractS3Client().send(
      new DeleteObjectCommand({
        Bucket: textractBucket,
        Key: createTextractInputS3Key(id)
      })
    );
  }
  await s3.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: createMetadataS3Key(appEnv.s3MetadataPrefix, id)
    })
  );

  return NextResponse.json({ deleted: true, id });
}

