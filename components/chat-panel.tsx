"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, ChevronLeft, ChevronRight, Clipboard, ClipboardCheck, FileText, MessageCircle, MoreHorizontal, Plus, Search, Send, Trash2, Wrench, X } from "lucide-react";
import { Button } from "@/components/ui";
import { type StoredFileMetadata } from "@/lib/file-assets";

type ChatMessage = { role: "user" | "assistant"; text: string };
type SessionSummary = { id: string; title: string; type?: "chat" | "manual" };

export function ChatPanel({ onSwitchMode, onLoadManualSession }: {
  onSwitchMode?: () => void;
  onLoadManualSession?: (id: string) => void;
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

  // File picker
  const [repositoryFiles, setRepositoryFiles] = useState<StoredFileMetadata[]>([]);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [fileQuery, setFileQuery] = useState("");
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);

  const filePickerRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const selectedRepositoryFiles = useMemo(
    () => repositoryFiles.filter((f) => selectedFileIds.includes(f.id)),
    [repositoryFiles, selectedFileIds]
  );
  const filteredRepositoryFiles = useMemo(
    () => repositoryFiles.filter((f) => f.fileName.toLowerCase().includes(fileQuery.toLowerCase())),
    [fileQuery, repositoryFiles]
  );

  // Load sessions list on mount
  useEffect(() => {
    fetch("/api/chat-sessions")
      .then((r) => r.json())
      .then((data: { sessions: SessionSummary[] }) => setSessions(data.sessions ?? []))
      .catch(() => {});
  }, []);

  // Load repository files
  useEffect(() => {
    let ignore = false;
    fetch("/api/files", { cache: "no-store" })
      .then((r) => r.json())
      .then((data: { files: StoredFileMetadata[] }) => { if (!ignore) setRepositoryFiles(data.files); })
      .catch(() => {});
    return () => { ignore = true; };
  }, []);

  // Close file picker on outside click
  useEffect(() => {
    function handlePointerDown(e: PointerEvent) {
      if (filePickerRef.current && !filePickerRef.current.contains(e.target as Node)) {
        setFilePickerOpen(false);
      }
    }
    if (filePickerOpen) document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [filePickerOpen]);

  // Auto scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  function toggleFile(id: string) {
    setSelectedFileIds((cur) => cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]);
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
  }

  async function loadSession(session: SessionSummary) {
    if (session.type === "manual") {
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
      setSessions(prev => prev.map(s => s.id === id ? { ...s, title: title.trim() } : s));
    } catch {
      setNotice("名前の変更に失敗しました。");
    }
    setEditingId(null);
    setMenuOpenId(null);
  }

  async function sendMessage() {
    const message = input.trim();
    if (!message || loading) return;

    const prevMessages = messages;
    const withUser: ChatMessage[] = [...messages, { role: "user", text: message }];
    setMessages(withUser);
    setInput("");
    setLoading(true);
    setNotice("");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          files: selectedRepositoryFiles.map((f) => ({
            id: f.id,
            fileName: f.fileName,
            s3Key: f.s3Key,
            summaryKey: f.summaryKey,
            knowledgeBaseKey: f.knowledgeBaseKey,
            extractedTextKey: f.extractedTextKey
          })),
          ...(bedrockSessionId ? { bedrockSessionId } : {})
        })
      });
      const data = (await res.json()) as { answer?: string; error?: string; bedrockSessionId?: string };
      if (!res.ok) throw new Error(data.error || "Failed to chat");

      const assistantText =
        data.answer?.trim() ||
        "資料庫から該当する内容を見つけられませんでした。資料の同期状態を確認してください。";
      const allMessages: ChatMessage[] = [...withUser, { role: "assistant", text: assistantText }];
      setMessages(allMessages);

      const newBedrockSessionId = data.bedrockSessionId ?? "";
      setBedrockSessionId(newBedrockSessionId);

      // Persist to S3 (non-blocking but check for errors)
      const sessionId = currentSessionId ?? crypto.randomUUID();
      const title =
        sessions.find((s) => s.id === sessionId)?.title ?? message.slice(0, 30);

      fetch(`/api/chat-sessions/${sessionId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: sessionId, title, bedrockSessionId: newBedrockSessionId, messages: allMessages })
      }).then((res) => {
        if (!res.ok) {
          res.json().then((d: { error?: string }) => {
            console.error("[chat save] PUT failed:", d.error);
            setNotice("会話の保存に失敗しました。（管理者に連絡してください）");
          }).catch(() => {
            setNotice("会話の保存に失敗しました。");
          });
        }
      }).catch((e) => {
        console.error("[chat save] network error:", e);
        setNotice("会話の保存に失敗しました（ネットワークエラー）。");
      });

      if (!currentSessionId) {
        setCurrentSessionId(sessionId);
        setSessions((prev) => [{ id: sessionId, title }, ...prev]);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "";
      setNotice(msg ? `回答生成に失敗しました。${msg}` : "回答生成に失敗しました。");
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
              {sidebarOpen ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
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
                <p style={{ fontSize: 11, color: "var(--ink-muted)", padding: "12px 8px", margin: 0 }}>
                  履歴なし
                </p>
              ) : (
                sessions.map((session) => (
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
                        style={{
                          width: "100%", fontSize: 12, padding: "4px 6px",
                          border: "1px solid var(--navy)", borderRadius: 4,
                          outline: "none", background: "#fff",
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          display: "flex", alignItems: "center", gap: 4,
                          padding: "6px 4px 6px 8px", borderRadius: 6,
                          background: currentSessionId === session.id ? "var(--navy-tint-soft)" : "transparent",
                          cursor: "pointer",
                        }}
                        onClick={() => loadSession(session)}
                      >
                        {session.type === "manual"
                          ? <Wrench size={11} style={{ flexShrink: 0, color: "var(--ink-faint)" }} aria-hidden="true" />
                          : <MessageCircle size={11} style={{ flexShrink: 0, color: "var(--ink-faint)" }} aria-hidden="true" />
                        }
                        <span style={{
                          flex: 1, fontSize: 12,
                          color: currentSessionId === session.id ? "var(--navy)" : "var(--ink-soft)",
                          fontWeight: currentSessionId === session.id ? 600 : 400,
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }}>
                          {session.title}
                        </span>
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); setMenuOpenId(menuOpenId === session.id ? null : session.id); }}
                          style={{
                            width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center",
                            border: "none", background: "transparent", cursor: "pointer", borderRadius: 3,
                            color: "var(--ink-faint)", flexShrink: 0,
                          }}
                        >
                          <MoreHorizontal size={12} aria-hidden="true" />
                        </button>
                      </div>
                    )}
                    {menuOpenId === session.id && (
                      <div style={{
                        position: "absolute", right: 0, top: "100%", zIndex: 50,
                        background: "#fff", border: "1px solid var(--line)", borderRadius: 6,
                        boxShadow: "0 4px 12px rgba(0,0,0,.12)", minWidth: 120, padding: "4px 0",
                      }}>
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); setEditingId(session.id); setEditingTitle(session.title); setMenuOpenId(null); }}
                          style={{ width: "100%", textAlign: "left", padding: "6px 12px", fontSize: 12, border: "none", background: "none", cursor: "pointer", color: "var(--ink)" }}
                        >名前を変更</button>
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); setDeleteConfirmId(session.id); setMenuOpenId(null); }}
                          style={{ width: "100%", textAlign: "left", padding: "6px 12px", fontSize: 12, border: "none", background: "none", cursor: "pointer", color: "#c0392b" }}
                        >削除</button>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          ) : null}
        </div>

        {/* ── チャットエリア ── */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
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
                <p style={{ margin: 0, fontSize: 13, textAlign: "center", lineHeight: 1.8 }}>
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
                  copied={copiedMessageIndex === index}
                  onCopy={() => copyMessage(msg.text, index)}
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
            <div ref={messagesEndRef} />
          </div>

          {/* 入力エリア */}
          <div
            style={{
              borderTop: "1px solid var(--line)",
              padding: 18,
              background: "var(--panel-deep)",
              borderBottomRightRadius: 16,
            }}
          >
            {selectedRepositoryFiles.length > 0 ? (
              <div className="row" style={{ flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                <span className="tiny soft" style={{ letterSpacing: "0.14em" }}>参照：</span>
                {selectedRepositoryFiles.map((file) => (
                  <span key={file.id} className="tag">
                    <span className="truncate" style={{ maxWidth: 180 }}>
                      {file.fileName.replace(/\.[^.]+$/, "")}
                    </span>
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

            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto auto", gap: 8, alignItems: "stretch" }}>
              <div style={{ position: "relative" }} ref={filePickerRef}>
                <Button
                  variant="secondary"
                  onClick={() => setFilePickerOpen((cur) => !cur)}
                  title="参照する資料を選ぶ"
                  style={{ height: "100%", paddingLeft: 14, paddingRight: 14, flexDirection: "column", gap: 2 }}
                >
                  <Plus size={16} aria-hidden="true" />
                  <span style={{ fontSize: 10, letterSpacing: "0.12em", fontWeight: 500 }}>資料を選ぶ</span>
                </Button>
                {filePickerOpen ? (
                  <div
                    style={{
                      position: "absolute",
                      bottom: "calc(100% + 8px)",
                      left: 0,
                      width: 360,
                      maxWidth: "calc(100vw - 32px)",
                      background: "#fff",
                      border: "1px solid var(--line)",
                      borderRadius: 12,
                      boxShadow: "var(--shadow-lg)",
                      padding: 14,
                      zIndex: 20,
                    }}
                  >
                    <div className="between" style={{ marginBottom: 10 }}>
                      <span className="panel-title" style={{ fontSize: 13 }}>参照する資料</span>
                      <button type="button" onClick={() => setFilePickerOpen(false)} className="btn ghost sm icon" title="閉じる">
                        <X size={14} aria-hidden="true" />
                      </button>
                    </div>
                    <div style={{ position: "relative", marginBottom: 10 }}>
                      <Search size={14} style={{ position: "absolute", left: 12, top: 12, color: "var(--ink-muted)" }} aria-hidden="true" />
                      <input
                        className="input"
                        placeholder="ファイル名で探す"
                        style={{ paddingLeft: 34, height: 36 }}
                        value={fileQuery}
                        onChange={(e) => setFileQuery(e.target.value)}
                      />
                    </div>
                    <div className="between" style={{ marginBottom: 8 }}>
                      <span className="tiny soft">未選択の場合は院内すべての資料から探します</span>
                      {selectedFileIds.length > 0 ? (
                        <button type="button" onClick={() => setSelectedFileIds([])} className="btn ghost sm">
                          すべて外す
                        </button>
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
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 10,
                              padding: "8px 10px",
                              background: selected ? "var(--navy-tint-soft)" : "transparent",
                              border: `1px solid ${selected ? "var(--navy-tint)" : "transparent"}`,
                              borderRadius: 8,
                              textAlign: "left",
                              cursor: "pointer",
                            }}
                          >
                            <span
                              style={{
                                width: 18,
                                height: 18,
                                borderRadius: 4,
                                border: `1.5px solid ${selected ? "var(--navy)" : "#c8c4b5"}`,
                                background: selected ? "var(--navy)" : "transparent",
                                color: "#fff",
                                display: "inline-flex",
                                alignItems: "center",
                                justifyContent: "center",
                              }}
                            >
                              {selected ? <Check size={12} aria-hidden="true" /> : null}
                            </span>
                            <span className="stack" style={{ minWidth: 0, flex: 1 }}>
                              <span className="truncate" style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }}>
                                {file.fileName.replace(/\.[^.]+$/, "")}
                              </span>
                              <span className="tiny soft truncate">
                                {file.sizeLabel || file.thumbnailLabel || "資料"}
                              </span>
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
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                style={{ resize: "none" }}
              />
              <Button
                onClick={sendMessage}
                disabled={loading || !input.trim()}
                style={{ height: "auto", paddingLeft: 18, paddingRight: 18, flexDirection: "column", gap: 4 }}
              >
                <Send size={18} aria-hidden="true" />
                送信
              </Button>
              {onSwitchMode ? (
                <button
                  type="button"
                  onClick={onSwitchMode}
                  title="マニュアル作成モード"
                  style={{ width: 44, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, border: "1px solid var(--line)", borderRadius: "var(--radius)", background: "transparent", cursor: "pointer", color: "var(--ink-soft)", fontSize: 10, letterSpacing: "0.1em", fontWeight: 500 }}
                >
                  <FileText size={16} aria-hidden="true" />
                  <span>作成</span>
                </button>
              ) : null}
            </div>
            <div className="tiny soft" style={{ marginTop: 8, letterSpacing: "0.06em" }}>
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
            <p style={{ margin: "0 0 6px", fontWeight: 600, fontSize: 15, color: "var(--ink)" }}>
              チャットを削除
            </p>
            <p style={{ margin: "0 0 20px", fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.6 }}>
              このチャットの履歴を削除します。この操作は取り消せません。
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <Button variant="ghost" onClick={() => setDeleteConfirmId(null)}>
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
  copied,
  onCopy,
}: {
  text: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-start" }}>
      <div style={{ maxWidth: "84%" }}>
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
          <span className="tiny" style={{ color: "var(--navy-deep)", fontWeight: 600, letterSpacing: "0.1em" }}>
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
        </div>
        <div className="row" style={{ marginTop: 10, gap: 6, flexWrap: "wrap" }}>
          <span className="tiny soft" style={{ letterSpacing: "0.14em" }}>出典</span>
          <span className="tag accent">
            <span className="truncate" style={{ maxWidth: 220 }}>院内資料</span>
            <span style={{ opacity: 0.75 }}>p.—</span>
          </span>
          <button type="button" className="btn ghost sm" style={{ marginLeft: 4 }} onClick={onCopy}>
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
