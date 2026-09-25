import { type RetrievalFilter } from "@aws-sdk/client-bedrock-agent-runtime";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ConverseCommand, type Message } from "@aws-sdk/client-bedrock-runtime";
import { NextResponse } from "next/server";
import { createBedrockRuntimeClient, createS3Client } from "@/lib/aws";
import { appEnv, requireEnv } from "@/lib/env";
import { hybridSearch, type HybridSearchResult } from "@/lib/hybrid-search";
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
  folderId?: string; // フォルダ選択時のフォルダID
  mode?: "rag" | "net"; // "rag"=資料のみ（デフォルト）, "net"=AIモード（資料優先+一般知識）
  history?: Array<{ role: "user" | "assistant"; text: string }>; // 直近の会話（今回の質問は含まない）
};

const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_CHARS = 2000;

const RAG_ONLY_PROMPT =
  "あなたは歯科医院の院内ナレッジだけを参照して回答するAIアシスタントです。検索結果に書かれている内容だけを根拠にしてください。一般知識、推測、外部知識、参考文献の補完は禁止です。検索結果に根拠がない場合は「選択された資料内では確認できません」とだけ明確に伝えてください。回答は現場スタッフ向けに簡潔な日本語にしてください。";
const NET_PROMPT =
  "あなたは歯科医院スタッフを支援するAIアシスタントです。以下の院内資料の検索結果を最優先で参照してください。検索結果に質問への回答が含まれている場合は、必ずその内容を根拠に答えてください。検索結果だけでは回答が不十分な場合は、あなたの一般的な医療・歯科知識を補足として活用して答えてください。院内資料に基づく内容と一般知識に基づく内容は明確に区別して伝えてください。回答は現場スタッフ向けに分かりやすい日本語にしてください。";

// Converse は user から始まり user/assistant が交互である必要がある
function buildHistoryMessages(history: ChatRequest["history"]): Message[] {
  const messages: Message[] = [];
  for (const item of (history ?? []).slice(-MAX_HISTORY_MESSAGES)) {
    const text = item.text?.trim().slice(0, MAX_HISTORY_CHARS);
    if (!text || (item.role !== "user" && item.role !== "assistant")) continue;
    if (messages.length === 0 && item.role !== "user") continue;
    const last = messages[messages.length - 1];
    if (last && last.role === item.role) {
      last.content = [{ text: `${last.content?.[0]?.text ?? ""}\n\n${text}` }];
    } else {
      messages.push({ role: item.role, content: [{ text }] });
    }
  }
  // 最後は assistant で終える（直後に今回の user 質問を足すため）
  if (messages.length > 0 && messages[messages.length - 1].role === "user") messages.pop();
  return messages;
}

function formatSearchResults(results: HybridSearchResult[]) {
  if (results.length === 0) return "（該当する検索結果はありません）";
  return results.map((r, i) => `[${i + 1}]\n${r.text}`).join("\n\n");
}

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

  // フォルダ選択時はfolderIdメタデータ属性でフィルタ（カスタムメタデータ方式）
  const retrievalFilter = createFolderIdFilter(body.folderId);

  try {
    // 検索は質問文だけで行う（添付の全文を混ぜると検索がずれるため、添付は回答生成にだけ渡す）
    const searchResults = await hybridSearch(knowledgeBaseId, message, {
      folderId: body.folderId,
      filter: retrievalFilter,
    });

    const bucket = appEnv.s3BucketName;
    const retrievalResults = searchResults.map((r) => ({
      content: { text: r.text },
      location: { s3Location: { uri: r.sourceUri } },
    }));
    console.log(`[chat/images] retrieveResults=${retrievalResults.length}`);

    // フォルダフィルタ適用かつ検索結果0件かつ資料モードの場合はガイドメッセージを返す（生成は省略）
    if (retrievalResults.length === 0 && !!body.folderId && body.mode !== "net") {
      return NextResponse.json({
        answer: "選択したフォルダの資料には、ご質問に関連する内容が見つかりませんでした。「すべての資料」に切り替えてもう一度お試しください。",
        citations: [],
        bedrockSessionId: body.bedrockSessionId ?? "",
        images: [],
      });
    }

    const [response, images] = await Promise.all([
      createBedrockRuntimeClient().send(
        new ConverseCommand({
          modelId: modelArn,
          system: [{ text: body.mode === "net" ? NET_PROMPT : RAG_ONLY_PROMPT }],
          messages: [
            ...buildHistoryMessages(body.history),
            {
              role: "user",
              content: [
                {
                  text: `${body.mode === "net" ? "院内資料の検索結果" : "検索結果"}:\n${formatSearchResults(searchResults)}\n\n質問:\n${message}${attachmentContext}`,
                },
              ],
            },
          ],
          inferenceConfig: { maxTokens: 4096 },
        })
      ),
      bucket && retrievalResults.length > 0
        ? extractImagesFromRetrieveResults(retrievalResults, bucket, message).catch((err) => {
            console.error("[chat/images] extractImagesFromRetrieveResults failed:", String(err));
            return [] as ChatImage[];
          })
        : Promise.resolve([] as ChatImage[]),
    ]);
    console.log(`[chat/images] result: ${images.length} images`);

    const answerText = (response.output?.message?.content ?? [])
      .map((block) => ("text" in block ? block.text ?? "" : ""))
      .join("");

    return NextResponse.json({
      answer: answerText,
      citations: [],
      // Bedrockセッションは使わなくなった（会話履歴は history で受け取る）。既存の保存形式との互換のため返す
      bedrockSessionId: body.bedrockSessionId ?? "",
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

function createFolderIdFilter(folderId?: string): RetrievalFilter | undefined {
  if (!folderId) return undefined;
  return { equals: { key: "folderId", value: folderId } };
}
