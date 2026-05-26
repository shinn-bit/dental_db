"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Download, ExternalLink, FileText, MessageCircle, Plus, Send, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui";

const GEMINI_API_KEY = process.env.NEXT_PUBLIC_GEMINI_API_KEY ?? "";
const GEMINI_FLASH_MODEL = "gemini-2.5-flash";

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

type ManualImagePart = { mimeType: string; base64: string; previewUrl: string };
type ManualMessage = {
  role: "user" | "model";
  text: string;
  displayText?: string;
  images?: ManualImagePart[];
};

async function streamGenerate(
  model: string,
  systemPrompt: string,
  contents: GeminiContent[],
  onChunk: (accumulated: string) => void
): Promise<void> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${GEMINI_API_KEY}&alt=sse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
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
  contents: GeminiContent[],
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
          contents,
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
  const wrappedSlides = slides.map(html => `<div class="sw">${html}</div>`).join("\n");
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
  "病気の解説", "原因", "病態・所見", "患者の訴え・臨床所見",
  "当日の処置・応急処置", "治療法", "治療の具体的なステップ",
  "治療中に確認するチェックリスト", "予後・術後のメンテナンス", "その他注意すべきこと"
];

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

const WORD_SYS_PROMPT = [
  "あなたは歯科医院の院内マニュアル作成AIです。",
  "ユーザーの指示に従い、以下の10項目構成でMarkdown形式のマニュアルを生成・編集してください。",
  "修正指示がある場合は、修正していない部分も含めた完全なマニュアルを出力してください。",
  "画像が提供された場合はその内容を参考にしてください。",
  "",
  "【出力構成（必ずこの順番・見出しで出力）】",
  ...MANUAL_SECTIONS.map((s, i) => `## ${i + 1}. ${s}`),
  "",
  "第8項目（治療中に確認するチェックリスト）は「- [ ] 」形式の箇条書きにしてください。",
].join("\n");

const SLIDE_SYS_PROMPT = [
  "あなたは視覚表現に優れたUIデザイナー兼歯科医療専門家です。",
  "ユーザーの指示に従い、歯科医院スタッフ向けプレゼンテーション（12枚）のHTMLスライドを生成してください。",
  "修正指示がある場合は全スライドを再生成してください。",
  "画像が提供された場合はその内容を参考にしてください。",
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
].join("\n");

function toGeminiContents(
  history: ManualMessage[],
  userText: string,
  userImages: ManualImagePart[]
): GeminiContent[] {
  const contents: GeminiContent[] = history.map(msg => {
    const parts: GeminiPart[] = [{ text: msg.text || " " }];
    (msg.images ?? []).forEach(img => parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } }));
    return { role: msg.role, parts };
  });
  const newParts: GeminiPart[] = [{ text: userText || " " }];
  userImages.forEach(img => newParts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } }));
  contents.push({ role: "user", parts: newParts });
  return contents;
}

