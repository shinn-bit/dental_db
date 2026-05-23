import { RetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";
import { NextResponse } from "next/server";
import { createBedrockAgentRuntimeClient } from "@/lib/aws";
import { appEnv, requireEnv } from "@/lib/env";

// KB からパッセージを取得するだけの軽量エンドポイント（Gemini呼び出しはクライアント側）

type RetrieveRequest = {
  theme?: string;
  purpose?: string;
  files?: {
    knowledgeBaseKey?: string;
    summaryKey?: string;
    extractedTextKey?: string;
  }[];
};

export async function POST(request: Request) {
  const body = (await request.json()) as RetrieveRequest;
  const theme = body.theme?.trim();

  if (!theme) {
    return NextResponse.json({ error: "テーマは必須です" }, { status: 400 });
  }

  const knowledgeBaseId = requireEnv(appEnv.bedrockKnowledgeBaseId, "BEDROCK_KNOWLEDGE_BASE_ID");
  const purpose = body.purpose?.trim() || "院内教育";

  const selectedFiles = (body.files ?? []).filter(
    (f) => f.knowledgeBaseKey || f.summaryKey || f.extractedTextKey
  );
  const sourceUris = selectedFiles
    .flatMap((f) => [
      f.knowledgeBaseKey ? `s3://${appEnv.s3BucketName}/${f.knowledgeBaseKey}` : "",
      !f.knowledgeBaseKey && f.summaryKey ? `s3://${appEnv.s3BucketName}/${f.summaryKey}` : "",
      f.extractedTextKey ? `s3://${appEnv.s3BucketName}/${f.extractedTextKey}` : ""
    ])
    .filter(Boolean);

  try {
    const result = await createBedrockAgentRuntimeClient().send(
      new RetrieveCommand({
        knowledgeBaseId,
        retrievalQuery: { text: `${theme} ${purpose}` },
        retrievalConfiguration: {
          vectorSearchConfiguration: {
            numberOfResults: 8,
            ...(sourceUris.length > 0 ? { filter: buildFilter(sourceUris) } : {})
          }
        }
      })
    );

    const passages = (result.retrievalResults ?? [])
      .map((r) => r.content?.text ?? "")
      .filter(Boolean);

    return NextResponse.json({ passages });
  } catch {
    // KB取得失敗時は空で返す（Geminiが一般知識で補完）
    return NextResponse.json({ passages: [] });
  }
}

function buildFilter(uris: string[]) {
  const filters = uris.map((uri) => ({
    equals: { key: "x-amz-bedrock-kb-source-uri", value: uri }
  }));
  return filters.length === 1 ? filters[0] : { orAll: filters };
}
