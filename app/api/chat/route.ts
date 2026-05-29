import {
  RetrieveAndGenerateCommand,
  type RetrievalFilter
} from "@aws-sdk/client-bedrock-agent-runtime";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { NextResponse } from "next/server";
import { createBedrockAgentRuntimeClient, createBedrockRuntimeClient, createS3Client } from "@/lib/aws";
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

    const bucket = appEnv.s3BucketName;
    const citationCount = (response.citations ?? []).length;
    const refCount = (response.citations ?? []).reduce(
      (n, c) => n + ((c as { retrievedReferences?: unknown[] }).retrievedReferences?.length ?? 0), 0
    );
    console.log(`[chat/images] bucket=${bucket ? "ok" : "EMPTY"} citations=${citationCount} refs=${refCount}`);
    // 最初のcitationの生構造をダンプ（refs=0の原因調査）
    if (citationCount > 0) {
      const firstCitation = (response.citations ?? [])[0];
      console.log("[chat/images] first citation keys:", Object.keys(firstCitation ?? {}).join(","));
      console.log("[chat/images] first citation raw:", JSON.stringify(firstCitation).slice(0, 500));
    }

    const images = bucket
      ? await extractImagesFromCitations(
          (response.citations ?? []) as Citation[],
          bucket
        ).catch((err) => {
          console.error("[chat/images] extractImagesFromCitations failed:", String(err));
          return [] as ChatImage[];
        })
      : [];
    console.log(`[chat/images] result: ${images.length} images`);

    return NextResponse.json({
      answer: response.output?.text || "",
      citations: response.citations || [],
      bedrockSessionId: response.sessionId || "",
      images,
    });
  } catch (error) {
    const msg =
      error instanceof Error ? error.message : "Unknown Bedrock error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

type ChatImage = {
  url: string;
  description: string;
  page: number;
  documentName: string;
};

type Citation = {
  retrievedReferences?: Array<{
    content?: { text?: string };
    location?: { s3Location?: { uri?: string } };
  }>;
};

async function extractImagesFromCitations(
  citations: Citation[],
  bucket: string
): Promise<ChatImage[]> {
  const s3 = createS3Client();
  const results: ChatImage[] = [];
  const processedDocIds = new Set<string>();

  for (const citation of citations) {
    for (const ref of citation.retrievedReferences ?? []) {
      const uri = ref.location?.s3Location?.uri ?? "";
      // kb/{id}.md の形式から id を抽出
      const match = uri.match(/\/kb\/([^/]+)\.md$/);
      if (!match) continue;

      const docId = match[1];
      if (processedDocIds.has(docId)) continue;
      processedDocIds.add(docId);

      // メタデータを取得
      try {
        const metaRes = await s3.send(
          new GetObjectCommand({ Bucket: bucket, Key: `${appEnv.s3MetadataPrefix}${docId}.json` })
        );
        const metaText = await metaRes.Body?.transformToString() ?? "{}";
        const metadata = JSON.parse(metaText) as {
          fileName?: string;
          images?: Array<{ page: number; s3Key: string; description: string }>;
        };

        const docImages = metadata.images ?? [];
        if (docImages.length === 0) continue;

        // 参照テキスト内の「Nページ」パターンからページ番号を抽出
        const retrievedText = ref.content?.text ?? "";
        const mentionedPages = new Set<number>(
          [...retrievedText.matchAll(/【(\d+)ページ/g)].map((m) => parseInt(m[1]))
        );

        // ページ番号が一致する画像を優先、なければドキュメント先頭の画像を使用
        const candidates = mentionedPages.size > 0
          ? docImages.filter((img) => mentionedPages.has(img.page))
          : docImages.slice(0, 2);

        for (const img of candidates.slice(0, 3)) {
          const url = await getSignedUrl(
            s3,
            new GetObjectCommand({ Bucket: bucket, Key: img.s3Key }),
            { expiresIn: 3600 }
          );
          results.push({
            url,
            description: img.description,
            page: img.page,
            documentName: metadata.fileName ?? docId,
          });
          if (results.length >= 5) break;
        }
      } catch { continue; }

      if (results.length >= 5) break;
    }
    if (results.length >= 5) break;
  }

  return results;
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
