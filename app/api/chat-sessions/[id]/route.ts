import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { NextResponse } from "next/server";
import { createS3Client } from "@/lib/aws";
import { appEnv } from "@/lib/env";
import { getS3Text, putS3Text, parseS3Json } from "@/lib/s3-json";

type ChatMessage = { role: "user" | "assistant"; text: string };
type ChatSession = { id: string; title: string; bedrockSessionId: string; messages: ChatMessage[] };
type SessionSummary = { id: string; title: string };

const BUCKET = appEnv.s3BucketName;
const INDEX_KEY = "chat-sessions/_index.json";
const PREFIX = "chat-sessions/";

async function readIndex(): Promise<SessionSummary[]> {
  try {
    const text = await getS3Text(BUCKET, INDEX_KEY);
    return text ? parseS3Json<SessionSummary[]>(text) : [];
  } catch {
    return [];
  }
}

async function writeIndex(sessions: SessionSummary[]): Promise<void> {
  await putS3Text(BUCKET, INDEX_KEY, JSON.stringify(sessions), "application/json");
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const text = await getS3Text(BUCKET, `${PREFIX}${id}.json`);
    return NextResponse.json(parseS3Json<ChatSession>(text));
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const session = (await req.json()) as ChatSession;
    await putS3Text(BUCKET, `${PREFIX}${id}.json`, JSON.stringify(session), "application/json");
    const index = await readIndex();
    const existing = index.findIndex((s) => s.id === id);
    if (existing >= 0) {
      index[existing].title = session.title;
    } else {
      index.unshift({ id, title: session.title });
    }
    await writeIndex(index);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[chat-sessions PUT] failed:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  await createS3Client().send(
    new DeleteObjectCommand({ Bucket: BUCKET, Key: `${PREFIX}${id}.json` })
  );

  const index = await readIndex();
  await writeIndex(index.filter((s) => s.id !== id));

  return NextResponse.json({ ok: true });
}
