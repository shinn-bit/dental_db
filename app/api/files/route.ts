import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { StartExecutionCommand } from "@aws-sdk/client-sfn";
import { NextResponse } from "next/server";
import { apiErrorResponse } from "@/lib/api-error";
import { createS3Client, createStepFunctionsClient } from "@/lib/aws";
import { appEnv, requireEnv } from "@/lib/env";
import {
  createMetadataS3Key,
  normalizeFileMetadata,
  supportsAutomatedTextPreparation,
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

function createPrepareExecutionName(fileId: string) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  return `prepare-${fileId}-${suffix}`.replace(/[^A-Za-z0-9-_]/g, "-").slice(0, 80);
}

async function startPrepareWorkflow(fileId: string) {
  const stateMachineArn = requireEnv(appEnv.prepareStateMachineArn, "PREPARE_STATE_MACHINE_ARN");
  await createStepFunctionsClient().send(
    new StartExecutionCommand({
      stateMachineArn,
      name: createPrepareExecutionName(fileId),
      input: JSON.stringify({ fileId })
    })
  );
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
          return normalizeFileMetadata(parseS3Json<FileMetadataInput>(text));
        })
    );

    metadata.sort((a, b) => Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt));

    const files = await Promise.all(
      metadata.map(async (m) => {
        if (!m.thumbnailKey) return { ...m, thumbnailUrl: null };
        try {
          const thumbnailUrl = await getSignedUrl(
            s3,
            new GetObjectCommand({ Bucket: bucket, Key: m.thumbnailKey }),
            { expiresIn: 3600 }
          );
          return { ...m, thumbnailUrl };
        } catch {
          return { ...m, thumbnailUrl: null };
        }
      })
    );

    return NextResponse.json({ files });
  } catch (error) {
    return apiErrorResponse(error, "S3一覧を読み込めませんでした");
  }
}

export async function POST(request: Request) {
  try {
    const bucket = requireEnv(appEnv.s3BucketName, "S3_BUCKET_NAME");
    const body = (await request.json()) as FileMetadataInput;

    if (!body.id || !body.fileName || !body.s3Key) {
      return NextResponse.json({ error: "id, fileName and s3Key are required" }, { status: 400 });
    }

    const metadata: StoredFileMetadata = normalizeFileMetadata(body);
    const shouldPrepare = supportsAutomatedTextPreparation(metadata);
    metadata.preparationStatus = body.preparationStatus || (shouldPrepare ? "processing" : "not_started");

    await createS3Client().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: createMetadataS3Key(appEnv.s3MetadataPrefix, metadata.id),
        Body: JSON.stringify(metadata, null, 2),
        ContentType: "application/json; charset=utf-8"
      })
    );

    if (shouldPrepare) {
      await startPrepareWorkflow(metadata.id);
    }

    return NextResponse.json({ file: metadata });
  } catch (error) {
    return apiErrorResponse(error, "S3メタデータを保存できませんでした");
  }
}

