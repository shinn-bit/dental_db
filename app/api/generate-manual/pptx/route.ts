import pptxgen from "pptxgenjs";
import { NextResponse } from "next/server";

type PptxRequest = { content?: string; theme?: string };
type SlideData = { title: string; subtitle?: string; bullets: string[] };

// ── Color palette ─────────────────────────────────────────────────
const C = {
  navyDeep:  "0d2350",
  navy:      "1a3a6c",
  navyLight: "2a5298",
  accent:    "4a7fc1",
  accentBright: "5b9bd5",
  white:     "FFFFFF",
  ink:       "1a1a2e",
  inkSoft:   "3d4a6b",
  grayLine:  "e0e4f0",
};

// ── Entry point ───────────────────────────────────────────────────
export async function POST(request: Request) {
  const body    = (await request.json()) as PptxRequest;
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

    // Unsplash: タイトルスライドの背景用に1枚だけ取得
    const bgImageData = await fetchUnsplashImage(theme);

    const prs = new pptxgen();
    prs.layout = "LAYOUT_16x9"; // 10in × 7.5in

    slides.forEach((slide, i) =>
      buildSlide(prs, slide, i, slides.length, i === 0 ? bgImageData : null)
    );

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

// ── Unsplash image fetch ─────────────────────────────────────────
async function fetchUnsplashImage(query: string): Promise<string | null> {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return null;

  try {
    const searchQuery = encodeURIComponent(`${query} dental clinic medical`);
    const res = await fetch(
      `https://api.unsplash.com/search/photos?query=${searchQuery}&per_page=1&orientation=landscape`,
      { headers: { Authorization: `Client-ID ${key}` }, cache: "no-store" }
    );
    if (!res.ok) return null;

    const data = (await res.json()) as {
      results: Array<{ urls: { regular: string } }>;
    };
    const imageUrl = data.results[0]?.urls?.regular;
    if (!imageUrl) return null;

    const imgRes = await fetch(imageUrl + "&w=1280&q=80");
    if (!imgRes.ok) return null;

    const buf = await imgRes.arrayBuffer();
    return `data:image/jpeg;base64,${Buffer.from(buf).toString("base64")}`;
  } catch {
    return null;
  }
}

// ── Markdown → slide data ─────────────────────────────────────────
function parseSlideMd(markdown: string): SlideData[] {
  return markdown
    .split(/(?:^|\n)---(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const lines    = part.split("\n").map((l) => l.trim()).filter(Boolean);
      const title    = (lines.find((l) => l.startsWith("# ")) ?? "").slice(2).trim();
      const subtitle = lines.find((l) => l.startsWith("## "))?.slice(3).trim();
      const bullets  = lines
        .filter((l) => l.startsWith("- ") || l.startsWith("* "))
        .map((l) => l.slice(2).trim())
        .filter(Boolean);
      return { title, subtitle, bullets };
    });
}

// ── Slide builder ────────────────────────────────────────────────
function buildSlide(
  prs: pptxgen,
  data: SlideData,
  index: number,
  total: number,
  bgImageData: string | null
) {
  const slide = prs.addSlide();

  if (index === 0) {
    buildTitleSlide(slide, data, bgImageData);
  } else {
    buildContentSlide(slide, data, index, total);
  }
}

// ── Title slide ───────────────────────────────────────────────────
function buildTitleSlide(slide: pptxgen.Slide, data: SlideData, bgImage: string | null) {
  if (bgImage) {
    // 写真背景
    slide.background = { data: bgImage };
    // 暗めのオーバーレイ（視認性確保）
    slide.addShape("rect" as pptxgen.SHAPE_NAME, {
      x: 0, y: 0, w: 10, h: 7.5,
      fill: { color: C.navyDeep, transparency: 30 },
      line: { width: 0 },
    });
  } else {
    // 写真なし: ネイビー背景
    slide.background = { color: C.navyDeep };
    // 装飾: 大きい半透明サークル（右下）
    slide.addShape("ellipse" as pptxgen.SHAPE_NAME, {
      x: 6.2, y: 4.0, w: 5.5, h: 5.5,
      fill: { color: C.navyLight, transparency: 70 },
      line: { width: 0 },
    });
    // 装飾: 小さいサークル（左上）
    slide.addShape("ellipse" as pptxgen.SHAPE_NAME, {
      x: -1.2, y: -1.2, w: 3.5, h: 3.5,
      fill: { color: C.accent, transparency: 75 },
      line: { width: 0 },
    });
  }

  // 上部細ライン（アクセント）
  slide.addShape("rect" as pptxgen.SHAPE_NAME, {
    x: 0.6, y: 2.5, w: 8.8, h: 0.06,
    fill: { color: C.accentBright, transparency: 0 },
    line: { width: 0 },
  });

  // タイトル
  slide.addText(data.title, {
    x: 0.6, y: 2.7, w: 8.8, h: 2.0,
    fontSize: 38, bold: true, color: C.white,
    align: "center", valign: "middle",
    shadow: { type: "outer", color: "000000", blur: 6, offset: 2, angle: 45, opacity: 0.4 },
  });

  // サブタイトル
  if (data.subtitle) {
    slide.addText(data.subtitle, {
      x: 0.6, y: 4.8, w: 8.8, h: 0.75,
      fontSize: 20, color: "aac8f5",
      align: "center",
    });
  }

  // 下部アクセントライン
  slide.addShape("rect" as pptxgen.SHAPE_NAME, {
    x: 0, y: 7.1, w: 10, h: 0.4,
    fill: { color: C.navy, transparency: 40 },
    line: { width: 0 },
  });
}

// ── Content slide ─────────────────────────────────────────────────
function buildContentSlide(
  slide: pptxgen.Slide,
  data: SlideData,
  index: number,
  total: number
) {
  slide.background = { color: "F7F9FC" };

  // ヘッダーバー（左が濃く右が少し薄いグラデーション）
  slide.addShape("rect" as pptxgen.SHAPE_NAME, {
    x: 0, y: 0, w: 10, h: 1.18,
    fill: { color: C.navyDeep },
    line: { width: 0 },
  });
  slide.addShape("rect" as pptxgen.SHAPE_NAME, {
    x: 5, y: 0, w: 5, h: 1.18,
    fill: { color: C.navy, transparency: 30 },
    line: { width: 0 },
  });

  // 左アクセントストライプ
  slide.addShape("rect" as pptxgen.SHAPE_NAME, {
    x: 0, y: 1.18, w: 0.12, h: 6.32,
    fill: { color: C.accent },
    line: { width: 0 },
  });

  // スライド番号バッジ（ヘッダー右端）
  slide.addShape("ellipse" as pptxgen.SHAPE_NAME, {
    x: 9.05, y: 0.17, w: 0.78, h: 0.78,
    fill: { color: C.accentBright },
    line: { width: 0 },
  });
  slide.addText(`${index}`, {
    x: 9.05, y: 0.17, w: 0.78, h: 0.78,
    fontSize: 15, bold: true, color: C.white,
    align: "center", valign: "middle",
  });

  // タイトル
  slide.addText(data.title, {
    x: 0.3, y: 0.1, w: 8.6, h: 1.0,
    fontSize: 22, bold: true, color: C.white,
    valign: "middle",
  });

  // 箇条書きエリア背景（白カード）
  slide.addShape("rect" as pptxgen.SHAPE_NAME, {
    x: 0.28, y: 1.3, w: 9.44, h: 5.6,
    fill: { color: C.white },
    line: { color: C.grayLine, width: 0.5 },
    rectRadius: 0.1,
  });

  // 箇条書き
  if (data.bullets.length > 0) {
    slide.addText(
      data.bullets.map((b) => ({
        text: `▸  ${b}`,
        options: { breakLine: true, paraSpaceAfter: 10 },
      })),
      {
        x: 0.55, y: 1.5, w: 9.1, h: 5.3,
        fontSize: 18, color: C.inkSoft,
        valign: "top",
      }
    );
  }

  // フッター
  slide.addShape("rect" as pptxgen.SHAPE_NAME, {
    x: 0, y: 7.28, w: 10, h: 0.22,
    fill: { color: C.navy },
    line: { width: 0 },
  });
  if (total > 1) {
    slide.addText(`${index} / ${total - 1}`, {
      x: 8.5, y: 7.28, w: 1.3, h: 0.22,
      fontSize: 9, color: C.white,
      align: "right", valign: "middle",
    });
  }
}
