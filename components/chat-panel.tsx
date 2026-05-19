"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Clipboard, ClipboardCheck, Plus, Search, Send, X } from "lucide-react";
import { Button } from "@/components/ui";
import { type ManualMetadata } from "@/lib/manuals";

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
  const [manuals, setManuals] = useState<ManualMetadata[]>([]);
  const [selectedManualIds, setSelectedManualIds] = useState<string[]>([]);
  const [manualPickerOpen, setManualPickerOpen] = useState(false);
  const [manualQuery, setManualQuery] = useState("");
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);
  const manualPickerRef = useRef<HTMLDivElement | null>(null);

  const selectedManuals = useMemo(
    () => manuals.filter((manual) => selectedManualIds.includes(manual.id)),
    [manuals, selectedManualIds]
  );
  const filteredManuals = useMemo(
    () => manuals.filter((manual) => manual.fileName.toLowerCase().includes(manualQuery.toLowerCase())),
    [manualQuery, manuals]
  );

  useEffect(() => {
    let ignore = false;

    async function loadManuals() {
      try {
        const response = await fetch("/api/files", { cache: "no-store" });
        if (!response.ok) {
          throw new Error("Failed to load manuals");
        }
        const data = (await response.json()) as { files: ManualMetadata[] };
        if (!ignore) {
          setManuals(data.files);
        }
      } catch {
        if (!ignore) {
          setNotice("マニュアル一覧を読み込めませんでした。");
        }
      }
    }

    loadManuals();

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (manualPickerRef.current && !manualPickerRef.current.contains(event.target as Node)) {
        setManualPickerOpen(false);
      }
    }

    if (manualPickerOpen) {
      document.addEventListener("pointerdown", handlePointerDown);
    }

    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [manualPickerOpen]);

  function toggleManual(id: string) {
    setSelectedManualIds((current) =>
      current.includes(id) ? current.filter((manualId) => manualId !== id) : [...current, id]
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
          manuals: selectedManuals.map((manual) => ({
            id: manual.id,
            fileName: manual.fileName,
            s3Key: manual.s3Key
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
            "院内マニュアルから該当する内容を見つけられませんでした。資料の同期状態を確認してください。"
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
        {selectedManuals.length > 0 ? (
          <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
            <span className="tiny soft" style={{ letterSpacing: "0.14em" }}>参照：</span>
            {selectedManuals.map((manual) => (
              <span key={manual.id} className="tag">
                <span className="truncate" style={{ maxWidth: 180 }}>{manual.fileName.replace(/\.[^.]+$/, "")}</span>
                <button
                  type="button"
                  onClick={() => toggleManual(manual.id)}
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
          <div style={{ position: "relative" }} ref={manualPickerRef}>
            <Button
              variant="secondary"
              onClick={() => setManualPickerOpen((current) => !current)}
              title="参照する資料を選ぶ"
              style={{ height: "100%", paddingLeft: 14, paddingRight: 14, flexDirection: "column", gap: 2 }}
            >
              <Plus size={16} aria-hidden="true" />
              <span style={{ fontSize: 10, letterSpacing: "0.12em", fontWeight: 500 }}>資料を選ぶ</span>
            </Button>
            {manualPickerOpen ? (
              <div style={{ position: "absolute", bottom: "calc(100% + 8px)", left: 0, width: 360, maxWidth: "calc(100vw - 32px)", background: "#fff", border: "1px solid var(--line)", borderRadius: 12, boxShadow: "var(--shadow-lg)", padding: 14, zIndex: 20 }}>
                <div className="between" style={{ marginBottom: 10 }}>
                  <span className="panel-title" style={{ fontSize: 13 }}>参照する資料</span>
                  <button type="button" onClick={() => setManualPickerOpen(false)} className="btn ghost sm icon" title="閉じる">
                    <X size={14} aria-hidden="true" />
                  </button>
                </div>
                <div style={{ position: "relative", marginBottom: 10 }}>
                  <Search size={14} style={{ position: "absolute", left: 12, top: 12, color: "var(--ink-muted)" }} aria-hidden="true" />
                  <input className="input" placeholder="ファイル名で探す" style={{ paddingLeft: 34, height: 36 }} value={manualQuery} onChange={(event) => setManualQuery(event.target.value)} />
                </div>
                <div className="between" style={{ marginBottom: 8 }}>
                  <span className="tiny soft">未選択の場合は院内すべての資料から探します</span>
                  {selectedManualIds.length > 0 ? (
                    <button type="button" onClick={() => setSelectedManualIds([])} className="btn ghost sm">すべて外す</button>
                  ) : null}
                </div>
                <div style={{ maxHeight: 280, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 }}>
                  {filteredManuals.map((manual) => {
                    const selected = selectedManualIds.includes(manual.id);
                    return (
                      <button
                        key={manual.id}
                        type="button"
                        onClick={() => toggleManual(manual.id)}
                        style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", background: selected ? "var(--navy-tint-soft)" : "transparent", border: `1px solid ${selected ? "var(--navy-tint)" : "transparent"}`, borderRadius: 8, textAlign: "left", cursor: "pointer" }}
                      >
                        <span style={{ width: 18, height: 18, borderRadius: 4, border: `1.5px solid ${selected ? "var(--navy)" : "#c8c4b5"}`, background: selected ? "var(--navy)" : "transparent", color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                          {selected ? <Check size={12} aria-hidden="true" /> : null}
                        </span>
                        <span className="stack" style={{ minWidth: 0, flex: 1 }}>
                          <span className="truncate" style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>{manual.fileName.replace(/\.[^.]+$/, "")}</span>
                          <span className="tiny soft truncate">{manual.categories.join("・")} ／ {manual.roles.join("・")}</span>
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
