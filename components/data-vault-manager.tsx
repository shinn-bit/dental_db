"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check, ChevronDown, ChevronRight, FileText, Folder, FolderOpen, Loader2,
  MoreHorizontal, Pencil, Plus, Search, Sparkles, Trash2, Upload, X
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui";
import { GoogleDrivePicker } from "@/components/google-drive-picker";

type VaultFolder = { id: string; name: string; parentId: string | null };
type VaultItem = {
  id: string;
  title: string;
  folderId: string | null;
  kind: "document" | "analysis";
  savedAt: string;
  fileName?: string;
  s3Key?: string;
  contentType?: string;
  sizeLabel?: string;
  textStatus?: "ready" | "scanned" | "failed";
  outputKey?: string;
  sourceIds?: string[];
  instruction?: string;
};
type VaultCatalog = { folders: VaultFolder[]; items: VaultItem[] };

/** ルート（フォルダ未所属）の表示名 */
const ROOT_LABEL = "データ保管庫";

// ── Folder helpers ───────────────────────────────────────────────
function getAncestors(folders: VaultFolder[], folderId: string | null): VaultFolder[] {
  if (!folderId) return [];
  const path: VaultFolder[] = [];
  let cur: string | null = folderId;
  while (cur) {
    const f: VaultFolder | undefined = folders.find(x => x.id === cur);
    if (!f) break;
    path.unshift(f);
    cur = f.parentId;
  }
  return path;
}

function flattenForPicker(folders: VaultFolder[], parentId: string | null, depth: number)
: { id: string; name: string; depth: number }[] {
  return folders
    .filter(f => f.parentId === parentId)
    .flatMap(f => [
      { id: f.id, name: f.name, depth },
      ...flattenForPicker(folders, f.id, depth + 1)
    ]);
}

