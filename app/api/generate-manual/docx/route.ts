import { marked } from "marked";
import { NextResponse } from "next/server";

// html-to-docx has no type declarations; load via require
// eslint-disable-next-line @typescript-eslint/no-require-imports
const HTMLtoDOCX = require("html-to-docx") as (
  html: string,
  headerHtml: null,
  options: Record<string, unknown>
) => Promise<Buffer>;

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
    const bodyHtml = await marked(content, { gfm: true, breaks: false });
    const fullHtml = `<h1>${escapeHtml(theme)}</h1>${bodyHtml}`;

    const docxBuffer = await HTMLtoDOCX(fullHtml, null, {
      title: theme,
      font: "Yu Mincho",
      fontSize: 22,
      complexScriptFontSize: 22,
      table: { row: { cantSplit: true } },
      footer: true,
      pageNumber: true,
    });

    return new Response(new Uint8Array(docxBuffer), {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(theme)}.docx"`,
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
