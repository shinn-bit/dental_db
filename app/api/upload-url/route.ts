import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextResponse } from "next/server";
import { createS3Client } from "@/lib/aws";
import { appEnv, requireEnv } from "@/lib/env";
import { createManualS3Key } from "@/lib/manuals";

type UploadUrlRequest = {
  fileName?: string;
  contentType?: string;
};

export async function POST(request: Request) {
  const body = (await request.json()) as UploadUrlRequest;
  const fileName = body.fileName?.trim();

  if (!fileName) {
    return NextResponse.json({ error: "fileName is required" }, { status: 400 });
  }

  const bucket = requireEnv(appEnv.s3BucketName, "S3_BUCKET_NAME");
  const id = crypto.randomUUID();
  const contentType = body.contentType || "application/octet-stream";
  const s3Key = createManualS3Key(appEnv.s3ManualPrefix, id, fileName);

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: s3Key,
    ContentType: contentType
  });

  const uploadUrl = await getSignedUrl(createS3Client(), command, { expiresIn: 300 });

  return NextResponse.json({
    id,
    uploadUrl,
    s3Key
  });
}
