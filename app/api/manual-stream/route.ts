import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

type StreamRequest = {
  model: string;
  systemPrompt: string;
  contents: unknown;
  generationConfig?: { maxOutputTokens?: number; temperature?: number };
};

const RETRY_DELAYS = [2000, 4000]; // 2回リトライ: 2秒後・4秒後

async function fetchGemini(url: string, body: string): Promise<Response> {
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (res.status !== 503 || attempt === RETRY_DELAYS.length) return res;
    await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
  }
  throw new Error("unreachable");
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "GEMINI_API_KEY is not configured" }, { status: 500 });
  }

  const { model, systemPrompt, contents, generationConfig } =
    (await req.json()) as StreamRequest;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`;
  const body = JSON.stringify({
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: generationConfig ?? { maxOutputTokens: 65536, temperature: 0.3 },
  });

  const upstream = await fetchGemini(url, body);

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
