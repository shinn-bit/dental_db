import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { NextResponse } from "next/server";

type DocxRequest = {
  content?: string;
  theme?: string;
};

export async function POST(request: Request) {
  const body = (await request.json()) as DocxRequest;
  const content = body.content?.trim();
  const theme = body.theme?.trim() || "マニュアル";

  if (!content) {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }

  try {
    const docxUint8 = await Packer.toBuffer(
      new Document({
        sections: [{ properties: {}, children: buildDocxChildren(theme, content) }]
      })
    );

    return new Response(Buffer.from(docxUint8), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(theme)}.docx"`
      }
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

function buildDocxChildren(theme: string, markdown: string): Paragraph[] {
  const children: Paragraph[] = [
    new Paragraph({
      children: [new TextRun({ text: theme, bold: true, size: 40 })],
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
      children.push(
        new Paragraph({
          children: parseInline(trimmed),
          spacing: { after: 120 }
        })
      );
    }
  }

  return children;
}

function parseInline(text: string): TextRun[] {
  const runs: TextRun[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push(new TextRun({ text: text.slice(last, m.index) }));
    runs.push(new TextRun({ text: m[1], bold: true }));
    last = m.index + m[0].length;
  }

  if (last < text.length) runs.push(new TextRun({ text: text.slice(last) }));
  return runs.length > 0 ? runs : [new TextRun({ text })];
}
