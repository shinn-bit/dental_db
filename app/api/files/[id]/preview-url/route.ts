import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextResponse } from "next/server";
import { createS3Client } from "@/lib/aws";
import { appEnv, requireEnv } from "@/lib/env";
import { createMetadataS3Key, normalizeFileMetadata, type FileMetadataInput } from "@/lib/file-assets";
import { parseS3Json } from "@/lib/s3-json";

async function bodyToString(body: unknown) {
  if (!body || typeof body !== "object" || !("transformToString" in body)) {
    return "";
  }

  return (body as { transformToString: () => Promise<string> }).transformToString();
}

async function getMetadata(id: string) {
  const bucket = requireEnv(appEnv.s3BucketName, "S3_BUCKET_NAME");
  const response = await createS3Client().send(
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
  const bucket = requireEnv(appEnv.s3BucketName, "S3_BUCKET_NAME");
  const file = await getMetadata(id);
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: file.s3Key
  });
  const url = await getSignedUrl(createS3Client(), command, { expiresIn: 300 });

  return NextResponse.json({
    url,
    contentType: file.contentType,
    fileName: file.fileName
  });
}

