import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextRequest, NextResponse } from "next/server";
import { createS3Client } from "@/lib/aws";
import { appEnv, requireEnv } from "@/lib/env";
import { normalizeFileMetadata, type FileMetadataInput } from "@/lib/file-assets";
import { parseS3Json } from "@/lib/s3-json";

export const maxDuration = 15;

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const bucket = requireEnv(appEnv.s3BucketName, "S3_BUCKET_NAME");
  const s3 = createS3Client();

  // メタデータ取得
  const metaKey = `${appEnv.s3MetadataPrefix}${id}.json`;
  const metaRes = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: metaKey }));
  const metaText = await metaRes.Body?.transformToString() ?? "{}";
  const metadata = normalizeFileMetadata(parseS3Json<FileMetadataInput>(metaText));

  const images = (metadata as { images?: FileMetadataInput["images"] }).images ?? [];

  if (images.length === 0) {
    return NextResponse.json({ images: [], imageProcessedAt: null });
  }

  // 各画像の presigned URL を生成（1時間有効）
  const imagesWithUrls = await Promise.all(
    images.map(async (img) => {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: bucket, Key: img.s3Key }),
        { expiresIn: 3600 }
      );
      return { ...img, url };
    })
  );

  return NextResponse.json({
    images: imagesWithUrls,
    imageProcessedAt: (metadata as { imageProcessedAt?: string }).imageProcessedAt ?? null,
  });
}
