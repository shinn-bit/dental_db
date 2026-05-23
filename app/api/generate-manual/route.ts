import { RetrieveCommand } from "@aws-sdk/client-bedrock-agent-runtime";
import { InvokeModelWithResponseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { createBedrockAgentRuntimeClient, createBedrockRuntimeClient } from "@/lib/aws";
import { appEnv, requireEnv } from "@/lib/env";

export const maxDuration = 60;

const MANUAL_SECTIONS = [
  "病気の解説",
  "原因",
  "病態・所見",
  "患者の訴え・臨床所見",
  "当日の処置・応急処置",
  "治療法",
  "治療の具体的なステップ",
  "治療中に確認するチェックリスト",
  "予後・術後のメンテナンス",
  "その他注意すべきこと"
] as const;

type ManualSourceFile = {
  id?: string;
  fileName?: string;
  knowledgeBaseKey?: string;
  summaryKey?: string;
  extractedTextKey?: string;
};

type GenerateManualRequest = {
  theme?: string;
  purpose?: string;
  files?: ManualSourceFile[];
};

export async function POST(request: Request) {
  const body = (await request.json()) as GenerateManualRequest;
  const theme = body.theme?.trim();

  if (!theme) {
    return new Response(JSON.stringify({ error: "テーマは必須です" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const knowledgeBaseId = requireEnv(appEnv.bedrockKnowledgeBaseId, "BEDROCK_KNOWLEDGE_BASE_ID");
  const modelArn = requireEnv(appEnv.bedrockModelArn, "BEDROCK_MODEL_ARN");
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

  const sectionList = MANUAL_SECTIONS.map((s, i) => `## ${i + 1}. ${s}`).join("\n");
  const retrieveQuery = `${theme} ${purpose} ${sectionList}`;

  // Step 1: KB からパッセージを取得（高速）
  let passages = "";
  try {
    const retrieveResult = await createBedrockAgentRuntimeClient().send(
      new RetrieveCommand({
        knowledgeBaseId,
        retrievalQuery: { text: retrieveQuery },
        retrievalConfiguration: {
          vectorSearchConfiguration: {
            numberOfResults: 8,
            ...(sourceUris.length > 0 ? { filter: buildFilter(sourceUris) } : {})
          }
        }
      })
    );
    passages = (retrieveResult.retrievalResults ?? [])
      .map((r) => r.content?.text ?? "")
      .filter(Boolean)
      .join("\n\n---\n\n");
  } catch {
    // 取得失敗時は一般知識のみで生成
    passages = "（院内資料の検索に失敗しました。一般的な歯科知識で補完します）";
  }

  const userPrompt = [
    `テーマ: ${theme}`,
    `用途: ${purpose}`,
    "",
    "以下の院内資料を参照し、このテーマの院内マニュアルを10項目構成で作成してください。",
    "各項目は「## 1. 病気の解説」のようなMarkdown見出し（##）で始め、内容を記載してください。",
    "第8項目（治療中に確認するチェックリスト）は「- [ ] 」形式の箇条書きにしてください。",
    "資料にない情報は一般的な歯科知識で補完してください。",
    "",
    "【院内資料】",
    passages,
    "",
    "【構成】",
    sectionList
  ].join("\n");

  // Step 2: Claude をストリーミング呼び出し
  const modelInput = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 4096,
    system: "あなたは歯科医院の院内マニュアル作成AIです。指定された10項目構成で、日本語で院内マニュアルを作成してください。",
    messages: [
      { role: "user", content: [{ type: "text", text: userPrompt }] }
    ]
  };

  try {
    const streamResult = await createBedrockRuntimeClient().send(
      new InvokeModelWithResponseStreamCommand({
        modelId: modelArn,
        contentType: "application/json",
        accept: "application/json",
        body: new TextEncoder().encode(JSON.stringify(modelInput))
      })
    );

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const event of streamResult.body ?? []) {
            if (event.chunk?.bytes) {
              const decoded = JSON.parse(new TextDecoder().decode(event.chunk.bytes)) as {
                type: string;
                delta?: { type: string; text?: string };
              };
              if (decoded.type === "content_block_delta" && decoded.delta?.text) {
                controller.enqueue(encoder.encode(decoded.delta.text));
              }
            }
          }
        } finally {
          controller.close();
        }
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "X-Manual-Theme": encodeURIComponent(theme),
        "Cache-Control": "no-cache"
      }
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

function buildFilter(uris: string[]) {
  const filters = uris.map((uri) => ({
    equals: { key: "x-amz-bedrock-kb-source-uri", value: uri }
  }));
  return filters.length === 1 ? filters[0] : { orAll: filters };
}
