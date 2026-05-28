import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 300;

type StreamRequest = {
  model: string;
  systemPrompt: string;
  contents: unknown;
  generationConfig?: {
    maxOutputTokens?: number;
    temperature?: number;
    thinkingConfig?: { thinkingBudget?: number };
  };
};

const RETRY_DELAYS_MS = [2000, 4000];
const HEARTBEAT_MS = 8000;

export async function POST(req: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "GEMINI_API_KEY is not configured" }, { status: 500 });
  }

  const { model, systemPrompt, contents, generationConfig } =
    (await req.json()) as StreamRequest;

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`;
  const geminiBody = JSON.stringify({
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: generationConfig ?? { maxOutputTokens: 65536, temperature: 0.3 },
  });

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // CloudFront のタイムアウト（30〜60秒）を防ぐため定期的にハートビートを送信する
      // クライアントの SSE パーサーは ": " で始まるコメント行を無視するので影響なし
      let closed = false;
      const heartbeat = setInterval(() => {
        if (!closed) {
          try { controller.enqueue(encoder.encode(": heartbeat\n\n")); } catch { /* closed */ }
        }
      }, HEARTBEAT_MS);

      const cleanup = () => {
        closed = true;
        clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      };

      try {
        let upstream: Response | null = null;

        for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
          const res = await fetch(geminiUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: geminiBody,
          });
          if ((res.status !== 503 && res.status !== 500) || attempt === RETRY_DELAYS_MS.length) {
            upstream = res;
            break;
          }
          await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        }

        if (!upstream || !upstream.ok || !upstream.body) {
          const errText = await upstream?.text().catch(() => "") ?? "";
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: errText })}\n\n`));
          cleanup();
          return;
        }

        const reader = upstream.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!closed) controller.enqueue(value);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown error";
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
        } catch { /* closed */ }
      } finally {
        cleanup();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
