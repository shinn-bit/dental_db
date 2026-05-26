import {
  RetrieveAndGenerateCommand,
  type RetrievalFilter
} from "@aws-sdk/client-bedrock-agent-runtime";
import { NextResponse } from "next/server";
import { createBedrockAgentRuntimeClient } from "@/lib/aws";
import { appEnv, requireEnv } from "@/lib/env";

type ChatRequest = {
  message?: string;
  files?: ChatSourceFile[];
  manuals?: ChatSourceFile[];
  bedrockSessionId?: string;
};

type ChatSourceFile = {
    id?: string;
    fileName?: string;
    s3Key?: string;
    summaryKey?: string;
    knowledgeBaseKey?: string;
    extractedTextKey?: string;
};

export async function POST(request: Request) {
  const body = (await request.json()) as ChatRequest;
  const message = body.message?.trim();

  if (!message) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  const knowledgeBaseId = requireEnv(appEnv.bedrockKnowledgeBaseId, "BEDROCK_KNOWLEDGE_BASE_ID");
  const modelArn = requireEnv(appEnv.bedrockModelArn, "BEDROCK_MODEL_ARN");
  const selectedFiles = (body.files || body.manuals || []).filter(
    (file) => file.fileName || file.knowledgeBaseKey || file.summaryKey || file.extractedTextKey
  );
  const sourceUris = selectedFiles
    .flatMap((file) => [
      file.knowledgeBaseKey
        ? `s3://${appEnv.s3BucketName}/${file.knowledgeBaseKey}`
        : file.summaryKey
          ? `s3://${appEnv.s3BucketName}/${file.summaryKey}`
          : "",
      file.extractedTextKey ? `s3://${appEnv.s3BucketName}/${file.extractedTextKey}` : ""
    ])
    .filter(Boolean);
  const retrievalFilter = createSourceUriFilter(sourceUris);
  const fileContext =
    selectedFiles.length > 0
      ? `\n\n対象資料:\n${selectedFiles
        .map(
          (file, index) =>
            `${index + 1}. ${file.fileName || "名称未設定"} (${file.knowledgeBaseKey || file.summaryKey || file.extractedTextKey || ""})`
        )
          .join("\n")}\n\n上記の対象資料を優先して参照してください。対象資料に該当情報がない場合は、その旨を明記してください。`
      : "";
  const queryText = `${message}${fileContext}`;

  try {
    const response = await createBedrockAgentRuntimeClient().send(
      new RetrieveAndGenerateCommand({
        ...(body.bedrockSessionId ? { sessionId: body.bedrockSessionId } : {}),
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
                  "あなたは歯科医院の院内ナレッジだけを参照して回答するAIアシスタントです。検索結果に書かれている内容だけを根拠にしてください。一般知識、推測、外部知識、参考文献の補完は禁止です。検索結果に根拠がない場合は「選択された資料内では確認できません」とだけ明確に伝えてください。回答は現場スタッフ向けに簡潔な日本語にしてください。\n\n検索結果:\n$search_results$\n\n質問:\n$query$"
              }
            }
          }
        }
      })
    );

    return NextResponse.json({
      answer: response.output?.text || "",
      citations: response.citations || [],
      bedrockSessionId: response.sessionId || ""
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
