import {
  RetrieveAndGenerateCommand,
  type RetrievalFilter
} from "@aws-sdk/client-bedrock-agent-runtime";
import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { NextResponse } from "next/server";
import { createBedrockAgentRuntimeClient, createBedrockRuntimeClient } from "@/lib/aws";
import { appEnv, requireEnv } from "@/lib/env";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";

type Attachment = {
  name: string;
  type: string;
  data: string; // base64
};

type ChatRequest = {
  message?: string;
  attachments?: Attachment[];
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

const IMAGE_FORMAT_MAP: Record<string, "jpeg" | "png" | "gif" | "webp"> = {
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

async function describeImage(
  buffer: Buffer,
  mimeType: string,
  filename: string,
  modelArn: string
): Promise<string> {
  const format = IMAGE_FORMAT_MAP[mimeType] ?? "jpeg";
  try {
    const response = await createBedrockRuntimeClient().send(
      new ConverseCommand({
        modelId: modelArn,
        messages: [
          {
            role: "user",
            content: [
              { image: { format, source: { bytes: buffer } } },
              {
                text: `この画像（ファイル名: ${filename}）に含まれているテキスト、データ、図表などの情報をすべて正確に書き起こしてください。`,
              },
            ],
          },
        ],
      })
    );
    const content = response.output?.message?.content ?? [];
    const textBlock = content.find((b) => "text" in b);
    return (textBlock as { text?: string } | undefined)?.text ?? "(画像の解析結果なし)";
  } catch (err) {
    console.error("[describeImage] error:", err);
    return "(画像の解析に失敗しました)";
  }
}

const MAX_ATTACHMENT_CHARS = 3000;

async function extractAttachmentText(
  attachment: Attachment,
  modelArn: string
): Promise<string> {
  const buffer = Buffer.from(attachment.data, "base64");
  try {
    if (attachment.type === "application/pdf") {
      const parsed = await pdfParse(buffer);
      const text = parsed.text.trim().slice(0, MAX_ATTACHMENT_CHARS);
      return `[添付ファイル: ${attachment.name}]\n${text}`;
    }

    if (
      attachment.type ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ) {
      const result = await mammoth.extractRawText({ buffer });
      const text = result.value.trim().slice(0, MAX_ATTACHMENT_CHARS);
      return `[添付ファイル: ${attachment.name}]\n${text}`;
    }

    if (attachment.type.startsWith("image/")) {
      const description = await describeImage(
        buffer,
        attachment.type,
        attachment.name,
        modelArn
      );
      return `[添付画像: ${attachment.name}]\n${description}`;
    }
  } catch (err) {
    console.error(`[extractAttachmentText] failed for ${attachment.name}:`, err);
  }
  return "";
}

export async function POST(request: Request) {
  const body = (await request.json()) as ChatRequest;
  const message = body.message?.trim();

  if (!message) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  const knowledgeBaseId = requireEnv(
    appEnv.bedrockKnowledgeBaseId,
    "BEDROCK_KNOWLEDGE_BASE_ID"
  );
  const modelArn = requireEnv(appEnv.bedrockModelArn, "BEDROCK_MODEL_ARN");

  // Extract text from attachments and append to query
  const attachmentParts: string[] = [];
  for (const attachment of body.attachments ?? []) {
    const text = await extractAttachmentText(attachment, modelArn);
    if (text) attachmentParts.push(text);
  }

  const attachmentContext =
    attachmentParts.length > 0
      ? `\n\n--- 添付ファイルの内容 ---\n${attachmentParts.join("\n\n")}\n---`
      : "";

  // Legacy: keep source file filter support
  const selectedFiles = (body.files || body.manuals || []).filter(
    (file) =>
      file.fileName ||
      file.knowledgeBaseKey ||
      file.summaryKey ||
      file.extractedTextKey
  );
  const sourceUris = selectedFiles
    .flatMap((file) => [
      file.knowledgeBaseKey
        ? `s3://${appEnv.s3BucketName}/${file.knowledgeBaseKey}`
        : file.summaryKey
          ? `s3://${appEnv.s3BucketName}/${file.summaryKey}`
          : "",
      file.extractedTextKey
        ? `s3://${appEnv.s3BucketName}/${file.extractedTextKey}`
        : "",
    ])
    .filter(Boolean);
  const retrievalFilter = createSourceUriFilter(sourceUris);

  const queryText = `${message}${attachmentContext}`;

  try {
    const response = await createBedrockAgentRuntimeClient().send(
      new RetrieveAndGenerateCommand({
        ...(body.bedrockSessionId ? { sessionId: body.bedrockSessionId } : {}),
        input: { text: queryText },
        retrieveAndGenerateConfiguration: {
          type: "KNOWLEDGE_BASE",
          knowledgeBaseConfiguration: {
            knowledgeBaseId,
            modelArn,
            retrievalConfiguration: {
              vectorSearchConfiguration: {
                numberOfResults: 5,
                ...(retrievalFilter ? { filter: retrievalFilter } : {}),
              },
            },
            generationConfiguration: {
              promptTemplate: {
                textPromptTemplate:
                  "あなたは歯科医院の院内ナレッジだけを参照して回答するAIアシスタントです。検索結果に書かれている内容だけを根拠にしてください。一般知識、推測、外部知識、参考文献の補完は禁止です。検索結果に根拠がない場合は「選択された資料内では確認できません」とだけ明確に伝えてください。回答は現場スタッフ向けに簡潔な日本語にしてください。\n\n検索結果:\n$search_results$\n\n質問:\n$query$",
              },
            },
          },
        },
      })
    );

    return NextResponse.json({
      answer: response.output?.text || "",
      citations: response.citations || [],
      bedrockSessionId: response.sessionId || "",
    });
  } catch (error) {
    const msg =
      error instanceof Error ? error.message : "Unknown Bedrock error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

function createSourceUriFilter(
  sourceUris: string[]
): RetrievalFilter | undefined {
  if (sourceUris.length === 0) return undefined;
  const filters = sourceUris.map((uri) => ({
    equals: { key: "x-amz-bedrock-kb-source-uri", value: uri },
  }));
  if (filters.length === 1) return filters[0];
  return { orAll: filters };
}
