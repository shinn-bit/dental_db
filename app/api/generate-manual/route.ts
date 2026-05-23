import {
  RetrieveAndGenerateCommand,
  type RetrievalFilter
} from "@aws-sdk/client-bedrock-agent-runtime";
import { NextResponse } from "next/server";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { createBedrockAgentRuntimeClient } from "@/lib/aws";
import { appEnv, requireEnv } from "@/lib/env";

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
  audience?: string;
  purpose?: string;
  detailLevel?: "brief" | "standard" | "detailed";
  files?: ManualSourceFile[];
};

export async function POST(request: Request) {
  const body = (await request.json()) as GenerateManualRequest;
  const theme = body.theme?.trim();

  if (!theme) {
    return NextResponse.json({ error: "テーマは必須です" }, { status: 400 });
  }

  const knowledgeBaseId = requireEnv(appEnv.bedrockKnowledgeBaseId, "BEDROCK_KNOWLEDGE_BASE_ID");
  const modelArn = requireEnv(appEnv.bedrockModelArn, "BEDROCK_MODEL_ARN");

  const audience = body.audience || "全スタッフ";
  const purpose = body.purpose?.trim() || "院内教育";
  const detailLevel = body.detailLevel || "standard";
  const detailLabel = detailLevel === "brief" ? "簡略（各項目3〜5文）" : detailLevel === "detailed" ? "詳細（各項目8〜12文）" : "標準（各項目5〜8文）";

  const sectionList = MANUAL_SECTIONS.map((s, i) => `## ${i + 1}. ${s}`).join("\n");

  const queryText = [
    `テーマ: ${theme}`,
    `対象読者: ${audience}`,
    `用途: ${purpose}`,
    `詳細度: ${detailLabel}`,
    "",
    "以下の10項目構成で院内マニュアルを作成してください。",
    "各項目は「## 1. 病気の解説」のようにMarkdownの見出し（##）で始め、その下に内容を記載してください。",
    "第8項目（治療中に確認するチェックリスト）は「- [ ] 」形式のチェックリスト箇条書きで作成してください。",
    "院内資料に記載のない情報は一般的な歯科知識で補完してください。",
    "",
    sectionList
  ].join("\n");

  const selectedFiles = (body.files ?? []).filter(
    (f) => f.knowledgeBaseKey || f.summaryKey || f.extractedTextKey
  );
  const sourceUris = selectedFiles
    .flatMap((f) => [
      f.knowledgeBaseKey ? `s3://${appEnv.s3BucketName}/${f.knowledgeBaseKey}` : "",
      f.summaryKey && !f.knowledgeBaseKey ? `s3://${appEnv.s3BucketName}/${f.summaryKey}` : "",
      f.extractedTextKey ? `s3://${appEnv.s3BucketName}/${f.extractedTextKey}` : ""
    ])
    .filter(Boolean);
  const retrievalFilter = createSourceUriFilter(sourceUris);

  try {
    const response = await createBedrockAgentRuntimeClient().send(
      new RetrieveAndGenerateCommand({
        input: { text: queryText },
        retrieveAndGenerateConfiguration: {
          type: "KNOWLEDGE_BASE",
          knowledgeBaseConfiguration: {
            knowledgeBaseId,
            modelArn,
            retrievalConfiguration: {
              vectorSearchConfiguration: {
                numberOfResults: 8,
                ...(retrievalFilter ? { filter: retrievalFilter } : {})
              }
            },
            generationConfiguration: {
              promptTemplate: {
                textPromptTemplate:
                  "あなたは歯科医院の院内マニュアル作成AIです。以下の院内資料（検索結果）を参照し、指定されたテーマの院内マニュアルを日本語で作成してください。院内資料に記載のない情報は一般的な歯科知識で補完してください。\n\n院内資料:\n$search_results$\n\nリクエスト:\n$query$"
              },
              inferenceConfig: {
                textInferenceConfig: {
                  maxTokens: 4096,
                  temperature: 0.3
                }
              }
            }
          }
        }
      })
    );

    const content = response.output?.text ?? "";
    const docxBuffer = await buildDocx(theme, audience, content);
    const docxBase64 = Buffer.from(docxBuffer).toString("base64");

    return NextResponse.json({ content, docxBase64, theme });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

async function buildDocx(theme: string, audience: string, markdown: string): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({
      children: [new TextRun({ text: theme, bold: true, size: 40 })],
      spacing: { after: 120 }
    }),
    new Paragraph({
      children: [new TextRun({ text: `対象読者: ${audience}`, color: "666666", size: 22 })],
      spacing: { after: 400 }
    })
  ];

  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed) {
      children.push(new Paragraph({ text: "", spacing: { after: 60 } }));
      continue;
    }

    if (trimmed.startsWith("## ")) {
      children.push(
        new Paragraph({
          text: trimmed.slice(3),
          heading: HeadingLevel.HEADING_1,
          spacing: { before: 400, after: 160 }
        })
      );
    } else if (trimmed.startsWith("### ")) {
      children.push(
        new Paragraph({
          text: trimmed.slice(4),
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 200, after: 100 }
        })
      );
    } else if (/^[-*]\s+\[\s?[x ]?\s?\]/.test(trimmed)) {
      const text = trimmed.replace(/^[-*]\s+\[\s?[x ]?\s?\]\s*/, "");
      children.push(
        new Paragraph({
          children: [new TextRun({ text: `□  ${text}` })],
          indent: { left: 360 },
          spacing: { after: 80 }
        })
      );
    } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      children.push(
        new Paragraph({
          text: trimmed.slice(2),
          bullet: { level: 0 },
          spacing: { after: 60 }
        })
      );
    } else {
      const inlineRuns = parseInline(trimmed);
      children.push(
        new Paragraph({
          children: inlineRuns,
          spacing: { after: 120 }
        })
      );
    }
  }

  const doc = new Document({
    sections: [{ properties: {}, children }]
  });

  return Packer.toBuffer(doc) as Promise<Buffer>;
}

function parseInline(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      runs.push(new TextRun({ text: text.slice(last, m.index) }));
    }
    runs.push(new TextRun({ text: m[1], bold: true }));
    last = m.index + m[0].length;
  }

  if (last < text.length) {
    runs.push(new TextRun({ text: text.slice(last) }));
  }

  return runs.length > 0 ? runs : [new TextRun({ text })];
}

function createSourceUriFilter(sourceUris: string[]): RetrievalFilter | undefined {
  const uris = sourceUris.filter(Boolean);
  if (uris.length === 0) return undefined;

  const filters = uris.map((uri) => ({
    equals: { key: "x-amz-bedrock-kb-source-uri", value: uri }
  }));

  return filters.length === 1 ? filters[0] : { orAll: filters };
}
