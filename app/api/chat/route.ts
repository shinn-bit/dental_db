import {
  RetrieveAndGenerateCommand,
  RetrieveCommand,
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
  folderKeys?: string[]; // フォルダ選択時のknowledgeBaseKeyリスト
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
  // folderKeys: フォルダ選択時に渡されるknowledgeBaseKeyリスト
  const folderUris = (body.folderKeys ?? [])
    .filter(Boolean)
    .map(k => `s3://${appEnv.s3BucketName}/${k}`);
  const retrievalFilter = createSourceUriFilter([...sourceUris, ...folderUris]);
  const queryText = `${message}${attachmentContext}`;

  try {
    const bedrockClient = createBedrockAgentRuntimeClient();

    // 回答生成と文書検索を並列実行
    // RetrieveAndGenerateはカスタムpromptTemplate使用時にretrievedReferencesを返さないため
    // RetrieveCommandで別途ソース文書を取得して画像引き出しに使う
    const [response, retrieveResponse] = await Promise.all([
      bedrockClient.send(new RetrieveAndGenerateCommand({
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
      })),
      bedrockClient.send(new RetrieveCommand({
        knowledgeBaseId,
        retrievalQuery: { text: queryText },
        retrievalConfiguration: {
          vectorSearchConfiguration: {
            numberOfResults: 5,
            ...(retrievalFilter ? { filter: retrievalFilter } : {}),
          },
        },
      })).catch(() => ({ retrievalResults: [] as never[] })),
    ]);

    const bucket = appEnv.s3BucketName;
    console.log(`[chat/images] bucket=${bucket ? "ok" : "EMPTY"} citations=${(response.citations ?? []).length}`);

    const retrievalResults = (retrieveResponse.retrievalResults ?? []) as Array<{
      content?: { text?: string };
      location?: { s3Location?: { uri?: string } };
    }>;
    console.log(`[chat/images] retrieveResults=${retrievalResults.length}`);

    // ── DEBUG: フォルダフィルタの動作確認 ──
    if (folderUris.length > 0) {
      console.log("[DEBUG] folderUris:", JSON.stringify(folderUris));
      console.log("[DEBUG] filter:", JSON.stringify(retrievalFilter));
      const filteredUris = retrievalResults.map(r => r.location?.s3Location?.uri ?? "");
      console.log("[DEBUG] FILTERED result URIs:", JSON.stringify(filteredUris));
      try {
        const unfiltered = await bedrockClient.send(new RetrieveCommand({
          knowledgeBaseId,
          retrievalQuery: { text: queryText },
          retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: 10 } },
        }));
        const unfilteredUris = (unfiltered.retrievalResults ?? []).map(r => r.location?.s3Location?.uri ?? "");
        console.log("[DEBUG] UNFILTERED top10 URIs:", JSON.stringify(unfilteredUris));
        const targetHit = unfilteredUris.some(u => folderUris.includes(u));
        console.log("[DEBUG] target file in unfiltered results?:", targetHit);
      } catch (e) {
        console.log("[DEBUG] unfiltered retrieve failed:", String(e));
      }
    }

    const images = bucket && retrievalResults.length > 0
      ? await extractImagesFromRetrieveResults(retrievalResults, bucket, message).catch((err) => {
          console.error("[chat/images] extractImagesFromRetrieveResults failed:", String(err));
          return [] as ChatImage[];
        })
      : [];
    console.log(`[chat/images] result: ${images.length} images`);

    // フォルダフィルタ適用かつ検索結果0件の場合は分かりやすいメッセージに差し替え
    const answerText = retrievalResults.length === 0 && folderUris.length > 0
      ? "選択したフォルダの資料には、ご質問に関連する内容が見つかりませんでした。「すべての資料」に切り替えてもう一度お試しください。"
      : response.output?.text || "";

    return NextResponse.json({
      answer: answerText,
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

// RetrieveCommand の結果から画像を抽出する
// KB再同期不要：ユーザーの質問キーワードとmetadata.images[].descriptionを直接マッチング
async function extractImagesFromRetrieveResults(
  retrievalResults: Array<{
    content?: { text?: string };
    location?: { s3Location?: { uri?: string } };
  }>,
  bucket: string,
  query: string
): Promise<ChatImage[]> {
  const s3 = createS3Client();
  const results: ChatImage[] = [];
  const processedDocIds = new Set<string>();

  // 日本語はスペース区切りがないのでN-gram（3〜6文字）で部分文字列を抽出
  const cleaned = query.replace(/[　！？。、・「」【】（）\s]/g, "");
  const queryKeywords = Array.from(new Set(
    [3, 4, 5, 6].flatMap(n =>
      Array.from({ length: Math.max(0, cleaned.length - n + 1) }, (_, i) => cleaned.slice(i, i + n))
    )
  ));

  for (const ref of retrievalResults) {
    const uri = ref.location?.s3Location?.uri ?? "";
    const match = uri.match(/\/kb\/([^/]+)\.md$/);
    if (!match) continue;

    const docId = match[1];
    if (processedDocIds.has(docId)) continue;
    processedDocIds.add(docId);

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

      // 表紙・目次・前書き等は除外
      const SKIP_WORDS = ["表紙", "目次", "はじめに", "前書き", "まえがき", "序文", "Contents", "Table of"];
      const contentImages = docImages.filter(
        img => !SKIP_WORDS.some(w => img.description.includes(w))
      );

      // 画像説明にキーワードが含まれるものをスコアリング
      const scored = contentImages
        .map(img => ({
          img,
          score: queryKeywords.filter(kw => img.description.includes(kw)).length,
        }))
        .filter(s => s.score >= 1)
        .sort((a, b) => b.score - a.score);

      console.log(`[chat/images] doc=${docId.slice(0, 8)} total=${docImages.length} matched=${scored.length}`);

      for (const { img } of scored.slice(0, 3)) {
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
