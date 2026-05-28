"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronLeft, ChevronRight, Download, ExternalLink, FileText, MessageCircle, MoreHorizontal, Plus, Send, Sparkles, Wrench, X } from "lucide-react";
import { Button } from "@/components/ui";

const GEMINI_FLASH_MODEL = "gemini-2.5-flash";

// ── Types ─────────────────────────────────────────────────────────────────────

type GeminiPart = { text: string } | { inlineData: { mimeType: string; data: string } };
type GeminiContent = { role: "user" | "model"; parts: GeminiPart[] };

type ImageMode = "reference" | "embed";
type PlacementMode = "ai" | "user";

type ManualImagePart = {
  mimeType: string;
  base64: string;
  previewUrl: string;
  mode: ImageMode;
  imageIndex?: number;
  placement?: string;
  storageKey: string;  // S3保存用UUID
  s3Key?: string;      // S3アップロード完了後に設定
};

type ManualImageRefStored = {
  mimeType: string; mode: ImageMode;
  imageIndex?: number; placement?: string;
  storageKey?: string; s3Key?: string;
};
type ManualMessageStored = {
  role: "user" | "model"; text: string; displayText?: string;
  images?: ManualImageRefStored[];
};
type ManualSession = {
  id: string; title: string; type: "manual";
  outputType: "word" | "slide"; generatedTheme: string;
  content: string; slidesHtml: string[];
  messages: ManualMessageStored[];
};

type PendingDoc = { name: string; type: string; base64: string };

type ManualMessage = {
  role: "user" | "model";
  text: string;
  displayText?: string;
  images?: ManualImagePart[];
  docNames?: string[];
};

type UploadQueue = {
  rawFiles: { base64: string; previewUrl: string; mimeType: string }[];
  step: 1 | 2;
  mode: ImageMode | null;
  placementMode: PlacementMode | null;
  placementText: string;
};

type SessionSummary = { id: string; title: string; type?: "chat" | "manual" };

// ── Gemini API helpers ────────────────────────────────────────────────────────

async function streamGenerate(
  model: string,
  systemPrompt: string,
  contents: GeminiContent[],
  onChunk: (accumulated: string) => void
): Promise<void> {
  const res = await fetch("/api/manual-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model, systemPrompt, contents,
      generationConfig: { maxOutputTokens: 65536, temperature: 0.3 },
    }),
  });
  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => "");
    if (res.status === 503) throw new Error("Gemini APIが混雑しています。しばらく待ってから再試行してください。");
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
        const parsed = JSON.parse(json) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
        if (text) { accumulated += text; onChunk(accumulated); }
      } catch {}
    }
  }
}

async function generateSlidesStreaming(
  model: string,
  contents: GeminiContent[],
  systemPrompt: string,
  onProgress: (notice: string) => void
): Promise<string[]> {
  const res = await fetch("/api/manual-stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model, systemPrompt, contents,
      generationConfig: { maxOutputTokens: 65536, temperature: 0.4 },
    }),
  });
  if (!res.ok || !res.body) {
    const errText = await res.text().catch(() => "");
    if (res.status === 503) throw new Error("gemini-2.5-flash が混雑しています。しばらく待ってから再試行してください。");
    throw new Error(`Gemini API エラー ${res.status} (${model}): ${errText}`);
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
        const parsed = JSON.parse(json) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
        if (text) {
          accumulated += text;
          const count = (accumulated.match(/===SLIDE_\d+===/g) ?? []).length;
          if (count > 0) onProgress(`スライドを生成中… ${count} 枚`);
        }
      } catch {}
    }
  }
  // ===SLIDE_N=== デリミタで分割して各スライドの <div> を抽出
  const slides: string[] = [];
  const segments = accumulated.split(/===SLIDE_\d+===/);
  for (const seg of segments) {
    const trimmed = seg.trim();
    const match = trimmed.match(/<div[\s\S]*<\/div>/);
    if (match) slides.push(match[0]);
  }
  return slides;
}

async function generateSingleSlideStreaming(
  model: string,
  contents: GeminiContent[],
  systemPrompt: string
): Promise<string> {
  let accumulated = "";
  await streamGenerate(model, systemPrompt, contents, text => { accumulated = text; });
  const match = accumulated.match(/<div[\s\S]*<\/div>/);
  return match ? match[0] : accumulated.trim();
}

// ── Slide helpers ─────────────────────────────────────────────────────────────

function injectEmbeddedImages(
  html: string,
  imageMap: Map<number, { base64: string; mimeType: string }>
): string {
  if (imageMap.size === 0) return html;
  return html.replace(/<div[^>]*data-image="(\d+)"[^>]*><\/div>/gi, (_, n) => {
    const img = imageMap.get(Number(n));
    if (!img) return "";
    return `<img src="data:${img.mimeType};base64,${img.base64}" style="max-width:100%;max-height:100%;object-fit:contain;display:block;" />`;
  });
}

