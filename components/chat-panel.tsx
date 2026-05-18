"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Clipboard, ClipboardCheck, FileText, Plus, Send, Sparkles, X } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { type ManualMetadata } from "@/lib/manuals";

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
};

const initialMessages: ChatMessage[] = [
  {
    role: "assistant",
    text: "院内マニュアルを参照して回答します。資料を追加・同期した後に質問してください。"
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
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);
  const manualPickerRef = useRef<HTMLDivElement | null>(null);

  const selectedManuals = useMemo(
    () => manuals.filter((manual) => selectedManualIds.includes(manual.id)),
    [manuals, selectedManualIds]
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
      if (!manualPickerRef.current) {
        return;
      }

      if (!manualPickerRef.current.contains(event.target as Node)) {
        setManualPickerOpen(false);
      }
    }

    if (manualPickerOpen) {
      document.addEventListener("pointerdown", handlePointerDown);
    }

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
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
            s3Key: manual.s3Key,
            extractedTextKey: manual.extractedTextKey
          }))
        })
      });
      if (!response.ok) {
        throw new Error("Failed to chat");
      }
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
            "回答を生成できませんでした。資料が同期済みか、質問内容が資料内にあるか確認してください。"
        }
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      setNotice(
        message
          ? `回答生成に失敗しました。${message}`
          : "回答生成に失敗しました。同期状態、Bedrockモデルアクセス、SSO期限を確認してください。"
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
      <section className="min-h-[620px] rounded-md border border-[var(--line)] bg-white">
        <div className="border-b border-[var(--line)] px-5 py-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-[#253041]">
            <Sparkles size={18} className="text-[var(--primary)]" aria-hidden="true" />
            チャット
          </div>
        </div>

        <div className="space-y-4 px-5 py-5">
          {messages.map((message, index) => (
            <div
              key={`${message.role}-${index}`}
              className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div className="group relative max-w-[78%]">
                <div
                  className={`rounded-md px-4 py-3 text-sm leading-6 ${
                    message.role === "user"
                      ? "bg-[var(--primary)] text-white"
                      : "border border-[var(--line)] bg-[#f8fafb] text-[#253041]"
                  }`}
                >
                  {message.role === "assistant" ? (
                    <MarkdownMessage text={message.text} />
                  ) : (
                    <span className="whitespace-pre-wrap">{message.text}</span>
                  )}
                </div>
                {message.role === "assistant" ? (
                  <button
                    type="button"
                    className="absolute -right-2 -top-2 inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--line)] bg-white text-[#394452] opacity-0 shadow-sm transition hover:bg-[#f0f3f6] group-hover:opacity-100 focus:opacity-100"
                    title="回答をコピー"
                    onClick={() => copyMessage(message.text, index)}
                  >
                    {copiedMessageIndex === index ? (
                      <ClipboardCheck size={16} aria-hidden="true" />
                    ) : (
                      <Clipboard size={16} aria-hidden="true" />
                    )}
                  </button>
                ) : null}
              </div>
            </div>
          ))}
          {loading ? (
            <div className="text-sm text-[var(--muted)]">回答を生成しています。</div>
          ) : null}
          {notice ? (
            <p className="rounded-md border border-[#f0d8b8] bg-[#fff8ed] px-3 py-2 text-sm text-[#7a4a11]">
              {notice}
            </p>
          ) : null}
        </div>

        <div className="mt-auto border-t border-[var(--line)] p-4">
          {selectedManuals.length > 0 ? (
            <div className="mb-3 flex flex-wrap gap-2">
              {selectedManuals.map((manual) => (
                <span
                  key={manual.id}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-[#d7e7e4] bg-[#eef8f6] px-2 py-1 text-xs font-semibold text-[var(--primary-dark)]"
                >
                  <span className="max-w-56 truncate">{manual.fileName}</span>
                  <button
                    type="button"
                    title="参照から外す"
                    onClick={() => toggleManual(manual.id)}
                  >
                    <X size={13} aria-hidden="true" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <div className="flex gap-2">
            <div className="relative" ref={manualPickerRef}>
              <Button
                variant="secondary"
                className="h-24 w-12 px-0"
                title="参照マニュアルを選択"
                onClick={() => setManualPickerOpen((current) => !current)}
              >
                <Plus size={20} aria-hidden="true" />
              </Button>
              {manualPickerOpen ? (
                <div className="absolute bottom-28 left-0 z-20 w-[min(360px,calc(100vw-2.5rem))] rounded-md border border-[var(--line)] bg-white p-3 shadow-lg">
                  <div className="mb-2 flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-[#253041]">参照マニュアル</h2>
                    <button
                      type="button"
                      className="text-xs font-semibold text-[var(--primary-dark)]"
                      onClick={() => setSelectedManualIds([])}
                    >
                      解除
                    </button>
                  </div>
                  <p className="mb-3 text-xs leading-5 text-[var(--muted)]">
                    選択時はその資料だけを検索対象にします。
                  </p>
                  <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                    {manuals.length === 0 ? (
                      <p className="text-sm text-[var(--muted)]">アップロード済み資料がありません。</p>
                    ) : null}
                    {manuals.map((manual) => {
                      const selected = selectedManualIds.includes(manual.id);
                      return (
                        <button
                          key={manual.id}
                          type="button"
                          className={`flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left transition ${
                            selected
                              ? "border-[#99d4cc] bg-[#e6f3f1]"
                              : "border-[var(--line)] bg-white hover:bg-[#f5f7f9]"
                          }`}
                          onClick={() => toggleManual(manual.id)}
                        >
                          <span
                            className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                              selected
                                ? "border-[var(--primary)] bg-[var(--primary)] text-white"
                                : "border-[#b8c3cf] bg-white"
                            }`}
                          >
                            {selected ? <Check size={14} aria-hidden="true" /> : null}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold text-[#253041]">
                              {manual.fileName}
                            </span>
                            <span className="mt-1 block text-xs text-[var(--muted)]">
                              {manual.categories.join(", ") || "未分類"}
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
              className="min-h-24 flex-1 resize-none rounded-md border border-[var(--line)] bg-white px-3 py-2 text-sm leading-6 outline-none"
              placeholder="例: インプラント術前説明の要点を受付向けにまとめて"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                  sendMessage();
                }
              }}
            />
            <Button className="h-24 w-24 self-stretch" disabled={loading} onClick={sendMessage}>
              <Send size={18} aria-hidden="true" />
              送信
            </Button>
          </div>
        </div>
      </section>

      <aside className="space-y-4">
        <section className="rounded-md border border-[var(--line)] bg-white p-4">
          <h2 className="text-sm font-semibold text-[#253041]">現在の接続</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge>S3保存</Badge>
            <Badge>Bedrock KB</Badge>
            <Badge>RAG回答</Badge>
          </div>
        </section>
        <section className="rounded-md border border-[var(--line)] bg-white p-4">
          <h2 className="text-sm font-semibold text-[#253041]">資料追加</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
            新しい資料を追加した後は、マニュアル管理画面でAI同期を実行してください。
          </p>
          <Link href="/manuals">
            <Button className="mt-4 w-full" variant="secondary">
              <FileText size={17} aria-hidden="true" />
              マニュアルを追加
            </Button>
          </Link>
        </section>
      </aside>
    </div>
  );
}

function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className="prose-lite">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
