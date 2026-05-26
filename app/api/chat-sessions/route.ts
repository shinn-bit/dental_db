import { NextResponse } from "next/server";
import { appEnv } from "@/lib/env";
import { getS3Text, parseS3Json } from "@/lib/s3-json";

export const dynamic = "force-dynamic";

type SessionSummary = { id: string; title: string };

const BUCKET = appEnv.s3BucketName;
const INDEX_KEY = "chat-sessions/_index.json";

export async function GET() {
  try {
    const text = await getS3Text(BUCKET, INDEX_KEY);
    const sessions = text ? parseS3Json<SessionSummary[]>(text) : [];
    return NextResponse.json({ sessions }, {
      headers: { "Cache-Control": "no-store, no-cache" }
    });
  } catch (err) {
    console.error("[chat-sessions GET] failed:", err);
    return NextResponse.json({ sessions: [] }, {
      headers: { "Cache-Control": "no-store, no-cache" }
    });
  }
}