function buildSlideIframeHtml(slides: string[], slideTheme: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!DOCTYPE html>
<html lang="ja"><head>
<meta charset="utf-8"><title>${esc(slideTheme)}</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@300;400;500;700&family=Noto+Serif+JP:wght@700&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#111827;padding:20px 0 40px;display:flex;flex-direction:column;align-items:flex-start}.sw{flex-shrink:0;margin-bottom:0}</style>
</head><body>${slides.map(html => `<div class="sw">${html}</div>`).join("\n")}
<script>(function(){function fit(){var w=window.innerWidth,s=Math.min(w/960,1),ml=Math.max((w-960*s)/2,0);document.querySelectorAll('.sw').forEach(function(wrap){var el=wrap.firstElementChild;if(!el)return;el.style.transform='scale('+s+')';el.style.transformOrigin='top left';el.style.display='block';wrap.style.width=(960*s)+'px';wrap.style.height=(540*s+24)+'px';wrap.style.marginLeft=ml+'px';});}window.addEventListener('resize',fit);fit();})();</script>
</body></html>`;
}

// ── Prompts ───────────────────────────────────────────────────────────────────

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
  "画像の取り扱い:",
  "- 参考画像: 内容生成の参考としてください",
  "- 埋め込み画像(IMAGE_N): 指定された場所（またはAIが判断した最適な場所）に [IMAGE_N] と記述してください。",
  "  修正時も既存の [IMAGE_N] マーカーを維持してください。",
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
  "【出力形式】各スライドを ===SLIDE_N===（N=1〜12）で区切り、その直後に <div ...>...</div> を出力してください。JSONではなくプレーンテキストで出力してください。",
  "画像の取り扱い:",
  "- 参考画像: 内容生成の参考としてください",
  "- 埋め込み画像IMAGE_N: NをそのままINDEXに使い <div data-image=\"INDEX\" style=\"position:absolute;max-width:44%;max-height:44%;overflow:hidden;\"></div> を挿入する。例: IMAGE_0 → data-image=\"0\"、IMAGE_1 → data-image=\"1\"",
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
  "【構成（必ず12枚・以下の順番を厳守）】",
  "1枚目: タイトルスライド（ネイビー背景、テーマを大きく）",
  "2枚目: 1. 病気の解説",
  "3枚目: 2. 原因",
  "4枚目: 3. 病態・所見",
  "5枚目: 4. 患者の訴え・臨床所見",
  "6枚目: 5. 当日の処置・応急処置",
  "7枚目: 6. 治療法",
  "8枚目: 7. 治療の具体的なステップ",
  "9枚目: 8. 治療中に確認するチェックリスト（チェックボックス付き箇条書き形式）",
  "10枚目: 9. 予後・術後のメンテナンス",
  "11枚目: 10. その他注意すべきこと",
  "12枚目: まとめ・重要ポイント",
  "※各スライドの見出しには必ず上記の番号と項目名を含めること。構成を省略・並び替え・統合しないこと。",
].join("\n");

const SLIDE_EDIT_SYS_PROMPT = [
  "あなたは視覚表現に優れたUIデザイナー兼歯科医療専門家です。",
  "渡されたHTMLスライドを修正指示に従って修正し、1枚分の修正済みHTMLスライドを返してください。",
  "【仕様（維持すること）】",
  ...SLIDE_SPEC_LINES,
].join("\n");

function buildSlideRegenSysPrompt(currentCount: number): string {
  return [
    "あなたは視覚表現に優れたUIデザイナー兼歯科医療専門家です。",
    "ユーザーの指示に従い、スライドを再生成してください。",
    "修正指示がある場合は全スライドを再生成してください。",
    `現在のスライド枚数: ${currentCount}枚`,
    "スライド枚数はユーザーの指示に従ってください。枚数の指定がない場合は現在の枚数を維持してください。勝手に増減しないこと。",
    "【出力形式】各スライドを ===SLIDE_N===（N=1から連番）で区切り、その直後に <div ...>...</div> を出力してください。JSONではなくプレーンテキストで出力してください。",
    "画像の取り扱い:",
    "- 参考画像: 内容生成の参考としてください",
    "- 埋め込み画像IMAGE_N: NをそのままINDEXに使い <div data-image=\"INDEX\" style=\"position:absolute;max-width:44%;max-height:44%;overflow:hidden;\"></div> を挿入する",
    "",
    "【各スライドの仕様】",
    ...SLIDE_SPEC_LINES,
    "",
    "【使えるビジュアル表現（自由に組み合わせてよい）】",
    "SVGフローチャート / SVGタイムライン / SVG棒グラフ・円グラフ / 2カラム比較レイアウト",
    "/ グリッドカード / HTMLテーブル / チェックリスト / SVGアイコン付き説明カード / SVG警告バナー",
    "→ 同じ種類を連続して使わず、各スライドの内容に最も適したビジュアルを自律的に選ぶこと",
    "→ テキストの羅列にしないこと。必ず何らかのビジュアル要素を含める",
  ].join("\n");
}

// ── Gemini contents builder ───────────────────────────────────────────────────

// 履歴なし・1ターン構成。編集時は docContext に現在のドキュメントを渡す。
function buildContents(
  userText: string,
  userImages: ManualImagePart[],
  resolvedDocs?: { name: string; type: string; base64?: string; text?: string }[],
  docContext?: string
): GeminiContent[] {
  const text = docContext
    ? `【現在のコンテンツ】\n${docContext}\n\n【指示】\n${userText || " "}`
    : (userText || " ");
  const parts: GeminiPart[] = [{ text }];
  userImages.forEach(img => parts.push({ inlineData: { mimeType: img.mimeType, data: img.base64 } }));
  resolvedDocs?.forEach(doc => {
    if (doc.type === "application/pdf" && doc.base64) {
      parts.push({ inlineData: { mimeType: "application/pdf", data: doc.base64 } });
    } else if (doc.text) {
      parts.push({ text: `\n[添付ファイル: ${doc.name}]\n${doc.text}` });
    }
  });
  return [{ role: "user", parts }];
}

// ── Chip style ────────────────────────────────────────────────────────────────

const chipStyle = (active: boolean): React.CSSProperties => ({
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  minWidth: 28, height: 26, padding: "0 6px",
  border: `1.5px solid ${active ? "var(--navy)" : "var(--line)"}`,
  borderRadius: 6,
  background: active ? "var(--navy)" : "transparent",
  color: active ? "#fff" : "var(--ink-soft)",
  fontSize: 11, fontWeight: active ? 600 : 400,
  cursor: "pointer", flexShrink: 0, transition: "all .12s ease",
});

// ── Component ─────────────────────────────────────────────────────────────────

export function ManualGeneratorPanel({ onSwitchMode, initialSessionId, onLoadChatSession }: {
  onSwitchMode?: () => void;
  initialSessionId?: string | null;
  onLoadChatSession?: (id: string) => void;
}) {
  const [messages, setMessages] = useState<ManualMessage[]>([]);
  const [input, setInput] = useState("");
  const [pendingImages, setPendingImages] = useState<ManualImagePart[]>([]);
  const [pendingDocs, setPendingDocs] = useState<PendingDoc[]>([]);
  const [uploadQueue, setUploadQueue] = useState<UploadQueue | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // Sidebar / session list
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  const [outputType, setOutputType] = useState<"word" | "slide">("word");
  const [generatedOutputType, setGeneratedOutputType] = useState<"word" | "slide">("word");
  const [editSelectedSlides, setEditSelectedSlides] = useState<number[]>([]);

  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [content, setContent] = useState("");
  const [slidesHtml, setSlidesHtml] = useState<string[]>([]);
  const [generatedTheme, setGeneratedTheme] = useState("");

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const embedCounterRef = useRef(0);
  const sessionIdRef = useRef<string>(initialSessionId ?? crypto.randomUUID());

  // 埋め込み画像マップ: imageIndex → data URI（プレビューとDOCX共通で使用）
  const embeddedImageMap = useMemo(() => {
    const map = new Map<number, { base64: string; mimeType: string }>();
    messages.forEach(msg =>
      (msg.images ?? []).forEach(img => {
        if (img.mode === "embed" && img.imageIndex !== undefined)
          map.set(img.imageIndex, { base64: img.base64, mimeType: img.mimeType });
      })
    );
    return map;
  }, [messages]);

  // Word プレビュー用: [IMAGE_N] でコンテンツを分割して描画用データを作る
  const wordPreviewParts = useMemo(() => {
    if (!content) return [];
    const segments = content.split(/\[IMAGE_(\d+)\]/);
    return segments.map((seg, i) => {
      if (i % 2 === 1) {
        // キャプチャグループ = N の数値
        const img = embeddedImageMap.get(Number(seg));
        return { type: "image" as const, n: seg, img };
      }
      return { type: "text" as const, text: seg };
    });
  }, [content, embeddedImageMap]);

  // スライドプレビュー用: data-image プレースホルダーを実画像に置換
  const slideIframeSrc = useMemo(() => {
    if (!slidesHtml.length) return "";
    const processed = slidesHtml.map(html => injectEmbeddedImages(html, embeddedImageMap));
    return buildSlideIframeHtml(processed, generatedTheme);
  }, [slidesHtml, generatedTheme, embeddedImageMap]);

  useEffect(() => {
    fetch("/api/chat-sessions")
      .then(r => r.json())
      .then((data: { sessions: SessionSummary[] }) => {
        setSessions(data.sessions ?? []);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // ── Image upload flow ─────────────────────────────────────────────────────

  function attachImages(imageFiles: File[]) {
    if (imageFiles.length === 0) return;
    Promise.all(
      imageFiles.map(file =>
        new Promise<{ base64: string; previewUrl: string; mimeType: string }>(resolve => {
          const reader = new FileReader();
          reader.onload = () => resolve({
            base64: (reader.result as string).split(",")[1],
            previewUrl: URL.createObjectURL(file),
            mimeType: file.type,
          });
          reader.readAsDataURL(file);
        })
      )
    ).then(rawFiles => {
      setUploadQueue({ rawFiles, step: 1, mode: null, placementMode: null, placementText: "" });
    });
  }

  function handleFileAttach(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (e.target) e.target.value = "";
    attachImages(files.filter(f => f.type.startsWith("image/")));
    handleDocAttach(files.filter(f =>
      f.type === "application/pdf" ||
      f.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ));
  }

  function handleDocAttach(files: File[]) {
    if (files.length === 0) return;
    Promise.all(
      files.map(file =>
        new Promise<PendingDoc>(resolve => {
          const reader = new FileReader();
          reader.onload = () => resolve({
            name: file.name,
            type: file.type,
            base64: (reader.result as string).split(",")[1],
          });
          reader.readAsDataURL(file);
        })
      )
    ).then(docs => setPendingDocs(prev => [...prev, ...docs]));
  }

  function removeDoc(idx: number) {
    setPendingDocs(prev => prev.filter((_, i) => i !== idx));
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setIsDragOver(false);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    const files = e.dataTransfer.files;
    if (!files.length) return;

    const imageFiles = Array.from(files).filter(f => f.type.startsWith("image/"));
    const docFiles = Array.from(files).filter(f =>
      f.type === "application/pdf" ||
      f.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );

    attachImages(imageFiles);
    handleDocAttach(docFiles);
  }

  function confirmUpload() {
    if (!uploadQueue || !uploadQueue.mode) return;
    if (uploadQueue.mode === "embed" && uploadQueue.placementMode === null) return;

    const startIndex = embedCounterRef.current;
    const newImages: ManualImagePart[] = uploadQueue.rawFiles.map((raw, i) => ({
      mimeType: raw.mimeType,
      base64: raw.base64,
      previewUrl: raw.previewUrl,
      mode: uploadQueue.mode!,
      imageIndex: uploadQueue.mode === "embed" ? startIndex + i : undefined,
      placement:
        uploadQueue.mode === "embed" && uploadQueue.placementMode === "user" && uploadQueue.placementText.trim()
          ? uploadQueue.placementText.trim()
          : undefined,
      storageKey: crypto.randomUUID(),
    }));

    if (uploadQueue.mode === "embed") embedCounterRef.current += uploadQueue.rawFiles.length;
    setPendingImages(prev => [...prev, ...newImages]);
    setUploadQueue(null);

    // S3へバックグラウンドアップロード
    newImages.forEach(img => {
      uploadImageToS3(img).then(s3Key => {
        if (s3Key) updateImageS3Key(img.storageKey, s3Key);
      });
    });
  }

  function removeImage(idx: number) {
    setPendingImages(prev => prev.filter((_, i) => i !== idx));
  }

  // ── Slide chips ───────────────────────────────────────────────────────────

  function toggleSlideChip(i: number) {
    setEditSelectedSlides(cur => cur.includes(i) ? cur.filter(x => x !== i) : [...cur, i]);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  function newManual() {
    sessionIdRef.current = crypto.randomUUID();
    setCurrentSessionId(null);
    setMessages([]); setInput(""); setPendingImages([]); setPendingDocs([]); setUploadQueue(null);
    setContent(""); setSlidesHtml([]); setGeneratedTheme(""); setNotice("");
    setEditSelectedSlides([]);
    embedCounterRef.current = 0;
  }

  // ── S3 image upload ──────────────────────────────────────────────────────

  async function uploadImageToS3(img: ManualImagePart): Promise<string | null> {
    try {
      const { uploadUrl, s3Key } = await fetch("/api/manual-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "upload", sessionId: sessionIdRef.current, storageKey: img.storageKey, mimeType: img.mimeType }),
      }).then(r => r.json()) as { uploadUrl: string; s3Key: string };
      const blob = await fetch(`data:${img.mimeType};base64,${img.base64}`).then(r => r.blob());
      await fetch(uploadUrl, { method: "PUT", body: blob, headers: { "Content-Type": img.mimeType } });
      return s3Key;
    } catch { return null; }
  }

  function updateImageS3Key(storageKey: string, s3Key: string) {
    const updater = (imgs: ManualImagePart[]) =>
      imgs.map(img => img.storageKey === storageKey ? { ...img, s3Key } : img);
    setPendingImages(updater);
    setMessages(prev => prev.map(msg => ({
      ...msg,
      images: msg.images ? updater(msg.images) : undefined,
    })));
  }

  // ── Session persistence ──────────────────────────────────────────────────

  function saveSession(opts: {
    msgs: ManualMessage[]; body: string; slides: string[];
    outType: "word" | "slide"; theme: string;
  }) {
    const id = sessionIdRef.current;
    const title = opts.theme || opts.msgs.find(m => m.role === "user")?.text?.slice(0, 30) || "マニュアル";
    const storedMsgs: ManualMessageStored[] = opts.msgs.map(msg => ({
      role: msg.role, text: msg.text,
      ...(msg.displayText ? { displayText: msg.displayText } : {}),
      ...(msg.images?.length ? {
        images: msg.images.map(({ mimeType, mode, imageIndex, placement, storageKey, s3Key }) => ({
          mimeType, mode,
          ...(imageIndex !== undefined ? { imageIndex } : {}),
          ...(placement ? { placement } : {}),
          ...(storageKey ? { storageKey } : {}),
          ...(s3Key ? { s3Key } : {}),
        }))
      } : {}),
    }));
    const session: ManualSession = {
      id, title, type: "manual",
      outputType: opts.outType, generatedTheme: opts.theme,
      content: opts.body, slidesHtml: opts.slides, messages: storedMsgs,
    };
    fetch(`/api/chat-sessions/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(session),
    }).catch(console.error);
    setSessions(prev => {
      const exists = prev.some(s => s.id === id);
      if (exists) return prev.map(s => s.id === id ? { ...s, title } : s);
      return [{ id, title, type: "manual" as const satisfies SessionSummary["type"] }, ...prev];
    });
    setCurrentSessionId(id);
  }

  // ── Session load ─────────────────────────────────────────────────────────

  useEffect(() => {
    if (!initialSessionId) return;
    sessionIdRef.current = initialSessionId;
    setCurrentSessionId(initialSessionId);
    (async () => {
      setLoading(true);
      setNotice("読み込み中…");
      try {
        const res = await fetch(`/api/chat-sessions/${initialSessionId}`);
        if (!res.ok) throw new Error("not found");
        const session = await res.json() as ManualSession;
        setContent(session.content ?? "");
        setSlidesHtml(session.slidesHtml ?? []);
        setGeneratedOutputType(session.outputType ?? "word");
        setOutputType(session.outputType ?? "word");
        setGeneratedTheme(session.generatedTheme ?? "");

        const restoredMsgs: ManualMessage[] = await Promise.all(
          (session.messages ?? []).map(async msg => {
            if (!msg.images?.length) return msg as ManualMessage;
            const images = await Promise.all(msg.images.map(async ref => {
              const base = {
                mimeType: ref.mimeType, mode: ref.mode,
                imageIndex: ref.imageIndex, placement: ref.placement,
                storageKey: ref.storageKey ?? crypto.randomUUID(),
                s3Key: ref.s3Key,
              };
              if (!ref.s3Key) return { ...base, base64: "", previewUrl: "" } as ManualImagePart;
              try {
                const { url } = await fetch("/api/manual-images", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ action: "download", s3Key: ref.s3Key }),
                }).then(r => r.json()) as { url: string };
                const blob = await fetch(url).then(r => r.blob());
                const base64 = await new Promise<string>(resolve => {
                  const reader = new FileReader();
                  reader.onload = () => resolve((reader.result as string).split(",")[1]);
                  reader.readAsDataURL(blob);
                });
                return { ...base, base64, previewUrl: URL.createObjectURL(blob) } as ManualImagePart;
              } catch { return { ...base, base64: "", previewUrl: "" } as ManualImagePart; }
            }));
            return { ...msg, images } as ManualMessage;
          })
        );
        setMessages(restoredMsgs);
        setNotice("");
      } catch {
        setNotice("セッションの読み込みに失敗しました");
      } finally {
        setLoading(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSessionId]);

  async function loadSessionById(id: string) {
    if (id === sessionIdRef.current && messages.length > 0) return;
    if (loading) return;
    setLoading(true);
    setNotice("読み込み中…");
    try {
      const res = await fetch(`/api/chat-sessions/${id}`);
      if (!res.ok) throw new Error("not found");
      const session = await res.json() as ManualSession;
      sessionIdRef.current = id;
      setCurrentSessionId(id);
      setContent(session.content ?? "");
      setSlidesHtml(session.slidesHtml ?? []);
      setGeneratedOutputType(session.outputType ?? "word");
      setOutputType(session.outputType ?? "word");
      setGeneratedTheme(session.generatedTheme ?? "");
      setEditSelectedSlides([]);
      embedCounterRef.current = 0;
      const restoredMsgs: ManualMessage[] = await Promise.all(
        (session.messages ?? []).map(async msg => {
          if (!msg.images?.length) return msg as ManualMessage;
          const images = await Promise.all(msg.images.map(async ref => {
            const base = {
              mimeType: ref.mimeType, mode: ref.mode,
              imageIndex: ref.imageIndex, placement: ref.placement,
              storageKey: ref.storageKey ?? crypto.randomUUID(),
              s3Key: ref.s3Key,
            };
            if (!ref.s3Key) return { ...base, base64: "", previewUrl: "" } as ManualImagePart;
            try {
              const { url } = await fetch("/api/manual-images", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "download", s3Key: ref.s3Key }),
              }).then(r => r.json()) as { url: string };
              const blob = await fetch(url).then(r => r.blob());
              const base64 = await new Promise<string>(resolve => {
                const reader = new FileReader();
                reader.onload = () => resolve((reader.result as string).split(",")[1]);
                reader.readAsDataURL(blob);
              });
              return { ...base, base64, previewUrl: URL.createObjectURL(blob) } as ManualImagePart;
            } catch { return { ...base, base64: "", previewUrl: "" } as ManualImagePart; }
          }));
          return { ...msg, images } as ManualMessage;
        })
      );
      setMessages(restoredMsgs);
      setInput("");
      setPendingImages([]);
      setPendingDocs([]);
      setNotice("");
    } catch {
      setNotice("セッションの読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }

  async function deleteSession(id: string) {
    try {
      await fetch(`/api/chat-sessions/${id}`, { method: "DELETE" });
      setSessions(prev => prev.filter(s => s.id !== id));
      if (sessionIdRef.current === id) newManual();
    } catch {
      setNotice("削除に失敗しました");
    }
    setMenuOpenId(null);
  }

  async function renameSession(id: string, title: string) {
    if (!title.trim()) return;
    try {
      await fetch(`/api/chat-sessions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim() }),
      });
      setSessions(prev => prev.map(s => s.id === id ? { ...s, title: title.trim() } : s));
    } catch {
      setNotice("名前の変更に失敗しました");
    }
    setEditingId(null);
    setMenuOpenId(null);
  }

  function getEmbeddedImages(): { imageIndex: number; base64: string; mimeType: string }[] {
    return Array.from(embeddedImageMap.entries()).map(([imageIndex, img]) => ({
      imageIndex, base64: img.base64, mimeType: img.mimeType,
    }));
  }

  // ── Send message ──────────────────────────────────────────────────────────

  async function sendMessage() {
    const text = input.trim();
    if ((!text && pendingImages.length === 0) || loading) return;

    const userMsg: ManualMessage = {
      role: "user",
      text,
      images: pendingImages.length > 0 ? pendingImages : undefined,
      docNames: pendingDocs.length > 0 ? pendingDocs.map(d => d.name) : undefined,
    };
    const newHistory = [...messages, userMsg];
    setMessages(newHistory);
    setInput("");
    setPendingImages([]);
    setLoading(true);
    setNotice("");

    // DOCX はサーバーでテキスト抽出、PDF はそのまま
    const resolvedDocs = await Promise.all(
      pendingDocs.map(async (doc) => {
        if (doc.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
          try {
            const res = await fetch("/api/extract-text", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ data: doc.base64, name: doc.name }),
            });
            const { text: extracted } = (await res.json()) as { text: string };
            return { name: doc.name, type: doc.type, text: extracted };
          } catch {
            return { name: doc.name, type: doc.type, text: `(${doc.name}の読み取りに失敗しました)` };
          }
        }
        return { name: doc.name, type: doc.type, base64: doc.base64 };
      })
    );
    setPendingDocs([]);

    const isFirstMessage = messages.length === 0;
    const currentOutputType = isFirstMessage ? outputType : generatedOutputType;

    if (isFirstMessage) {
      setContent(""); setSlidesHtml([]);
      setGeneratedOutputType(outputType);
      setGeneratedTheme(text.slice(0, 40));
      setEditSelectedSlides([]);
    }

    // 初回のみ院内資料をRAGで取得してコンテキストに注入
    let ragContext = "";
    if (isFirstMessage && text.trim()) {
      try {
        setNotice("院内資料を検索中…");
        const ctxRes = await fetch("/api/manual-context", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: text }),
        });
        const { context, found } = (await ctxRes.json()) as { context: string; found: number };
        if (context) {
          ragContext = context;
          setNotice(`院内資料 ${found}件 を参照して生成します`);
          await new Promise(r => setTimeout(r, 800));
        }
      } catch { /* RAG失敗時は無視してGemini単体で生成 */ }
      setNotice("");
    }

    // Augment user text with embedded image placement instructions
    const embeddedInThisMsg = pendingImages.filter(img => img.mode === "embed");
    let augmentedText = text;
    if (embeddedInThisMsg.length > 0) {
      augmentedText += "\n\n【埋め込み画像の配置指示】\n";
      embeddedInThisMsg.forEach(img => {
        augmentedText += `IMAGE_${img.imageIndex}: ${img.placement ?? "最適な位置に配置してください"}\n`;
      });
    }
    if (ragContext) {
      augmentedText = `【院内ナレッジ資料からの関連情報（この内容を参考に作成してください）】\n${ragContext}\n\n【作成指示】\n${augmentedText}`;
    }

    try {
      if (currentOutputType === "slide") {
        const hasPartialSelection = slidesHtml.length > 0 && editSelectedSlides.length > 0;

        if (hasPartialSelection) {
          // ── 個別スライド修正（並列）──────────────────────────────────────
          const targets = [...editSelectedSlides].sort((a, b) => a - b);
          setNotice(`${targets.map(i => `${i + 1}枚目`).join("・")}を並列修正中…`);

          const results = await Promise.all(
            targets.map(idx => {
              const editPrompt = [
                augmentedText,
                "",
                `【${idx + 1}枚目のスライドHTML】`,
                slidesHtml[idx],
                "",
                "このスライドを修正指示に従って修正した1枚分の <div>...</div> を返してください。",
              ].join("\n");
              return generateSingleSlideStreaming(GEMINI_FLASH_MODEL, buildContents(editPrompt, pendingImages, resolvedDocs), SLIDE_EDIT_SYS_PROMPT)
                .then(html => ({ idx, html }));
            })
          );

          const updated = [...slidesHtml];
          results.forEach(({ idx, html }) => { if (html) updated[idx] = html; });
          const finalMsgs = [...newHistory, { role: "model" as const, text: `${targets.map(i => `${i + 1}枚目`).join("・")}を更新しました。` }];
          setSlidesHtml(updated);
          setEditSelectedSlides([]);
          setMessages(finalMsgs);
          setNotice("");
          saveSession({ msgs: finalMsgs, body: content, slides: updated, outType: currentOutputType, theme: generatedTheme });
        } else {
          // ── 全スライド生成（ストリーミング）──────────────────────────────
          setNotice("スライドを生成中…");
          const theme = isFirstMessage ? text.slice(0, 40) : generatedTheme;
          const slidePrompt = isFirstMessage
            ? SLIDE_SYS_PROMPT
            : buildSlideRegenSysPrompt(slidesHtml.length);
          const slides = await generateSlidesStreaming(
            GEMINI_FLASH_MODEL,
            buildContents(augmentedText, pendingImages, resolvedDocs),
            slidePrompt,
            setNotice
          );
          const finalMsgs = [...newHistory, { role: "model" as const, text: `スライドを${slides.length}枚生成しました。修正があればお知らせください。` }];
          setSlidesHtml(slides);
          setEditSelectedSlides([]);
          setMessages(finalMsgs);
          setNotice("");
          saveSession({ msgs: finalMsgs, body: "", slides, outType: currentOutputType, theme });
        }
      } else {
        // ── Word 文書生成 ─────────────────────────────────────────────────
        const theme = isFirstMessage ? text.slice(0, 40) : generatedTheme;
        const wordContents = buildContents(augmentedText, pendingImages, resolvedDocs, content || undefined);
        let accumulated = "";
        await streamGenerate(GEMINI_FLASH_MODEL, WORD_SYS_PROMPT, wordContents, chunk => {
          accumulated = chunk;
          setContent(chunk);
        });
        const finalMsgs = [...newHistory, { role: "model" as const, text: accumulated, displayText: "✓ マニュアルを生成・更新しました。修正があればお知らせください。" }];
        setMessages(finalMsgs);
        saveSession({ msgs: finalMsgs, body: accumulated, slides: [], outType: currentOutputType, theme });
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "生成に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  // ── Download ──────────────────────────────────────────────────────────────

  async function downloadDocx() {
    if (!content || !generatedTheme) return;
    try {
      const res = await fetch("/api/generate-manual/docx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, theme: generatedTheme, images: getEmbeddedImages() })
      });
      if (!res.ok) throw new Error(`docx エラー ${res.status}`);
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
            const fn = () => { if (document.visibilityState === "visible") { document.removeEventListener("visibilitychange", fn); resolve(); } };
            document.addEventListener("visibilitychange", fn);
          });
        }
        setNotice(`PPTX 生成中… ${i + 1} / ${slidesHtml.length} このタブから離れないでください`);

        // data-image プレースホルダーを実画像に置換してからレンダリング
        const slideHtml = injectEmbeddedImages(slidesHtml[i], embeddedImageMap);

        container.innerHTML = slideHtml;
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

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <section className="panel" style={{ display: "flex", flexDirection: "row", flex: 1, minHeight: 0, width: "100%" }}>

      {/* ── サイドバー（履歴） ── */}
      <div
        style={{
          width: sidebarOpen ? 180 : 40,
          flexShrink: 0,
          borderRight: "1px solid var(--line)",
          display: "flex",
          flexDirection: "column",
          transition: "width 0.2s ease",
          overflow: "hidden",
          background: "var(--panel-deep, #f8f9fa)",
          borderRadius: "16px 0 0 16px",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "10px 6px", borderBottom: "1px solid var(--line)", flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => setSidebarOpen(v => !v)}
            title={sidebarOpen ? "サイドバーを閉じる" : "サイドバーを開く"}
            style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, color: "var(--ink-soft)", flexShrink: 0 }}
          >
            {sidebarOpen ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
          </button>
          {sidebarOpen ? (
            <button
              type="button"
              onClick={newManual}
              title="新しいマニュアル"
              style={{ flex: 1, display: "flex", alignItems: "center", gap: 5, padding: "4px 6px", border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, color: "var(--ink-soft)", fontSize: 12, fontWeight: 500, whiteSpace: "nowrap" }}
            >
              <Plus size={13} aria-hidden="true" />
              新しいマニュアル
            </button>
          ) : null}
        </div>

        {sidebarOpen ? (
          <div style={{ flex: 1, overflowY: "auto", padding: "6px 4px" }}>
            {sessions.length === 0 ? (
              <p style={{ fontSize: 11, color: "var(--ink-muted)", padding: "12px 8px", margin: 0 }}>履歴なし</p>
            ) : (
              sessions.map(session => (
                <div
                  key={session.id}
                  style={{ position: "relative", marginBottom: 1 }}
                  onMouseLeave={() => { if (menuOpenId === session.id) setMenuOpenId(null); }}
                >
                  {editingId === session.id ? (
                    <input
                      autoFocus
                      value={editingTitle}
                      onChange={e => setEditingTitle(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === "Enter") renameSession(session.id, editingTitle);
                        if (e.key === "Escape") { setEditingId(null); setMenuOpenId(null); }
                      }}
                      onBlur={() => renameSession(session.id, editingTitle)}
                      style={{ width: "100%", fontSize: 12, padding: "4px 6px", border: "1px solid var(--navy)", borderRadius: 4, outline: "none", background: "#fff" }}
                    />
                  ) : (
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 4px 6px 8px", borderRadius: 6, background: currentSessionId === session.id ? "var(--navy-tint-soft)" : "transparent", cursor: "pointer" }}
                      onClick={() => {
                        if (session.type === "manual") loadSessionById(session.id);
                        else onLoadChatSession?.(session.id);
                      }}
                    >
                      {session.type === "manual" ? (
                        <Wrench size={11} style={{ flexShrink: 0, color: "var(--ink-faint)" }} aria-hidden="true" />
                      ) : (
                        <MessageCircle size={11} style={{ flexShrink: 0, color: "var(--ink-faint)" }} aria-hidden="true" />
                      )}
                      <span style={{ flex: 1, fontSize: 12, color: currentSessionId === session.id ? "var(--navy)" : "var(--ink-soft)", fontWeight: currentSessionId === session.id ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {session.title}
                      </span>
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); setMenuOpenId(menuOpenId === session.id ? null : session.id); }}
                        style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "transparent", cursor: "pointer", borderRadius: 3, color: "var(--ink-faint)", flexShrink: 0 }}
                      >
                        <MoreHorizontal size={12} aria-hidden="true" />
                      </button>
                    </div>
                  )}
                  {menuOpenId === session.id ? (
                    <div style={{ position: "absolute", right: 0, top: "100%", zIndex: 50, background: "#fff", border: "1px solid var(--line)", borderRadius: 6, boxShadow: "0 4px 12px rgba(0,0,0,.12)", minWidth: 120, padding: "4px 0" }}>
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); setEditingId(session.id); setEditingTitle(session.title); setMenuOpenId(null); }}
                        style={{ width: "100%", textAlign: "left", padding: "6px 12px", fontSize: 12, border: "none", background: "none", cursor: "pointer", color: "var(--ink)" }}
                      >
                        名前を変更
                      </button>
                      <button
                        type="button"
                        onClick={e => { e.stopPropagation(); deleteSession(session.id); }}
                        style={{ width: "100%", textAlign: "left", padding: "6px 12px", fontSize: 12, border: "none", background: "none", cursor: "pointer", color: "#c0392b" }}
                      >
                        削除
                      </button>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          左パネル: 指示チャット
      ══════════════════════════════════════════════════════════════════════ */}
      <div
        style={{ width: 420, flexShrink: 0, display: "flex", flexDirection: "column", borderRight: "1px solid var(--line)", position: "relative" }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDragOver ? (
          <div style={{
            position: "absolute", inset: 0, zIndex: 10, pointerEvents: "none",
            background: "rgba(44,82,130,0.06)",
            border: "2px dashed var(--navy)",
            borderRadius: "16px 0 0 16px",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            <span style={{ color: "var(--navy)", fontSize: 14, fontWeight: 600, letterSpacing: "0.08em" }}>
              ここにドロップして添付
            </span>
          </div>
        ) : null}

        {/* ヘッダー */}
        <div className="panel-head">
          <div className="row" style={{ gap: 8 }}>
            <FileText size={16} style={{ color: "var(--navy)" }} aria-hidden="true" />
            <span className="panel-title">マニュアル作成</span>
          </div>
          <div className="row" style={{ gap: 6 }}>
            {/* 出力形式トグル */}
            <div style={{ display: "flex", border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
              {(["word", "slide"] as const).map(type => {
                const isActive = (messages.length === 0 ? outputType : generatedOutputType) === type;
                const canSwitch = messages.length === 0 && !loading;
                return (
                  <button key={type} type="button"
                    onClick={() => { if (canSwitch) setOutputType(type); }}
                    title={type === "word" ? "Word文書" : "スライド"}
                    style={{ padding: "4px 10px", fontSize: 11, fontWeight: isActive ? 600 : 400, background: isActive ? "var(--navy)" : "transparent", color: isActive ? "#fff" : "var(--ink-soft)", border: 0, cursor: canSwitch ? "pointer" : "default", opacity: !canSwitch && !isActive ? 0.4 : 1 }}
                  >
                    {type === "word" ? "Word" : "Slides"}
                  </button>
                );
              })}
            </div>
            <button type="button" onClick={newManual} title="新しいマニュアル"
              style={{ width: 28, height: 28, border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, color: "var(--ink-soft)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Plus size={15} aria-hidden="true" />
            </button>
            {onSwitchMode ? (
              <button type="button" onClick={onSwitchMode} title="チャットモードへ"
                style={{ width: 28, height: 28, border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, color: "var(--ink-soft)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <MessageCircle size={15} aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>

        {/* メッセージ一覧 */}
        <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          {messages.length === 0 && !loading ? (
            <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "var(--ink-faint)", padding: 24 }}>
              <Sparkles size={28} strokeWidth={1.2} aria-hidden="true" />
              <p style={{ margin: 0, fontSize: 13, textAlign: "center", lineHeight: 1.8 }}>
                作成したいマニュアルを<br />自由に入力してください<br />
                <span style={{ fontSize: 12, color: "var(--ink-muted)" }}>画像・PDF・DOCXの添付にも対応しています</span>
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
                            <div key={j} style={{ position: "relative" }}>
                              <img src={img.previewUrl} alt="" style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 8, border: "1px solid var(--line)" }} />
                              <span style={{ position: "absolute", bottom: 2, left: 2, background: img.mode === "embed" ? "var(--navy)" : "#555", color: "#fff", fontSize: 9, padding: "1px 4px", borderRadius: 3 }}>
                                {img.mode === "embed" ? `埋込 #${img.imageIndex}` : "参考"}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {msg.docNames && msg.docNames.length > 0 ? (
                        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
                          {msg.docNames.map((name, j) => (
                            <span key={j} className="tag" style={{ fontSize: 11 }}>
                              <span className="truncate" style={{ maxWidth: 160 }}>{name}</span>
                            </span>
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

        {/* ── スライドチップ選択（スライド生成後のみ） ── */}
        {generatedOutputType === "slide" && slidesHtml.length > 0 && !loading ? (
          <div style={{ padding: "6px 12px", borderTop: "1px solid var(--line-soft)", display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", background: "var(--surface, #fafafa)" }}>
            <span style={{ fontSize: 11, color: "var(--ink-muted)", flexShrink: 0, marginRight: 2 }}>修正対象:</span>
            <button type="button" onClick={() => setEditSelectedSlides([])} style={chipStyle(editSelectedSlides.length === 0)}>全て</button>
            {slidesHtml.map((_, i) => (
              <button key={i} type="button" onClick={() => toggleSlideChip(i)} style={chipStyle(editSelectedSlides.includes(i))}>{i + 1}</button>
            ))}
          </div>
        ) : null}

        {/* ── 画像アップロード確認パネル ── */}
        {uploadQueue ? (
          <div style={{ margin: "0 12px 8px", padding: 12, background: "#f0f4ff", border: "1px solid var(--navy-tint)", borderRadius: 10 }}>
            {/* サムネイル */}
            <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              {uploadQueue.rawFiles.map((raw, i) => (
                <img key={i} src={raw.previewUrl} alt="" style={{ width: 48, height: 48, objectFit: "cover", borderRadius: 6, border: "1px solid var(--line)" }} />
              ))}
            </div>

            {uploadQueue.step === 1 ? (
              <>
                <p style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)", margin: "0 0 8px" }}>この画像をどのように使いますか？</p>
                <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                  <button type="button"
                    onClick={() => setUploadQueue(q => q ? { ...q, mode: "reference" } : null)}
                    style={{ flex: 1, padding: "6px 0", fontSize: 12, border: `1.5px solid ${uploadQueue.mode === "reference" ? "var(--navy)" : "var(--line)"}`, borderRadius: 6, background: uploadQueue.mode === "reference" ? "var(--navy)" : "#fff", color: uploadQueue.mode === "reference" ? "#fff" : "var(--ink-soft)", cursor: "pointer", fontWeight: uploadQueue.mode === "reference" ? 600 : 400 }}>
                    参考として使う
                  </button>
                  <button type="button"
                    onClick={() => setUploadQueue(q => q ? { ...q, mode: "embed", step: 2 } : null)}
                    style={{ flex: 1, padding: "6px 0", fontSize: 12, border: `1.5px solid ${uploadQueue.mode === "embed" ? "var(--navy)" : "var(--line)"}`, borderRadius: 6, background: uploadQueue.mode === "embed" ? "var(--navy)" : "#fff", color: uploadQueue.mode === "embed" ? "#fff" : "var(--ink-soft)", cursor: "pointer", fontWeight: uploadQueue.mode === "embed" ? 600 : 400 }}>
                    ドキュメントに埋め込む
                  </button>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  {uploadQueue.mode === "reference" ? (
                    <button type="button" onClick={confirmUpload}
                      style={{ flex: 1, padding: "6px 0", fontSize: 12, background: "var(--navy)", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>
                      確定
                    </button>
                  ) : null}
                  <button type="button" onClick={() => setUploadQueue(null)}
                    style={{ flex: uploadQueue.mode === "reference" ? "0 0 auto" : 1, padding: "6px 12px", fontSize: 12, background: "transparent", color: "var(--ink-soft)", border: "1px solid var(--line)", borderRadius: 6, cursor: "pointer" }}>
                    キャンセル
                  </button>
                </div>
              </>
            ) : (
              /* step 2: 配置指定 */
              <>
                <p style={{ fontSize: 12, fontWeight: 600, color: "var(--ink)", margin: "0 0 8px" }}>配置を指定しますか？</p>
                <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                  <button type="button"
                    onClick={() => setUploadQueue(q => q ? { ...q, placementMode: "ai" } : null)}
                    style={{ flex: 1, padding: "6px 0", fontSize: 12, border: `1.5px solid ${uploadQueue.placementMode === "ai" ? "var(--navy)" : "var(--line)"}`, borderRadius: 6, background: uploadQueue.placementMode === "ai" ? "var(--navy)" : "#fff", color: uploadQueue.placementMode === "ai" ? "#fff" : "var(--ink-soft)", cursor: "pointer", fontWeight: uploadQueue.placementMode === "ai" ? 600 : 400 }}>
                    AIに任せる
                  </button>
                  <button type="button"
                    onClick={() => setUploadQueue(q => q ? { ...q, placementMode: "user" } : null)}
                    style={{ flex: 1, padding: "6px 0", fontSize: 12, border: `1.5px solid ${uploadQueue.placementMode === "user" ? "var(--navy)" : "var(--line)"}`, borderRadius: 6, background: uploadQueue.placementMode === "user" ? "var(--navy)" : "#fff", color: uploadQueue.placementMode === "user" ? "#fff" : "var(--ink-soft)", cursor: "pointer", fontWeight: uploadQueue.placementMode === "user" ? 600 : 400 }}>
                    場所を指定する
                  </button>
                </div>
                {uploadQueue.placementMode === "user" ? (
                  <input
                    className="input"
                    placeholder="例: 治療手順のセクション"
                    value={uploadQueue.placementText}
                    onChange={e => setUploadQueue(q => q ? { ...q, placementText: e.target.value } : null)}
                    style={{ marginBottom: 8, height: 34, fontSize: 12 }}
                  />
                ) : null}
                <div style={{ display: "flex", gap: 6 }}>
                  {uploadQueue.placementMode ? (
                    <button type="button" onClick={confirmUpload}
                      style={{ flex: 1, padding: "6px 0", fontSize: 12, background: "var(--navy)", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}>
                      確定
                    </button>
                  ) : null}
                  <button type="button" onClick={() => setUploadQueue(null)}
                    style={{ flex: uploadQueue.placementMode ? "0 0 auto" : 1, padding: "6px 12px", fontSize: 12, background: "transparent", color: "var(--ink-soft)", border: "1px solid var(--line)", borderRadius: 6, cursor: "pointer" }}>
                    キャンセル
                  </button>
                </div>
              </>
            )}
          </div>
        ) : null}

        {/* ── 確定済みドキュメントチップ ── */}
        {pendingDocs.length > 0 ? (
          <div style={{ padding: "6px 12px 0", borderTop: "1px solid var(--line-soft)", display: "flex", gap: 6, flexWrap: "wrap", background: "var(--surface, #fafafa)" }}>
            {pendingDocs.map((doc, i) => (
              <span key={i} className="tag">
                <span className="truncate" style={{ maxWidth: 160, fontSize: 11 }}>{doc.name}</span>
                <button type="button" onClick={() => removeDoc(i)}
                  style={{ background: "transparent", border: 0, color: "inherit", cursor: "pointer", padding: 0, marginLeft: 2, display: "inline-flex" }}>
                  <X size={10} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {/* ── 確定済み画像サムネイル ── */}
        {pendingImages.length > 0 ? (
          <div style={{ padding: "8px 12px", borderTop: "1px solid var(--line-soft)", display: "flex", gap: 8, flexWrap: "wrap", background: "var(--surface, #fafafa)" }}>
            {pendingImages.map((img, i) => (
              <div key={i} style={{ position: "relative" }}>
                <img src={img.previewUrl} alt="" style={{ width: 52, height: 52, objectFit: "cover", borderRadius: 8, border: "1px solid var(--line)" }} />
                <span style={{ position: "absolute", bottom: 2, left: 2, background: img.mode === "embed" ? "var(--navy)" : "#555", color: "#fff", fontSize: 9, padding: "1px 4px", borderRadius: 3 }}>
                  {img.mode === "embed" ? `埋込 #${img.imageIndex}` : "参考"}
                </span>
                <button type="button" onClick={() => removeImage(i)}
                  style={{ position: "absolute", top: -6, right: -6, width: 18, height: 18, borderRadius: "50%", background: "var(--navy-deep)", color: "#fff", border: "none", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <X size={10} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {/* ── 入力エリア ── */}
        <div style={{ padding: 12, borderTop: "1px solid var(--line)", background: "var(--panel-deep)", borderBottomLeftRadius: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 8, alignItems: "stretch" }}>
            <button type="button" onClick={() => fileInputRef.current?.click()} title="ファイルを添付（画像・PDF・DOCX）"
              style={{ width: 44, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, border: "1px solid var(--line)", borderRadius: "var(--radius)", background: "transparent", cursor: "pointer", color: "var(--ink-soft)", fontSize: 10, letterSpacing: "0.1em", fontWeight: 500 }}>
              <Plus size={16} aria-hidden="true" />
              <span>追加</span>
            </button>
            <input type="file" accept="image/*,.pdf,.docx" multiple hidden ref={fileInputRef} onChange={handleFileAttach} />
            <textarea className="textarea" rows={3} placeholder="マニュアル作成の指示を入力…" value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); sendMessage(); } }}
              disabled={loading} style={{ resize: "none" }}
            />
            <Button onClick={sendMessage} disabled={loading || (!input.trim() && pendingImages.length === 0)}
              style={{ height: "auto", paddingLeft: 16, paddingRight: 16, flexDirection: "column", gap: 4 }}>
              <Send size={16} aria-hidden="true" />
              送信
            </Button>
          </div>
          <div className="tiny soft" style={{ marginTop: 6, letterSpacing: "0.06em" }}>⌘ + Enter で送信</div>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          右パネル: プレビュー
      ══════════════════════════════════════════════════════════════════════ */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <div className="panel-head">
          <span className="tiny soft">
            {generatedOutputType === "slide" && slidesHtml.length > 0
              ? `スライド ${slidesHtml.length} 枚`
              : "プレビュー"}
          </span>
          <div className="row" style={{ gap: 6 }}>
            {!loading && generatedOutputType === "word" && content ? (
              <Button variant="secondary" onClick={downloadDocx} style={{ gap: 5, fontSize: 12, paddingLeft: 12, paddingRight: 12, height: 30 }}>
                <Download size={13} aria-hidden="true" />Word (.docx)
              </Button>
            ) : null}
            {!loading && generatedOutputType === "slide" && slidesHtml.length > 0 ? (
              <>
                <Button variant="ghost" onClick={() => openSlidePreview(slideIframeSrc)} style={{ gap: 5, fontSize: 12, paddingLeft: 12, paddingRight: 12, height: 30 }}>
                  <ExternalLink size={13} aria-hidden="true" />別タブで開く
                </Button>
                <Button variant="secondary" onClick={downloadPptx} style={{ gap: 5, fontSize: 12, paddingLeft: 12, paddingRight: 12, height: 30 }}>
                  <Download size={13} aria-hidden="true" />PowerPoint (.pptx)
                </Button>
              </>
            ) : null}
          </div>
        </div>

        {loading && !content && slidesHtml.length === 0 ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, color: "var(--ink-faint)" }}>
            <span className="dot ok" style={{ width: 10, height: 10, animation: "pulse 1.2s infinite" }} />
            <p style={{ margin: 0, fontSize: 13, color: "var(--ink-muted)" }}>{notice || "生成中…"}</p>
          </div>
        ) : generatedOutputType === "slide" && slidesHtml.length > 0 ? (
          <iframe key={slideIframeSrc.length} srcDoc={slideIframeSrc}
            style={{ flex: 1, width: "100%", border: "none", minHeight: 500 }} title="スライドプレビュー" />
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
                  {wordPreviewParts.map((part, i) =>
                    part.type === "image" ? (
                      part.img ? (
                        <img
                          key={i}
                          src={`data:${part.img.mimeType};base64,${part.img.base64}`}
                          alt={`埋め込み画像${part.n}`}
                          style={{ maxWidth: "100%", height: "auto", display: "block", margin: "12px 0" }}
                        />
                      ) : null
                    ) : (
                      <ReactMarkdown key={i} remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
                    )
                  )}
                </div>
              </>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 10, color: "var(--ink-faint)" }}>
                <FileText size={32} strokeWidth={1.2} aria-hidden="true" />
                <p style={{ margin: 0, fontSize: 13, textAlign: "center", lineHeight: 1.8 }}>
                  左のチャットからマニュアルを作成します
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
