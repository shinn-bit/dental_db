import {
  RetrieveAndGenerateCommand,
  RetrieveCommand,
} from "@aws-sdk/client-bedrock-agent-runtime";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { NextResponse } from "next/server";
import {
  createBedrockAgentRuntimeClient,
  createBedrockRuntimeClient,
  createS3Client,
} from "@/lib/aws";
import { appEnv, requireEnv } from "@/lib/env";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";

type Attachment = { name: string; type: string; data: string };

type InsuranceChatRequest = {
  message?: string;
  attachments?: Attachment[];
  bedrockSessionId?: string;
  folderKeys?: string[]; // 保険フォルダのknowledgeBaseKeyリスト
};

const IMAGE_FORMAT_MAP: Record<string, "jpeg" | "png" | "gif" | "webp"> = {
  "image/jpeg": "jpeg", "image/jpg": "jpeg",
  "image/png": "png", "image/gif": "gif", "image/webp": "webp",
};

const INSURANCE_PROMPT = `あなたは歯科医院の保険請求専門AIアシスタントです。
院内の保険ルール資料だけを参照して回答してください。
資料に根拠がない場合は「院内資料に該当情報がありません。保険請求の専門家にご確認ください。」と伝えてください。

ユーザーの入力内容のインテントを自動で判断し、以下の形式で応答してください：

■ 治療内容が入力された場合（例：「初診、スケーリング、CR充填2本」）
　▶ 請求例：
　　- [コード名]（点数）：算定条件・注意事項
　▶ 算定上の注意点：（あれば）

■「チェック」「確認」「漏れ」等、請求内容の検証を求められた場合
　▶ 指摘事項：
　　- 請求漏れ・誤り・重複算定の問題点
　▶ 修正提案：
　　- 具体的な修正方法

■ 保険ルールに関する質問の場合
　根拠資料・算定要件を明示して簡潔に回答。

■「最適化」「追加算定」「もっと取れないか」等の相談の場合
　▶ 追加算定の可能性：
　　- 項目・条件・優先度

検索結果:
$search_results$

質問・入力内容:
$query$`;

async function describeImage(
  buffer: Buffer, mimeType: string, filename: string, modelArn: string
): Promise<string> {
  const format = IMAGE_FORMAT_MAP[mimeType] ?? "jpeg";
  try {
    const response = await createBedrockRuntimeClient().send(
      new ConverseCommand({
        modelId: modelArn,
        messages: [{
          role: "user",
          content: [
            { image: { format, source: { bytes: buffer } } },
            { text: `この画像（ファイル名: ${filename}）に含まれているテキスト、データ、図表などの情報をすべて正確に書き起こしてください。` },
          ],
        }],
      })
    );
    const content = response.output?.message?.content ?? [];
    const textBlock = content.find((b) => "text" in b);
    return (textBlock as { text?: string } | undefined)?.text ?? "(画像の解析結果なし)";
  } catch { return "(画像の解析に失敗しました)"; }
}

async function extractAttachmentText(
  attachment: Attachment, modelArn: string
): Promise<string> {
  const buffer = Buffer.from(attachment.data, "base64");
  try {
    if (attachment.type === "application/pdf") {
      const parsed = await pdfParse(buffer);
      return `[添付ファイル: ${attachment.name}]\n${parsed.text.trim().slice(0, 3000)}`;
    }
    if (attachment.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      const result = await mammoth.extractRawText({ buffer });
      return `[添付ファイル: ${attachment.name}]\n${result.value.trim().slice(0, 3000)}`;
    }
    if (attachment.type.startsWith("image/")) {
      const desc = await describeImage(buffer, attachment.type, attachment.name, modelArn);
      return `[添付画像: ${attachment.name}]\n${desc}`;
    }
  } catch (err) {
    console.error(`[insurance-chat] attachment extract failed: ${attachment.name}`, err);
  }
  return "";
}

