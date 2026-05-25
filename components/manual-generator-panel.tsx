"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Download, FileText, Search, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui";
import { type StoredFileMetadata } from "@/lib/file-assets";

const GEMINI_API_KEY = process.env.NEXT_PUBLIC_GEMINI_API_KEY ?? "";
const GEMINI_MODEL = "gemini-2.5-flash";

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

export function ManualGeneratorPanel() {
  const [theme, setTheme] = useState("");

  const [repositoryFiles, setRepositoryFiles] = useState<StoredFileMetadata[]>([]);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const filePickerRef = useRef<HTMLDivElement | null>(null);

  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [content, setContent] = useState("");
  const [generatedTheme, setGeneratedTheme] = useState("");

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

  async function generate() {
    if (!theme.trim() || loading) return;
    if (!GEMINI_API_KEY) {
      setNotice("NEXT_PUBLIC_GEMINI_API_KEY が設定されていません");
      return;
    }

    setLoading(true);
    setNotice("");
    setContent("");
    setGeneratedTheme("");

    const currentTheme = theme.trim();

    try {
      // Step 1: 院内資料を KB から取得（軽量・高速）
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

      // Step 2: Gemini でストリーミング生成（ブラウザから直接）
      const sectionList = MANUAL_SECTIONS.map((s, i) => `## ${i + 1}. ${s}`).join("\n");
      const context = passages.length > 0
        ? `\n\n【院内資料（参考）】\n${passages.join("\n\n---\n\n")}`
        : "";

      const prompt = [
        `テーマ: ${currentTheme}`,
        "",
        "以下の10項目構成で院内マニュアルを日本語で作成してください。",
        "各項目は「## 1. 病気の解説」のようにMarkdown見出し（##）で始め、その下に内容を記載してください。",
        "第8項目（治療中に確認するチェックリスト）は「- [ ] 」形式の箇条書きにしてください。",
        context,
        "",
        sectionList
      ].filter(Boolean).join("\n");

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?key=${GEMINI_API_KEY}&alt=sse`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            system_instruction: {
              parts: [{ text: "あなたは歯科医院の院内マニュアル作成AIです。指定された構成で日本語のマニュアルを作成してください。" }]
            },
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: 8192, temperature: 0.3 }
          })
        }
      );

      if (!response.ok || !response.body) {
        const errText = await response.text().catch(() => "");
        let detail = errText;
        try { detail = JSON.stringify(JSON.parse(errText), null, 2); } catch {}
        throw new Error(`Gemini API エラー ${response.status}: ${detail}`);
      }

      // SSE ストリームを読む
      const reader = response.body.getReader();
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
            if (text) {
              accumulated += text;
              setContent(accumulated);
            }
          } catch {
            // malformed chunk は無視
          }
        }
      }

      setGeneratedTheme(currentTheme);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "生成に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  async function downloadDocx(overrideContent?: string, overrideTheme?: string) {
    const docContent = overrideContent ?? content;
    const docTheme = overrideTheme ?? generatedTheme;
    if (!docContent || !docTheme) return;
    try {
      const res = await fetch("/api/generate-manual/docx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: docContent, theme: docTheme })
      });
      if (!res.ok) throw new Error("ダウンロードに失敗しました");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${docTheme}.docx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "ダウンロードに失敗しました");
    }
  }

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

          <Button onClick={generate} disabled={!theme.trim() || loading} style={{ gap: 8 }}>
            <Sparkles size={16} aria-hidden="true" />
            {loading ? "生成中…" : "マニュアルを生成"}
          </Button>

          {notice ? <p className="tag accent" style={{ alignSelf: "flex-start" }}>{notice}</p> : null}
        </div>

        {content || loading ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div className="between" style={{ padding: "14px 24px 10px", borderBottom: "1px solid var(--line-soft)" }}>
              <span className="row" style={{ gap: 8, fontSize: 13 }}>
                {loading
                  ? <><span className="dot ok" style={{ animation: "pulse 1.2s infinite" }} /><span style={{ color: "var(--ink-muted)" }}>生成中…</span></>
                  : <span className="tiny soft" style={{ letterSpacing: "0.08em" }}>プレビュー</span>}
              </span>
              {!loading && content ? (
                <Button variant="secondary" onClick={downloadDocx} style={{ gap: 6, fontSize: 13, paddingLeft: 14, paddingRight: 14, height: 34 }}>
                  <Download size={14} aria-hidden="true" />
                  Word (.docx) でダウンロード
                </Button>
              ) : null}
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
              {generatedTheme ? (
                <h1 style={{ fontFamily: "var(--serif)", fontSize: 18, fontWeight: 700, color: "var(--navy-deep)", marginBottom: 20, marginTop: 0 }}>{generatedTheme}</h1>
              ) : null}
              <div className="prose">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
              </div>
            </div>
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
