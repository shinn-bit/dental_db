import pptxgen from "pptxgenjs";
import { NextResponse } from "next/server";

type PptxRequest = { content?: string; theme?: string };
type SlideData = { title: string; subtitle?: string; bullets: string[] };

const NAVY   = "1a3a6c";
const ACCENT = "4a7fc1";
const WHITE  = "FFFFFF";
const INK    = "222222";

export async function POST(request: Request) {
  const body = (await request.json()) as PptxRequest;
  const content = body.content?.trim();
  const theme   = body.theme?.trim() || "プレゼンテーション";

  if (!content) {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }

  try {
    const slides = parseSlideMd(content);
    if (slides.length === 0) {
      return NextResponse.json({ error: "スライドが見つかりませんでした" }, { status: 400 });
    }

    const prs = new pptxgen();
    prs.layout = "LAYOUT_16x9"; // 10in × 7.5in

    slides.forEach((slide, i) => buildSlide(prs, slide, i, slides.length));

    const buffer = (await prs.write({ outputType: "nodebuffer" })) as Buffer;

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "Content-Disposition": `attachment; filename="${encodeURIComponent(theme)}.pptx"`,
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

// ── markdown → slide data ──────────────────────────────────────────
function parseSlideMd(markdown: string): SlideData[] {
  return markdown
    .split(/(?:^|\n)---(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const lines = part.split("\n").map((l) => l.trim()).filter(Boolean);
      const title    = (lines.find((l) => l.startsWith("# ")) ?? "").slice(2).trim();
      const subtitle = lines.find((l) => l.startsWith("## "))?.slice(3).trim();
      const bullets  = lines
        .filter((l) => l.startsWith("- ") || l.startsWith("* "))
        .map((l) => l.slice(2).trim())
        .filter(Boolean);
      return { title, subtitle, bullets };
    });
}

// ── slide builder ─────────────────────────────────────────────────
function buildSlide(prs: pptxgen, data: SlideData, index: number, total: number) {
  const slide = prs.addSlide();

  if (index === 0) {
    // ── タイトルスライド ──
    slide.background = { color: NAVY };
    slide.addText(data.title, {
      x: 0.6, y: 1.8, w: 8.8, h: 2.2,
      fontSize: 36, bold: true, color: WHITE,
      align: "center", valign: "middle",
    });
    if (data.subtitle) {
      slide.addText(data.subtitle, {
        x: 0.6, y: 4.1, w: 8.8, h: 0.8,
        fontSize: 20, color: "aac4f0",
        align: "center",
      });
    }
    // アクセントライン
    slide.addShape("rect" as pptxgen.SHAPE_NAME, {
      x: 3.8, y: 5.1, w: 2.4, h: 0.07,
      fill: { color: ACCENT }, line: { width: 0 },
    });
  } else {
    // ── コンテンツスライド ──
    slide.background = { color: "FFFFFF" };

    // ヘッダーバー
    slide.addShape("rect" as pptxgen.SHAPE_NAME, {
      x: 0, y: 0, w: 10, h: 1.15,
      fill: { color: NAVY }, line: { width: 0 },
    });
    // 左アクセントライン
    slide.addShape("rect" as pptxgen.SHAPE_NAME, {
      x: 0, y: 1.15, w: 0.09, h: 5.3,
      fill: { color: ACCENT }, line: { width: 0 },
    });

    // タイトル
    slide.addText(data.title, {
      x: 0.3, y: 0.12, w: 9.4, h: 0.9,
      fontSize: 22, bold: true, color: WHITE,
      valign: "middle",
    });

    // 箇条書き
    if (data.bullets.length > 0) {
      slide.addText(
        data.bullets.map((b) => ({
          text: b,
          options: { bullet: { indent: 20 }, breakLine: true, paraSpaceAfter: 8 },
        })),
        {
          x: 0.28, y: 1.3, w: 9.5, h: 5.1,
          fontSize: 19, color: INK,
          valign: "top",
        }
      );
    }

    // スライド番号
    if (total > 1) {
      slide.addText(`${index} / ${total - 1}`, {
        x: 8.7, y: 6.9, w: 1.1, h: 0.3,
        fontSize: 10, color: "aaaaaa",
        align: "right",
      });
    }
  }
}
