"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronLeft, ChevronRight, Clipboard, ClipboardCheck, FileText, LayoutTemplate, MessageCircle, MoreHorizontal, Paperclip, Plus, Send, X } from "lucide-react";
import { Button } from "@/components/ui";

type ChatImage = { url: string; description: string; page: number; documentName: string };
type ChatMessage = { role: "user" | "assistant"; text: string; images?: ChatImage[] };
type SessionSummary = { id: string; title: string; type?: "chat" | "manual" | "document" | "slide" | "insurance" };

const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_FILES = 5;

export function ChatPanel({ onSwitchMode, onLoadManualSession, initialSessionId }: {
  onSwitchMode?: () => void;
  onLoadManualSession?: (id: string) => void;
  initialSessionId?: string | null;
}) {
  // Session management
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [bedrockSessionId, setBedrockSessionId] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");

  // Chat
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");

  // Attachments
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const LINE_HEIGHT = 22.4;
  const TEXTAREA_PADDING_V = 16;
  const MAX_TEXTAREA_HEIGHT = Math.round(LINE_HEIGHT * 7 + TEXTAREA_PADDING_V);

  function adjustTextareaHeight() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    const next = Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > MAX_TEXTAREA_HEIGHT ? "auto" : "hidden";
  }

  // Load sessions list on mount
  useEffect(() => {
    fetch("/api/chat-sessions")
      .then((r) => r.json())
      .then((data: { sessions: SessionSummary[] }) =>
        setSessions((data.sessions ?? []).filter(s => s.type !== "insurance"))
      )
      .catch(() => {});
  }, []);

  // Load session specified via URL param
  useEffect(() => {
    if (!initialSessionId) return;
    fetch(`/api/chat-sessions/${initialSessionId}`)
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((data: { messages?: ChatMessage[]; bedrockSessionId?: string }) => {
        setCurrentSessionId(initialSessionId);
        setMessages(data.messages ?? []);
        setBedrockSessionId(data.bedrockSessionId ?? "");
      })
      .catch(() => {});
  }, [initialSessionId]);

  // Auto scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

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
    addFiles(e.dataTransfer.files);
  }

  function addFiles(fileList: FileList | null) {
    if (!fileList) return;
    const errors: string[] = [];
    const valid: File[] = [];

    for (const file of Array.from(fileList)) {
      if (!ALLOWED_MIME_TYPES.includes(file.type)) {
        errors.push(`${file.name}: 対応していないファイル形式です`);
        continue;
      }
      if (file.size > MAX_FILE_SIZE) {
        errors.push(`${file.name}: ファイルサイズが10MBを超えています`);
        continue;
      }
      valid.push(file);
    }

    setAttachedFiles((prev) => {
      const combined = [...prev, ...valid];
      if (combined.length > MAX_FILES) {
        errors.push(`添付できるファイルは${MAX_FILES}件までです`);
        return combined.slice(0, MAX_FILES);
      }
      return combined;
    });

    if (errors.length > 0) setNotice(errors.join(" / "));
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeFile(index: number) {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
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

  function newChat() {
    setCurrentSessionId(null);
    setMessages([]);
    setBedrockSessionId("");
    setInput("");
    setNotice("");
    setAttachedFiles([]);
  }

  async function loadSession(session: SessionSummary) {
    if (session.type === "manual" || session.type === "slide") {
      onLoadManualSession?.(session.id);
      return;
    }
    if (session.id === currentSessionId || loading) return;
    try {
      const res = await fetch(`/api/chat-sessions/${session.id}`);
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { messages?: ChatMessage[]; bedrockSessionId?: string };
      setCurrentSessionId(session.id);
      setMessages(data.messages ?? []);
      setBedrockSessionId(data.bedrockSessionId ?? "");
      setInput("");
      setNotice("");
    } catch {
      setNotice("チャットの読み込みに失敗しました。");
    }
  }

  async function deleteSession(id: string) {
    try {
      await fetch(`/api/chat-sessions/${id}`, { method: "DELETE" });
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (currentSessionId === id) newChat();
    } catch {
      setNotice("削除に失敗しました。");
    }
    setDeleteConfirmId(null);
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
      setSessions((prev) =>
        prev.map((s) => (s.id === id ? { ...s, title: title.trim() } : s))
      );
    } catch {
      setNotice("名前の変更に失敗しました。");
    }
    setEditingId(null);
    setMenuOpenId(null);
  }

  async function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        resolve(result.split(",")[1] ?? "");
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function sendMessage() {
    const message = input.trim();
    if (!message || loading) return;

    const filesToSend = [...attachedFiles];
    const displayText =
      filesToSend.length > 0
        ? `${message}\n[添付: ${filesToSend.map((f) => f.name).join(", ")}]`
        : message;

    const prevMessages = messages;
    const withUser: ChatMessage[] = [
      ...messages,
      { role: "user", text: displayText },
    ];
    setMessages(withUser);
    setInput("");
    setAttachedFiles([]);
    setTimeout(adjustTextareaHeight, 0);
    setLoading(true);
    setNotice("");

    try {
      const attachments = await Promise.all(
        filesToSend.map(async (file) => ({
          name: file.name,
          type: file.type,
          data: await fileToBase64(file),
        }))
      );

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(bedrockSessionId ? { bedrockSessionId } : {}),
        }),
      });
      const data = (await res.json()) as {
        answer?: string;
        error?: string;
        bedrockSessionId?: string;
        images?: ChatImage[];
      };
      if (!res.ok) throw new Error(data.error || "Failed to chat");

      const assistantText =
        data.answer?.trim() ||
        "資料庫から該当する内容を見つけられませんでした。資料の同期状態を確認してください。";
      const allMessages: ChatMessage[] = [
        ...withUser,
        {
          role: "assistant",
          text: assistantText,
          ...(data.images && data.images.length > 0 ? { images: data.images } : {}),
        },
      ];
      setMessages(allMessages);

      const newBedrockSessionId = data.bedrockSessionId ?? "";
      setBedrockSessionId(newBedrockSessionId);

      const sessionId = currentSessionId ?? crypto.randomUUID();
      const title =
        sessions.find((s) => s.id === sessionId)?.title ?? message.slice(0, 30);

      fetch(`/api/chat-sessions/${sessionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: sessionId,
          title,
          bedrockSessionId: newBedrockSessionId,
          messages: allMessages,
        }),
      })
        .then((res) => {
          if (!res.ok) {
            res
              .json()
              .then((d: { error?: string }) => {
                console.error("[chat save] PUT failed:", d.error);
                setNotice(
                  "会話の保存に失敗しました。（管理者に連絡してください）"
                );
              })
              .catch(() => {
                setNotice("会話の保存に失敗しました。");
              });
          }
        })
        .catch((e) => {
          console.error("[chat save] network error:", e);
          setNotice("会話の保存に失敗しました（ネットワークエラー）。");
        });

      if (!currentSessionId) {
        setCurrentSessionId(sessionId);
        setSessions((prev) => [{ id: sessionId, title }, ...prev]);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "";
      setNotice(
        msg ? `回答生成に失敗しました。${msg}` : "回答生成に失敗しました。"
      );
      setMessages(prevMessages);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <section
        className="panel"
        style={{ display: "flex", flexDirection: "row", flex: 1, minHeight: 0 }}
      >
        {/* ── サイドバー ── */}
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
          {/* サイドバーヘッダー */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "10px 6px",
              borderBottom: "1px solid var(--line)",
              flexShrink: 0,
            }}
          >
            <button
              type="button"
              onClick={() => setSidebarOpen((v) => !v)}
              title={sidebarOpen ? "サイドバーを閉じる" : "サイドバーを開く"}
              style={{
                width: 28,
                height: 28,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: "none",
                background: "transparent",
                cursor: "pointer",
                borderRadius: 6,
                color: "var(--ink-soft)",
                flexShrink: 0,
              }}
            >
              {sidebarOpen ? (
                <ChevronLeft size={16} />
              ) : (
                <ChevronRight size={16} />
              )}
            </button>
            {sidebarOpen ? (
              <button
                type="button"
                onClick={newChat}
                title="新しいチャット"
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                  padding: "4px 6px",
                  border: "none",
                  background: "transparent",
                  cursor: "pointer",
                  borderRadius: 6,
                  color: "var(--ink-soft)",
                  fontSize: 12,
                  fontWeight: 500,
                  whiteSpace: "nowrap",
                }}
              >
                <Plus size={13} aria-hidden="true" />
                新しいチャット
              </button>
            ) : null}
          </div>

          {/* セッション一覧 */}
          {sidebarOpen ? (
            <div style={{ flex: 1, overflowY: "auto", padding: "6px 4px" }}>
              {sessions.length === 0 ? (
                <p
                  style={{
                    fontSize: 11,
                    color: "var(--ink-muted)",
                    padding: "12px 8px",
                    margin: 0,
                  }}
                >
                  履歴なし
                </p>
              ) : (
                sessions.map((session) => (
                  <div
                    key={session.id}
                    style={{ position: "relative", marginBottom: 1 }}
                    onMouseLeave={() => {
                      if (menuOpenId === session.id) setMenuOpenId(null);
                    }}
                  >
                    {editingId === session.id ? (
                      <input
                        autoFocus
                        value={editingTitle}
                        onChange={(e) => setEditingTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter")
                            renameSession(session.id, editingTitle);
                          if (e.key === "Escape") {
                            setEditingId(null);
                            setMenuOpenId(null);
                          }
                        }}
                        onBlur={() => renameSession(session.id, editingTitle)}
                        style={{
                          width: "100%",
                          fontSize: 12,
                          padding: "4px 6px",
                          border: "1px solid var(--navy)",
                          borderRadius: 4,
                          outline: "none",
                          background: "#fff",
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                          padding: "6px 4px 6px 8px",
                          borderRadius: 6,
                          background:
                            currentSessionId === session.id
                              ? "var(--navy-tint-soft)"
                              : "transparent",
                          cursor: "pointer",
                        }}
                        onClick={() => loadSession(session)}
                      >
                        {session.type === "slide" ? (
                          <LayoutTemplate
                            size={12}
                            style={{ flexShrink: 0, color: "#4a90d9" }}
                            aria-hidden="true"
                          />
                        ) : session.type === "manual" || session.type === "document" ? (
                          <FileText
                            size={12}
                            style={{ flexShrink: 0, color: "var(--ink-soft)" }}
                            aria-hidden="true"
                          />
                        ) : (
                          <MessageCircle
                            size={11}
                            style={{ flexShrink: 0, color: "var(--ink-faint)" }}
                            aria-hidden="true"
                          />
                        )}
                        <span
                          style={{
                            flex: 1,
                            fontSize: 12,
                            color:
                              currentSessionId === session.id
                                ? "var(--navy)"
                                : "var(--ink-soft)",
                            fontWeight:
                              currentSessionId === session.id ? 600 : 400,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {session.title}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setMenuOpenId(
                              menuOpenId === session.id ? null : session.id
                            );
                          }}
                          style={{
                            width: 20,
                            height: 20,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            border: "none",
                            background: "transparent",
                            cursor: "pointer",
                            borderRadius: 3,
                            color: "var(--ink-faint)",
                            flexShrink: 0,
                          }}
                        >
                          <MoreHorizontal size={12} aria-hidden="true" />
                        </button>
                      </div>
                    )}
                    {menuOpenId === session.id && (
                      <div
                        style={{
                          position: "absolute",
                          right: 0,
                          top: "100%",
                          zIndex: 50,
                          background: "#fff",
                          border: "1px solid var(--line)",
                          borderRadius: 6,
                          boxShadow: "0 4px 12px rgba(0,0,0,.12)",
                          minWidth: 120,
                          padding: "4px 0",
                        }}
                      >
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingId(session.id);
                            setEditingTitle(session.title);
                            setMenuOpenId(null);
                          }}
                          style={{
                            width: "100%",
                            textAlign: "left",
                            padding: "6px 12px",
                            fontSize: 12,
                            border: "none",
                            background: "none",
                            cursor: "pointer",
                            color: "var(--ink)",
                          }}
                        >
                          名前を変更
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteConfirmId(session.id);
                            setMenuOpenId(null);
                          }}
                          style={{
                            width: "100%",
                            textAlign: "left",
                            padding: "6px 12px",
                            fontSize: 12,
                            border: "none",
                            background: "none",
                            cursor: "pointer",
                            color: "#c0392b",
                          }}
                        >
                          削除
                        </button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          ) : null}
        </div>

        {/* ── チャットエリア ── */}
        <div
          style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, position: "relative" }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDragOver ? (
            <div style={{
              position: "absolute", inset: 0, zIndex: 10, pointerEvents: "none",
              background: "rgba(44,82,130,0.06)",
              border: "2px dashed var(--navy)",
              borderRadius: 16,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <span style={{ color: "var(--navy)", fontSize: 14, fontWeight: 600, letterSpacing: "0.08em" }}>
                ここにドロップして添付
              </span>
            </div>
          ) : null}
          <div className="panel-head">
            <div className="row" style={{ gap: 10 }}>
              <span className="panel-title">会話</span>
              <span className="panel-sub">
                {messages.filter((m) => m.role === "user").length} 件の質問
              </span>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <span className="dot ok" />
              <span className="tiny soft">資料の読み込み完了</span>
            </div>
          </div>

          {/* メッセージ一覧 */}
          <div
            style={{
              flex: 1,
              minHeight: 0,
              padding: "28px 28px 8px",
              display: "flex",
              flexDirection: "column",
              gap: 22,
              overflowY: "auto",
            }}
          >
            {messages.length === 0 && !loading ? (
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--ink-faint)",
                  gap: 10,
                  padding: 32,
                }}
              >
                <MessageCircle size={32} strokeWidth={1.2} aria-hidden="true" />
                <p
                  style={{
                    margin: 0,
                    fontSize: 13,
                    textAlign: "center",
                    lineHeight: 1.8,
                  }}
                >
                  質問を入力してチャットを開始してください
                </p>
              </div>
            ) : null}
            {messages.map((msg, index) =>
              msg.role === "user" ? (
                <UserMessage key={index} text={msg.text} />
              ) : (
                <AssistantMessage
                  key={index}
                  text={msg.text}
                  images={msg.images}
                  copied={copiedMessageIndex === index}
                  onCopy={() => copyMessage(msg.text, index)}
                />
              )
            )}
            {loading ? (
              <div
                className="row"
                style={{ color: "var(--ink-muted)", fontSize: 13 }}
              >
                <span
                  className="dot ok"
                  style={{ animation: "pulse 1.2s infinite" }}
                />
                資料から該当箇所を探しています…
              </div>
            ) : null}
            {notice ? (
              <p className="tag accent" style={{ alignSelf: "flex-start" }}>
                {notice}
              </p>
            ) : null}
            <div ref={messagesEndRef} />
          </div>

          {/* 入力エリア */}
          <div
            style={{
              borderTop: "1px solid var(--line)",
              padding: "10px 14px",
              background: "var(--panel-deep)",
              borderBottomRightRadius: 16,
            }}
          >
            {/* 添付ファイルチップ */}
            {attachedFiles.length > 0 ? (
              <div
                className="row"
                style={{ flexWrap: "wrap", gap: 6, marginBottom: 10 }}
              >
                <span
                  className="tiny soft"
                  style={{ letterSpacing: "0.14em" }}
                >
                  添付：
                </span>
                {attachedFiles.map((file, i) => (
                  <span key={i} className="tag">
                    <span className="truncate" style={{ maxWidth: 180 }}>
                      {file.name}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeFile(i)}
                      style={{
                        background: "transparent",
                        border: 0,
                        color: "inherit",
                        cursor: "pointer",
                        padding: 0,
                        marginLeft: 2,
                        display: "inline-flex",
                      }}
                      title="添付を外す"
                    >
                      <X size={11} aria-hidden="true" />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}

            <div
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr auto auto",
                gap: 8,
                alignItems: "stretch",
              }}
            >
              {/* 添付ボタン */}
              <input
                ref={fileInputRef}
                type="file"
                multiple
                accept=".jpg,.jpeg,.png,.gif,.webp,.pdf,.docx"
                style={{ display: "none" }}
                onChange={(e) => addFiles(e.target.files)}
              />
              <Button
                variant="secondary"
                onClick={() => fileInputRef.current?.click()}
                title="ファイルを添付（画像・PDF・DOCX）"
                style={{
                  height: "100%",
                  paddingLeft: 14,
                  paddingRight: 14,
                  flexDirection: "column",
                  gap: 2,
                }}
              >
                <Paperclip size={16} aria-hidden="true" />
                <span
                  style={{
                    fontSize: 10,
                    letterSpacing: "0.12em",
                    fontWeight: 500,
                  }}
                >
                  添付
                </span>
              </Button>

              <textarea
                ref={textareaRef}
                className="textarea"
                rows={6}
                placeholder="質問を入力"
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  adjustTextareaHeight();
                }}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                style={{
                  resize: "none",
                  minHeight: "unset",
                  padding: "8px 14px",
                  overflowY: "hidden",
                }}
              />
              <Button
                onClick={sendMessage}
                disabled={loading || !input.trim()}
                style={{
                  height: "auto",
                  paddingLeft: 18,
                  paddingRight: 18,
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                <Send size={18} aria-hidden="true" />
                送信
              </Button>
              {onSwitchMode ? (
                <button
                  type="button"
                  onClick={onSwitchMode}
                  title="マニュアル作成モード"
                  style={{
                    width: 44,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 2,
                    border: "1px solid var(--line)",
                    borderRadius: "var(--radius)",
                    background: "transparent",
                    cursor: "pointer",
                    color: "var(--ink-soft)",
                    fontSize: 10,
                    letterSpacing: "0.1em",
                    fontWeight: 500,
                  }}
                >
                  <FileText size={16} aria-hidden="true" />
                  <span>作成</span>
                </button>
              ) : null}
            </div>
            <div
              className="tiny soft"
              style={{ marginTop: 4, letterSpacing: "0.06em" }}
            >
              ⌘ + Enter で送信
            </div>
          </div>
        </div>
      </section>

      {/* 削除確認ダイアログ */}
      {deleteConfirmId ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
          onClick={() => setDeleteConfirmId(null)}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 14,
              padding: 24,
              width: 300,
              boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <p
              style={{
                margin: "0 0 6px",
                fontWeight: 600,
                fontSize: 15,
                color: "var(--ink)",
              }}
            >
              チャットを削除
            </p>
            <p
              style={{
                margin: "0 0 20px",
                fontSize: 13,
                color: "var(--ink-soft)",
                lineHeight: 1.6,
              }}
            >
              このチャットの履歴を削除します。この操作は取り消せません。
            </p>
            <div
              style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}
            >
              <Button
                variant="ghost"
                onClick={() => setDeleteConfirmId(null)}
              >
                キャンセル
              </Button>
              <Button
                onClick={() => deleteSession(deleteConfirmId)}
                style={{ background: "#c53030", borderColor: "#c53030" }}
              >
                削除
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function ImageStrip({ images }: { images: ChatImage[] }) {
  const [lightbox, setLightbox] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ dragging: boolean; startX: number; startY: number; scrollLeft: number; scrollTop: number }>({
    dragging: false, startX: 0, startY: 0, scrollLeft: 0, scrollTop: 0,
  });

  // ズーム変更後にスクロール位置を中央に合わせる
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
    el.scrollTop  = (el.scrollHeight - el.clientHeight) / 2;
  }, [zoom]);

  function openAt(i: number) { setLightbox(i); setZoom(1); }
  function close() { setLightbox(null); setZoom(1); }
  function prev() { setLightbox(l => (l ?? 1) - 1); setZoom(1); }
  function next() { setLightbox(l => (l ?? 0) + 1); setZoom(1); }
  function zoomIn()    { setZoom(z => Math.min(4, +(z + 0.25).toFixed(2))); }
  function zoomOut()   { setZoom(z => Math.max(0.5, +(z - 0.25).toFixed(2))); }
  function zoomReset() { setZoom(1); }

  function handleWheel(e: React.WheelEvent) {
    e.preventDefault();
    setZoom(z => Math.max(0.5, Math.min(4, +(z * (e.deltaY > 0 ? 0.9 : 1.1)).toFixed(2))));
  }

  function handleMouseDown(e: React.MouseEvent) {
    if (zoom <= 1) return;
    e.preventDefault();
    const el = scrollRef.current;
    if (!el) return;
    dragRef.current = { dragging: true, startX: e.clientX, startY: e.clientY, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop };
  }

  function handleMouseMove(e: React.MouseEvent) {
    const d = dragRef.current;
    if (!d.dragging) return;
    e.preventDefault();
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = d.scrollLeft - (e.clientX - d.startX);
    el.scrollTop  = d.scrollTop  - (e.clientY - d.startY);
  }

  function handleMouseUp() { dragRef.current.dragging = false; }

  return (
    <>
      <div style={{ marginTop: 14 }}>
        <div className="tiny" style={{ color: "var(--ink-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
          関連資料の画像 {images.length}枚
        </div>
        <div style={{ display: "flex", gap: 10, overflowX: "auto", paddingBottom: 8 }}>
          {images.map((img, i) => (
            <button key={i} type="button" onClick={() => openAt(i)}
              style={{ flexShrink: 0, width: 210, border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden", background: "#f0f0ee", cursor: "zoom-in", padding: 0 }}
              title={`${img.documentName.replace(/\.[^.]+$/, "")} p.${img.page}`}
            >
              <img src={img.url} alt="" style={{ width: "100%", aspectRatio: "3/4", objectFit: "contain", display: "block" }} />
              <div style={{ padding: "5px 10px", background: "var(--panel-deep)", borderTop: "1px solid var(--line-soft)", display: "flex", justifyContent: "space-between" }}>
                <span style={{ fontSize: 11, color: "var(--ink-muted)" }}>p.{img.page}</span>
                <span style={{ fontSize: 11, color: "var(--ink-faint)" }}>{i + 1}/{images.length}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {lightbox !== null ? (
        <div onClick={close}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.88)", zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
        >
          <div onClick={e => e.stopPropagation()}
            style={{ background: "#fff", borderRadius: 12, overflow: "hidden", width: "min(96vw, 1100px)", maxHeight: "96vh", display: "flex", flexDirection: "column" }}
          >
            {/* ツールバー */}
            <div style={{ background: "#1e1e1e", padding: "8px 12px", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
              <button type="button" onClick={prev} disabled={lightbox === 0}
                style={{ background: "none", border: "1px solid rgba(255,255,255,0.3)", color: "#fff", borderRadius: 5, padding: "3px 10px", cursor: lightbox === 0 ? "default" : "pointer", fontSize: 18, opacity: lightbox === 0 ? 0.3 : 1 }}>‹</button>
              <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 12, minWidth: 48, textAlign: "center" }}>{lightbox + 1} / {images.length}</span>
              <button type="button" onClick={next} disabled={lightbox === images.length - 1}
                style={{ background: "none", border: "1px solid rgba(255,255,255,0.3)", color: "#fff", borderRadius: 5, padding: "3px 10px", cursor: lightbox === images.length - 1 ? "default" : "pointer", fontSize: 18, opacity: lightbox === images.length - 1 ? 0.3 : 1 }}>›</button>
              <div style={{ flex: 1 }} />
              <button type="button" onClick={zoomOut}
                style={{ background: "none", border: "1px solid rgba(255,255,255,0.3)", color: "#fff", borderRadius: 5, padding: "3px 10px", cursor: "pointer", fontSize: 15 }}>－</button>
              <button type="button" onClick={zoomReset}
                style={{ background: "none", border: "1px solid rgba(255,255,255,0.3)", color: "rgba(255,255,255,0.8)", borderRadius: 5, padding: "3px 8px", cursor: "pointer", fontSize: 11, minWidth: 44, textAlign: "center" }}>{Math.round(zoom * 100)}%</button>
              <button type="button" onClick={zoomIn}
                style={{ background: "none", border: "1px solid rgba(255,255,255,0.3)", color: "#fff", borderRadius: 5, padding: "3px 10px", cursor: "pointer", fontSize: 15 }}>＋</button>
              <button type="button" onClick={close}
                style={{ background: "none", border: "1px solid rgba(255,255,255,0.3)", color: "#fff", borderRadius: 5, padding: "3px 10px", cursor: "pointer", fontSize: 14, marginLeft: 8 }}>✕</button>
            </div>

            {/* 画像エリア */}
            <div
              ref={scrollRef}
              onWheel={handleWheel}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
              style={{ background: "#111", overflow: "auto", cursor: zoom > 1 ? (dragRef.current.dragging ? "grabbing" : "grab") : "default", flexShrink: 0, height: "72vh", userSelect: "none" }}
            >
              {/* スクロール領域をzoomに応じて拡大 → 画像は中央に配置 */}
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: `${Math.max(100, zoom * 100)}%`,
                height: `${Math.max(72, zoom * 72)}vh`,
                minWidth: "100%", minHeight: "72vh",
              }}>
                <img src={images[lightbox].url} alt="" draggable={false}
                  style={{ width: "100%", height: "100%", objectFit: "contain", display: "block", userSelect: "none" }}
                />
              </div>
            </div>

            {/* 説明 */}
            <div style={{ padding: "12px 18px", borderTop: "1px solid var(--line-soft)", overflowY: "auto", maxHeight: "20vh", flexShrink: 0 }}>
              <div style={{ fontSize: 11, color: "var(--ink-muted)", marginBottom: 5, letterSpacing: "0.05em" }}>
                {images[lightbox].documentName.replace(/\.[^.]+$/, "")} — {images[lightbox].page}ページ
              </div>
              <div style={{ fontSize: 13, color: "var(--ink)", lineHeight: 1.75 }}>{images[lightbox].description}</div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function UserMessage({ text }: { text: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <div
        style={{
          maxWidth: "78%",
          background: "var(--navy-deep)",
          color: "#f5efe1",
          borderRadius: "14px 14px 4px 14px",
          padding: "12px 16px",
          fontSize: 14,
          lineHeight: 1.7,
          whiteSpace: "pre-wrap",
          letterSpacing: "0.02em",
        }}
      >
        {text}
      </div>
    </div>
  );
}

function AssistantMessage({
  text,
  images,
  copied,
  onCopy,
}: {
  text: string;
  images?: ChatImage[];
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-start" }}>
      <div style={{ width: "100%" }}>
        <div className="row" style={{ marginBottom: 8, gap: 8 }}>
          <span
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              background: "var(--navy-tint)",
              color: "var(--navy-deep)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontFamily: '"Noto Serif JP",serif',
              fontWeight: 600,
              fontSize: 11,
            }}
          >
            知
          </span>
          <span
            className="tiny"
            style={{
              color: "var(--navy-deep)",
              fontWeight: 600,
              letterSpacing: "0.1em",
            }}
          >
            院内ナレッジ
          </span>
        </div>
        <div
          style={{
            background: "#ffffff",
            border: "1px solid var(--line)",
            borderRadius: "4px 14px 14px 14px",
            padding: "14px 18px",
            fontSize: 14,
            lineHeight: 1.85,
            color: "var(--ink)",
          }}
        >
          <div className="prose-lite">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
          {images && images.length > 0 ? (
            <ImageStrip images={images} />
          ) : null}
        </div>
        <div
          className="row"
          style={{ marginTop: 10, gap: 6, flexWrap: "wrap" }}
        >
          <span
            className="tiny soft"
            style={{ letterSpacing: "0.14em" }}
          >
            出典
          </span>
          <span className="tag accent">
            <span className="truncate" style={{ maxWidth: 220 }}>
              院内資料
            </span>
            <span style={{ opacity: 0.75 }}>p.—</span>
          </span>
          <button
            type="button"
            className="btn ghost sm"
            style={{ marginLeft: 4 }}
            onClick={onCopy}
          >
            {copied ? (
              <ClipboardCheck size={13} aria-hidden="true" />
            ) : (
              <Clipboard size={13} aria-hidden="true" />
            )}
            コピー
          </button>
        </div>
      </div>
    </div>
  );
}
