"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Download, FileText, Search, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui";
import { type StoredFileMetadata } from "@/lib/file-assets";

export function ManualGeneratorPanel() {
  const [theme, setTheme] = useState("");
  const [purpose, setPurpose] = useState("");

  const [repositoryFiles, setRepositoryFiles] = useState<StoredFileMetadata[]>([]);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const filePickerRef = useRef<HTMLDivElement | null>(null);

  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [content, setContent] = useState("");
  const [docxBase64, setDocxBase64] = useState("");
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
    async function load() {
      try {
        const res = await fetch("/api/files", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { files: StoredFileMetadata[] };
        if (!ignore) setRepositoryFiles(data.files);
      } catch {
        // 非致命的
      }
    }
    load();
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

    setLoading(true);
    setNotice("");
    setContent("");
    setDocxBase64("");

    const files = selectedFiles.map((f) => ({
      id: f.id,
      fileName: f.fileName,
      knowledgeBaseKey: f.knowledgeBaseKey,
      summaryKey: f.summaryKey,
      extractedTextKey: f.extractedTextKey
    }));

    try {
      const res = await fetch("/api/generate-manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: theme.trim(), purpose, files })
      });
      const data = (await res.json()) as { content?: string; docxBase64?: string; theme?: string; error?: string };
      if (!res.ok) throw new Error(data.error || "生成に失敗しました");
      setContent(data.content ?? "");
      setDocxBase64(data.docxBase64 ?? "");
      setGeneratedTheme(data.theme ?? theme.trim());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "生成に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  function downloadDocx() {
    if (!docxBase64) return;
    const bytes = Uint8Array.from(atob(docxBase64), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${generatedTheme || "manual"}.docx`;
    a.click();
    URL.revokeObjectURL(url);
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
        {/* Form */}
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

          <div>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, letterSpacing: "0.1em", color: "var(--ink-soft)", marginBottom: 6 }}>
              用途（任意）
            </label>
            <input
              className="input"
              placeholder="例: 新人研修、患者説明資料"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
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
                {selectedFiles.length > 0
                  ? `${selectedFiles.length}件の資料を選択中`
                  : "資料を選んで絞り込む（未選択=全資料参照）"}
              </button>

              {filePickerOpen ? (
                <div style={{ position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, background: "#fff", border: "1px solid var(--line)", borderRadius: 12, boxShadow: "var(--shadow-lg)", padding: 14, zIndex: 20 }}>
                  <div className="between" style={{ marginBottom: 10 }}>
                    <span className="panel-title" style={{ fontSize: 13 }}>参照する資料</span>
                    <button type="button" onClick={() => setFilePickerOpen(false)} className="btn ghost sm icon" title="閉じる">
                      <X size={14} aria-hidden="true" />
                    </button>
                  </div>
                  <div style={{ position: "relative", marginBottom: 10 }}>
                    <Search size={14} style={{ position: "absolute", left: 12, top: 12, color: "var(--ink-muted)" }} aria-hidden="true" />
                    <input className="input" placeholder="ファイル名で探す" style={{ paddingLeft: 34, height: 36 }} value={fileQuery} onChange={(e) => setFileQuery(e.target.value)} />
                  </div>
                  <div className="between" style={{ marginBottom: 8 }}>
                    <span className="tiny soft">未選択は全資料から生成</span>
                    {selectedFileIds.length > 0 ? (
                      <button type="button" onClick={() => setSelectedFileIds([])} className="btn ghost sm">すべて外す</button>
                    ) : null}
                  </div>
                  <div style={{ maxHeight: 220, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                    {filteredFiles.map((file) => {
                      const selected = selectedFileIds.includes(file.id);
                      return (
                        <button
                          key={file.id}
                          type="button"
                          onClick={() => toggleFile(file.id)}
                          style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: selected ? "var(--navy-tint-soft)" : "transparent", border: `1px solid ${selected ? "var(--navy-tint)" : "transparent"}`, borderRadius: 8, textAlign: "left", cursor: "pointer" }}
                        >
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
                    {filteredFiles.length === 0 ? (
                      <p className="tiny soft" style={{ textAlign: "center", padding: "16px 0" }}>資料が見つかりません</p>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </div>

            {selectedFiles.length > 0 ? (
              <div className="row" style={{ flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                {selectedFiles.map((f) => (
                  <span key={f.id} className="tag">
                    <span className="truncate" style={{ maxWidth: 160 }}>{f.fileName.replace(/\.[^.]+$/, "")}</span>
                    <button type="button" onClick={() => toggleFile(f.id)} style={{ background: "transparent", border: 0, color: "inherit", cursor: "pointer", padding: 0, marginLeft: 2, display: "inline-flex" }} title="外す">
                      <X size={11} aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
          </div>

          <Button onClick={generate} disabled={!theme.trim() || loading} style={{ gap: 8 }}>
            <Sparkles size={16} aria-hidden="true" />
            {loading ? "生成中…" : "マニュアルを生成"}
          </Button>

          {notice ? (
            <p className="tag accent" style={{ alignSelf: "flex-start" }}>{notice}</p>
          ) : null}
        </div>

        {/* Result */}
        {loading ? (
          <div className="row" style={{ padding: "28px 24px", color: "var(--ink-muted)", fontSize: 13, gap: 8 }}>
            <span className="dot ok" style={{ animation: "pulse 1.2s infinite" }} />
            院内資料を参照してマニュアルを生成しています…
          </div>
        ) : content ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div className="between" style={{ padding: "14px 24px 10px", borderBottom: "1px solid var(--line-soft)" }}>
              <span className="tiny soft" style={{ letterSpacing: "0.08em" }}>プレビュー</span>
              <Button variant="secondary" onClick={downloadDocx} style={{ gap: 6, fontSize: 13, paddingLeft: 14, paddingRight: 14, height: 34 }}>
                <Download size={14} aria-hidden="true" />
                Word (.docx) でダウンロード
              </Button>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
              <h1 style={{ fontFamily: "var(--serif)", fontSize: 18, fontWeight: 700, color: "var(--navy-deep)", marginBottom: 20, marginTop: 0 }}>
                {generatedTheme}
              </h1>
              <div className="prose">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "var(--ink-faint)", padding: 32 }}>
            <FileText size={32} strokeWidth={1.2} aria-hidden="true" />
            <p style={{ margin: 0, fontSize: 13, textAlign: "center", lineHeight: 1.8 }}>
              テーマを入力して「マニュアルを生成」を<br />クリックしてください
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
