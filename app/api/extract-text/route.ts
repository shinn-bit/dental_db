import { NextResponse } from "next/server";
import mammoth from "mammoth";

export async function POST(request: Request) {
  const { data, name } = (await request.json()) as { data: string; name?: string };
  if (!data) return NextResponse.json({ error: "data is required" }, { status: 400 });

  try {
    const buffer = Buffer.from(data, "base64");
    const result = await mammoth.extractRawText({ buffer });
    return NextResponse.json({ text: result.value.trim().slice(0, 4000), name });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "extraction failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
