import { RetrieveCommand, type RetrievalFilter } from "@aws-sdk/client-bedrock-agent-runtime";
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { fromIni } from "@aws-sdk/credential-providers";
import { createBedrockAgentRuntimeClient } from "@/lib/aws";
import { appEnv } from "@/lib/env";

// 意味検索（Bedrock KB）とキーワード検索（BM25 Lambda）を並列実行し、RRFで統合する。
// キーワード検索が失敗しても意味検索だけで回答できるようにする。

const VECTOR_TOP_K = 20;
const LEXICAL_TOP_K = 20;
const FUSED_TOP_K = 12;
// Reciprocal Rank Fusion の定数（一般的な既定値）
const RRF_K = 60;

export type HybridSearchResult = {
  key: string;
  text: string;
  sourceUri: string;
  score: number;
  foundBy: Array<"vector" | "lexical">;
};

type LexicalResponse = {
  results?: Array<{ key: string; text: string; sourceUri: string }>;
  stale?: boolean;
};

function createLambdaClient() {
  const credentials = appEnv.awsProfile ? fromIni({ profile: appEnv.awsProfile }) : undefined;
  return new LambdaClient({
    region: appEnv.awsRegion,
    ...(credentials ? { credentials } : {}),
  });
}

async function vectorSearch(knowledgeBaseId: string, query: string, filter?: RetrievalFilter) {
  const response = await createBedrockAgentRuntimeClient().send(
    new RetrieveCommand({
      knowledgeBaseId,
      retrievalQuery: { text: query },
      retrievalConfiguration: {
        vectorSearchConfiguration: {
          numberOfResults: VECTOR_TOP_K,
          ...(filter ? { filter } : {}),
        },
      },
    })
  );
  return (response.retrievalResults ?? []).map((result) => {
    const text = result.content?.text ?? "";
    const chunkId = result.metadata?.["x-amz-bedrock-kb-chunk-id"];
    return {
      key: typeof chunkId === "string" && chunkId ? chunkId : text,
      text,
      sourceUri: result.location?.s3Location?.uri ?? "",
    };
  });
}

async function lexicalSearch(query: string, folderId?: string) {
  const response = await createLambdaClient().send(
    new InvokeCommand({
      FunctionName: process.env.LEXICAL_SEARCH_FUNCTION_NAME ?? "dental-lexical-search-dev",
      Payload: Buffer.from(
        JSON.stringify({ action: "search", query, topK: LEXICAL_TOP_K, ...(folderId ? { folderId } : {}) })
      ),
    })
  );
  if (response.FunctionError) {
    throw new Error(`lexical search failed: ${Buffer.from(response.Payload ?? []).toString("utf-8")}`);
  }
  const body = JSON.parse(Buffer.from(response.Payload ?? []).toString("utf-8")) as LexicalResponse;
  if (body.stale) console.log("[hybrid-search] lexical index is stale; rebuild triggered");
  return body.results ?? [];
}

export async function hybridSearch(
  knowledgeBaseId: string,
  query: string,
  options: { folderId?: string; filter?: RetrievalFilter } = {}
): Promise<HybridSearchResult[]> {
  const [vectorResults, lexicalResults] = await Promise.all([
    vectorSearch(knowledgeBaseId, query, options.filter),
    lexicalSearch(query, options.folderId).catch((error) => {
      console.error("[hybrid-search] lexical search unavailable:", String(error));
      return [];
    }),
  ]);

  const fused = new Map<string, HybridSearchResult>();
  const add = (
    results: Array<{ key: string; text: string; sourceUri: string }>,
    source: "vector" | "lexical"
  ) => {
    results.forEach((result, rank) => {
      const existing = fused.get(result.key);
      const score = 1 / (RRF_K + rank + 1);
      if (existing) {
        existing.score += score;
        existing.foundBy.push(source);
      } else {
        fused.set(result.key, { ...result, score, foundBy: [source] });
      }
    });
  };
  add(vectorResults, "vector");
  add(lexicalResults, "lexical");

  const ranked = Array.from(fused.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, FUSED_TOP_K);
  const both = ranked.filter((r) => r.foundBy.length > 1).length;
  console.log(
    `[hybrid-search] vector=${vectorResults.length} lexical=${lexicalResults.length} fused=${ranked.length} both=${both}`
  );
  return ranked;
}
