import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { NextRequest, NextResponse } from "next/server";
import { appEnv, requireEnv } from "@/lib/env";
import { createS3Client } from "@/lib/aws";
import { fromIni } from "@aws-sdk/credential-providers";
import { parseS3Json } from "@/lib/s3-json";
import { normalizeFileMetadata, type FileMetadataInput } from "@/lib/file-assets";

export const maxDuration = 10;

function createLambdaClient() {
  const credentials = appEnv.awsProfile ? fromIni({ profile: appEnv.awsProfile }) : undefined;
  return new LambdaClient({
    region: appEnv.awsRegion,
    ...(credentials ? { credentials } : {}),
  });
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const bucket = requireEnv(appEnv.s3BucketName, "S3_BUCKET_NAME");
  const metaKey = `${appEnv.s3MetadataPrefix}${id}.json`;
  const functionName = process.env.IMAGE_PROCESSOR_FUNCTION_NAME ?? "dental-image-processor-dev";
  const s3 = createS3Client();

  try {
    // メタデータに "processing" を書き込む（フロントがすぐ状態を確認できるように）
    const metaRes = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: metaKey }));
    const metaText = await metaRes.Body?.transformToString() ?? "{}";
    const metadata = normalizeFileMetadata(parseS3Json<FileMetadataInput>(metaText));

    const updated = {
      ...metadata,
      imageProcessingStatus: "processing" as const,
      imageProcessingError: "",
    };
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: metaKey,
      Body: JSON.stringify(updated, null, 2),
      ContentType: "application/json; charset=utf-8",
    }));

    // Lambda を非同期起動（fire-and-forget）
    await createLambdaClient().send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ fileId: id })),
      })
    );

    return NextResponse.json({ status: "STARTED", fileId: id });
  } catch (err) {
    console.error("[process-images]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "不明なエラー" },
      { status: 500 }
    );
  }
}
