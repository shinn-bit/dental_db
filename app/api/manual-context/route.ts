import { RetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";
import { NextRequest, NextResponse } from "next/server";
import { createBedrockAgentRuntimeClient } from "@/lib/aws";
import { appEnv, requireEnv } from "@/lib/env";

export const maxDuration = 30;

const HIGH_SCORE = 0.6;
const MIN_SCORE = 0.3;

export async function POST(req: NextRequest) {
  const { query } = (await req.json()) as { query: string };
  if (!query?.trim()) return NextResponse.json({ context: "", found: 0 });

  const knowledgeBaseId = requireEnv(appEnv.bedrockKnowledgeBaseId, "BEDROCK_KNOWLEDGE_BASE_ID");

  try {
    const result = await createBedrockAgentRuntimeClient().send(
      new RetrieveCommand({
        knowledgeBaseId,
        retrievalQuery: { text: query },
        retrievalConfiguration: {
          vectorSearchConfiguration: { numberOfResults: 30 },
        },
      })
    );

    const all = result.retrievalResults ?? [];

    const high = all
      .filter((r) => (r.score ?? 0) >= HIGH_SCORE)
      .map((r) => r.content?.text ?? "")
      .filter(Boolean);

    const mid = all
      .filter((r) => {
        const s = r.score ?? 0;
        return s >= MIN_SCORE && s < HIGH_SCORE;
      })
      .map((r) => r.content?.text ?? "")
      .filter(Boolean);

    if (high.length === 0 && mid.length === 0) {
      return NextResponse.json({ context: "", found: 0 });
    }

    const parts: string[] = [];
    if (high.length > 0) {
      parts.push(
        `【高関連度の院内資料（特に参考にしてください）】\n${high.join("\n\n---\n\n")}`
      );
    }
    if (mid.length > 0) {
      parts.push(
        `【参考程度の院内資料】\n${mid.join("\n\n---\n\n")}`
      );
    }

    return NextResponse.json({
      context: parts.join("\n\n"),
      found: high.length + mid.length,
    });
  } catch (err) {
    console.error("[manual-context] RAG retrieval failed:", err);
    return NextResponse.json({ context: "", found: 0 });
  }
}
