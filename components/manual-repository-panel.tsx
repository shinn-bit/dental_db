"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check, ChevronDown, ChevronRight, FileText, Folder, FolderOpen,
  MoreHorizontal, Plus, X,
} from "lucide-react";

type RepoFolder = { id: string; name: string; parentId: string | null };
type RepoItem = {
  id: string;
  title: string;
  folderId: string | null;
  sessionId: string;
  type: "word" | "slide";
  docMode: "summary" | "procedure" | "free";
  savedAt: string;
  firstSlideHtml?: string;
};
type RepoCatalog = { folders: RepoFolder[]; items: RepoItem[] };

const MODE_LABELS: Record<string, string> = {
  summary: "病気の要約",
  procedure: "手順作成",
  free: "自由作成",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function collectDescendants(folders: RepoFolder[], id: string): Set<string> {
  const result = new Set<string>();
  const collect = (fid: string) => {
    result.add(fid);
    folders.filter(f => f.parentId === fid).forEach(f => collect(f.id));
  };
  collect(id);
  return result;
}

function getAncestors(folders: RepoFolder[], folderId: string | null): RepoFolder[] {
  if (!folderId) return [];
  const path: RepoFolder[] = [];
  let cur: string | null = folderId;
  while (cur) {
    const f = folders.find(x => x.id === cur);
    if (!f) break;
    path.unshift(f);
    cur = f.parentId;
  }
  return path;
}

// ── Sub-components (outside parent to avoid remount on re-render) ─────────────

function SlidePreview({ html }: { html: string }) {
  return (
    <div style={{ width: 192, height: 108, overflow: "hidden", flexShrink: 0, background: "#111827" }}>
      <div
        style={{ width: 960, height: 540, transform: "scale(0.2)", transformOrigin: "top left", pointerEvents: "none" }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

const cardMenuItemStyle: React.CSSProperties = {
  width: "100%", textAlign: "left", padding: "6px 12px", fontSize: 12,
  border: "none", background: "none", cursor: "pointer", color: "var(--ink)",
  whiteSpace: "nowrap",
};

function FolderCard({ folder, itemCount, onOpen, onRename, onDelete }: {
  folder: RepoFolder;
  itemCount: number;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div
      style={{ border: "1px solid var(--line)", borderRadius: 10, overflow: "visible", background: "#fff", cursor: "pointer", position: "relative" }}
      onClick={onOpen}
      onMouseLeave={() => setMenuOpen(false)}
    >
      <div style={{ height: 88, background: "var(--navy-tint-soft, #eef2f8)", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "10px 10px 0 0" }}>
        <Folder size={36} strokeWidth={1.2} style={{ color: "var(--navy)" }} />
      </div>
      <div style={{ padding: "8px 10px" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 3 }}>
          {folder.name}
        </div>
        <div style={{ fontSize: 11, color: "var(--ink-muted)" }}>{itemCount} 件</div>
      </div>
      <div style={{ position: "absolute", top: 6, right: 6 }} onClick={e => e.stopPropagation()}>
        <button
          type="button"
          onClick={() => setMenuOpen(v => !v)}
          style={{ width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "rgba(238,242,248,0.9)", borderRadius: 6, cursor: "pointer", color: "var(--navy)" }}
        >
          <MoreHorizontal size={13} />
        </button>
        {menuOpen && (
          <div style={{ position: "absolute", right: 0, top: "100%", zIndex: 50, background: "#fff", border: "1px solid var(--line)", borderRadius: 6, boxShadow: "0 4px 12px rgba(0,0,0,.12)", padding: "4px 0" }}>
            <button type="button" onClick={() => { onOpen(); setMenuOpen(false); }} style={cardMenuItemStyle}>開く</button>
            <button type="button" onClick={() => { onRename(); setMenuOpen(false); }} style={cardMenuItemStyle}>名前を変更</button>
            <button type="button" onClick={() => { onDelete(); setMenuOpen(false); }} style={{ ...cardMenuItemStyle, color: "#c0392b" }}>削除</button>
          </div>
        )}
      </div>
    </div>
  );
}

function ItemCard({ item, onOpen, onDelete }: {
  item: RepoItem;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const date = new Date(item.savedAt).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
  return (
    <div
      style={{ border: "1px solid var(--line)", borderRadius: 10, overflow: "visible", background: "#fff", cursor: "pointer", position: "relative" }}
      onClick={onOpen}
      onMouseLeave={() => setMenuOpen(false)}
    >
      <div style={{ height: 88, background: "#f0f4f8", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", borderRadius: "10px 10px 0 0" }}>
        {item.type === "slide" && item.firstSlideHtml ? (
          <SlidePreview html={item.firstSlideHtml} />
        ) : (
          <FileText size={36} strokeWidth={1.1} style={{ color: "#7ba3cc" }} />
        )}
      </div>
      <div style={{ padding: "8px 10px" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 4 }}>
          {item.title}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 10, color: "var(--ink-muted)", background: "var(--navy-tint-soft, #eef2f8)", padding: "1px 6px", borderRadius: 8, whiteSpace: "nowrap" }}>
            {MODE_LABELS[item.docMode] ?? item.docMode}
          </span>
          <span style={{ fontSize: 10, color: "var(--ink-muted)", marginLeft: "auto" }}>{date}</span>
        </div>
      </div>
      <div style={{ position: "absolute", top: 6, right: 6 }} onClick={e => e.stopPropagation()}>
        <button
          type="button"
          onClick={() => setMenuOpen(v => !v)}
          style={{ width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "rgba(240,244,248,0.9)", borderRadius: 6, cursor: "pointer", color: "var(--ink-soft)" }}
        >
          <MoreHorizontal size={13} />
        </button>
        {menuOpen && (
          <div style={{ position: "absolute", right: 0, top: "100%", zIndex: 50, background: "#fff", border: "1px solid var(--line)", borderRadius: 6, boxShadow: "0 4px 12px rgba(0,0,0,.12)", padding: "4px 0" }}>
            <button type="button" onClick={() => { onOpen(); setMenuOpen(false); }} style={cardMenuItemStyle}>開いて編集</button>
            <button type="button" onClick={() => { onDelete(); setMenuOpen(false); }} style={{ ...cardMenuItemStyle, color: "#c0392b" }}>削除</button>
          </div>
        )}
      </div>
    </div>
  );
}

function ConfirmModal({ title, message, onCancel, onConfirm }: {
  title: string; message: string; onCancel: () => void; onConfirm: () => void;
}) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onCancel}>
      <div style={{ background: "#fff", borderRadius: 14, padding: 24, width: 320, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }} onClick={e => e.stopPropagation()}>
        <p style={{ margin: "0 0 6px", fontWeight: 600, fontSize: 15, color: "var(--ink)" }}>{title}</p>
        <p style={{ margin: "0 0 20px", fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.6 }}>{message}</p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onCancel} style={{ padding: "7px 16px", fontSize: 13, border: "1px solid var(--line)", borderRadius: "var(--radius)", background: "transparent", cursor: "pointer", color: "var(--ink-soft)" }}>
            キャンセル
          </button>
          <button type="button" onClick={onConfirm} style={{ padding: "7px 16px", fontSize: 13, border: "none", borderRadius: "var(--radius)", background: "#c53030", cursor: "pointer", color: "#fff", fontWeight: 600 }}>
            削除
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function ManualRepositoryPanel() {
  const router = useRouter();

  const [catalog, setCatalog] = useState<RepoCatalog>({ folders: [], items: [] });
  const [dataLoading, setDataLoading] = useState(true);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  const [folderMenuId, setFolderMenuId] = useState<string | null>(null);

  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingFolderName, setEditingFolderName] = useState("");

  // undefined = not adding, null = root, string = under folder
  const [addingFolderParentId, setAddingFolderParentId] = useState<string | null | undefined>(undefined);
  const [newFolderName, setNewFolderName] = useState("");

  const [deleteItemId, setDeleteItemId] = useState<string | null>(null);
  const [deleteFolderId, setDeleteFolderId] = useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renamingFolderName, setRenamingFolderName] = useState("");

  const [folderError, setFolderError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/manual-repository")
      .then(r => r.json())
      .then((d: RepoCatalog) => setCatalog(d))
      .catch(() => {})
      .finally(() => setDataLoading(false));
  }, []);

  async function apiPost(body: object): Promise<Record<string, unknown>> {
    const res = await fetch("/api/manual-repository", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<Record<string, unknown>>;
  }

  async function createFolder() {
    const name = newFolderName.trim();
    if (!name) { setAddingFolderParentId(undefined); setNewFolderName(""); return; }
    const parentId = addingFolderParentId ?? null;
    setFolderError(null);
    try {
      const { id } = await apiPost({ action: "create-folder", name, parentId });
      setCatalog(prev => ({ ...prev, folders: [...prev.folders, { id: id as string, name, parentId }] }));
      if (parentId) setExpandedFolders(prev => new Set([...prev, parentId]));
      setAddingFolderParentId(undefined);
      setNewFolderName("");
    } catch (e) {
      setFolderError(e instanceof Error ? e.message : "フォルダ作成に失敗しました");
    }
  }

  async function renameFolder(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) { setRenamingFolderId(null); setEditingFolderId(null); return; }
    await apiPost({ action: "rename-folder", id, name: trimmed }).catch(() => {});
    setCatalog(prev => ({ ...prev, folders: prev.folders.map(f => f.id === id ? { ...f, name: trimmed } : f) }));
    setRenamingFolderId(null);
    setEditingFolderId(null);
  }

  async function deleteFolder(id: string) {
    const descendants = collectDescendants(catalog.folders, id);
    await apiPost({ action: "delete-folder", id }).catch(() => {});
    setCatalog(prev => ({
      folders: prev.folders.filter(f => !descendants.has(f.id)),
      items: prev.items.map(i => i.folderId && descendants.has(i.folderId) ? { ...i, folderId: null } : i),
    }));
    if (selectedFolderId && descendants.has(selectedFolderId)) setSelectedFolderId(null);
    setDeleteFolderId(null);
  }

  async function deleteItem(id: string) {
    await apiPost({ action: "delete-item", id }).catch(() => {});
    setCatalog(prev => ({ ...prev, items: prev.items.filter(i => i.id !== id) }));
    setDeleteItemId(null);
  }

  function toggleExpand(id: string) {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function selectFolder(id: string | null) {
    setSelectedFolderId(id);
    setFolderMenuId(null);
  }

  function openItem(item: RepoItem) {
    router.push(`/manual?sessionId=${item.sessionId}&repoItemId=${item.id}`);
  }

  // ── Folder input (inline JSX — not a component — to preserve focus) ────────

  function newFolderInputRow(depth: number) {
    const indent = 6 + depth * 14;
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 3, padding: `3px 6px 3px ${indent}px` }}>
        <Folder size={12} style={{ color: "var(--navy)", flexShrink: 0 }} />
        <input
          autoFocus
          value={newFolderName}
          onChange={e => setNewFolderName(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); createFolder(); }
            if (e.key === "Escape") { setAddingFolderParentId(undefined); setNewFolderName(""); }
          }}
          placeholder="フォルダ名"
          style={{ flex: 1, minWidth: 0, fontSize: 11, padding: "2px 5px", border: "1px solid var(--navy)", borderRadius: 4, outline: "none" }}
        />
        <button type="button" onClick={createFolder} title="確定" style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "var(--navy)", borderRadius: 4, cursor: "pointer", color: "#fff", flexShrink: 0 }}>
          <Check size={11} />
        </button>
        <button type="button" onClick={() => { setAddingFolderParentId(undefined); setNewFolderName(""); }} title="キャンセル" style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--line)", background: "transparent", borderRadius: 4, cursor: "pointer", color: "var(--ink-muted)", flexShrink: 0 }}>
          <X size={11} />
        </button>
      </div>
    );
  }

  // ── Folder tree renderer ──────────────────────────────────────────────────

  function renderTree(parentId: string | null, depth: number): React.ReactNode {
    return catalog.folders
      .filter(f => f.parentId === parentId)
      .map(folder => {
        const hasChildren = catalog.folders.some(f => f.parentId === folder.id);
        const isExpanded = expandedFolders.has(folder.id);
        const isSelected = selectedFolderId === folder.id;
        const indent = 6 + depth * 14;

        return (
          <div key={folder.id}>
            {/* Folder row */}
            <div
              style={{ display: "flex", alignItems: "center", gap: 2, padding: `3px 4px 3px ${indent}px`, borderRadius: 6, background: isSelected ? "var(--navy-tint-soft, #eef2f8)" : "transparent", position: "relative" }}
              onMouseLeave={() => { if (folderMenuId === folder.id) setFolderMenuId(null); }}
            >
              {editingFolderId === folder.id ? (
                <input
                  autoFocus
                  value={editingFolderName}
                  onChange={e => setEditingFolderName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") renameFolder(folder.id, editingFolderName);
                    if (e.key === "Escape") setEditingFolderId(null);
                  }}
                  onBlur={() => renameFolder(folder.id, editingFolderName)}
                  style={{ flex: 1, fontSize: 11, padding: "2px 5px", border: "1px solid var(--navy)", borderRadius: 4, outline: "none" }}
                />
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => { toggleExpand(folder.id); selectFolder(folder.id); }}
                    style={{ display: "flex", alignItems: "center", gap: 3, flex: 1, background: "none", border: "none", cursor: "pointer", minWidth: 0, padding: 0 }}
                  >
                    <span style={{ width: 12, flexShrink: 0, display: "flex", justifyContent: "center", color: "var(--ink-faint)" }}>
                      {hasChildren ? (isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />) : null}
                    </span>
                    {isExpanded
                      ? <FolderOpen size={12} style={{ color: "var(--navy)", flexShrink: 0 }} />
                      : <Folder size={12} style={{ color: "var(--navy)", flexShrink: 0 }} />
                    }
                    <span style={{ fontSize: 12, color: isSelected ? "var(--navy)" : "var(--ink-soft)", fontWeight: isSelected ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, textAlign: "left" }}>
                      {folder.name}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); setFolderMenuId(folderMenuId === folder.id ? null : folder.id); }}
                    style={{ width: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-faint)", flexShrink: 0 }}
                  >
                    <MoreHorizontal size={10} />
                  </button>
                </>
              )}

              {/* Dropdown menu — below trigger, not to the right */}
              {folderMenuId === folder.id && (
                <div style={{ position: "absolute", right: 0, top: "100%", zIndex: 100, background: "#fff", border: "1px solid var(--line)", borderRadius: 6, boxShadow: "0 4px 12px rgba(0,0,0,.14)", minWidth: 140, padding: "4px 0" }}>
                  <button type="button" onClick={() => { setAddingFolderParentId(folder.id); setNewFolderName(""); setExpandedFolders(p => new Set([...p, folder.id])); setFolderMenuId(null); }} style={cardMenuItemStyle}>
                    サブフォルダ作成
                  </button>
                  <button type="button" onClick={() => { setEditingFolderId(folder.id); setEditingFolderName(folder.name); setFolderMenuId(null); }} style={cardMenuItemStyle}>
                    名前を変更
                  </button>
                  <button type="button" onClick={() => { setDeleteFolderId(folder.id); setFolderMenuId(null); }} style={{ ...cardMenuItemStyle, color: "#c0392b" }}>
                    削除
                  </button>
                </div>
              )}
            </div>

            {isExpanded && (
              <>
                {renderTree(folder.id, depth + 1)}
                {addingFolderParentId === folder.id && newFolderInputRow(depth + 1)}
              </>
            )}
          </div>
        );
      });
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const subFolders = catalog.folders.filter(f => f.parentId === selectedFolderId);
  const visibleItems = catalog.items.filter(i => i.folderId === selectedFolderId);
  const ancestors = getAncestors(catalog.folders, selectedFolderId);
  const hasContent = subFolders.length > 0 || visibleItems.length > 0;

  return (
    <section className="panel" style={{ display: "flex", flexDirection: "row", flex: 1, minHeight: 0 }}>

      {/* ── Sidebar ── */}
      <div style={{ width: 220, flexShrink: 0, borderRight: "1px solid var(--line)", display: "flex", flexDirection: "column", background: "var(--panel-deep, #f8f9fa)", borderRadius: "16px 0 0 16px", overflow: "hidden" }}>

        {/* Header — clicking returns to root */}
        <div
          style={{ padding: "12px 10px 8px", borderBottom: "1px solid var(--line)", flexShrink: 0, cursor: "pointer" }}
          onClick={() => selectFolder(null)}
        >
          <span style={{ fontSize: 13, fontWeight: 600, color: selectedFolderId === null ? "var(--navy)" : "var(--ink-soft)", letterSpacing: "0.04em" }}>保管庫</span>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "6px 4px" }}>
          {renderTree(null, 0)}
          {addingFolderParentId === null && newFolderInputRow(0)}
        </div>

        {folderError && (
          <div style={{ padding: "6px 8px", background: "#fff5f5", borderTop: "1px solid #feb2b2", flexShrink: 0 }}>
            <p style={{ margin: "0 0 2px", fontSize: 11, color: "#c53030" }}>{folderError}</p>
            <button type="button" onClick={() => setFolderError(null)} style={{ fontSize: 10, color: "#c53030", background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline" }}>閉じる</button>
          </div>
        )}

        <div style={{ padding: 8, borderTop: "1px solid var(--line)", flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => { setAddingFolderParentId(null); setNewFolderName(""); setFolderError(null); }}
            style={{ width: "100%", display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", border: "1px dashed var(--line)", borderRadius: 6, background: "transparent", cursor: "pointer", color: "var(--ink-soft)", fontSize: 12 }}
          >
            <Plus size={12} />
            フォルダ作成
          </button>
        </div>
      </div>

      {/* ── Main area ── */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>

        {/* Breadcrumb header */}
        <div className="panel-head">
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button
              type="button"
              onClick={() => selectFolder(null)}
              style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 12, color: selectedFolderId === null ? "var(--navy)" : "var(--ink-muted)", fontWeight: selectedFolderId === null ? 600 : 400 }}
            >
              保管庫
            </button>
            {ancestors.map(f => (
              <span key={f.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <ChevronRight size={11} style={{ color: "var(--ink-faint)", flexShrink: 0 }} />
                <button
                  type="button"
                  onClick={() => selectFolder(f.id)}
                  style={{ background: "none", border: "none", cursor: "pointer", padding: 0, fontSize: 12, color: selectedFolderId === f.id ? "var(--navy)" : "var(--ink-muted)", fontWeight: selectedFolderId === f.id ? 600 : 400 }}
                >
                  {f.name}
                </button>
              </span>
            ))}
          </div>
          <span className="tiny soft">{subFolders.length + visibleItems.length} 件</span>
        </div>

        {/* Grid */}
        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          {dataLoading ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--ink-faint)", fontSize: 13 }}>
              読み込み中…
            </div>
          ) : !hasContent ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 10, color: "var(--ink-faint)" }}>
              <Folder size={32} strokeWidth={1.2} />
              <p style={{ margin: 0, fontSize: 13 }}>空です</p>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 14 }}>
              {/* Folders first */}
              {subFolders.map(folder => {
                const count = catalog.items.filter(i => i.folderId === folder.id).length
                  + catalog.folders.filter(f => f.parentId === folder.id).length;
                return (
                  <FolderCard
                    key={folder.id}
                    folder={folder}
                    itemCount={count}
                    onOpen={() => { selectFolder(folder.id); setExpandedFolders(p => new Set([...p, folder.id])); }}
                    onRename={() => { setRenamingFolderId(folder.id); setRenamingFolderName(folder.name); }}
                    onDelete={() => setDeleteFolderId(folder.id)}
                  />
                );
              })}
              {/* Then files */}
              {visibleItems.map(item => (
                <ItemCard
                  key={item.id}
                  item={item}
                  onOpen={() => openItem(item)}
                  onDelete={() => setDeleteItemId(item.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Rename folder modal (triggered from FolderCard) ── */}
      {renamingFolderId && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setRenamingFolderId(null)}>
          <div style={{ background: "#fff", borderRadius: 14, padding: 24, width: 300, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }} onClick={e => e.stopPropagation()}>
            <p style={{ margin: "0 0 12px", fontWeight: 600, fontSize: 15, color: "var(--ink)" }}>フォルダ名を変更</p>
            <input
              autoFocus
              className="input"
              value={renamingFolderName}
              onChange={e => setRenamingFolderName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") renameFolder(renamingFolderId, renamingFolderName); if (e.key === "Escape") setRenamingFolderId(null); }}
              style={{ marginBottom: 16, height: 36 }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setRenamingFolderId(null)} style={{ padding: "7px 16px", fontSize: 13, border: "1px solid var(--line)", borderRadius: "var(--radius)", background: "transparent", cursor: "pointer", color: "var(--ink-soft)" }}>キャンセル</button>
              <button type="button" onClick={() => renameFolder(renamingFolderId, renamingFolderName)} style={{ padding: "7px 16px", fontSize: 13, border: "none", borderRadius: "var(--radius)", background: "var(--navy)", cursor: "pointer", color: "#fff", fontWeight: 600 }}>変更</button>
            </div>
          </div>
        </div>
      )}

      {deleteItemId && (
        <ConfirmModal
          title="アイテムを削除"
          message="保管庫からこのアイテムを削除します。チャット履歴は削除されません。"
          onCancel={() => setDeleteItemId(null)}
          onConfirm={() => deleteItem(deleteItemId)}
        />
      )}
      {deleteFolderId && (
        <ConfirmModal
          title="フォルダを削除"
          message="このフォルダを削除します。フォルダ内のアイテムはルートに移動します。サブフォルダも削除されます。"
          onCancel={() => setDeleteFolderId(null)}
          onConfirm={() => deleteFolder(deleteFolderId)}
        />
      )}
    </section>
  );
}
