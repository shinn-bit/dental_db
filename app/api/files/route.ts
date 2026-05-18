import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-error";
import { createS3Client } from "@/lib/aws";
import { appEnv, requireEnv } from "@/lib/env";
import {
  createMetadataS3Key,
  formatFileSize,
  getThumbnailLabel,
  type ManualMetadata
} from "@/lib/manuals";
import { parseS3Json } from "@/lib/s3-json";

async function bodyToString(body: unknown) {
  if (!body || typeof body !== "object" || !("transformToString" in body)) {
    return "";
  }

  return (body as { transformToString: () => Promise<string> }).transformToString();
}

export async function GET() {
  try {
    const bucket = requireEnv(appEnv.s3BucketName, "S3_BUCKET_NAME");
    const s3 = createS3Client();
    const listed = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: appEnv.s3MetadataPrefix
      })
    );

    const objects = listed.Contents || [];
    const metadata = await Promise.all(
      objects
        .filter((object) => object.Key?.endsWith(".json"))
        .map(async (object) => {
          const response = await s3.send(
            new GetObjectCommand({
              Bucket: bucket,
              Key: object.Key
            })
          );
          const text = await bodyToString(response.Body);
          return parseS3Json<ManualMetadata>(text);
        })
    );

    metadata.sort((a, b) => Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt));

    return NextResponse.json({ files: metadata });
  } catch (error) {
    return apiErrorResponse(error, "S3一覧を読み込めませんでした");
  }
}

export async function POST(request: Request) {
  try {
    const bucket = requireEnv(appEnv.s3BucketName, "S3_BUCKET_NAME");
    const body = (await request.json()) as Partial<ManualMetadata>;

    if (!body.id || !body.fileName || !body.s3Key) {
      return NextResponse.json({ error: "id, fileName and s3Key are required" }, { status: 400 });
    }

    const metadata: ManualMetadata = {
      id: body.id,
      fileName: body.fileName,
      s3Key: body.s3Key,
      contentType: body.contentType || "application/octet-stream",
      size: body.size || 0,
      sizeLabel: body.sizeLabel || formatFileSize(body.size || 0),
      thumbnailLabel: body.thumbnailLabel || getThumbnailLabel(body.fileName),
      categoryIds: body.categoryIds || [],
      categories: body.categories || [],
      clinicalAreaIds: body.clinicalAreaIds || [],
      clinicalAreas: body.clinicalAreas || [],
      roleIds: body.roleIds || [],
      roles: body.roles || [],
      tags: body.tags || [],
      version: body.version || "",
      memo: body.memo || "",
      summary: body.summary || "",
      summaryStatus: body.summaryStatus || "not_started",
      summaryKey: body.summaryKey || "",
      summaryUpdatedAt: body.summaryUpdatedAt || "",
      textExtractionStatus: body.textExtractionStatus || "not_started",
      textExtractionSource: body.textExtractionSource,
      extractedTextKey: body.extractedTextKey || "",
      extractedTextLength: body.extractedTextLength || 0,
      textractJobId: body.textractJobId || "",
      uploadedAt: body.uploadedAt || new Date().toISOString()
    };

    await createS3Client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: createMetadataS3Key(appEnv.s3MetadataPrefix, metadata.id),
        Body: JSON.stringify(metadata, null, 2),
        ContentType: "application/json; charset=utf-8"
      })
    );

    return NextResponse.json({ file: metadata });
  } catch (error) {
    return apiErrorResponse(error, "S3メタデータを保存できませんでした");
  }
}