export function ManualGeneratorPanel({ onSwitchMode }: { onSwitchMode?: () => void }) {
  const [messages, setMessages] = useState<ManualMessage[]>([]);
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<ManualImagePart[]>([]);

  const [outputType, setOutputType] = useState<"word" | "slide">("word");
  const [generatedOutputType, setGeneratedOutputType] = useState<"word" | "slide">("word");

  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [content, setContent] = useState("");
  const [slidesHtml, setSlidesHtml] = useState<string[]>([]);
  const [generatedTheme, setGeneratedTheme] = useState("");

  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const slideIframeSrc = useMemo(
    () => slidesHtml.length ? buildSlideIframeHtml(slidesHtml, generatedTheme) : "",
    [slidesHtml, generatedTheme]
  );

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  function handleImageAttach(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        setPendingImages((prev) => [...prev, { mimeType: file.type, base64, previewUrl: URL.createObjectURL(file) }]);
      };
      reader.readAsDataURL(file);
    });
    if (e.target) e.target.value = "";
  }

  function removeImage(idx: number) {
    setPendingImages(prev => prev.filter((_, i) => i !== idx));
  }

  function newManual() {
    setMessages([]);
    setInput("");
    setPendingImages([]);
    setContent("");
    setSlidesHtml([]);
    setGeneratedTheme("");
    setNotice("");
  }

  async function sendMessage() {
    const text = input.trim();
    if ((!text && pendingImages.length === 0) || loading) return;
    if (!GEMINI_API_KEY) {
      setNotice("NEXT_PUBLIC_GEMINI_API_KEY が設定されていません");
      return;
    }

    const userMsg: ManualMessage = {
      role: "user",
      text,
      images: pendingImages.length > 0 ? pendingImages : undefined,
    };
    const newHistory = [...messages, userMsg];
    setMessages(newHistory);
    setInput("");
    setPendingImages([]);
    setLoading(true);
    setNotice("");

    const isFirstMessage = messages.length === 0;
    const currentOutputType = isFirstMessage ? outputType : generatedOutputType;

    if (isFirstMessage) {
      setContent("");
      setSlidesHtml([]);
      setGeneratedOutputType(outputType);
      setGeneratedTheme(text.slice(0, 40));
    }

    const contents = toGeminiContents(messages, text, userMsg.images ?? []);

    try {
      if (currentOutputType === "slide") {
        setNotice("スライドを生成中…");
        const slides = await generateSlideJson(GEMINI_FLASH_MODEL, contents, SLIDE_SYS_PROMPT);
        setSlidesHtml(slides);
        const modelMsg: ManualMessage = {
          role: "model",
          text: `スライドを${slides.length}枚生成しました。修正があればお知らせください。`,
        };
        setMessages([...newHistory, modelMsg]);
        setNotice("");
      } else {
        let accumulated = "";
        await streamGenerate(GEMINI_FLASH_MODEL, WORD_SYS_PROMPT, contents, (chunk) => {
          accumulated = chunk;
          setContent(chunk);
        });
        const modelMsg: ManualMessage = {
          role: "model",
          text: accumulated,
          displayText: "✓ マニュアルを生成・更新しました。修正があればお知らせください。",
        };
        setMessages([...newHistory, modelMsg]);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "生成に失敗しました");
    } finally {
      setLoading(false);
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
      a.href = url; a.download = `${generatedTheme}.docx`; a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "ダウンロードに失敗しました");
    }
  }

  function openSlidePreview(src: string) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([src], { type: "text/html;charset=utf-8" }));
    a.target = "_blank"; a.rel = "noopener"; a.click();
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
                document.removeEventListener("visibilitychange", fn); resolve();
              }
            };
            document.addEventListener("visibilitychange", fn);
          });
        }
        setNotice(`PPTX 生成中… ${i + 1} / ${slidesHtml.length} このタブから離れないでください`);
        container.innerHTML = slidesHtml[i];
        const el = container.firstElementChild as HTMLElement | null;
        if (!el) continue;
        el.style.width = "960px"; el.style.height = "540px";
        const dataUrl = await toPng(el, { width: 960, height: 540, pixelRatio: 1, fontEmbedCSS: "" });
        const slide = prs.addSlide();
        slide.addImage({ data: dataUrl, x: 0, y: 0, w: "100%", h: "100%" });
      }
      document.body.removeChild(container);
      setNotice("");
      const blob = await prs.write({ outputType: "blob" }) as Blob;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `${generatedTheme}.pptx`; a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "PPTX 生成に失敗しました");
    }
  }

  return (
    <section className="panel" style={{ display: "flex", flexDirection: "row", flex: 1, minHeight: 0, width: "100%" }}>
      {/* ── 左: 指示チャット ── */}
      <div style={{ width: 400, flexShrink: 0, display: "flex", flexDirection: "column", borderRight: "1px solid var(--line)" }}>
        {/* ヘッダー */}
        <div className="panel-head">
          <div className="row" style={{ gap: 8 }}>
            <FileText size={16} style={{ color: "var(--navy)" }} aria-hidden="true" />
            <span className="panel-title">マニュアル作成</span>
          </div>
          <div className="row" style={{ gap: 6 }}>
            {/* 新規マニュアル */}
            <button
              type="button"
              onClick={newManual}
              title="新しいマニュアル"
              style={{ width: 28, height: 28, border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, color: "var(--ink-soft)", display: "flex", alignItems: "center", justifyContent: "center" }}
            >
              <Plus size={15} aria-hidden="true" />
            </button>
            {/* チャットモードへ */}
            {onSwitchMode ? (
              <button
                type="button"
                onClick={onSwitchMode}
                title="チャットモードへ"
                style={{ width: 28, height: 28, border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, color: "var(--ink-soft)", display: "flex", alignItems: "center", justifyContent: "center" }}
              >
                <MessageCircle size={15} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>

        {/* メッセージ一覧 */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px", display: "flex", flexDirection: "column", gap: 12 }}>
          {messages.length === 0 && !loading ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "var(--ink-faint)", padding: 24 }}>
              <Sparkles size={28} strokeWidth={1.2} aria-hidden="true" />
              <p style={{ margin: 0, fontSize: 13, textAlign: "center", lineHeight: 1.8 }}>
                作成したいマニュアルを<br />自由に入力してください<br />
                <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>画像の添付にも対応しています</span>
              </p>
            </div>
          ) : (
            messages.map((msg, i) => {
              if (msg.role === "user") {
                return (
                  <div key={i} style={{ display: "flex", justifyContent: "flex-end" }}>
                    <div style={{ maxWidth: "85%", display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-end" }}>
                      {msg.images && msg.images.length > 0 ? (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
                          {msg.images.map((img, j) => (
                            <img key={j} src={img.previewUrl} alt="" style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: "1px solid var(--line)" }} />
                          ))}
                        </div>
                      ) : null}
                      {msg.text ? (
                        <div style={{ background: "var(--navy-deep)", color: "#f5efe1", borderRadius: "14px 14px 4px 14px", padding: "10px 14px", fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
                          {msg.text}
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              }
              return (
                <div key={i} style={{ display: "flex", justifyContent: "flex-start" }}>
                  <div style={{ maxWidth: "90%", background: "#f0f4f8", borderRadius: "4px 14px 14px 14px", padding: "10px 14px", fontSize: 13, lineHeight: 1.7, color: "var(--ink-soft)" }}>
                    {msg.displayText ?? msg.text}
                  </div>
                </div>
              );
            })
          )}
          {loading ? (
            <div className="row" style={{ color: "var(--ink-muted)", fontSize: 13 }}>
              <span className="dot ok" style={{ animation: "pulse 1.2s infinite" }} />
              {notice || "生成中…"}
            </div>
          ) : null}
          {notice && !loading ? (
            <p className="tag accent" style={{ alignSelf: "flex-start" }}>{notice}</p>
          ) : null}
          <div ref={messagesEndRef} />
        </div>

        {/* 画像サムネイルプレビュー */}
        {pendingImages.length > 0 ? (
          <div style={{ padding: "8px 12px", borderTop: "1px solid var(--line-soft)", display: "flex", gap: 8, flexWrap: "wrap", background: "var(--surface, #fafafa)" }}>
            {pendingImages.map((img, i) => (
              <div key={i} style={{ position: "relative" }}>
                <img src={img.previewUrl} alt="" style={{ width: 52, height: 52, objectFit: "cover", borderRadius: 8, border: "1px solid var(--line)" }} />
                <button
                  type="button"
                  onClick={() => removeImage(i)}
                  style={{ position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: "50%", background: "var(--navy-deep)", color: "#fff", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
                >
                  <X size={10} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {/* 入力エリア */}
        <div style={{ padding: 12, borderTop: "1px solid var(--line)", background: "var(--panel-deep)", borderBottomLeftRadius: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 8, alignItems: "stretch" }}>
            <button
              type="button"
              onClick={() => imageInputRef.current?.click()}
              title="画像を添付"
              style={{ width: 44, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, border: "1px solid var(--line)", borderRadius: "var(--radius)", background: "transparent", cursor: "pointer", color: "var(--ink-soft)", fontSize: 10, letterSpacing: "0.1em", fontWeight: 500 }}
            >
              <Plus size={16} aria-hidden="true" />
              <span>画像</span>
            </button>
            <input
              type="file"
              accept="image/*"
              multiple
              hidden
              ref={imageInputRef}
              onChange={handleImageAttach}
            />
            <textarea
              className="textarea"
              rows={3}
              placeholder="マニュアル作成の指示を入力…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              disabled={loading}
              style={{ resize: "none" }}
            />
            <Button
              onClick={sendMessage}
              disabled={loading || (!input.trim() && pendingImages.length === 0)}
              style={{ height: "auto", paddingLeft: 16, paddingRight: 16, flexDirection: "column", gap: 4 }}
            >
              <Send size={16} aria-hidden="true" />
              送信
            </Button>
          </div>
          <div className="tiny soft" style={{ marginTop: 6, letterSpacing: "0.06em" }}>⌘ + Enter で送信</div>
        </div>
      </div>

      {/* ── 右: プレビュー ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div className="panel-head">
          {/* 出力形式セレクター（生成前は選択可、生成後は表示のみ） */}
          <div style={{ display: "flex", border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
            {(["word", "slide"] as const).map(type => {
              const isActive = (messages.length === 0 ? outputType : generatedOutputType) === type;
              const canSwitch = messages.length === 0 && !loading;
              return (
                <button
                  key={type}
                  type="button"
                  onClick={() => { if (canSwitch) setOutputType(type); }}
                  title={type === "word" ? "Word文書として生成" : "PowerPointスライドとして生成"}
                  style={{
                    padding: "5px 14px",
                    fontSize: 12,
                    fontWeight: isActive ? 600 : 400,
                    background: isActive ? "var(--navy)" : "transparent",
                    color: isActive ? "#fff" : "var(--ink-soft)",
                    border: 0,
                    cursor: canSwitch ? "pointer" : "default",
                    opacity: !canSwitch && !isActive ? 0.4 : 1,
                    display: "flex",
                    alignItems: "center",
                    gap: 5,
                  }}
                >
                  {type === "word" ? (
                    <><FileText size={12} aria-hidden="true" />Word文書</>
                  ) : (
                    <><ExternalLink size={12} aria-hidden="true" />スライド</>
                  )}
                </button>
              );
            })}
          </div>

          <div className="row" style={{ gap: 6 }}>
            {!loading && generatedOutputType === "word" && content ? (
              <Button
                variant="secondary"
                onClick={downloadDocx}
                style={{ gap: 5, fontSize: 12, paddingLeft: 12, paddingRight: 12, height: 30 }}
              >
                <Download size={13} aria-hidden="true" />Word (.docx)
              </Button>
            ) : null}
            {!loading && generatedOutputType === "slide" && slidesHtml.length > 0 ? (
              <>
                <Button
                  variant="ghost"
                  onClick={() => openSlidePreview(slideIframeSrc)}
                  style={{ gap: 5, fontSize: 12, paddingLeft: 12, paddingRight: 12, height: 30 }}
                >
                  <ExternalLink size={13} aria-hidden="true" />別タブで開く
                </Button>
                <Button
                  variant="secondary"
                  onClick={downloadPptx}
                  style={{ gap: 5, fontSize: 12, paddingLeft: 12, paddingRight: 12, height: 30 }}
                >
                  <Download size={13} aria-hidden="true" />PowerPoint (.pptx)
                </Button>
              </>
            ) : null}
          </div>
        </div>

        {/* プレビューコンテンツ */}
        {loading && !content && slidesHtml.length === 0 ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, color: "var(--ink-faint)" }}>
            <span className="dot ok" style={{ width: 10, height: 10, animation: "pulse 1.2s infinite" }} />
            <p style={{ margin: 0, fontSize: 13, color: "var(--ink-muted)" }}>{notice || "生成中…"}</p>
          </div>
        ) : generatedOutputType === "slide" && slidesHtml.length > 0 ? (
          <iframe
            key={slideIframeSrc.length}
            srcDoc={slideIframeSrc}
            style={{ flex: 1, width: "100%", border: "none", minHeight: 500 }}
            title="スライドプレビュー"
          />
        ) : (
          <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
            {content ? (
              <>
                {generatedTheme ? (
                  <h1 style={{ fontFamily: "var(--serif)", fontSize: 18, fontWeight: 700, color: "var(--navy-deep)", marginBottom: 20, marginTop: 0 }}>
                    {generatedTheme}
                  </h1>
                ) : null}
                <div className="prose">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
                </div>
              </>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 14, color: "var(--ink-faint)", padding: 32 }}>
                {outputType === "word" ? (
                  <FileText size={36} strokeWidth={1.2} aria-hidden="true" />
                ) : (
                  <ExternalLink size={36} strokeWidth={1.2} aria-hidden="true" />
                )}
                <p style={{ margin: 0, fontSize: 13, textAlign: "center", lineHeight: 1.9 }}>
                  {outputType === "word"
                    ? <>上で <strong style={{ color: "var(--navy)" }}>Word文書</strong> が選択されています<br />左のチャットでマニュアルの内容を指示してください</>
                    : <>上で <strong style={{ color: "var(--navy)" }}>PowerPointスライド</strong> が選択されています<br />左のチャットでスライドの内容を指示してください</>
                  }
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
