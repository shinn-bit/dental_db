import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
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

  await createS3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: createMetadataS3Key(appEnv.s3MetadataPrefix, id),
      Body: JSON.stringify(nextMetadata, null, 2),
      ContentType: "application/json; charset=utf-8"
    })
  );

  return NextResponse.json({ file: nextMetadata });
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

