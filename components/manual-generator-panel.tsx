"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Download, ExternalLink, FileText, MessageSquare, Search, Send, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui";
import { type StoredFileMetadata } from "@/lib/file-assets";

const GEMINI_API_KEY        = process.env.NEXT_PUBLIC_GEMINI_API_KEY ?? "";
const GEMINI_FLASH_MODEL = "gemini-2.5-flash";

type EditHistoryItem = { instruction: string; targets: number[]; ok: boolean };

async function streamGenerate(
  model: string,
  prompt: string,
  systemPrompt: string,
  onChunk: (accumulated: string) => void
): Promise<void> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${GEMINI_API_KEY}&alt=sse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 65536, temperature: 0.3 }
      })
    }
  );
  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => "");
    let detail = errText;
    try { detail = JSON.stringify(JSON.parse(errText), null, 2); } catch {}
    throw new Error(`Gemini API エラー ${res.status} (${model}): ${detail}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let accumulated = "";
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const json = line.slice(6).trim();
      if (!json || json === "[DONE]") continue;
      try {
        const parsed = JSON.parse(json) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
        if (text) { accumulated += text; onChunk(accumulated); }
      } catch {}
    }
  }
}

async function generateSlideJson(
  model: string,
  prompt: string,
  systemPrompt: string
): Promise<string[]> {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 8000;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 65536,
            temperature: 0.4,
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                slides: {
                  type: "ARRAY",
                  items: {
                    type: "OBJECT",
                    properties: { html: { type: "STRING" } },
                    required: ["html"]
                  }
                }
              },
              required: ["slides"]
            }
          }
        })
      }
    );

    if (res.status === 503 && attempt < MAX_RETRIES - 1) {
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
      continue;
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      let detail = errText;
      try { detail = JSON.stringify(JSON.parse(errText), null, 2); } catch {}
      if (res.status === 503) {
        throw new Error(`gemini-2.5-flash が混雑しています。しばらく待ってから再試行してください。`);
      }
      throw new Error(`Gemini API エラー ${res.status} (${model}): ${detail}`);
    }

    const data = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    const parsed = JSON.parse(text) as { slides?: Array<{ html?: string }> };
    return (parsed.slides ?? []).map(s => s.html ?? "").filter(Boolean);
  }

  throw new Error(`gemini-2.5-flash が混雑しています。しばらく待ってから再試行してください。`);
}

function buildSlideIframeHtml(slides: string[], slideTheme: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const wrappedSlides = slides
    .map(html => `<div class="sw">${html}</div>`)
    .join("\n");
  return `<!DOCTYPE html>
<html lang="ja"><head>
<meta charset="utf-8">
<title>${esc(slideTheme)}</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@300;400;500;700&family=Noto+Serif+JP:wght@700&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#111827;padding:20px 0 40px;display:flex;flex-direction:column;align-items:flex-start}
.sw{flex-shrink:0;margin-bottom:0}
</style>
</head>
<body>${wrappedSlides}
<script>(function(){
function fit(){
  var w=window.innerWidth;
  var s=Math.min(w/960,1);
  var ml=Math.max((w-960*s)/2,0);
  document.querySelectorAll('.sw').forEach(function(wrap){
    var el=wrap.firstElementChild;
    if(!el)return;
    el.style.transform='scale('+s+')';
    el.style.transformOrigin='top left';
    el.style.display='block';
    wrap.style.width=(960*s)+'px';
    wrap.style.height=(540*s+24)+'px';
    wrap.style.marginLeft=ml+'px';
  });
}
window.addEventListener('resize',fit);fit();
})();</script>
</body></html>`;
}

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
];

const SLIDE_SYS_PROMPT = [
  "あなたは視覚表現に優れたUIデザイナー兼歯科医療専門家です。",
  "歯科医院スタッフが直感的に理解できるプレゼンテーションを、HTML/CSS/SVGを駆使して生成します。",
  "テキストを単純に並べるのではなく、フローチャート・比較表・グラフ・タイムラインなど、内容に応じた最適なビジュアルを積極的に採用してください。",
].join("\n");

const SLIDE_SPEC_LINES = [
  "- サイズ: position:relative; overflow:hidden; width:960px; height:540px",
  "- フォント: 'Noto Sans JP',sans-serif（ページで読込済み）、見出しに 'Noto Serif JP' も使用可",
  "- スタイルはすべてstyle属性にインライン記述（classは使わない）",
  "- 外部画像URL禁止。図・アイコンはSVGで描く",
  "- カラー: ネイビー #0d2350/#1a3a6c、アクセント #5b9bd5/#4a7fc1、本文背景 #f7f9fc、テキスト #3d4a6b",
  "- テキスト要素には必ず overflow:hidden を指定する",
  "- 絶対配置の要素同士が重ならないよう top/left/width/height を厳密に計算する",
  "- 見出し: font-size 20〜26px、本文・箇条書き: font-size 14〜17px",
  "- 1スライドの情報量を絞る（箇条書き最大4項目、各項目25字以内）",
  "- コンテンツ量が多い場合は font-size を小さくして収める（最小13px）",
];

export function ManualGeneratorPanel() {
  const [theme, setTheme] = useState("");

  const [repositoryFiles, setRepositoryFiles] = useState<StoredFileMetadata[]>([]);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const filePickerRef = useRef<HTMLDivElement | null>(null);

  const [outputType, setOutputType] = useState<"word" | "slide">("word");
  const [generatedOutputType, setGeneratedOutputType] = useState<"word" | "slide">("word");

  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [content, setContent] = useState("");
  const [slidesHtml, setSlidesHtml] = useState<string[]>([]);
  const [generatedTheme, setGeneratedTheme] = useState("");

  // Edit state
  const [editInstruction, setEditInstruction] = useState("");
  const [editSelectedSlides, setEditSelectedSlides] = useState<number[]>([]);
  const [editLoading, setEditLoading] = useState(false);
  const [editNotice, setEditNotice] = useState("");
  const [editHistory, setEditHistory] = useState<EditHistoryItem[]>([]);
  const editInputRef = useRef<HTMLInputElement | null>(null);

  const slideIframeSrc = useMemo(
    () => slidesHtml.length ? buildSlideIframeHtml(slidesHtml, generatedTheme) : "",
    [slidesHtml, generatedTheme]
  );

  const selectedFiles = useMemo(
    () => repositoryFiles.filter((f) => selectedFileIds.includes(f.id)),
    [repositoryFiles, selectedFileIds]
  );
  const filteredFiles = useMemo(
    () => repositoryFiles.filter((f) => f.fileName.toLowerCase().includes(fileQuery.toLowerCase())),
    [repositoryFiles, fileQuery]
  );

  useEffect(() => {
    let ignore = false;
    fetch("/api/files", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { files: StoredFileMetadata[] }) => { if (!ignore) setRepositoryFiles(data.files); })
      .catch(() => {});
    return () => { ignore = true; };
  }, []);

  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      if (filePickerRef.current && !filePickerRef.current.contains(e.target as Node)) {
        setFilePickerOpen(false);
      }
    }
    if (filePickerOpen) document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [filePickerOpen]);

  function toggleFile(id: string) {
    setSelectedFileIds((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
  }

  function toggleEditSlide(i: number) {
    setEditSelectedSlides(cur =>
      cur.includes(i) ? cur.filter(x => x !== i) : [...cur, i]
    );
  }

  async function generate() {
    if (!theme.trim() || loading) return;
    if (!GEMINI_API_KEY) {
      setNotice("NEXT_PUBLIC_GEMINI_API_KEY が設定されていません");
      return;
    }

    setLoading(true);
    setNotice("院内資料を取得中…");
    setContent("");
    setSlidesHtml([]);
    setGeneratedTheme("");
    // reset edit state
    setEditInstruction("");
    setEditSelectedSlides([]);
    setEditHistory([]);
    setEditNotice("");

    const currentTheme = theme.trim();

    try {
      const files = selectedFiles.map((f) => ({
        knowledgeBaseKey: f.knowledgeBaseKey,
        summaryKey: f.summaryKey,
        extractedTextKey: f.extractedTextKey
      }));
      const retrieveRes = await fetch("/api/generate-manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: currentTheme, files })
      });
      const { passages = [] } = retrieveRes.ok
        ? (await retrieveRes.json() as { passages: string[] })
        : { passages: [] };

      const isSlide = outputType === "slide";
      const context = passages.length > 0
        ? `\n\n【院内資料（参考）】\n${passages.join("\n\n")}`
        : "";

      if (isSlide) {
        const slidePrompt = [
          `テーマ: ${currentTheme}`,
          "",
          "歯科医院スタッフ向けプレゼンテーション（12枚）のHTMLスライドを作成してください。",
          "",
          "【各スライドの仕様】",
          ...SLIDE_SPEC_LINES,
          "",
          "【使えるビジュアル表現（自由に組み合わせてよい）】",
          "SVGフローチャート / SVGタイムライン / SVG棒グラフ・円グラフ / 2カラム比較レイアウト",
          "/ グリッドカード / HTMLテーブル / チェックリスト / SVGアイコン付き説明カード / SVG警告バナー",
          "→ 同じ種類を連続して使わず、各スライドの内容に最も適したビジュアルを自律的に選ぶこと",
          "→ テキストの羅列にしないこと。必ず何らかのビジュアル要素を含める",
          "",
          "【構成（12枚）】",
          "1枚目: タイトル（ネイビー背景、テーマを大きく）",
          "2〜11枚目: 定義→原因→症状→診断→治療手順→注意事項の流れでカバー",
          "12枚目: まとめ・重要ポイント",
          context,
        ].filter(Boolean).join("\n");

        setNotice("gemini-2.5-flash でスライドを生成中…");
        const slides = await generateSlideJson(GEMINI_FLASH_MODEL, slidePrompt, SLIDE_SYS_PROMPT);
        setSlidesHtml(slides);
        setNotice("");
      } else {
        const wordSysPrompt = "あなたは歯科医院の院内マニュアル作成AIです。指定された構成で日本語のマニュアルを作成してください。";
        const wordPrompt = [
          `テーマ: ${currentTheme}`,
          "",
          "以下の10項目構成で院内マニュアルを日本語で作成してください。",
          "各項目は「## 1. 病気の解説」のようにMarkdown見出し（##）で始め、その下に内容を記載してください。",
          "第8項目（治療中に確認するチェックリスト）は「- [ ] 」形式の箇条書きにしてください。",
          context,
          "",
          MANUAL_SECTIONS.map((s, i) => `## ${i + 1}. ${s}`).join("\n")
        ].filter(Boolean).join("\n");
        setNotice("");
        await streamGenerate(GEMINI_FLASH_MODEL, wordPrompt, wordSysPrompt, setContent);
      }

      setGeneratedTheme(currentTheme);
      setGeneratedOutputType(outputType);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "生成に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  async function editSlides() {
    if (!editInstruction.trim() || editLoading || !slidesHtml.length) return;

    // 未選択 = 全スライド対象
    const targets = editSelectedSlides.length === 0
      ? slidesHtml.map((_, i) => i)
      : [...editSelectedSlides].sort((a, b) => a - b);

    const instruction = editInstruction.trim();
    setEditLoading(true);
    setEditNotice(`スライドを修正中… 0 / ${targets.length}`);

    const sysPrompt = [
      "あなたは視覚表現に優れたUIデザイナー兼歯科医療専門家です。",
      "渡されたHTMLスライドを修正指示に従って修正し、1枚分の修正済みHTMLスライドを返してください。",
      "【仕様（維持すること）】",
      ...SLIDE_SPEC_LINES,
    ].join("\n");

    try {
      const updated = [...slidesHtml];
      for (let n = 0; n < targets.length; n++) {
        const idx = targets[n];
        setEditNotice(`スライドを修正中… ${n + 1} / ${targets.length} (${idx + 1}枚目)`);

        const prompt = [
          `【修正指示】`,
          instruction,
          ``,
          `【${idx + 1}枚目のスライドHTML】`,
          slidesHtml[idx],
          ``,
          `上記スライドを修正指示に従って修正した1枚分のHTMLを返してください。`,
        ].join("\n");

        const result = await generateSlideJson(GEMINI_FLASH_MODEL, prompt, sysPrompt);
        if (result.length > 0) updated[idx] = result[0];
      }

      setSlidesHtml(updated);
      setEditHistory(h => [...h, { instruction, targets, ok: true }]);
      setEditInstruction("");
      setEditNotice("");
    } catch (error) {
      const msg = error instanceof Error ? error.message : "修正に失敗しました";
      setEditNotice(msg);
      setEditHistory(h => [...h, { instruction, targets, ok: false }]);
    } finally {
      setEditLoading(false);
    }
  }

  async function editDocument() {
    if (!editInstruction.trim() || editLoading || !content) return;

    const instruction = editInstruction.trim();
    setEditLoading(true);
    setEditNotice("マニュアルを修正中…");

    const sysPrompt = "あなたは歯科医院の院内マニュアル作成AIです。修正指示に従ってマニュアルを修正し、修正していない部分も含めた完全なマニュアルを出力してください。";
    const prompt = [
      `【修正指示】`,
      instruction,
      ``,
      `【現在のマニュアル全文】`,
      content,
      ``,
      `上記マニュアルを修正指示に従って修正し、完全なマニュアルを出力してください。`,
    ].join("\n");

    try {
      setContent("");
      setEditNotice("");
      await streamGenerate(GEMINI_FLASH_MODEL, prompt, sysPrompt, setContent);
      setEditHistory(h => [...h, { instruction, targets: [], ok: true }]);
      setEditInstruction("");
    } catch (error) {
      const msg = error instanceof Error ? error.message : "修正に失敗しました";
      setEditNotice(msg);
      setEditHistory(h => [...h, { instruction, targets: [], ok: false }]);
    } finally {
      setEditLoading(false);
    }
  }

  async function downloadDocx() {
    if (!content || !generatedTheme) return;
    try {
      const res = await fetch("/api/generate-manual/docx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, theme: generatedTheme })
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(`docx エラー ${res.status}: ${errData.error ?? "不明"}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${generatedTheme}.docx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "ダウンロードに失敗しました");
    }
  }

  function openSlidePreview(src: string, filename: string) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([src], { type: "text/html;charset=utf-8" }));
    a.target = "_blank";
    a.rel = "noopener";
    a.click();
    void filename;
  }

  async function downloadPptx() {
    if (!slidesHtml.length || !generatedTheme) return;
    setNotice("PPTX 生成中… このタブから離れないでください");
    try {
      if (!document.querySelector('link[href*="Noto+Sans+JP"]')) {
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = "https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@300;400;500;700&family=Noto+Serif+JP:wght@700&display=swap";
        document.head.appendChild(link);
        await document.fonts.ready;
      }

      const { toPng } = await import("html-to-image");
      const { default: pptxgen } = await import("pptxgenjs");

      const container = document.createElement("div");
      container.style.cssText = "position:fixed;top:-9999px;left:-9999px;width:960px;overflow:hidden;";
      document.body.appendChild(container);

      const prs = new pptxgen();
      prs.layout = "LAYOUT_16x9";

      for (let i = 0; i < slidesHtml.length; i++) {
        if (document.visibilityState === "hidden") {
          setNotice(`PPTX 生成中… ${i + 1} / ${slidesHtml.length} ⚠ このタブに戻ってください`);
          await new Promise<void>(resolve => {
            const fn = () => {
              if (document.visibilityState === "visible") {
                document.removeEventListener("visibilitychange", fn);
                resolve();
              }
            };
            document.addEventListener("visibilitychange", fn);
          });
        }
        setNotice(`PPTX 生成中… ${i + 1} / ${slidesHtml.length} このタブから離れないでください`);

        container.innerHTML = slidesHtml[i];
        const el = container.firstElementChild as HTMLElement | null;
        if (!el) continue;
        el.style.width = "960px";
        el.style.height = "540px";

        const dataUrl = await toPng(el, { width: 960, height: 540, pixelRatio: 1, fontEmbedCSS: "" });
        const slide = prs.addSlide();
        slide.addImage({ data: dataUrl, x: 0, y: 0, w: "100%", h: "100%" });
      }

      document.body.removeChild(container);
      setNotice("");

      const blob = await prs.write({ outputType: "blob" }) as Blob;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${generatedTheme}.pptx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "PPTX 生成に失敗しました");
    }
  }

  // ── スライド選択チップ ──────────────────────────────────────────
  const slideChipStyle = (active: boolean): React.CSSProperties => ({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: 28,
    height: 28,
    padding: "0 6px",
    border: `1.5px solid ${active ? "var(--navy)" : "var(--line)"}`,
    borderRadius: 6,
    background: active ? "var(--navy)" : "transparent",
    color: active ? "#fff" : "var(--ink-soft)",
    fontSize: 12,
    fontWeight: active ? 600 : 400,
    cursor: "pointer",
    flexShrink: 0,
    transition: "all .12s ease",
  });

  const allSelected = editSelectedSlides.length === 0;

  return (
    <section className="panel" style={{ display: "flex", flexDirection: "column", minHeight: "calc(100vh - 200px)" }}>
      <div className="panel-head">
        <div className="row" style={{ gap: 10 }}>
          <FileText size={16} style={{ color: "var(--navy)" }} aria-hidden="true" />
          <span className="panel-title">マニュアル生成</span>
        </div>
        <span className="tiny soft">院内資料をもとに10項目構成で生成</span>
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflowY: "auto" }}>
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 14 }}>
          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, letterSpacing: "0.1em", color: "var(--ink-soft)", marginBottom: 6 }}>
              テーマ <span style={{ color: "var(--accent)" }}>*</span>
            </label>
            <input
              className="input"
              placeholder="例: 急性歯髄炎の処置"
              value={theme}
              onChange={(e) => setTheme(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") generate(); }}
            />
          </div>

          {/* File picker */}
          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, letterSpacing: "0.1em", color: "var(--ink-soft)", marginBottom: 6 }}>
              参照資料（任意）
            </label>
            <div style={{ position: "relative" }} ref={filePickerRef}>
              <button
                type="button"
                onClick={() => setFilePickerOpen((cur) => !cur)}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", border: "1px solid var(--line)", borderRadius: "var(--radius)", background: "var(--panel)", cursor: "pointer", fontSize: 13, color: "var(--ink-soft)", width: "100%" }}
              >
                <Search size={14} aria-hidden="true" />
                {selectedFiles.length > 0 ? `${selectedFiles.length}件の資料を選択中` : "資料を選んで絞り込む（未選択=全資料参照）"}
              </button>

              {filePickerOpen ? (
                <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, background: "#fff", border: "1px solid var(--line)", borderRadius: 12, boxShadow: "var(--shadow-lg)", padding: 14, zIndex: 20 }}>
                  <div className="between" style={{ marginBottom: 10 }}>
                    <span className="panel-title" style={{ fontSize: 13 }}>参照する資料</span>
                    <button type="button" onClick={() => setFilePickerOpen(false)} className="btn ghost sm icon" title="閉じる"><X size={14} aria-hidden="true" /></button>
                  </div>
                  <div style={{ position: "relative", marginBottom: 10 }}>
                    <Search size={14} style={{ position: "absolute", left: 12, top: 12, color: "var(--ink-muted)" }} aria-hidden="true" />
                    <input className="input" placeholder="ファイル名で探す" style={{ paddingLeft: 34, height: 36 }} value={fileQuery} onChange={(e) => setFileQuery(e.target.value)} />
                  </div>
                  <div className="between" style={{ marginBottom: 8 }}>
                    <span className="tiny soft">未選択は全資料から生成</span>
                    {selectedFileIds.length > 0 ? <button type="button" onClick={() => setSelectedFileIds([])} className="btn ghost sm">すべて外す</button> : null}
                  </div>
                  <div style={{ maxHeight: 220, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                    {filteredFiles.map((file) => {
                      const selected = selectedFileIds.includes(file.id);
                      return (
                        <button key={file.id} type="button" onClick={() => toggleFile(file.id)}
                          style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: selected ? "var(--navy-tint-soft)" : "transparent", border: `1px solid ${selected ? "var(--navy-tint)" : "transparent"}`, borderRadius: 8, textAlign: "left", cursor: "pointer" }}>
                          <span style={{ width: 18, height: 18, borderRadius: 4, border: `1.5px solid ${selected ? "var(--navy)" : "#c8c4b5"}`, background: selected ? "var(--navy)" : "transparent", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                            {selected ? <Check size={12} aria-hidden="true" /> : null}
                          </span>
                          <span className="stack" style={{ minWidth: 0, flex: 1 }}>
                            <span className="truncate" style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>{file.fileName.replace(/\.[^.]+$/, "")}</span>
                            <span className="tiny soft truncate">{file.sizeLabel || file.thumbnailLabel || "資料"}</span>
                          </span>
                        </button>
                      );
                    })}
                    {filteredFiles.length === 0 ? <p className="tiny soft" style={{ textAlign: "center", padding: "16px 0" }}>資料が見つかりません</p> : null}
                  </div>
                </div>
              ) : null}
            </div>
            {selectedFiles.length > 0 ? (
              <div className="row" style={{ flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                {selectedFiles.map((f) => (
                  <span key={f.id} className="tag">
                    <span className="truncate" style={{ maxWidth: 160 }}>{f.fileName.replace(/\.[^.]+$/, "")}</span>
                    <button type="button" onClick={() => toggleFile(f.id)} style={{ background: "transparent", border: 0, color: "inherit", cursor: "pointer", padding: 0, marginLeft: 2, display: "inline-flex" }} title="外す"><X size={11} aria-hidden="true" /></button>
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          {/* 出力形式トグル */}
          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, letterSpacing: "0.1em", color: "var(--ink-soft)", marginBottom: 6 }}>出力形式</label>
            <div style={{ display: "flex", border: "1px solid var(--line)", borderRadius: "var(--radius)", overflow: "hidden" }}>
              {(["word", "slide"] as const).map((type) => (
                <button key={type} type="button" onClick={() => setOutputType(type)}
                  style={{ flex: 1, padding: "9px 0", fontSize: 13, fontWeight: outputType === type ? 600 : 400, background: outputType === type ? "var(--navy)" : "transparent", color: outputType === type ? "#fff" : "var(--ink-soft)", border: 0, cursor: "pointer", transition: "all .15s ease" }}>
                  {type === "word" ? "ドキュメント（Word）" : "スライド（PowerPoint）"}
                </button>
              ))}
            </div>
          </div>

          <Button onClick={generate} disabled={!theme.trim() || loading} style={{ gap: 8 }}>
            <Sparkles size={16} aria-hidden="true" />
            {loading ? "生成中…" : "マニュアルを生成"}
          </Button>

          {notice ? <p className="tag accent" style={{ alignSelf: "flex-start" }}>{notice}</p> : null}
        </div>

        {(content || slidesHtml.length > 0 || loading) ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
            {/* ── ヘッダーバー ── */}
            <div className="between" style={{ padding: "10px 24px", borderBottom: "1px solid var(--line-soft)", flexShrink: 0 }}>
              <span className="row" style={{ gap: 8, fontSize: 13 }}>
                {loading
                  ? <><span className="dot ok" style={{ animation: "pulse 1.2s infinite" }} /><span style={{ color: "var(--ink-muted)", fontSize: 12 }}>{notice || "生成中…"}</span></>
                  : <span className="tiny soft">{generatedOutputType === "slide" ? `スライド ${slidesHtml.length} 枚` : "プレビュー"}</span>}
              </span>
              {!loading ? (
                generatedOutputType === "slide" ? (
                  <div className="row" style={{ gap: 6 }}>
                    {slidesHtml.length > 0 ? (
                      <>
                        <Button variant="ghost" onClick={() => openSlidePreview(slideIframeSrc, generatedTheme)}
                          style={{ gap: 5, fontSize: 12, paddingLeft: 12, paddingRight: 12, height: 30 }}>
                          <ExternalLink size={13} aria-hidden="true" />別タブで開く
                        </Button>
                        <Button variant="secondary" onClick={downloadPptx}
                          style={{ gap: 5, fontSize: 12, paddingLeft: 12, paddingRight: 12, height: 30 }}>
                          <Download size={13} aria-hidden="true" />PowerPoint (.pptx)
                        </Button>
                      </>
                    ) : null}
                  </div>
                ) : (
                  content ? (
                    <Button variant="secondary" onClick={downloadDocx}
                      style={{ gap: 6, fontSize: 13, paddingLeft: 14, paddingRight: 14, height: 34 }}>
                      <Download size={14} aria-hidden="true" />
                      Word (.docx) でダウンロード
                    </Button>
                  ) : null
                )
              ) : null}
            </div>

            {/* ── 編集パネル（生成完了後のみ表示） ── */}
            {!loading && (slidesHtml.length > 0 || content) ? (
              <div style={{ borderTop: "1px solid var(--line)", padding: "14px 24px 18px", flexShrink: 0, background: "var(--surface, #fafafa)" }}>
                {/* パネルタイトル */}
                <div className="row" style={{ gap: 6, marginBottom: 12 }}>
                  <MessageSquare size={13} style={{ color: "var(--navy)" }} aria-hidden="true" />
                  <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: "0.08em", color: "var(--ink-soft)" }}>
                    編集指示
                  </span>
                </div>

                {/* スライド選択チップ（スライドモードのみ） */}
                {generatedOutputType === "slide" && slidesHtml.length > 0 ? (
                  <div style={{ marginBottom: 10 }}>
                    <span style={{ fontSize: 11, color: "var(--ink-muted)", marginRight: 8 }}>対象:</span>
                    <div style={{ display: "inline-flex", flexWrap: "wrap", gap: 4, verticalAlign: "middle" }}>
                      {/* 全スライドボタン */}
                      <button
                        type="button"
                        onClick={() => setEditSelectedSlides([])}
                        style={slideChipStyle(allSelected)}
                        title="全スライドを対象にする"
                      >
                        全て
                      </button>
                      {/* 個別スライドチップ */}
                      {slidesHtml.map((_, i) => {
                        const active = editSelectedSlides.includes(i);
                        return (
                          <button
                            key={i}
                            type="button"
                            onClick={() => toggleEditSlide(i)}
                            style={slideChipStyle(active)}
                            title={`${i + 1}枚目を対象にする`}
                          >
                            {i + 1}
                          </button>
                        );
                      })}
                    </div>
                    {!allSelected ? (
                      <span style={{ marginLeft: 8, fontSize: 11, color: "var(--ink-muted)" }}>
                        {editSelectedSlides.sort((a, b) => a - b).map(i => `${i + 1}枚目`).join("・")} を対象
                      </span>
                    ) : (
                      <span style={{ marginLeft: 8, fontSize: 11, color: "var(--ink-muted)" }}>全スライドを対象</span>
                    )}
                  </div>
                ) : null}

                {/* 履歴（チャット風） */}
                {editHistory.length > 0 ? (
                  <div style={{ maxHeight: 130, overflowY: "auto", marginBottom: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                    {editHistory.map((h, idx) => (
                      <div key={idx} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                        {/* ユーザー発言 */}
                        <div style={{ display: "flex", justifyContent: "flex-end" }}>
                          <span style={{ background: "var(--navy)", color: "#fff", borderRadius: "10px 10px 2px 10px", padding: "5px 10px", fontSize: 12, maxWidth: "80%" }}>
                            {generatedOutputType === "slide" && h.targets.length > 0
                              ? `[${h.targets.map(t => `${t + 1}枚目`).join("・")}] `
                              : ""}
                            {h.instruction}
                          </span>
                        </div>
                        {/* AI応答 */}
                        <div style={{ display: "flex", justifyContent: "flex-start" }}>
                          <span style={{
                            background: h.ok ? "#e8f4e8" : "#fde8e8",
                            color: h.ok ? "#2d7a2d" : "#c0392b",
                            borderRadius: "10px 10px 10px 2px",
                            padding: "5px 10px",
                            fontSize: 12,
                          }}>
                            {h.ok
                              ? (generatedOutputType === "slide"
                                ? `✓ ${h.targets.length === 0 ? "全スライド" : h.targets.map(t => `${t + 1}枚目`).join("・")}を更新しました`
                                : "✓ マニュアルを更新しました")
                              : `✗ 修正に失敗しました`}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}

                {/* 入力フォーム */}
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    ref={editInputRef}
                    className="input"
                    placeholder={
                      generatedOutputType === "slide"
                        ? "例: フローチャートをシンプルにして、文字を大きくして"
                        : "例: 第3節をもっと詳しく説明して、箇条書きを増やして"
                    }
                    value={editInstruction}
                    onChange={(e) => setEditInstruction(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        if (generatedOutputType === "slide") editSlides();
                        else editDocument();
                      }
                    }}
                    disabled={editLoading}
                    style={{ flex: 1, height: 38 }}
                  />
                  <Button
                    onClick={generatedOutputType === "slide" ? editSlides : editDocument}
                    disabled={!editInstruction.trim() || editLoading}
                    style={{ gap: 5, height: 38, paddingLeft: 14, paddingRight: 14, flexShrink: 0 }}
                  >
                    {editLoading
                      ? <><span className="dot ok" style={{ width: 8, height: 8, animation: "pulse 1.2s infinite" }} />修正中…</>
                      : <><Send size={13} aria-hidden="true" />修正</>}
                  </Button>
                </div>

                {editNotice ? (
                  <p className="tag accent" style={{ marginTop: 8, alignSelf: "flex-start" }}>{editNotice}</p>
                ) : null}
              </div>
            ) : null}

            {/* ── スライドプレビュー ── */}
            {generatedOutputType === "slide" ? (
              !loading && slidesHtml.length > 0 ? (
                <iframe
                  key={slideIframeSrc.length}
                  srcDoc={slideIframeSrc}
                  style={{ flex: 1, width: "100%", border: "none", minHeight: "500px" }}
                  title="スライドプレビュー"
                />
              ) : (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, color: "var(--ink-faint)" }}>
                  {loading ? (
                    <>
                      <span className="dot ok" style={{ width: 10, height: 10, animation: "pulse 1.2s infinite" }} />
                      <p style={{ margin: 0, fontSize: 13, color: "var(--ink-muted)", textAlign: "center" }}>{notice}</p>
                    </>
                  ) : null}
                </div>
              )
            ) : (
              <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
                {generatedTheme ? (
                  <h1 style={{ fontFamily: "var(--serif)", fontSize: 18, fontWeight: 700, color: "var(--navy-deep)", marginBottom: 20, marginTop: 0 }}>{generatedTheme}</h1>
                ) : null}
                <div className="prose">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "var(--ink-faint)", padding: 32 }}>
            <FileText size={32} strokeWidth={1.2} aria-hidden="true" />
            <p style={{ margin: 0, fontSize: 13, textAlign: "center", lineHeight: 1.8 }}>テーマを入力して「マニュアルを生成」を<br />クリックしてください</p>
          </div>
        )}
      </div>
    </section>
  );
}
