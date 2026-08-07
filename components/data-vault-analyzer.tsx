"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft, Check, Copy, FileText, Folder, Loader2, Plus, Save, Send, Sparkles, X
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui";

type VaultItem = {
  id: string;
  title: string;
  folderId: string | null;
  kind: "document" | "analysis";
  savedAt: string;
  sizeLabel?: string;
  textStatus?: "ready" | "scanned" | "failed";
};
type VaultCatalog = { folders: { id: string; name: string; parentId: string | null }[]; items: VaultItem[] };

type Exchange = { instruction: string; output: string };

const PRESETS: { label: string; instruction: string; multiOnly?: boolean }[] = [
  {
    label: "要約",
    instruction: "この資料の要点を、見出しごとに整理して要約してください。"
  },
  {
    label: "要点抽出",
    instruction: "この資料から、数値・判断基準・手順・注意点を箇条書きで抽出してください。"
  },
  {
    label: "比較",
    instruction: "これらの資料の共通点と相違点を、表形式で整理してください。",
    multiOnly: true
  }
];

async function callVault<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch("/api/data-vault", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || "操作に失敗しました");
  }
  return (await res.json()) as T;
}

export function DataVaultAnalyzer() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const folderId = searchParams.get("folder");

  const [catalog, setCatalog] = useState<VaultCatalog>({ folders: [], items: [] });
  // 遷移時のクエリを初期値として一度だけ読む。以降は画面内の操作で増減させる
  const [targetIds, setTargetIds] = useState<string[]>(
    () => (searchParams.get("ids") ?? "").split(",").filter(Boolean)
  );
  const [instruction, setInstruction] = useState("");
  const [output, setOutput] = useState("");
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [warning, setWarning] = useState("");
  const [usage, setUsage] = useState<{ inputTokens?: number; outputTokens?: number } | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [picking, setPicking] = useState(false);
  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/data-vault", { cache: "no-store" });
      if (res.ok) setCatalog((await res.json()) as VaultCatalog);
    })();
  }, []);

  const documents = useMemo(
    () => catalog.items.filter(i => i.kind === "document"),
    [catalog.items]
  );
  const targets = useMemo(
    () => targetIds.map(id => documents.find(d => d.id === id)).filter((d): d is VaultItem => !!d),
    [targetIds, documents]
  );

  const scrollToBottom = useCallback(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  async function run() {
    const text = instruction.trim();
    if (!text || !targetIds.length || running) return;

    setRunning(true);
    setError("");
    setWarning("");
    setUsage(null);
    setSaved(false);
    setOutput("");

    try {
      const res = await fetch("/api/data-vault/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: targetIds,
          instruction: text,
          history: exchanges.flatMap(e => [
            { role: "user" as const, text: e.instruction },
            { role: "assistant" as const, text: e.output }
          ])
        })
      });

      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "分析に失敗しました");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let accumulated = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = JSON.parse(line.slice(6)) as {
            type: string;
            text?: string;
            message?: string;
            skipped?: string[];
            inputTokens?: number;
            outputTokens?: number;
          };
          if (payload.type === "delta" && payload.text) {
            accumulated += payload.text;
            setOutput(accumulated);
            scrollToBottom();
          } else if (payload.type === "warning" && payload.skipped?.length) {
            setWarning(`次の資料は読み取れなかったため除外しました: ${payload.skipped.join("、")}`);
          } else if (payload.type === "usage") {
            setUsage({ inputTokens: payload.inputTokens, outputTokens: payload.outputTokens });
          } else if (payload.type === "error") {
            setError(payload.message ?? "分析に失敗しました");
          }
        }
      }

      if (accumulated) {
        setExchanges(cur => [...cur, { instruction: text, output: accumulated }]);
        setInstruction("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "分析に失敗しました");
    } finally {
      setRunning(false);
    }
  }

  async function save() {
    if (!output) return;
    const defaultTitle = exchanges.length
      ? exchanges[exchanges.length - 1].instruction.slice(0, 40)
      : instruction.slice(0, 40);
    const title = window.prompt("保存するタイトル", defaultTitle);
    if (!title?.trim()) return;
    try {
      await callVault({
        action: "save-analysis",
        title: title.trim(),
        folderId,
        sourceIds: targetIds,
        instruction: exchanges.length ? exchanges[exchanges.length - 1].instruction : instruction,
        model: "claude-sonnet-4-6",
        content: output
      });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存に失敗しました");
    }
  }

  async function copy() {
    await navigator.clipboard.writeText(output);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  const hasMultiple = targets.length >= 2;

  // ── 資料追加モーダル：フォルダ階層をそのまま出す ────────────────
  function docIdsInSubtree(folderId: string): string[] {
    const subtree = new Set<string>();
    const walk = (fid: string) => {
      subtree.add(fid);
      catalog.folders.filter(f => f.parentId === fid).forEach(f => walk(f.id));
    };
    walk(folderId);
    return documents.filter(d => d.folderId && subtree.has(d.folderId)).map(d => d.id);
  }

  function toggleDoc(id: string) {
    setTargetIds(cur => (cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]));
  }

  function toggleFolderDocs(folderId: string) {
    const ids = docIdsInSubtree(folderId);
    if (!ids.length) return;
    const allSelected = ids.every(id => targetIds.includes(id));
    setTargetIds(cur =>
      allSelected
        ? cur.filter(id => !ids.includes(id))
        : [...cur, ...ids.filter(id => !cur.includes(id))]
    );
  }

  function renderDocRows(folderId: string | null, depth: number) {
    return documents
      .filter(d => (d.folderId ?? null) === folderId)
      .map(d => (
        <label
          key={d.id}
          style={{
            display: "flex", alignItems: "center", gap: 9, cursor: "pointer",
            padding: `7px 20px 7px ${20 + depth * 16}px`
          }}
        >
          <input
            type="checkbox" checked={targetIds.includes(d.id)}
            onChange={() => toggleDoc(d.id)}
            style={{ width: 15, height: 15, cursor: "pointer", flexShrink: 0 }}
          />
          <FileText size={14} style={{ color: "var(--ink-muted)", flexShrink: 0 }} aria-hidden="true" />
          <span className="truncate" style={{ fontSize: 13 }}>{d.title}</span>
        </label>
      ));
  }

  function renderFolderNodes(parentId: string | null, depth: number): React.ReactNode {
    return catalog.folders
      .filter(f => f.parentId === parentId)
      .map(f => {
        const ids = docIdsInSubtree(f.id);
        const allSelected = ids.length > 0 && ids.every(id => targetIds.includes(id));
        const someSelected = ids.some(id => targetIds.includes(id));
        return (
          <div key={f.id}>
            <div
              style={{
                display: "flex", alignItems: "center", gap: 9,
                padding: `7px 20px 7px ${20 + depth * 16}px`,
                background: "var(--panel-deep)", borderTop: "1px solid var(--line-soft)"
              }}
            >
              <input
                type="checkbox" checked={allSelected} disabled={!ids.length}
                ref={el => { if (el) el.indeterminate = !allSelected && someSelected; }}
                onChange={() => toggleFolderDocs(f.id)}
                title="このフォルダ内の資料をまとめて選択"
                style={{ width: 15, height: 15, cursor: ids.length ? "pointer" : "default", flexShrink: 0 }}
              />
              {depth > 0 && <span style={{ color: "var(--ink-muted)", fontSize: 11 }}>└</span>}
              <Folder size={14} style={{ color: "var(--navy)", flexShrink: 0 }} aria-hidden="true" />
              <span className="truncate" style={{ fontSize: 12.5, fontWeight: 600, flex: 1 }}>{f.name}</span>
              <span className="tiny soft" style={{ flexShrink: 0 }}>{ids.length}</span>
            </div>
            {renderDocRows(f.id, depth + 1)}
            {renderFolderNodes(f.id, depth + 1)}
          </div>
        );
      });
  }

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "280px minmax(0,1fr)", gap: 20, alignItems: "stretch", height: "calc(100vh - 200px)", minHeight: 560 }}>

        {/* ── 対象資料 (left) ── */}
        <section className="panel" style={{ display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
          <div className="panel-head" style={{ flexShrink: 0 }}>
            <span className="panel-title">対象資料</span>
            <span className="panel-sub">{targets.length} 件</span>
          </div>
          <div className="panel-pad" style={{ paddingTop: 14, overflowY: "auto", flex: 1, minHeight: 0 }}>
            {targets.length === 0 ? (
              <div className="small soft" style={{ textAlign: "center", padding: "24px 0" }}>
                資料が選択されていません。
              </div>
            ) : (
              <div className="stack" style={{ gap: 8 }}>
                {targets.map(t => (
                  <div key={t.id} className="row" style={{ gap: 8, padding: "9px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "var(--panel-deep)" }}>
                    <FileText size={14} style={{ color: "var(--ink-muted)", flexShrink: 0 }} aria-hidden="true" />
                    <div className="stack" style={{ flex: 1, minWidth: 0, gap: 2 }}>
                      <span className="truncate" style={{ fontSize: 12.5, fontWeight: 500 }}>{t.title}</span>
                      {t.textStatus === "scanned" && (
                        <span className="tiny" style={{ color: "var(--warn)" }}>画像PDF</span>
                      )}
                    </div>
                    <button
                      type="button" className="btn ghost sm icon" title="対象から外す"
                      onClick={() => setTargetIds(cur => cur.filter(id => id !== t.id))}
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <Button variant="secondary" size="sm" style={{ width: "100%", marginTop: 12, gap: 5 }} onClick={() => setPicking(true)}>
              <Plus size={12} aria-hidden="true" />資料を追加
            </Button>

            <div className="divider" />
            <div className="tiny soft" style={{ lineHeight: 1.7 }}>
              資料はRAGを介さず全文をそのままAIに渡します。参照範囲が資料全体になるため、断片検索より正確です。
            </div>
          </div>
          <div style={{ padding: 14, borderTop: "1px solid var(--line)", flexShrink: 0 }}>
            <Button variant="ghost" size="sm" style={{ width: "100%", gap: 6 }} onClick={() => router.push("/data-vault")}>
              <ArrowLeft size={13} aria-hidden="true" />データ保管庫へ戻る
            </Button>
          </div>
        </section>

        {/* ── AIに指示 (right) ── */}
        <section className="panel" style={{ display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
          <div className="panel-head between" style={{ flexShrink: 0 }}>
            <span className="panel-title">AIに指示</span>
            {usage && (
              <span className="tiny soft">
                入力 {usage.inputTokens?.toLocaleString()} / 出力 {usage.outputTokens?.toLocaleString()} トークン
              </span>
            )}
          </div>

          {/* プリセット + 入力 */}
          <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--line)", flexShrink: 0 }}>
            <div className="row" style={{ gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
              {PRESETS.filter(p => !p.multiOnly || hasMultiple).map(p => (
                <Button
                  key={p.label} variant="secondary" size="sm"
                  disabled={running}
                  onClick={() => setInstruction(p.instruction)}
                >
                  {p.label}
                </Button>
              ))}
            </div>
            <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
              <textarea
                className="textarea"
                rows={2}
                placeholder="指示を入力…（例: 患者説明に使える言葉に書き直して）"
                value={instruction}
                onChange={e => setInstruction(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void run(); }
                }}
                style={{ flex: 1, resize: "vertical", minHeight: 56, lineHeight: 1.6, padding: "10px 12px" }}
              />
              <Button
                disabled={running || !instruction.trim() || !targetIds.length}
                onClick={() => void run()}
                style={{ gap: 6, flexShrink: 0 }}
              >
                {running
                  ? <><Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} aria-hidden="true" />生成中</>
                  : <><Send size={13} aria-hidden="true" />送信</>}
              </Button>
            </div>
            <div className="tiny soft" style={{ marginTop: 6 }}>Ctrl + Enter で送信</div>
          </div>

          {/* 出力 */}
          <div ref={outputRef} style={{ flex: 1, overflowY: "auto", padding: 20, minHeight: 0 }}>
            {warning && <p className="tag accent" style={{ display: "block", marginBottom: 12 }}>{warning}</p>}
            {error && (
              <p style={{ display: "block", marginBottom: 12, padding: "10px 12px", borderRadius: 6, background: "var(--warn-tint)", color: "var(--warn)", fontSize: 12.5 }}>
                {error}
              </p>
            )}

            {/* 過去のやりとり */}
            {exchanges.slice(0, -1).map((ex, i) => (
              <div key={i} style={{ marginBottom: 24, opacity: 0.72 }}>
                <div className="tiny soft" style={{ marginBottom: 6, letterSpacing: "0.08em" }}>指示: {ex.instruction}</div>
                <div className="prose-lite">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{ex.output}</ReactMarkdown>
                </div>
                <div className="divider" />
              </div>
            ))}

            {output ? (
              <div className="prose">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{output}</ReactMarkdown>
              </div>
            ) : !running && (
              <div style={{ textAlign: "center", padding: 60 }}>
                <Sparkles size={22} style={{ color: "var(--ink-muted)" }} aria-hidden="true" />
                <div className="serif" style={{ fontSize: 17, color: "var(--ink-soft)", margin: "12px 0 6px" }}>
                  指示を入力して送信してください
                </div>
                <div className="small soft">上のプリセットからも選べます。</div>
              </div>
            )}
          </div>

          {/* アクション */}
          {output && !running && (
            <div style={{ padding: "12px 20px", borderTop: "1px solid var(--line)", display: "flex", justifyContent: "flex-end", gap: 8, flexShrink: 0 }}>
              <Button variant="secondary" size="sm" onClick={() => void copy()} style={{ gap: 5 }}>
                {copied ? <><Check size={12} aria-hidden="true" />コピーしました</> : <><Copy size={12} aria-hidden="true" />コピー</>}
              </Button>
              <Button size="sm" disabled={saved} onClick={() => void save()} style={{ gap: 5 }}>
                {saved ? <><Check size={12} aria-hidden="true" />保存しました</> : <><Save size={12} aria-hidden="true" />保管庫に保存</>}
              </Button>
            </div>
          )}
        </section>
      </div>

      {/* 資料を追加するモーダル */}
      {picking && (
        <div
          onClick={() => setPicking(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(20,18,14,.45)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: 32 }}
        >
          <div
            onClick={e => e.stopPropagation()}
            className="panel"
            style={{ width: "min(520px,100%)", maxHeight: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}
          >
            <div className="panel-head between" style={{ flexShrink: 0 }}>
              <span className="panel-title">資料を追加</span>
              <button type="button" className="btn ghost sm icon" onClick={() => setPicking(false)} title="閉じる">
                <X size={14} aria-hidden="true" />
              </button>
            </div>
            <div style={{ overflowY: "auto", flex: 1, minHeight: 0, padding: "8px 0" }}>
              {documents.length === 0 ? (
                <div className="small soft" style={{ padding: 24, textAlign: "center" }}>資料がありません。</div>
              ) : (
                <>
                  {/* ルート直下の資料 */}
                  {renderDocRows(null, 0)}
                  {/* フォルダ階層 */}
                  {renderFolderNodes(null, 0)}
                </>
              )}
            </div>
            <div style={{ padding: 14, borderTop: "1px solid var(--line)", display: "flex", justifyContent: "flex-end", flexShrink: 0 }}>
              <Button size="sm" onClick={() => setPicking(false)}>閉じる</Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
