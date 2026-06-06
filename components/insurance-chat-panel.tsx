"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ChevronLeft, ChevronRight, Clipboard, ClipboardCheck,
  MessageCircle, MoreHorizontal, Paperclip, Plus, RefreshCw, Send, X,
} from "lucide-react";
import { Button } from "@/components/ui";

type ChatImage = { url: string; description: string; page: number; documentName: string };
type ChatMessage = { role: "user" | "assistant"; text: string; images?: ChatImage[] };
type SessionSummary = { id: string; title: string; type?: string };

const ALLOWED_MIME_TYPES = [
  "image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILES = 5;

export function InsuranceChatPanel({
  initialSessionId,
  onLoadChatSession,
}: {
  initialSessionId?: string | null;
  onLoadChatSession?: (id: string) => void;
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [bedrockSessionId, setBedrockSessionId] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");

  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  // Sync state
  const [syncing, setSyncing] = useState(false);
  const [syncNotice, setSyncNotice] = useState("");

  // 保険フォルダのID（自動検出）
  const [insuranceFolderId, setInsuranceFolderId] = useState<string>("");

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const LINE_HEIGHT = 22.4;
  const MAX_TEXTAREA_HEIGHT = Math.round(LINE_HEIGHT * 7 + 16);

  function adjustTextareaHeight() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  }

  useEffect(() => {
    fetch("/api/chat-sessions")
      .then(r => r.json())
      .then((data: { sessions: SessionSummary[] }) =>
        setSessions((data.sessions ?? []).filter(s => s.type === "insurance"))
      )
      .catch(() => {});
  }, []);

  // 保険フォルダのIDを自動検出
  useEffect(() => {
    try {
      const foldersRaw = localStorage.getItem("dental-repo-folders-v2");
      const folders: { id: string; name: string }[] = foldersRaw ? JSON.parse(foldersRaw) : [];
      const insuranceFolder = folders.find(f => f.name.includes("保険"));
      if (insuranceFolder) setInsuranceFolderId(insuranceFolder.id);
    } catch {}
  }, []);

  useEffect(() => {
    if (!initialSessionId) return;
    fetch(`/api/chat-sessions/${initialSessionId}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json(); })
      .then((data: { messages?: ChatMessage[]; bedrockSessionId?: string }) => {
        setCurrentSessionId(initialSessionId);
        setMessages(data.messages ?? []);
        setBedrockSessionId(data.bedrockSessionId ?? "");
      })
      .catch(() => {});
  }, [initialSessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // ── File attachment ───────────────────────────────────────────────────────

  function addFiles(fileList: FileList | null) {
    if (!fileList) return;
    const errors: string[] = [];
    const valid: File[] = [];
    for (const file of Array.from(fileList)) {
      if (!ALLOWED_MIME_TYPES.includes(file.type)) { errors.push(`${file.name}: 非対応形式`); continue; }
      if (file.size > MAX_FILE_SIZE) { errors.push(`${file.name}: 10MB超`); continue; }
      valid.push(file);
    }
    setAttachedFiles(prev => {
      const combined = [...prev, ...valid];
      if (combined.length > MAX_FILES) { errors.push(`最大${MAX_FILES}件`); return combined.slice(0, MAX_FILES); }
      return combined;
    });
    if (errors.length > 0) setNotice(errors.join(" / "));
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleDragOver(e: React.DragEvent) { e.preventDefault(); setIsDragOver(true); }
  function handleDragLeave(e: React.DragEvent) {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setIsDragOver(false);
  }
  function handleDrop(e: React.DragEvent) { e.preventDefault(); setIsDragOver(false); addFiles(e.dataTransfer.files); }

  // ── Session management ────────────────────────────────────────────────────

  function newChat() {
    setCurrentSessionId(null); setMessages([]); setBedrockSessionId("");
    setInput(""); setNotice(""); setAttachedFiles([]);
  }

  async function loadSession(s: SessionSummary) {
    if (s.id === currentSessionId || loading) return;
    try {
      const res = await fetch(`/api/chat-sessions/${s.id}`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { messages?: ChatMessage[]; bedrockSessionId?: string };
      setCurrentSessionId(s.id); setMessages(data.messages ?? []);
      setBedrockSessionId(data.bedrockSessionId ?? "");
      setInput(""); setNotice("");
    } catch { setNotice("読み込みに失敗しました。"); }
  }

  async function deleteSession(id: string) {
    await fetch(`/api/chat-sessions/${id}`, { method: "DELETE" }).catch(() => {});
    setSessions(prev => prev.filter(s => s.id !== id));
    if (currentSessionId === id) newChat();
    setDeleteConfirmId(null); setMenuOpenId(null);
  }

  async function renameSession(id: string, title: string) {
    if (!title.trim()) return;
    await fetch(`/api/chat-sessions/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title.trim() }),
    }).catch(() => {});
    setSessions(prev => prev.map(s => s.id === id ? { ...s, title: title.trim() } : s));
    setEditingId(null); setMenuOpenId(null);
  }

  // ── Send message ──────────────────────────────────────────────────────────

  async function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(",")[1] ?? "");
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function sendMessage() {
    const message = input.trim();
    if (!message || loading) return;

    const filesToSend = [...attachedFiles];
    const displayText = filesToSend.length > 0
      ? `${message}\n[添付: ${filesToSend.map(f => f.name).join(", ")}]`
      : message;

    const prevMessages = messages;
    const withUser: ChatMessage[] = [...messages, { role: "user", text: displayText }];
    setMessages(withUser); setInput(""); setAttachedFiles([]);
    setTimeout(adjustTextareaHeight, 0);
    setLoading(true); setNotice("");

    try {
      const attachments = await Promise.all(
        filesToSend.map(async file => ({
          name: file.name, type: file.type, data: await fileToBase64(file),
        }))
      );

      const res = await fetch("/api/insurance-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(bedrockSessionId ? { bedrockSessionId } : {}),
          ...(insuranceFolderId ? { folderId: insuranceFolderId } : {}),
        }),
      });
      const data = (await res.json()) as {
        answer?: string; error?: string; bedrockSessionId?: string; images?: ChatImage[];
      };
      if (!res.ok) throw new Error(data.error || "Failed");

      const assistantText = data.answer?.trim() || "該当する保険ルール資料が見つかりませんでした。資料庫の14_保険ルールフォルダに資料を追加してRAG同期してください。";
      const allMessages: ChatMessage[] = [
        ...withUser,
        { role: "assistant", text: assistantText, ...(data.images?.length ? { images: data.images } : {}) },
      ];
      setMessages(allMessages);

      const newBedrockId = data.bedrockSessionId ?? "";
      setBedrockSessionId(newBedrockId);

      const sessionId = currentSessionId ?? crypto.randomUUID();
      const title = sessions.find(s => s.id === sessionId)?.title ?? message.slice(0, 30);

      fetch(`/api/chat-sessions/${sessionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: sessionId, title, type: "insurance", bedrockSessionId: newBedrockId, messages: allMessages }),
      }).catch(() => {});

      if (!currentSessionId) {
        setCurrentSessionId(sessionId);
        setSessions(prev => [{ id: sessionId, title, type: "insurance" }, ...prev]);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "回答生成に失敗しました。");
      setMessages(prevMessages);
    } finally {
      setLoading(false);
    }
  }

  // ── Insurance KB sync ─────────────────────────────────────────────────────

  async function syncInsuranceKB() {
    setSyncing(true);
    setSyncNotice("");
    try {
      const res = await fetch("/api/insurance-sync", { method: "POST" });
      const data = (await res.json()) as { jobId?: string; status?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "資料の取り込みに失敗しました");
      setSyncNotice("取り込みを開始しました。数分後に検索へ反映されます。");
      window.setTimeout(() => setSyncNotice(""), 6000);
    } catch (e) {
      setSyncNotice(e instanceof Error ? e.message : "資料の取り込みに失敗しました");
    } finally {
      setSyncing(false);
    }
  }

  async function copyMessage(text: string, index: number) {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopiedIndex(index);
    window.setTimeout(() => setCopiedIndex(null), 1600);
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <section className="panel" style={{ display: "flex", flexDirection: "row", flex: 1, minHeight: 0 }}>

        {/* ── Sidebar ── */}
        <div style={{
          width: sidebarOpen ? 180 : 40, flexShrink: 0, borderRight: "1px solid var(--line)",
          display: "flex", flexDirection: "column", transition: "width 0.2s ease",
          overflow: "hidden", background: "var(--panel-deep,#f8f9fa)", borderRadius: "16px 0 0 16px",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "10px 6px", borderBottom: "1px solid var(--line)", flexShrink: 0 }}>
            <button type="button" onClick={() => setSidebarOpen(v => !v)}
              title={sidebarOpen ? "サイドバーを閉じる" : "サイドバーを開く"}
              style={{ width: 28, height: 28, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, color: "var(--ink-soft)", flexShrink: 0 }}>
              {sidebarOpen ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
            </button>
            {sidebarOpen && (
              <button type="button" onClick={newChat} title="新しい相談"
                style={{ flex: 1, display: "flex", alignItems: "center", gap: 5, padding: "4px 6px", border: "none", background: "transparent", cursor: "pointer", borderRadius: 6, color: "var(--ink-soft)", fontSize: 12, fontWeight: 500, whiteSpace: "nowrap" }}>
                <Plus size={13} aria-hidden="true" />
                新しい相談
              </button>
            )}
          </div>

          {sidebarOpen && (
            <div style={{ flex: 1, overflowY: "auto", padding: "6px 4px" }}>
              {sessions.length === 0 ? (
                <p style={{ fontSize: 11, color: "var(--ink-muted)", padding: "12px 8px", margin: 0 }}>履歴なし</p>
              ) : sessions.map(session => (
                <div key={session.id} style={{ position: "relative", marginBottom: 1 }}
                  onMouseLeave={() => { if (menuOpenId === session.id) setMenuOpenId(null); }}>
                  {editingId === session.id ? (
                    <input autoFocus value={editingTitle} onChange={e => setEditingTitle(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter") renameSession(session.id, editingTitle); if (e.key === "Escape") { setEditingId(null); setMenuOpenId(null); } }}
                      onBlur={() => renameSession(session.id, editingTitle)}
                      style={{ width: "100%", fontSize: 12, padding: "4px 6px", border: "1px solid var(--navy)", borderRadius: 4, outline: "none", background: "#fff" }} />
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "6px 4px 6px 8px", borderRadius: 6, background: currentSessionId === session.id ? "var(--navy-tint-soft)" : "transparent", cursor: "pointer" }}
                      onClick={() => loadSession(session)}>
                      <MessageCircle size={11} style={{ flexShrink: 0, color: "var(--ink-faint)" }} aria-hidden="true" />
                      <span style={{ flex: 1, fontSize: 12, color: currentSessionId === session.id ? "var(--navy)" : "var(--ink-soft)", fontWeight: currentSessionId === session.id ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {session.title}
                      </span>
                      <button type="button"
                        onClick={e => { e.stopPropagation(); setMenuOpenId(menuOpenId === session.id ? null : session.id); }}
                        style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "transparent", cursor: "pointer", borderRadius: 3, color: "var(--ink-faint)", flexShrink: 0 }}>
                        <MoreHorizontal size={12} aria-hidden="true" />
                      </button>
                    </div>
                  )}
                  {menuOpenId === session.id && (
                    <div style={{ position: "absolute", right: 0, top: "100%", zIndex: 50, background: "#fff", border: "1px solid var(--line)", borderRadius: 6, boxShadow: "0 4px 12px rgba(0,0,0,.12)", minWidth: 120, padding: "4px 0" }}>
                      <button type="button"
                        onClick={e => { e.stopPropagation(); setEditingId(session.id); setEditingTitle(session.title); setMenuOpenId(null); }}
                        style={{ width: "100%", textAlign: "left", padding: "6px 12px", fontSize: 12, border: "none", background: "none", cursor: "pointer", color: "var(--ink)" }}>名前を変更</button>
                      <button type="button"
                        onClick={e => { e.stopPropagation(); setDeleteConfirmId(session.id); setMenuOpenId(null); }}
                        style={{ width: "100%", textAlign: "left", padding: "6px 12px", fontSize: 12, border: "none", background: "none", cursor: "pointer", color: "#c0392b" }}>削除</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Chat area ── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, position: "relative" }}
          onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>

          {isDragOver && (
            <div style={{ position: "absolute", inset: 0, zIndex: 10, pointerEvents: "none", background: "rgba(44,82,130,0.06)", border: "2px dashed var(--navy)", borderRadius: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ color: "var(--navy)", fontSize: 14, fontWeight: 600 }}>ここにドロップして添付</span>
            </div>
          )}

          {/* Header */}
          <div className="panel-head">
            <div className="row" style={{ gap: 10 }}>
              <span className="panel-title">保険請求AI</span>
              <span className="panel-sub">{messages.filter(m => m.role === "user").length} 件</span>
            </div>
            <div className="row" style={{ gap: 8 }}>
              {syncNotice && (
                <span style={{ fontSize: 11, color: syncing ? "var(--ink-muted)" : "var(--navy)", letterSpacing: "0.04em" }}>
                  {syncNotice}
                </span>
              )}
              <button type="button" onClick={syncInsuranceKB} disabled={syncing}
                title="14_保険ルールフォルダに資料を追加・移動した際に押してください"
                style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 10px", border: "1px solid var(--line)", borderRadius: "var(--radius)", background: "transparent", cursor: syncing ? "default" : "pointer", color: "var(--ink-soft)", fontSize: 12, opacity: syncing ? 0.6 : 1 }}>
                <RefreshCw size={12} style={{ animation: syncing ? "spin 1s linear infinite" : "none" }} aria-hidden="true" />
                {syncing ? "取り込み中…" : "資料を反映"}
              </button>
            </div>
          </div>

          {/* Messages */}
          <div style={{ flex: 1, minHeight: 0, padding: "28px 28px 8px", display: "flex", flexDirection: "column", gap: 22, overflowY: "auto" }}>
            {messages.length === 0 && !loading ? (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--ink-faint)", gap: 12, padding: 32 }}>
                <MessageCircle size={32} strokeWidth={1.2} aria-hidden="true" />
                <div style={{ textAlign: "center" }}>
                  <p style={{ margin: "0 0 8px", fontSize: 13, lineHeight: 1.8 }}>
                    治療内容・請求内容・保険ルールの質問を入力してください
                  </p>
                  <p style={{ margin: 0, fontSize: 11, color: "var(--ink-muted)", lineHeight: 1.7 }}>
                    資料庫の <strong>14_保険ルール</strong> フォルダに資料を追加・移動したら<br />
                    右上の「資料を反映」ボタンを押してください
                  </p>
                </div>
              </div>
            ) : null}

            {messages.map((msg, index) =>
              msg.role === "user" ? (
                <InsuranceUserMessage key={index} text={msg.text} />
              ) : (
                <InsuranceAssistantMessage
                  key={index}
                  text={msg.text}
                  images={msg.images}
                  copied={copiedIndex === index}
                  onCopy={() => copyMessage(msg.text, index)}
                />
              )
            )}

            {loading && (
              <div className="row" style={{ color: "var(--ink-muted)", fontSize: 13 }}>
                <span className="dot ok" style={{ animation: "pulse 1.2s infinite" }} />
                保険ルール資料を検索中…
              </div>
            )}
            {notice && <p className="tag accent" style={{ alignSelf: "flex-start" }}>{notice}</p>}
            <div ref={messagesEndRef} />
          </div>

          {/* Input area */}
          <div style={{ borderTop: "1px solid var(--line)", padding: "10px 14px", background: "var(--panel-deep)", borderBottomRightRadius: 16 }}>
            {attachedFiles.length > 0 && (
              <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                <span className="tiny soft" style={{ letterSpacing: "0.14em" }}>添付：</span>
                {attachedFiles.map((file, i) => (
                  <span key={i} className="tag">
                    <span className="truncate" style={{ maxWidth: 180 }}>{file.name}</span>
                    <button type="button" onClick={() => setAttachedFiles(prev => prev.filter((_, j) => j !== i))}
                      style={{ background: "transparent", border: 0, color: "inherit", cursor: "pointer", padding: 0, marginLeft: 2, display: "inline-flex" }}>
                      <X size={11} aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 8, alignItems: "stretch" }}>
              <input ref={fileInputRef} type="file" multiple accept=".jpg,.jpeg,.png,.gif,.webp,.pdf,.docx" style={{ display: "none" }} onChange={e => addFiles(e.target.files)} />
              <Button variant="secondary" onClick={() => fileInputRef.current?.click()} title="ファイルを添付"
                style={{ height: "100%", paddingLeft: 14, paddingRight: 14, flexDirection: "column", gap: 2 }}>
                <Paperclip size={16} aria-hidden="true" />
                <span style={{ fontSize: 10, letterSpacing: "0.12em", fontWeight: 500 }}>添付</span>
              </Button>
              <textarea ref={textareaRef} className="textarea" rows={6} placeholder="治療内容や請求内容を入力、または保険ルールを質問"
                value={input}
                onChange={e => { setInput(e.target.value); adjustTextareaHeight(); }}
                onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); sendMessage(); } }}
                style={{ resize: "none", minHeight: "unset", padding: "8px 14px", overflowY: "hidden" }} />
              <Button onClick={sendMessage} disabled={loading || !input.trim()}
                style={{ height: "auto", paddingLeft: 18, paddingRight: 18, flexDirection: "column", gap: 4 }}>
                <Send size={18} aria-hidden="true" />
                送信
              </Button>
            </div>
            <div className="tiny soft" style={{ marginTop: 4, letterSpacing: "0.06em" }}>⌘ + Enter で送信</div>
          </div>
        </div>
      </section>

      {/* Delete confirm */}
      {deleteConfirmId && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setDeleteConfirmId(null)}>
          <div style={{ background: "#fff", borderRadius: 14, padding: 24, width: 300, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }}
            onClick={e => e.stopPropagation()}>
            <p style={{ margin: "0 0 6px", fontWeight: 600, fontSize: 15, color: "var(--ink)" }}>チャットを削除</p>
            <p style={{ margin: "0 0 20px", fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.6 }}>この相談履歴を削除します。取り消せません。</p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Button variant="ghost" onClick={() => setDeleteConfirmId(null)}>キャンセル</Button>
              <Button onClick={() => deleteSession(deleteConfirmId)} style={{ background: "#c53030", borderColor: "#c53030" }}>削除</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function InsuranceUserMessage({ text }: { text: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <div style={{ maxWidth: "78%", background: "var(--navy-deep)", color: "#f5efe1", borderRadius: "14px 14px 4px 14px", padding: "12px 16px", fontSize: 14, lineHeight: 1.7, whiteSpace: "pre-wrap", letterSpacing: "0.02em" }}>
        {text}
      </div>
    </div>
  );
}

function InsuranceAssistantMessage({ text, images, copied, onCopy }: {
  text: string; images?: ChatImage[]; copied: boolean; onCopy: () => void;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-start" }}>
      <div style={{ width: "100%" }}>
        <div className="row" style={{ marginBottom: 8, gap: 8 }}>
          <span style={{ width: 22, height: 22, borderRadius: 6, background: "#e8f0e8", color: "#2d6a2d", display: "inline-flex", alignItems: "center", justifyContent: "center", fontFamily: '"Noto Serif JP",serif', fontWeight: 600, fontSize: 11 }}>
            保
          </span>
          <span className="tiny" style={{ color: "#2d6a2d", fontWeight: 600, letterSpacing: "0.1em" }}>保険請求AI</span>
        </div>
        <div style={{ background: "#ffffff", border: "1px solid var(--line)", borderRadius: "4px 14px 14px 14px", padding: "14px 18px", fontSize: 14, lineHeight: 1.85, color: "var(--ink)" }}>
          <div className="prose-lite">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
          {images && images.length > 0 && (
            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="tiny" style={{ color: "var(--ink-muted)", letterSpacing: "0.08em" }}>関連資料の画像</div>
              {images.map((img, i) => (
                <div key={i} style={{ border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
                  <img src={img.url} alt={img.description} style={{ width: "100%", maxHeight: 320, objectFit: "contain", display: "block", background: "#f8f9fa" }} />
                  <div style={{ padding: "8px 12px", background: "var(--panel-deep)", borderTop: "1px solid var(--line-soft)" }}>
                    <div style={{ fontSize: 11, color: "var(--ink-muted)", marginBottom: 3 }}>{img.documentName.replace(/\.[^.]+$/, "")} — {img.page}ページ</div>
                    <div style={{ fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.6 }}>{img.description}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="row" style={{ marginTop: 10, gap: 6 }}>
          <button type="button" className="btn ghost sm" onClick={onCopy}>
            {copied ? <ClipboardCheck size={13} aria-hidden="true" /> : <Clipboard size={13} aria-hidden="true" />}
            コピー
          </button>
        </div>
      </div>
    </div>
  );
}