/** 指定フォルダとその子孫のIDを集める */
function collectSubtree(folders: VaultFolder[], id: string): Set<string> {
  const result = new Set<string>();
  const walk = (fid: string) => {
    result.add(fid);
    folders.filter(f => f.parentId === fid).forEach(f => walk(f.id));
  };
  walk(id);
  return result;
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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

export function DataVaultManager() {
  const router = useRouter();
  const [catalog, setCatalog] = useState<VaultCatalog>({ folders: [], items: [] });
  const [loading, setLoading] = useState(true);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // アップロード待ち。title はデフォルトでファイル名、その場で変更できる
  const [pendingFiles, setPendingFiles] = useState<{ file: File; title: string }[]>([]);
  const [destFolderId, setDestFolderId] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ item: VaultItem; content: string } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // フォルダツリーの開閉・インライン入力・右クリックメニュー
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [addingParentId, setAddingParentId] = useState<string | null | undefined>(undefined);
  const [newFolderName, setNewFolderName] = useState("");
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingFolderName, setEditingFolderName] = useState("");
  const [menu, setMenu] = useState<{ folder: VaultFolder | null; x: number; y: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reload = () => setReloadKey(k => k + 1);

  // メニュー外クリック・Escape・スクロールで閉じる
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(null); };
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/data-vault", { cache: "no-store" });
        if (!res.ok) throw new Error();
        const data = (await res.json()) as VaultCatalog;
        if (!cancelled) setCatalog(data);
      } catch {
        if (!cancelled) setNotice("データ保管庫を読み込めませんでした。");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  const ancestors = useMemo(
    () => getAncestors(catalog.folders, selectedFolderId),
    [catalog.folders, selectedFolderId]
  );
  const childFolders = useMemo(
    () => catalog.folders.filter(f => f.parentId === selectedFolderId),
    [catalog.folders, selectedFolderId]
  );
  const visibleItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q) {
      return catalog.items.filter(i =>
        i.title.toLowerCase().includes(q) || (i.instruction ?? "").toLowerCase().includes(q)
      );
    }
    return catalog.items.filter(i => (i.folderId ?? null) === selectedFolderId);
  }, [catalog.items, selectedFolderId, query]);

  const selectedDocuments = useMemo(
    () => catalog.items.filter(i => selectedIds.has(i.id) && i.kind === "document"),
    [catalog.items, selectedIds]
  );

  // ── Upload ─────────────────────────────────────────────────────
  function addPendingFiles(next: FileList | File[]) {
    const incoming = Array.from(next).filter(f => f.size > 0);
    if (!incoming.length) return;
    setPendingFiles(cur => {
      const keys = new Set(cur.map(p => `${p.file.name}-${p.file.size}`));
      return [
        ...cur,
        ...incoming
          .filter(f => !keys.has(`${f.name}-${f.size}`))
          .map(f => ({ file: f, title: f.name.replace(/\.[^.]+$/, "") }))
      ];
    });
    setNotice("");
  }

  async function uploadFiles() {
    if (!pendingFiles.length) { setNotice("ファイルを選択してください。"); return; }
    setIsUploading(true);
    setNotice("アップロードしています。");
    try {
      let scanned = 0;
      for (const { file, title } of pendingFiles) {
        const contentType = file.type || "application/octet-stream";
        const { id, uploadUrl, s3Key } = await callVault<{ id: string; uploadUrl: string; s3Key: string }>({
          action: "get-upload-url", fileName: file.name, contentType
        });
        const put = await fetch(uploadUrl, {
          method: "PUT", headers: { "Content-Type": contentType }, body: file
        });
        if (!put.ok) throw new Error("アップロードに失敗しました");
        const { item } = await callVault<{ item: VaultItem }>({
          action: "register-document",
          id, fileName: file.name, s3Key, contentType,
          size: file.size, folderId: destFolderId, title
        });
        if (item.textStatus !== "ready") scanned += 1;
      }
      setPendingFiles([]);
      setNotice(
        scanned > 0
          ? `${pendingFiles.length}件を追加しました。うち${scanned}件は文字を読み取れなかったため、分析時にPDFを直接AIへ渡します。`
          : `${pendingFiles.length}件を追加しました。`
      );
      reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "アップロードに失敗しました。");
    } finally {
      setIsUploading(false);
    }
  }

  // ── Folder / item ops ──────────────────────────────────────────
  /** インライン入力から新規フォルダを確定する */
  async function addFolder(name: string, parentId: string | null) {
    const trimmed = name.trim();
    if (!trimmed) { cancelAdding(); return; }
    setAddingParentId(undefined);
    setNewFolderName("");
    await callVault({ action: "create-folder", name: trimmed, parentId });
    reload();
  }

  function cancelAdding() {
    setAddingParentId(undefined);
    setNewFolderName("");
  }

  /** インライン編集からフォルダ名を確定する */
  async function renameFolder(id: string, name: string) {
    const trimmed = name.trim();
    const current = catalog.folders.find(f => f.id === id);
    setEditingFolderId(null);
    if (!trimmed || !current || trimmed === current.name) return;
    await callVault({ action: "rename-folder", id, name: trimmed });
    reload();
  }

  async function deleteFolder(folder: VaultFolder) {
    setMenu(null);
    if (!window.confirm(`「${folder.name}」を削除しますか？\n中の資料は削除されず、「${ROOT_LABEL}」直下に移動します。`)) return;
    await callVault({ action: "delete-folder", id: folder.id });
    if (selectedFolderId === folder.id) setSelectedFolderId(folder.parentId);
    reload();
  }

  // ── 右クリックメニュー ────────────────────────────────────────
  function openMenu(e: React.MouseEvent, folder: VaultFolder | null) {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ folder, x: e.clientX, y: e.clientY });
  }

  function startAddingUnder(parentId: string | null) {
    setMenu(null);
    setNewFolderName("");
    setAddingParentId(parentId);
    if (parentId) setExpandedIds(prev => new Set([...prev, parentId]));
  }

  function startRenaming(folder: VaultFolder) {
    setMenu(null);
    setEditingFolderId(folder.id);
    setEditingFolderName(folder.name);
  }

  async function renameItem(item: VaultItem, title: string) {
    const trimmed = title.trim();
    if (!trimmed || trimmed === item.title) return;
    await callVault({ action: "update-item", id: item.id, title: trimmed });
    reload();
  }

  async function deleteItem(item: VaultItem) {
    if (!window.confirm(`「${item.title}」を削除しますか？`)) return;
    await callVault({ action: "delete-item", id: item.id });
    setSelectedIds(cur => { const n = new Set(cur); n.delete(item.id); return n; });
    reload();
  }

  async function moveItem(itemId: string, folderId: string | null) {
    await callVault({ action: "update-item", id: itemId, folderId });
    reload();
  }

  async function openItem(item: VaultItem) {
    if (item.kind === "analysis") {
      const { content } = await callVault<{ content: string }>({
        action: "get-output", itemId: item.id
      });
      setViewing({ item, content });
      return;
    }
    if (!item.s3Key) return;
    const { url } = await callVault<{ url: string }>({
      action: "get-download-url", s3Key: item.s3Key
    });
    window.open(url, "_blank", "noopener");
  }

  function toggleSelect(id: string) {
    setSelectedIds(cur => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  /** フォルダ配下（サブフォルダ含む）の資料IDを集める */
  function documentIdsUnder(folderId: string): string[] {
    const subtree = collectSubtree(catalog.folders, folderId);
    return catalog.items
      .filter(i => i.kind === "document" && i.folderId && subtree.has(i.folderId))
      .map(i => i.id);
  }

  /** フォルダを選択すると配下の資料をまとめて選択・解除する */
  function toggleFolderSelect(folderId: string) {
    const ids = documentIdsUnder(folderId);
    if (!ids.length) return;
    const allSelected = ids.every(id => selectedIds.has(id));
    setSelectedIds(cur => {
      const next = new Set(cur);
      for (const id of ids) {
        if (allSelected) next.delete(id); else next.add(id);
      }
      return next;
    });
  }

  function startAnalysis() {
    if (!selectedDocuments.length) return;
    const ids = selectedDocuments.map(i => i.id).join(",");
    const folder = selectedFolderId ? `&folder=${selectedFolderId}` : "";
    router.push(`/data-vault/analyze?ids=${ids}${folder}`);
  }

  // ── サイドバーのフォルダツリー ────────────────────────────────
  // コンポーネントに切り出すと入力欄のフォーカスが飛ぶので関数のまま置く
  function newFolderInputRow(depth: number) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 3, padding: `3px 6px 3px ${10 + depth * 14}px` }}>
        <Folder size={12} style={{ color: "var(--navy)", flexShrink: 0 }} aria-hidden="true" />
        <input
          autoFocus
          value={newFolderName}
          placeholder="フォルダ名"
          onChange={e => setNewFolderName(e.target.value)}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); void addFolder(newFolderName, addingParentId ?? null); }
            if (e.key === "Escape") cancelAdding();
          }}
          style={{ flex: 1, minWidth: 0, fontSize: 11.5, padding: "2px 6px", border: "1px solid var(--navy)", borderRadius: 4, outline: "none" }}
        />
        <button
          type="button" title="決定"
          onClick={() => void addFolder(newFolderName, addingParentId ?? null)}
          style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "var(--navy)", borderRadius: 4, cursor: "pointer", color: "#fff", flexShrink: 0 }}
        >
          <Check size={11} aria-hidden="true" />
        </button>
        <button
          type="button" title="やめる" onClick={cancelAdding}
          style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--line)", background: "transparent", borderRadius: 4, cursor: "pointer", color: "var(--ink-muted)", flexShrink: 0 }}
        >
          <X size={11} aria-hidden="true" />
        </button>
      </div>
    );
  }

  function renderFolderTree(parentId: string | null, depth: number): React.ReactNode {
    return catalog.folders.filter(f => f.parentId === parentId).map(folder => {
      const hasChildren = catalog.folders.some(f => f.parentId === folder.id);
      const isExpanded = expandedIds.has(folder.id);
      const isSelected = selectedFolderId === folder.id;
      const isDropTarget = dropTargetId === folder.id;

      return (
        <div key={folder.id}>
          <div
            onContextMenu={e => openMenu(e, folder)}
            onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDropTargetId(folder.id); }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTargetId(null); }}
            onDrop={e => {
              e.preventDefault(); e.stopPropagation(); setDropTargetId(null);
              if (draggedId) void moveItem(draggedId, folder.id);
            }}
            style={{
              display: "flex", alignItems: "center", gap: 3,
              padding: `4px 4px 4px ${10 + depth * 14}px`, borderRadius: 6,
              background: isDropTarget ? "var(--navy)" : isSelected ? "var(--navy-tint)" : "transparent",
              color: isDropTarget ? "#fff" : isSelected ? "var(--navy-deep)" : "var(--ink-soft)",
              outline: isDropTarget ? "2px solid var(--navy-deep)" : "none", outlineOffset: -2
            }}
          >
            {editingFolderId === folder.id ? (
              <input
                autoFocus value={editingFolderName}
                onChange={e => setEditingFolderName(e.target.value)}
                onClick={e => e.stopPropagation()}
                onKeyDown={e => {
                  if (e.key === "Enter") { e.preventDefault(); void renameFolder(folder.id, editingFolderName); }
                  if (e.key === "Escape") setEditingFolderId(null);
                }}
                onBlur={() => void renameFolder(folder.id, editingFolderName)}
                style={{ flex: 1, minWidth: 0, fontSize: 12, padding: "2px 5px", border: "1px solid var(--navy)", borderRadius: 4, outline: "none" }}
              />
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setExpandedIds(prev => {
                      const s = new Set(prev);
                      if (s.has(folder.id)) s.delete(folder.id); else s.add(folder.id);
                      return s;
                    });
                    setSelectedFolderId(folder.id);
                  }}
                  style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, minWidth: 0, padding: 0, background: "none", border: "none", cursor: "pointer", color: "inherit" }}
                >
                  <span style={{ width: 13, flexShrink: 0, display: "flex", justifyContent: "center" }}>
                    {hasChildren ? (isExpanded ? <ChevronDown size={11} aria-hidden="true" /> : <ChevronRight size={11} aria-hidden="true" />) : null}
                  </span>
                  {isExpanded
                    ? <FolderOpen size={13} style={{ flexShrink: 0, color: isDropTarget ? "#fff" : "var(--navy)" }} aria-hidden="true" />
                    : <Folder size={13} style={{ flexShrink: 0, color: isDropTarget ? "#fff" : "var(--navy)" }} aria-hidden="true" />}
                  <span style={{ fontSize: 12.5, fontWeight: isSelected ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, textAlign: "left" }}>
                    {folder.name}
                  </span>
                </button>
                <button
                  type="button" title="操作"
                  onClick={e => openMenu(e, folder)}
                  style={{ width: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "transparent", cursor: "pointer", color: "inherit", flexShrink: 0, opacity: 0.7 }}
                >
                  <MoreHorizontal size={10} aria-hidden="true" />
                </button>
              </>
            )}
          </div>

          {isExpanded && (
            <>
              {renderFolderTree(folder.id, depth + 1)}
              {addingParentId === folder.id && newFolderInputRow(depth + 1)}
            </>
          )}
        </div>
      );
    });
  }

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "320px minmax(0,1fr)", gap: 20, alignItems: "stretch", height: "calc(100vh - 200px)", minHeight: 560 }}>

        {/* ── Upload panel (left) ── */}
        <section className="panel" style={{ display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
          <div className="panel-head" style={{ flexShrink: 0 }}>
            <span className="panel-title">資料を追加する</span>
            <span className="panel-sub">PDF（A4数枚程度を想定）</span>
          </div>
          <div className="panel-pad" style={{ paddingTop: 18, overflowY: "auto", flex: 1, minHeight: 0 }}>
            <div
              onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={e => { e.preventDefault(); setIsDragging(false); addPendingFiles(e.dataTransfer.files); }}
              onClick={() => fileInputRef.current?.click()}
              style={{
                border: `1.5px dashed ${isDragging ? "var(--navy)" : "#cbc7b8"}`,
                background: isDragging ? "var(--navy-tint-soft)" : "var(--panel-deep)",
                borderRadius: 12, padding: "28px 18px", textAlign: "center",
                cursor: "pointer", transition: "all .15s ease"
              }}
            >
              <Upload size={22} aria-hidden="true" style={{ color: "var(--ink-muted)" }} />
              <div className="serif" style={{ fontSize: 16, marginTop: 10, color: "var(--navy-deep)", fontWeight: 600, letterSpacing: "0.04em" }}>
                ここにファイルを置く
              </div>
              <div className="small soft" style={{ marginTop: 4 }}>またはクリックして選択</div>
            </div>
            <input
              ref={fileInputRef} type="file" multiple accept="application/pdf" hidden
              onChange={e => { addPendingFiles(e.target.files ?? []); e.target.value = ""; }}
            />

            <div style={{ marginTop: 12 }}>
              <GoogleDrivePicker onFilesSelected={addPendingFiles} disabled={isUploading} />
            </div>

            {pendingFiles.length > 0 && (
              <div style={{ marginTop: 14, border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
                <div className="tiny" style={{ padding: "8px 12px", background: "var(--panel-deep)", color: "var(--ink-soft)", letterSpacing: "0.12em", fontWeight: 600 }}>
                  追加する予定の資料
                </div>
                {pendingFiles.map((p, idx) => (
                  <div key={`${p.file.name}-${idx}`} className="stack" style={{ gap: 5, padding: "9px 12px", borderTop: "1px solid var(--line-soft)" }}>
                    <div className="row" style={{ gap: 6 }}>
                      <input
                        className="input"
                        value={p.title}
                        placeholder="タイトル"
                        onChange={e => setPendingFiles(cur =>
                          cur.map((x, i) => (i === idx ? { ...x, title: e.target.value } : x))
                        )}
                        style={{ flex: 1, minWidth: 0, height: 30, fontSize: 12.5 }}
                      />
                      <button type="button" className="btn ghost sm icon" title="選択から外す"
                        onClick={() => setPendingFiles(cur => cur.filter((_, i) => i !== idx))}>
                        <X size={13} aria-hidden="true" />
                      </button>
                    </div>
                    <span className="tiny soft truncate">
                      {p.file.name} ・ {formatSize(p.file.size)}
                    </span>
                  </div>
                ))}
                <div className="tiny soft" style={{ padding: "8px 12px", borderTop: "1px solid var(--line-soft)" }}>
                  タイトルはここで変更できます（初期値はファイル名）。
                </div>
              </div>
            )}

            <div className="divider" />
            <label className="label">追加先フォルダ</label>
            <FolderPicker
              folders={catalog.folders}
              value={destFolderId}
              onChange={setDestFolderId}
            />

            {notice ? <p className="tag accent" style={{ marginTop: 14, display: "block" }}>{notice}</p> : null}

            <Button style={{ width: "100%", marginTop: 14 }} disabled={isUploading} onClick={uploadFiles}>
              {isUploading ? "追加しています…" : "データ保管庫に追加"}
            </Button>
            <div className="tiny soft" style={{ textAlign: "center", marginTop: 8, letterSpacing: "0.06em" }}>
              追加時に文字を読み取ります。AI処理は分析するときだけ動きます。
            </div>
          </div>
        </section>

        {/* ── Library panel (right) ── */}
        <section className="panel" style={{ display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0, position: "relative" }}>
          <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexShrink: 0 }}>
            <nav style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", minWidth: 0 }}>
              <Crumb active={selectedFolderId === null} onClick={() => setSelectedFolderId(null)}>{ROOT_LABEL}</Crumb>
              {ancestors.map(f => (
                <span key={f.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <ChevronRight size={13} style={{ color: "var(--ink-muted)" }} aria-hidden="true" />
                  <Crumb active={selectedFolderId === f.id} onClick={() => setSelectedFolderId(f.id)}>{f.name}</Crumb>
                </span>
              ))}
            </nav>
            <div className="row" style={{ gap: 8, flexShrink: 0 }}>
              <div style={{ position: "relative" }}>
                <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--ink-muted)", pointerEvents: "none" }} aria-hidden="true" />
                <input className="input" placeholder="保管庫全体から探す" value={query}
                  onChange={e => setQuery(e.target.value)}
                  style={{ paddingLeft: 32, height: 36, width: 200 }} />
              </div>
            </div>
          </div>

          <div style={{ flex: 1, display: "grid", gridTemplateColumns: "200px 1fr", minHeight: 0, overflow: "hidden" }}>
            {/* Sidebar */}
            <div
              style={{ background: "var(--panel-deep)", borderRight: "1px solid var(--line)", display: "flex", flexDirection: "column", minHeight: 0 }}
              onContextMenu={e => openMenu(e, null)}
              onDragOver={e => { e.preventDefault(); setDropTargetId("__root__"); }}
              onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTargetId(null); }}
              onDrop={e => {
                e.preventDefault(); setDropTargetId(null);
                if (draggedId) void moveItem(draggedId, null);
              }}
            >
              <div style={{ flex: 1, overflowY: "auto", padding: "10px 6px" }}>
                {/* ルート行 */}
                <div
                  onClick={() => setSelectedFolderId(null)}
                  onContextMenu={e => openMenu(e, null)}
                  style={{
                    display: "flex", alignItems: "center", gap: 5, padding: "5px 8px", borderRadius: 6,
                    cursor: "pointer", marginBottom: 2, fontSize: 12.5, letterSpacing: "0.02em",
                    background: dropTargetId === "__root__" ? "var(--navy)" : selectedFolderId === null ? "var(--navy-tint)" : "transparent",
                    color: dropTargetId === "__root__" ? "#fff" : selectedFolderId === null ? "var(--navy-deep)" : "var(--ink-soft)",
                    fontWeight: selectedFolderId === null ? 600 : 500
                  }}
                >
                  <FolderOpen size={13} style={{ color: dropTargetId === "__root__" ? "#fff" : "var(--navy)", flexShrink: 0 }} aria-hidden="true" />
                  <span className="truncate" style={{ flex: 1 }}>{ROOT_LABEL}</span>
                </div>

                {renderFolderTree(null, 0)}
                {addingParentId === null && newFolderInputRow(0)}
              </div>

              <div style={{ padding: 8, borderTop: "1px solid var(--line)", flexShrink: 0 }}>
                <button
                  type="button"
                  onClick={() => startAddingUnder(null)}
                  style={{ width: "100%", display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", border: "1px dashed var(--line)", borderRadius: 6, background: "transparent", cursor: "pointer", color: "var(--ink-soft)", fontSize: 12 }}
                >
                  <Plus size={12} aria-hidden="true" />フォルダ作成
                </button>
              </div>
            </div>

            {/* Content */}
            <div
              onContextMenu={e => {
                // 空白部分の右クリック → 表示中フォルダの直下に作成
                if (e.target === e.currentTarget) {
                  openMenu(e, catalog.folders.find(f => f.id === selectedFolderId) ?? null);
                }
              }}
              style={{ overflowY: "auto", padding: 20, paddingBottom: selectedDocuments.length ? 84 : 20 }}
            >
              {loading ? (
                <div style={{ textAlign: "center", padding: 60 }}>
                  <Loader2 size={20} style={{ animation: "spin 1s linear infinite", color: "var(--ink-muted)" }} aria-hidden="true" />
                  <div className="serif" style={{ fontSize: 16, marginTop: 10 }}>読み込み中…</div>
                </div>
              ) : (
                <>
                  {query ? (
                    <div className="between" style={{ marginBottom: 14 }}>
                      <span className="small soft">「{query}」の検索結果</span>
                      <span className="small soft">{visibleItems.length} 件</span>
                    </div>
                  ) : childFolders.length > 0 && (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(180px,1fr))", gap: 12, marginBottom: 20 }}>
                      {childFolders.map(f => (
                        <FolderCard
                          key={f.id} folder={f}
                          count={documentIdsUnder(f.id).length}
                          selectable={documentIdsUnder(f.id).length > 0}
                          selected={
                            documentIdsUnder(f.id).length > 0 &&
                            documentIdsUnder(f.id).every(id => selectedIds.has(id))
                          }
                          partiallySelected={documentIdsUnder(f.id).some(id => selectedIds.has(id))}
                          onToggleSelect={() => toggleFolderSelect(f.id)}
                          highlight={dropTargetId === f.id}
                          onOpen={() => setSelectedFolderId(f.id)}
                          onRenameCommit={name => void renameFolder(f.id, name)}
                          onDelete={() => void deleteFolder(f)}
                          onContextMenu={e => openMenu(e, f)}
                          onDragOver={e => { e.preventDefault(); setDropTargetId(f.id); }}
                          onDragLeave={() => setDropTargetId(null)}
                          onDrop={e => {
                            e.preventDefault(); setDropTargetId(null);
                            if (draggedId) void moveItem(draggedId, f.id);
                          }}
                        />
                      ))}
                    </div>
                  )}

                  {visibleItems.length === 0 ? (
                    <div style={{ textAlign: "center", padding: 60 }}>
                      <div className="serif" style={{ fontSize: 18, color: "var(--ink-soft)", marginBottom: 8 }}>
                        {query ? "該当する資料はありません" : "まだ資料がありません"}
                      </div>
                      <div className="small soft">
                        {query ? "別のキーワードで試してください。" : "左のパネルからPDFを追加してください。"}
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: 12 }}>
                      {visibleItems.map(item => (
                        <ItemCard
                          key={item.id} item={item}
                          selected={selectedIds.has(item.id)}
                          onToggle={() => toggleSelect(item.id)}
                          onOpen={() => void openItem(item)}
                          onRenameCommit={title => void renameItem(item, title)}
                          onDelete={() => void deleteItem(item)}
                          onDragStart={() => setDraggedId(item.id)}
                          onDragEnd={() => { setDraggedId(null); setDropTargetId(null); }}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* 選択中のアクションバー */}
          {selectedDocuments.length > 0 && (
            <div style={{
              position: "absolute", left: 200, right: 0, bottom: 0,
              borderTop: "1px solid var(--line)", background: "var(--panel)",
              padding: "12px 20px", display: "flex", alignItems: "center",
              justifyContent: "space-between", gap: 12
            }}>
              <span className="small soft">{selectedDocuments.length}件の資料を選択中</span>
              <div className="row" style={{ gap: 8 }}>
                <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>選択を解除</Button>
                <Button size="sm" onClick={startAnalysis} style={{ gap: 6 }}>
                  <Sparkles size={13} aria-hidden="true" />分析する
                </Button>
              </div>
            </div>
          )}
        </section>
      </div>

      {/* 右クリックメニュー */}
      {menu && (
        <div
          onClick={e => e.stopPropagation()}
          onContextMenu={e => e.preventDefault()}
          style={{
            position: "fixed", left: menu.x, top: menu.y, zIndex: 200,
            background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 6,
            boxShadow: "0 4px 14px rgba(0,0,0,.16)", minWidth: 160, padding: "4px 0"
          }}
        >
          <button type="button" style={menuItemSt} onClick={() => startAddingUnder(menu.folder?.id ?? null)}>
            {menu.folder ? "サブフォルダ作成" : "フォルダ作成"}
          </button>
          {menu.folder && (
            <>
              <button type="button" style={menuItemSt} onClick={() => startRenaming(menu.folder!)}>
                名前を変更
              </button>
              <div style={{ height: 1, background: "var(--line-soft)", margin: "4px 0" }} />
              <button type="button" style={{ ...menuItemSt, color: "#c0392b" }} onClick={() => void deleteFolder(menu.folder!)}>
                削除
              </button>
            </>
          )}
        </div>
      )}

      {/* 分析結果ビューア */}
      {viewing && (
        <div
          onClick={() => setViewing(null)}
          style={{ position: "fixed", inset: 0, background: "rgba(20,18,14,.45)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: 32 }}
        >
          <div
            onClick={e => e.stopPropagation()}
            className="panel"
            style={{ width: "min(860px,100%)", maxHeight: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}
          >
            <div className="panel-head between" style={{ flexShrink: 0 }}>
              <span className="panel-title">{viewing.item.title}</span>
              <button type="button" className="btn ghost sm icon" onClick={() => setViewing(null)} title="閉じる">
                <X size={14} aria-hidden="true" />
              </button>
            </div>
            {viewing.item.instruction && (
              <div className="tiny soft" style={{ padding: "10px 20px", borderBottom: "1px solid var(--line-soft)", background: "var(--panel-deep)" }}>
                指示: {viewing.item.instruction}
              </div>
            )}
            <div className="panel-pad prose" style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{viewing.content}</ReactMarkdown>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Small parts ──────────────────────────────────────────────────
function Crumb({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button" onClick={onClick}
      className="serif"
      style={{
        background: "none", border: "none", cursor: "pointer", padding: "2px 4px",
        fontSize: 15, fontWeight: active ? 600 : 500,
        color: active ? "var(--ink)" : "var(--ink-muted)", letterSpacing: "0.04em"
      }}
    >
      {children}
    </button>
  );
}

/** 階層をインデントと └ で示すフォルダ選択ドロップダウン */
function FolderPicker({
  folders, value, onChange
}: {
  folders: VaultFolder[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);

  const rows: { id: string | null; name: string; depth: number }[] = [
    { id: null, name: ROOT_LABEL, depth: 0 },
    ...flattenForPicker(folders, null, 0).map(f => ({ id: f.id as string | null, name: f.name, depth: f.depth + 1 }))
  ];

  // 選択中フォルダの階層パス
  const path: string[] = [];
  let cur = value;
  while (cur) {
    const f = folders.find(x => x.id === cur);
    if (!f) break;
    path.unshift(f.name);
    cur = f.parentId;
  }
  const label = [ROOT_LABEL, ...path].join(" › ");

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="input"
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 6, textAlign: "left", cursor: "pointer" }}
      >
        <Folder size={13} style={{ color: "var(--navy)", flexShrink: 0 }} aria-hidden="true" />
        <span className="truncate" style={{ flex: 1, fontSize: 12.5 }}>{label}</span>
        <ChevronDown size={13} style={{ color: "var(--ink-muted)", flexShrink: 0 }} aria-hidden="true" />
      </button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
          <div
            style={{
              position: "absolute", left: 0, right: 0, top: "calc(100% + 4px)", zIndex: 41,
              background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 6,
              boxShadow: "0 4px 14px rgba(0,0,0,.14)", maxHeight: 240, overflowY: "auto", padding: "4px 0"
            }}
          >
            {rows.map(r => {
              const active = (r.id ?? null) === (value ?? null);
              return (
                <button
                  key={r.id ?? "__root__"}
                  type="button"
                  onClick={() => { onChange(r.id); setOpen(false); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 5, width: "100%",
                    padding: `6px 10px 6px ${10 + r.depth * 14}px`,
                    border: "none", cursor: "pointer", textAlign: "left", fontSize: 12.5,
                    background: active ? "var(--navy-tint)" : "transparent",
                    color: active ? "var(--navy-deep)" : "var(--ink-soft)",
                    fontWeight: active ? 600 : 400
                  }}
                >
                  {r.depth > 0 && (
                    <span style={{ color: "var(--ink-muted)", flexShrink: 0, fontSize: 11 }}>└</span>
                  )}
                  {r.depth === 0
                    ? <FolderOpen size={13} style={{ color: "var(--navy)", flexShrink: 0 }} aria-hidden="true" />
                    : <Folder size={13} style={{ color: "var(--navy)", flexShrink: 0 }} aria-hidden="true" />}
                  <span className="truncate">{r.name}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

const menuItemSt: React.CSSProperties = {
  width: "100%", textAlign: "left", padding: "7px 14px", fontSize: 12.5,
  border: "none", background: "none", cursor: "pointer", color: "var(--ink)", whiteSpace: "nowrap"
};

function FolderCard({
  folder, count, highlight, selectable, selected, partiallySelected, onToggleSelect,
  onOpen, onRenameCommit, onDelete, onContextMenu,
  onDragOver, onDragLeave, onDrop
}: {
  folder: VaultFolder; count: number; highlight: boolean;
  selectable: boolean; selected: boolean; partiallySelected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  onRenameCommit: (name: string) => void;
  onDelete: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const [hover, setHover] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(folder.name);

  function commit() {
    setRenaming(false);
    if (draft.trim() && draft.trim() !== folder.name) onRenameCommit(draft);
    else setDraft(folder.name);
  }

  return (
    <div
      onClick={() => { if (!renaming) onOpen(); }}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
      style={{
        position: "relative", padding: 14, borderRadius: 10, cursor: "pointer",
        border: `1px solid ${highlight ? "var(--navy)" : selected ? "var(--navy)" : "var(--line)"}`,
        background: highlight ? "var(--navy-tint)" : selected ? "var(--navy-tint-soft)" : "var(--panel)",
        display: "flex", flexDirection: "column", gap: 10, minHeight: 96
      }}
    >
      <div onClick={e => e.stopPropagation()} style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 2, opacity: hover && !renaming ? 1 : 0, transition: "opacity .15s ease", background: "var(--panel)", borderRadius: 6, padding: 2, border: "1px solid var(--line)" }}>
        <button type="button" className="btn ghost sm icon" title="名前を変更"
          onClick={() => { setDraft(folder.name); setRenaming(true); }}>
          <Pencil size={12} aria-hidden="true" />
        </button>
        <button type="button" className="btn ghost sm icon" title="削除" onClick={onDelete}><Trash2 size={12} aria-hidden="true" /></button>
      </div>
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        {selectable && (
          <input
            type="checkbox"
            checked={selected}
            ref={el => { if (el) el.indeterminate = !selected && partiallySelected; }}
            onClick={e => e.stopPropagation()}
            onChange={onToggleSelect}
            title="このフォルダ内の資料をまとめて選択"
            style={{ width: 15, height: 15, cursor: "pointer", flexShrink: 0 }}
          />
        )}
        <Folder size={20} style={{ color: "var(--navy)" }} aria-hidden="true" />
      </div>
      <div className="stack" style={{ gap: 4, flex: 1 }}>
        {renaming ? (
          <input
            autoFocus className="input" value={draft}
            onClick={e => e.stopPropagation()}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => {
              if (e.key === "Enter") { e.preventDefault(); commit(); }
              if (e.key === "Escape") { setDraft(folder.name); setRenaming(false); }
            }}
            style={{ height: 30, fontSize: 13.5 }}
          />
        ) : (
          <span className="serif truncate" style={{ fontSize: 15, fontWeight: 600, color: "var(--ink)", letterSpacing: "0.04em" }}>{folder.name}</span>
        )}
      </div>
      <div className="tiny soft" style={{ paddingTop: 8, borderTop: "1px solid var(--line-soft)" }}>
        資料 {count} 件{count > 0 ? "（サブフォルダ含む）" : ""}
      </div>
    </div>
  );
}

function ItemCard({
  item, selected, onToggle, onOpen, onRenameCommit, onDelete, onDragStart, onDragEnd
}: {
  item: VaultItem; selected: boolean;
  onToggle: () => void; onOpen: () => void;
  onRenameCommit: (title: string) => void;
  onDelete: () => void;
  onDragStart: () => void; onDragEnd: () => void;
}) {
  const isAnalysis = item.kind === "analysis";
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(item.title);

  function commit() {
    setRenaming(false);
    if (draft.trim() && draft.trim() !== item.title) onRenameCommit(draft);
    else setDraft(item.title);
  }

  return (
    <div
      draggable onDragStart={onDragStart} onDragEnd={onDragEnd}
      style={{
        border: `1px solid ${selected ? "var(--navy)" : "var(--line)"}`,
        background: selected ? "var(--navy-tint-soft)" : "var(--panel)",
        borderRadius: 10, padding: 14, display: "flex", flexDirection: "column", gap: 10
      }}
    >
      <div className="row" style={{ alignItems: "flex-start", gap: 10 }}>
        {!isAnalysis && (
          <input
            type="checkbox" checked={selected} onChange={onToggle}
            title="分析の対象にする"
            style={{ marginTop: 3, width: 15, height: 15, cursor: "pointer", flexShrink: 0 }}
          />
        )}
        <span style={{ color: isAnalysis ? "var(--navy)" : "var(--ink-muted)", display: "flex", flexShrink: 0, marginTop: 1 }}>
          {isAnalysis ? <Sparkles size={15} aria-hidden="true" /> : <FileText size={15} aria-hidden="true" />}
        </span>
        <div className="stack" style={{ minWidth: 0, flex: 1, gap: 5 }}>
          {renaming ? (
            <input
              autoFocus className="input" value={draft}
              onChange={e => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={e => {
                if (e.key === "Enter") { e.preventDefault(); commit(); }
                if (e.key === "Escape") { setDraft(item.title); setRenaming(false); }
              }}
              style={{ height: 30, fontSize: 13.5 }}
            />
          ) : (
            <h3 className="serif" style={{ margin: 0, fontSize: 14.5, fontWeight: 600, lineHeight: 1.45, color: "var(--ink)", letterSpacing: "0.02em" }}>
              {item.title}
            </h3>
          )}
          <div className="tiny soft" style={{ letterSpacing: "0.06em" }}>
            {new Date(item.savedAt).toLocaleDateString("ja-JP")}
            {item.sizeLabel ? ` ・ ${item.sizeLabel}` : ""}
          </div>
        </div>
      </div>

      <div className="row" style={{ gap: 6, fontSize: 11, color: "var(--ink-muted)", flexWrap: "wrap" }}>
        {isAnalysis ? (
          <span className="row" style={{ gap: 5 }}><span className="dot ok" />AI分析結果</span>
        ) : item.textStatus === "ready" ? (
          <span className="row" style={{ gap: 5 }}><span className="dot ok" />読み取り済み</span>
        ) : item.textStatus === "scanned" ? (
          <span className="row" style={{ gap: 4, color: "var(--warn)", background: "var(--warn-tint)", padding: "3px 8px", borderRadius: 4, fontWeight: 500 }}>
            画像PDF（分析時に直接AIへ）
          </span>
        ) : (
          <span className="row" style={{ gap: 4, color: "var(--warn)", background: "var(--warn-tint)", padding: "3px 8px", borderRadius: 4, fontWeight: 500 }}>
            文字を読み取れません
          </span>
        )}
      </div>

      <div className="row" style={{ gap: 6, borderTop: "1px solid var(--line-soft)", paddingTop: 10 }}>
        <Button variant="secondary" size="sm" onClick={onOpen}>{isAnalysis ? "結果を見る" : "開く"}</Button>
        <div style={{ flex: 1 }} />
        <button type="button" className="btn ghost sm icon" title="タイトルを変更"
          onClick={() => { setDraft(item.title); setRenaming(true); }}>
          <Pencil size={13} aria-hidden="true" />
        </button>
        <button type="button" className="btn ghost sm icon" title="削除" onClick={onDelete}><Trash2 size={13} aria-hidden="true" /></button>
      </div>
    </div>
  );
}
