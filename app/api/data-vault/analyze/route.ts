import { ConverseStreamCommand, type ContentBlock } from "@aws-sdk/client-bedrock-runtime";
import { NextResponse } from "next/server";
import { createBedrockRuntimeClient } from "@/lib/aws";
import { appEnv, requireEnv } from "@/lib/env";
import { getS3Bytes, getS3Text } from "@/lib/s3-json";
import { readCatalog, vaultBucket } from "@/lib/data-vault";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** 出力が費用の6割を占めるので既定を絞る */
const MAX_OUTPUT_TOKENS = 2048;
/** 1資料あたりの投入文字数の上限。想定はA4数枚なので通常は掛からない */
const MAX_CHARS_PER_DOCUMENT = 60000;
/** Converse APIのdocumentブロック上限に合わせる */
const MAX_PDF_BYTES = 4_500_000;
const MAX_DOCUMENT_BLOCKS = 5;
const HEARTBEAT_MS = 8000;

const SYSTEM_PROMPT = `あなたは歯科医院の院内資料を読み解くアシスタントです。

出力ルール:
- 日本語で出力する
- 資料に書かれている内容だけを答える
- 推測で補わない
- 資料から判断できないことは「資料内では確認できません」と書く
- 数値、手順、基準、注意点、器材名などの具体情報を優先する
- Markdownの見出しと箇条書きで構造化する`;

type AnalyzeRequest = {
  ids: string[];
  instruction: string;
  history?: { role: "user" | "assistant"; text: string }[];
};

/** Bedrockのdocument nameは英数字・空白・ハイフン・括弧のみ許可される */
function safeDocumentName(index: number) {
  return `document-${index + 1}`;
}

export async function POST(request: Request) {
  const { ids, instruction, history } = (await request.json()) as AnalyzeRequest;

  if (!ids?.length) {
    return NextResponse.json({ error: "資料が選択されていません" }, { status: 400 });
  }
  if (!instruction?.trim()) {
    return NextResponse.json({ error: "指示を入力してください" }, { status: 400 });
  }

  const modelId = requireEnv(appEnv.bedrockModelArn, "BEDROCK_MODEL_ARN");
  const bucket = vaultBucket();
  const catalog = await readCatalog();
  const targets = ids
    .map(id => catalog.items.find(i => i.id === id))
    .filter((i): i is NonNullable<typeof i> => !!i && i.kind === "document");

  if (!targets.length) {
    return NextResponse.json({ error: "選択された資料が見つかりません" }, { status: 404 });
  }

  // ── 資料の中身を組み立てる ──
  // テキスト抽出済み → textブロック（確実・安価・サイズ上限なし）
  // 抽出できないスキャンPDF → documentブロックでPDF原本を渡す
  const content: ContentBlock[] = [];
  const skipped: string[] = [];
  let documentBlocks = 0;

  for (const [index, item] of targets.entries()) {
    if (item.textStatus === "ready" && item.textKey) {
      try {
        const text = await getS3Text(bucket, item.textKey);
        content.push({
          text: `# 資料${index + 1}: ${item.title}\n\n${text.slice(0, MAX_CHARS_PER_DOCUMENT)}`
        });
        continue;
      } catch {
        skipped.push(item.title);
        continue;
      }
    }

    if (item.s3Key && item.contentType?.includes("pdf")) {
      if (documentBlocks >= MAX_DOCUMENT_BLOCKS) {
        skipped.push(item.title);
        continue;
      }
      try {
        const bytes = await getS3Bytes(bucket, item.s3Key);
        if (bytes.byteLength > MAX_PDF_BYTES) {
          skipped.push(item.title);
          continue;
        }
        content.push({ text: `# 資料${index + 1}: ${item.title}` });
        content.push({
          document: {
            format: "pdf",
            name: safeDocumentName(index),
            source: { bytes }
          }
        });
        documentBlocks += 1;
        continue;
      } catch {
        skipped.push(item.title);
        continue;
      }
    }

    skipped.push(item.title);
  }

  if (!content.length) {
    return NextResponse.json(
      { error: "選択された資料から本文を読み取れませんでした" },
      { status: 422 }
    );
  }

  content.push({ text: `\n---\n\n【指示】\n${instruction.trim()}` });

  const messages = [
    ...(history ?? []).map(h => ({
      role: h.role,
      content: [{ text: h.text }]
    })),
    { role: "user" as const, content }
  ];

  const encoder = new TextEncoder();
  const client = createBedrockRuntimeClient();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (payload: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          /* closed */
        }
      };

      // CloudFrontのアイドルタイムアウト対策。SSEのコメント行は無視される
      const heartbeat = setInterval(() => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
          } catch {
            /* closed */
          }
        }
      }, HEARTBEAT_MS);

      const cleanup = () => {
        closed = true;
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      try {
        if (skipped.length) {
          send({ type: "warning", skipped });
        }

        const response = await client.send(
          new ConverseStreamCommand({
            modelId,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            messages: messages as any,
            system: [{ text: SYSTEM_PROMPT }],
            inferenceConfig: { maxTokens: MAX_OUTPUT_TOKENS, temperature: 0.2 }
          })
        );

        for await (const event of response.stream ?? []) {
          const delta = event.contentBlockDelta?.delta?.text;
          if (delta) send({ type: "delta", text: delta });

          const usage = event.metadata?.usage;
          if (usage) {
            send({
              type: "usage",
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens
            });
          }
        }

        send({ type: "done" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "分析に失敗しました";
        console.error("[data-vault/analyze]", error);
        send({ type: "error", message });
      } finally {
        cleanup();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    }
  });
}