export async function POST(request: Request) {
  const body = (await request.json()) as InsuranceChatRequest;
  const message = body.message?.trim();
  if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });

  const knowledgeBaseId = requireEnv(appEnv.bedrockKnowledgeBaseId, "BEDROCK_KNOWLEDGE_BASE_ID");
  const modelArn = requireEnv(appEnv.bedrockModelArn, "BEDROCK_MODEL_ARN");

  const attachmentParts: string[] = [];
  for (const att of body.attachments ?? []) {
    const text = await extractAttachmentText(att, modelArn);
    if (text) attachmentParts.push(text);
  }
  const attachmentContext = attachmentParts.length > 0
    ? `\n\n--- 添付ファイルの内容 ---\n${attachmentParts.join("\n\n")}\n---`
    : "";

  const queryText = `${message}${attachmentContext}`;

  // 保険フォルダのファイルに絞ったフィルタを構築
  const folderUris = (body.folderKeys ?? []).filter(Boolean).map(k => `s3://${appEnv.s3BucketName}/${k}`);
  const retrievalFilter = folderUris.length > 0
    ? folderUris.length === 1
      ? { equals: { key: "x-amz-bedrock-kb-source-uri", value: { stringValue: folderUris[0] } } }
      : { orAll: folderUris.map(uri => ({ equals: { key: "x-amz-bedrock-kb-source-uri", value: { stringValue: uri } } })) }
    : undefined;

  try {
    const bedrockClient = createBedrockAgentRuntimeClient();

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
                numberOfResults: 8,
                ...(retrievalFilter ? { filter: retrievalFilter } : {}),
              },
            },
            generationConfiguration: {
              promptTemplate: { textPromptTemplate: INSURANCE_PROMPT },
            },
          },
        },
      })),
      bedrockClient.send(new RetrieveCommand({
        knowledgeBaseId,
        retrievalQuery: { text: queryText },
        retrievalConfiguration: {
          vectorSearchConfiguration: {
            numberOfResults: 8,
            ...(retrievalFilter ? { filter: retrievalFilter } : {}),
          },
        },
      })).catch(() => ({ retrievalResults: [] as never[] })),
    ]);

    const bucket = appEnv.s3BucketName;
    const retrievalResults = (retrieveResponse.retrievalResults ?? []) as Array<{
      content?: { text?: string };
      location?: { s3Location?: { uri?: string } };
    }>;

    const images = bucket && retrievalResults.length > 0
      ? await extractImages(retrievalResults, bucket, message).catch(() => [] as ChatImage[])
      : [];

    return NextResponse.json({
      answer: response.output?.text || "",
      bedrockSessionId: response.sessionId || "",
      images,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown Bedrock error";
    console.error("[insurance-chat] error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

type ChatImage = { url: string; description: string; page: number; documentName: string };

async function extractImages(
  results: Array<{ content?: { text?: string }; location?: { s3Location?: { uri?: string } } }>,
  bucket: string,
  query: string
): Promise<ChatImage[]> {
  const s3 = createS3Client();
  const out: ChatImage[] = [];
  const seen = new Set<string>();

  const cleaned = query.replace(/[　！？。、・「」【】（）\s]/g, "");
  const keywords = Array.from(new Set(
    [3, 4, 5, 6].flatMap(n =>
      Array.from({ length: Math.max(0, cleaned.length - n + 1) }, (_, i) => cleaned.slice(i, i + n))
    )
  ));

  for (const ref of results) {
    const uri = ref.location?.s3Location?.uri ?? "";
    const match = uri.match(/\/kb\/([^/]+)\.md$/);
    if (!match) continue;
    const docId = match[1];
    if (seen.has(docId)) continue;
    seen.add(docId);

    try {
      const metaRes = await s3.send(new GetObjectCommand({
        Bucket: bucket, Key: `${appEnv.s3MetadataPrefix}${docId}.json`,
      }));
      const meta = JSON.parse(await metaRes.Body?.transformToString() ?? "{}") as {
        fileName?: string;
        images?: Array<{ page: number; s3Key: string; description: string }>;
      };
      const SKIP = ["表紙", "目次", "はじめに", "前書き", "まえがき", "序文", "Contents", "Table of"];
      const scored = (meta.images ?? [])
        .filter(img => !SKIP.some(w => img.description.includes(w)))
        .map(img => ({ img, score: keywords.filter(kw => img.description.includes(kw)).length }))
        .filter(s => s.score >= 1)
        .sort((a, b) => b.score - a.score);

      for (const { img } of scored.slice(0, 3)) {
        const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: img.s3Key }), { expiresIn: 3600 });
        out.push({ url, description: img.description, page: img.page, documentName: meta.fileName ?? docId });
        if (out.length >= 5) break;
      }
    } catch { continue; }
    if (out.length >= 5) break;
  }
  return out;
}
