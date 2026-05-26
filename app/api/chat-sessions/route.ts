import { NextResponse } from "next/server";
import { appEnv } from "@/lib/env";
import { getS3Text, parseS3Json } from "@/lib/s3-json";

type SessionSummary = { id: string; title: string };

const BUCKET = appEnv.s3BucketName;
const INDEX_KEY = "chat-sessions/_index.json";

export async function GET() {
  try {
    const text = await getS3Text(BUCKET, INDEX_KEY);
    const sessions = text ? parseS3Json<SessionSummary[]>(text) : [];
    return NextResponse.json({ sessions });
  } catch {
    return NextResponse.json({ sessions: [] });
  }
}
