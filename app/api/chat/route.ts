import {
  RetrieveAndGenerateCommand,
  type RetrievalFilter
} from "@aws-sdk/client-bedrock-agent-runtime";
import { NextResponse } from "next/server";
import { createBedrockAgentRuntimeClient } from "@/lib/aws";
import { appEnv, requireEnv } from "@/lib/env";

type ChatRequest = {
  message?: string;
  manuals?: Array<{
    id?: string;
    fileName?: string;
    s3Key?: string;
  }>;
};

export async function POST(request: Request) {
  const body = (await request.json()) as ChatRequest;
  const message = body.message?.trim();

  if (!message) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  const knowledgeBaseId = requireEnv(appEnv.bedrockKnowledgeBaseId, "BEDROCK_KNOWLEDGE_BASE_ID");
  const modelArn = requireEnv(appEnv.bedrockModelArn, "BEDROCK_MODEL_ARN");
  const selectedManuals = (body.manuals || []).filter((manual) => manual.fileName || manual.s3Key);
  const sourceUris = selectedManuals
    .map((manual) => (manual.s3Key ? `s3://${appEnv.s3BucketName}/${manual.s3Key}` : ""))
    .filter(Boolean);
  const retrievalFilter = createSourceUriFilter(sourceUris);
  const manualContext =
    selectedManuals.length > 0
      ? `\n\n対象資料:\n${selectedManuals
          .map((manual, index) => `${index + 1}. ${manual.fileName || "名称未設定"} (${manual.s3Key || ""})`)
          .join("\n")}\n\n上記の対象資料を優先して参照してください。対象資料に該当情報がない場合は、その旨を明記してください。`
      : "";
  const queryText = `${message}${manualContext}`;

  try {
    const response = await createBedrockAgentRuntimeClient().send(
      new RetrieveAndGenerateCommand({
        input: {
          text: queryText
        },
        retrieveAndGenerateConfiguration: {
          type: "KNOWLEDGE_BASE",
          knowledgeBaseConfiguration: {
            knowledgeBaseId,
            modelArn,
            retrievalConfiguration: {
              vectorSearchConfiguration: {
                numberOfResults: 5,
                ...(retrievalFilter ? { filter: retrievalFilter } : {})
              }
            },
            generationConfiguration: {
              promptTemplate: {
                textPromptTemplate:
                  "あなたは歯科医院の院内マニュアルだけを参照して回答するAIアシスタントです。検索結果に書かれている内容だけを根拠にしてください。一般知識、推測、外部知識、参考文献の補完は禁止です。検索結果に根拠がない場合は「選択された資料内では確認できません」とだけ明確に伝えてください。回答は現場スタッフ向けに簡潔な日本語にしてください。\n\n検索結果:\n$search_results$\n\n質問:\n$query$"
              }
            }
          }
        }
      })
    );

    return NextResponse.json({
      answer: response.output?.text || "",
      citations: response.citations || []
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Bedrock error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function createSourceUriFilter(sourceUris: string[]): RetrievalFilter | undefined {
  if (sourceUris.length === 0) {
    return undefined;
  }

  const filters = sourceUris.map((uri) => ({
    equals: {
      key: "x-amz-bedrock-kb-source-uri",
      value: uri
    }
  }));

  if (filters.length === 1) {
    return filters[0];
  }

  return {
    orAll: filters
  };
}
