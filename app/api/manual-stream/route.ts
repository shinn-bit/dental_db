import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

type StreamRequest = {
  model: string;
  systemPrompt: string;
  contents: unknown;
  generationConfig?: { maxOutputTokens?: number; temperature?: number };
};

export async function POST(req: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "GEMINI_API_KEY is not configured" }, { status: 500 });
  }

  const { model, systemPrompt, contents, generationConfig } =
    (await req.json()) as StreamRequest;

  const upstream = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: generationConfig ?? { maxOutputTokens: 65536, temperature: 0.3 },
      }),
    }
  );

  if (!upstream.ok || !upstream.body) {
    const errText = await upstream.text().catch(() => "");
    return NextResponse.json({ error: errText }, { status: upstream.status });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
