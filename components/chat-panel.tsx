"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Clipboard, ClipboardCheck, Plus, Search, Send, X } from "lucide-react";
import { Button } from "@/components/ui";
import { type StoredFileMetadata } from "@/lib/file-assets";

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
};

const initialMessages: ChatMessage[] = [
  {
    role: "user",
    text: "新人衛生士向けに、SRPの注意点を3つだけ短くまとめて。"
  },
  {
    role: "assistant",
    text: `以下、新人衛生士さん向けにSRPで特に押さえるポイントを3つに絞りました。

1. **プロービング圧は20gが目安**。強く入れすぎると正確な深さが測れず、歯肉も傷つけます。
2. **キュレットはモディファイドペングリップで把持**。指で支点をつくり、手首ではなく前腕で動かす意識を。
3. **ストロークは短く確実に**。長く引きずるストロークは歯肉損傷の原因になります。

判断に迷ったら必ず先輩に声をかけてから処置に入ってください。`
  }
];

export function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [repositoryFiles, setRepositoryFiles] = useState<StoredFileMetadata[]>([]);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);
  const filePickerRef = useRef<HTMLDivElement | null>(null);

  const selectedRepositoryFiles = useMemo(
    () => repositoryFiles.filter((file) => selectedFileIds.includes(file.id)),
    [repositoryFiles, selectedFileIds]
  );
  const filteredRepositoryFiles = useMemo(
    () => repositoryFiles.filter((file) => file.fileName.toLowerCase().includes(fileQuery.toLowerCase())),
    [fileQuery, repositoryFiles]
  );

  useEffect(() => {
    let ignore = false;

    async function loadRepositoryFiles() {
      try {
        const response = await fetch("/api/files", { cache: "no-store" });
        if (!response.ok) {
          throw new Error("Failed to load files");
        }
        const data = (await response.json()) as { files: StoredFileMetadata[] };
        if (!ignore) {
          setRepositoryFiles(data.files);
        }
      } catch {
        if (!ignore) {
          setNotice("資料庫の一覧を読み込めませんでした。");
        }
      }
    }

    loadRepositoryFiles();

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (filePickerRef.current && !filePickerRef.current.contains(event.target as Node)) {
        setFilePickerOpen(false);
      }
    }

    if (filePickerOpen) {
      document.addEventListener("pointerdown", handlePointerDown);
    }

    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [filePickerOpen]);

  function toggleFile(id: string) {
    setSelectedFileIds((current) =>
      current.includes(id) ? current.filter((fileId) => fileId !== id) : [...current, id]
    );
  }

  async function copyMessage(text: string, index: number) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMessageIndex(index);
      window.setTimeout(() => setCopiedMessageIndex(null), 1600);
    } catch {
      setNotice("コピーに失敗しました。ブラウザのクリップボード権限を確認してください。");
    }
  }

  async function sendMessage() {
    const message = input.trim();
    if (!message || loading) {
      return;
    }

    setMessages((current) => [...current, { role: "user", text: message }]);
    setInput("");
    setLoading(true);
    setNotice("");

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          files: selectedRepositoryFiles.map((file) => ({
            id: file.id,
            fileName: file.fileName,
            s3Key: file.s3Key,
            summaryKey: file.summaryKey,
            knowledgeBaseKey: file.knowledgeBaseKey,
            extractedTextKey: file.extractedTextKey
          }))
        })
      });
      const data = (await response.json()) as { answer?: string; error?: string };
      if (!response.ok) {
        throw new Error(data.error || "Failed to chat");
      }
      setMessages((current) => [
        ...current,
        {
          role: "assistant",
          text:
            data.answer?.trim() ||
            "資料庫から該当する内容を見つけられませんでした。資料の同期状態を確認してください。"
        }
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      setNotice(message ? `回答生成に失敗しました。${message}` : "回答生成に失敗しました。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="panel" style={{ display: "flex", flexDirection: "column", minHeight: "calc(100vh - 200px)" }}>
      <div className="panel-head">
        <div className="row" style={{ gap: 10 }}>
          <span className="panel-title">会話</span>
          <span className="panel-sub">{messages.filter((message) => message.role === "user").length} 件の質問</span>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <span className="dot ok" />
          <span className="tiny soft">資料の読み込み完了</span>
        </div>
      </div>

      <div style={{ flex: 1, padding: "28px 28px 8px", display: "flex", flexDirection: "column", gap: 22, overflowY: "auto" }}>
        {messages.map((message, index) =>
          message.role === "user" ? (
            <UserMessage key={`${message.role}-${index}`} text={message.text} />
          ) : (
            <AssistantMessage
              key={`${message.role}-${index}`}
              text={message.text}
              copied={copiedMessageIndex === index}
              onCopy={() => copyMessage(message.text, index)}
            />
          )
        )}
        {loading ? (
          <div className="row" style={{ color: "var(--ink-muted)", fontSize: 13 }}>
            <span className="dot ok" style={{ animation: "pulse 1.2s infinite" }} />
            資料から該当箇所を探しています…
          </div>
        ) : null}
        {notice ? (
          <p className="tag accent" style={{ alignSelf: "flex-start" }}>
            {notice}
          </p>
        ) : null}
      </div>

      <div style={{ borderTop: "1px solid var(--line)", padding: 18, background: "var(--panel-deep)", borderBottomLeftRadius: 16, borderBottomRightRadius: 16 }}>
        {selectedRepositoryFiles.length > 0 ? (
          <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
            <span className="tiny soft" style={{ letterSpacing: "0.14em" }}>参照：</span>
            {selectedRepositoryFiles.map((file) => (
              <span key={file.id} className="tag">
                <span className="truncate" style={{ maxWidth: 180 }}>{file.fileName.replace(/\.[^.]+$/, "")}</span>
                <button
                  type="button"
                  onClick={() => toggleFile(file.id)}
                  style={{ background: "transparent", border: 0, color: "inherit", cursor: "pointer", padding: 0, marginLeft: 2, display: "inline-flex" }}
                  title="この資料を外す"
                >
                  <X size={11} aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 8, alignItems: "stretch" }}>
          <div style={{ position: "relative" }} ref={filePickerRef}>
            <Button
              variant="secondary"
              onClick={() => setFilePickerOpen((current) => !current)}
              title="参照する資料を選ぶ"
              style={{ height: "100%", paddingLeft: 14, paddingRight: 14, flexDirection: "column", gap: 2 }}
            >
              <Plus size={16} aria-hidden="true" />
              <span style={{ fontSize: 10, letterSpacing: "0.12em", fontWeight: 500 }}>資料を選ぶ</span>
            </Button>
            {filePickerOpen ? (
              <div style={{ position: "absolute", bottom: "calc(100% + 8px)", left: 0, width: 360, maxWidth: "calc(100vw - 32px)", background: "#fff", border: "1px solid var(--line)", borderRadius: 12, boxShadow: "var(--shadow-lg)", padding: 14, zIndex: 20 }}>
                <div className="between" style={{ marginBottom: 10 }}>
                  <span className="panel-title" style={{ fontSize: 13 }}>参照する資料</span>
                  <button type="button" onClick={() => setFilePickerOpen(false)} className="btn ghost sm icon" title="閉じる">
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
                <div style={{ position: "relative", marginBottom: 10 }}>
                  <Search size={14} style={{ position: "absolute", left: 12, top: 12, color: "var(--ink-muted)" }} aria-hidden="true" />
                  <input className="input" placeholder="ファイル名で探す" style={{ paddingLeft: 34, height: 36 }} value={fileQuery} onChange={(event) => setFileQuery(event.target.value)} />
                </div>
                <div className="between" style={{ marginBottom: 8 }}>
                  <span className="tiny soft">未選択の場合は院内すべての資料から探します</span>
                  {selectedFileIds.length > 0 ? (
                    <button type="button" onClick={() => setSelectedFileIds([])} className="btn ghost sm">すべて外す</button>
                  ) : null}
                </div>
                <div style={{ maxHeight: 280, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                  {filteredRepositoryFiles.map((file) => {
                    const selected = selectedFileIds.includes(file.id);
                    return (
                      <button
                        key={file.id}
                        type="button"
                        onClick={() => toggleFile(file.id)}
                        style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: selected ? "var(--navy-tint-soft)" : "transparent", border: `1px solid ${selected ? "var(--navy-tint)" : "transparent"}`, borderRadius: 8, textAlign: "left", cursor: "pointer" }}
                      >
                        <span style={{ width: 18, height: 18, borderRadius: 4, border: `1.5px solid ${selected ? "var(--navy)" : "#c8c4b5"}`, background: selected ? "var(--navy)" : "transparent", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                          {selected ? <Check size={12} aria-hidden="true" /> : null}
                        </span>
                        <span className="stack" style={{ minWidth: 0, flex: 1 }}>
                          <span className="truncate" style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>{file.fileName.replace(/\.[^.]+$/, "")}</span>
                          <span className="tiny soft truncate">{file.sizeLabel || file.thumbnailLabel || "資料"}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
          <textarea
            className="textarea"
            rows={3}
            placeholder="質問を入力"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                sendMessage();
              }
            }}
            style={{ resize: "none" }}
          />
          <Button onClick={sendMessage} disabled={loading || !input.trim()} style={{ height: "auto", paddingLeft: 18, paddingRight: 18, flexDirection: "column", gap: 4 }}>
            <Send size={18} aria-hidden="true" />
            送信
          </Button>
        </div>
        <div className="tiny soft" style={{ marginTop: 8, letterSpacing: "0.06em" }}>⌘ + Enter で送信</div>
      </div>
    </section>
  );
}

function UserMessage({ text }: { text: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <div style={{ maxWidth: "78%", background: "var(--navy-deep)", color: "#f5efe1", borderRadius: "14px 14px 4px 14px", padding: "12px 16px", fontSize: 14, lineHeight: 1.7, whiteSpace: "pre-wrap", letterSpacing: "0.02em" }}>
        {text}
      </div>
    </div>
  );
}

function AssistantMessage({ text, copied, onCopy }: { text: string; copied: boolean; onCopy: () => void }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-start" }}>
      <div style={{ maxWidth: "84%" }}>
        <div className="row" style={{ marginBottom: 8, gap: 8 }}>
          <span style={{ width: 22, height: 22, borderRadius: 6, background: "var(--navy-tint)", color: "var(--navy-deep)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontFamily: '"Noto Serif JP",serif', fontWeight: 600, fontSize: 11 }}>知</span>
          <span className="tiny" style={{ color: "var(--navy-deep)", fontWeight: 600, letterSpacing: "0.1em" }}>院内ナレッジ</span>
        </div>
        <div style={{ background: "#ffffff", border: "1px solid var(--line)", borderRadius: "4px 14px 14px 14px", padding: "14px 18px", fontSize: 14, lineHeight: 1.85, color: "var(--ink)" }}>
          <div className="prose-lite">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
        </div>
        <div className="row" style={{ marginTop: 10, gap: 6, flexWrap: "wrap" }}>
          <span className="tiny soft" style={{ letterSpacing: "0.14em" }}>出典</span>
          <span className="tag accent">
            <span className="truncate" style={{ maxWidth: 220 }}>院内資料</span>
            <span style={{ opacity: 0.75 }}>p.—</span>
          </span>
          <button type="button" className="btn ghost sm" style={{ marginLeft: 4 }} onClick={onCopy}>
            {copied ? <ClipboardCheck size={13} aria-hidden="true" /> : <Clipboard size={13} aria-hidden="true" />}
            コピー
          </button>
        </div>
      </div>
    </div>
  );
}


