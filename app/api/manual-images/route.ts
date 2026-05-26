import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { NextResponse } from "next/server";
import { createS3Client } from "@/lib/aws";
import { appEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

type UploadBody = { action: "upload"; sessionId: string; storageKey: string; mimeType: string };
type DownloadBody = { action: "download"; s3Key: string };

export async function POST(req: Request) {
  try {
    const body = await req.json() as UploadBody | DownloadBody;
    const client = createS3Client();
    const bucket = appEnv.s3BucketName;

    if (body.action === "upload") {
      const s3Key = `chat-sessions/images/${body.sessionId}/${body.storageKey}`;
      const uploadUrl = await getSignedUrl(client, new PutObjectCommand({
        Bucket: bucket, Key: s3Key, ContentType: body.mimeType,
      }), { expiresIn: 300 });
      return NextResponse.json({ uploadUrl, s3Key });
    } else {
      const url = await getSignedUrl(client, new GetObjectCommand({
        Bucket: bucket, Key: body.s3Key,
      }), { expiresIn: 3600 });
      return NextResponse.json({ url });
    }
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
