"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDown, ChevronRight, FileText, Folder, FolderOpen, MoreHorizontal, Plus,
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

function getBreadcrumb(folders: RepoFolder[], folderId: string | null): string[] {
  if (!folderId) return [];
  const path: string[] = [];
  let cur: string | null = folderId;
  while (cur) {
    const f = folders.find(x => x.id === cur);
    if (!f) break;
    path.unshift(f.name);
    cur = f.parentId;
  }
  return path;
}

// ── Sub-components (defined OUTSIDE parent to avoid remount on re-render) ─────

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

const menuItemStyle: React.CSSProperties = {
  width: "100%", textAlign: "left", padding: "6px 12px", fontSize: 12,
  border: "none", background: "none", cursor: "pointer", color: "var(--ink)",
};

function ItemCard({ item, onOpen, onDelete, menuOpen, onMenuToggle }: {
  item: RepoItem;
  onOpen: () => void;
  onDelete: () => void;
  menuOpen: boolean;
  onMenuToggle: () => void;
}) {
  const date = new Date(item.savedAt).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
  return (
    <div
      style={{ border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden", background: "#fff", cursor: "pointer", position: "relative" }}
      onClick={onOpen}
      onMouseLeave={() => { if (menuOpen) onMenuToggle(); }}
    >
      <div style={{ height: 108, background: "#f0f4f8", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
        {item.type === "slide" && item.firstSlideHtml ? (
          <SlidePreview html={item.firstSlideHtml} />
        ) : (
          <FileText size={40} strokeWidth={1.1} style={{ color: "#7ba3cc" }} />
        )}
      </div>
      <div style={{ padding: "9px 10px" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 5 }}>
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
          onClick={onMenuToggle}
          style={{ width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "rgba(255,255,255,0.88)", borderRadius: 6, cursor: "pointer", color: "var(--ink-soft)" }}
        >
          <MoreHorizontal size={13} />
        </button>
        {menuOpen && (
          <div style={{ position: "absolute", right: 0, top: "100%", zIndex: 50, background: "#fff", border: "1px solid var(--line)", borderRadius: 6, boxShadow: "0 4px 12px rgba(0,0,0,.12)", minWidth: 120, padding: "4px 0" }}>
            <button type="button" onClick={onOpen} style={menuItemStyle}>開いて編集</button>
            <button type="button" onClick={onDelete} style={{ ...menuItemStyle, color: "#c0392b" }}>削除</button>
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
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onCancel}>
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
  const [itemMenuId, setItemMenuId] = useState<string | null>(null);

  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingFolderName, setEditingFolderName] = useState("");

  // addingFolderParentId: undefined = not adding, null = adding at root, string = adding under folder
  const [addingFolderParentId, setAddingFolderParentId] = useState<string | null | undefined>(undefined);
  const [newFolderName, setNewFolderName] = useState("");

  const [deleteItemId, setDeleteItemId] = useState<string | null>(null);
  const [deleteFolderId, setDeleteFolderId] = useState<string | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/manual-repository")
      .then(r => r.json())
      .then((d: RepoCatalog) => setCatalog(d))
      .catch(() => {})
      .finally(() => setDataLoading(false));
  }, []);

  async function api(body: object) {
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
    if (!name) {
      setAddingFolderParentId(undefined);
      setNewFolderName("");
      return;
    }
    const parentId = addingFolderParentId ?? null;
    setFolderError(null);
    try {
      const { id } = await api({ action: "create-folder", name, parentId });
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
    if (!trimmed) { setEditingFolderId(null); return; }
    await api({ action: "rename-folder", id, name: trimmed }).catch(() => {});
    setCatalog(prev => ({ ...prev, folders: prev.folders.map(f => f.id === id ? { ...f, name: trimmed } : f) }));
    setEditingFolderId(null);
  }

  async function deleteFolder(id: string) {
    const descendants = collectDescendants(catalog.folders, id);
    await api({ action: "delete-folder", id }).catch(() => {});
    setCatalog(prev => ({
      folders: prev.folders.filter(f => !descendants.has(f.id)),
      items: prev.items.map(i => i.folderId && descendants.has(i.folderId) ? { ...i, folderId: null } : i),
    }));
    if (selectedFolderId && descendants.has(selectedFolderId)) setSelectedFolderId(null);
    setDeleteFolderId(null);
    setFolderMenuId(null);
  }

  async function deleteItem(id: string) {
    await api({ action: "delete-item", id }).catch(() => {});
    setCatalog(prev => ({ ...prev, items: prev.items.filter(i => i.id !== id) }));
    setDeleteItemId(null);
    setItemMenuId(null);
  }

  function toggleExpand(id: string) {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function openItem(item: RepoItem) {
    router.push(`/manual?sessionId=${item.sessionId}&repoItemId=${item.id}`);
  }

  // ── Folder input JSX (inline, not a component, to preserve focus on re-render) ──
  function newFolderInputJsx(depth: number) {
    const indent = 6 + depth * 14;
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: `4px 4px 4px ${indent}px` }}>
        <span style={{ width: 14, flexShrink: 0 }} />
        <Folder size={13} style={{ color: "var(--navy)", flexShrink: 0 }} />
        <input
          // NOTE: autoFocus works here because this element is newly mounted when
          // addingFolderParentId changes. Subsequent re-renders (from newFolderName
          // updates) do NOT remount this element — it's plain JSX, not a React
          // component defined inside the parent — so focus is preserved.
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={newFolderName}
          onChange={e => setNewFolderName(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); createFolder(); }
            if (e.key === "Escape") { setAddingFolderParentId(undefined); setNewFolderName(""); }
          }}
          placeholder="フォルダ名（Enterで確定）"
          style={{ flex: 1, fontSize: 12, padding: "3px 6px", border: "1px solid var(--navy)", borderRadius: 4, outline: "none" }}
        />
        <button
          type="button"
          onClick={createFolder}
          style={{ fontSize: 11, padding: "2px 8px", border: "1px solid var(--navy)", borderRadius: 4, background: "var(--navy)", color: "#fff", cursor: "pointer", flexShrink: 0 }}
        >
          確定
        </button>
        <button
          type="button"
          onClick={() => { setAddingFolderParentId(undefined); setNewFolderName(""); }}
          style={{ fontSize: 11, padding: "2px 6px", border: "1px solid var(--line)", borderRadius: 4, background: "transparent", color: "var(--ink-muted)", cursor: "pointer", flexShrink: 0 }}
        >
          ✕
        </button>
      </div>
    );
  }

  // ── Folder tree renderer ──────────────────────────────────────────────────

  function renderFolderTree(parentId: string | null, depth: number): React.ReactNode {
    return catalog.folders
      .filter(f => f.parentId === parentId)
      .map(folder => {
        const hasChildren = catalog.folders.some(f => f.parentId === folder.id);
        const isExpanded = expandedFolders.has(folder.id);
        const isSelected = selectedFolderId === folder.id;
        const itemCount = catalog.items.filter(i => i.folderId === folder.id).length;
        const indent = 6 + depth * 14;

        return (
          <div key={folder.id}>
            <div
              style={{ display: "flex", alignItems: "center", gap: 3, padding: `4px 4px 4px ${indent}px`, borderRadius: 6, background: isSelected ? "var(--navy-tint-soft, #eef2f8)" : "transparent", position: "relative" }}
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
                  style={{ flex: 1, fontSize: 12, padding: "2px 6px", border: "1px solid var(--navy)", borderRadius: 4, outline: "none" }}
                />
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => { toggleExpand(folder.id); setSelectedFolderId(folder.id); setFolderMenuId(null); }}
                    style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, background: "none", border: "none", cursor: "pointer", minWidth: 0, padding: 0 }}
                  >
                    <span style={{ width: 14, flexShrink: 0, display: "flex", justifyContent: "center", color: "var(--ink-faint)" }}>
                      {hasChildren ? (isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />) : null}
                    </span>
                    {isExpanded
                      ? <FolderOpen size={13} style={{ color: "var(--navy)", flexShrink: 0 }} />
                      : <Folder size={13} style={{ color: "var(--navy)", flexShrink: 0 }} />}
                    <span style={{ fontSize: 12, color: isSelected ? "var(--navy)" : "var(--ink-soft)", fontWeight: isSelected ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, textAlign: "left" }}>
                      {folder.name}
                    </span>
                    {itemCount > 0 && (
                      <span style={{ fontSize: 10, color: "var(--ink-muted)", flexShrink: 0 }}>{itemCount}</span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={e => { e.stopPropagation(); setFolderMenuId(folderMenuId === folder.id ? null : folder.id); }}
                    style={{ width: 18, height: 18, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-faint)", flexShrink: 0 }}
                  >
                    <MoreHorizontal size={11} />
                  </button>
                </>
              )}

              {folderMenuId === folder.id && (
                <div style={{ position: "absolute", left: "calc(100% + 4px)", top: 0, zIndex: 50, background: "#fff", border: "1px solid var(--line)", borderRadius: 6, boxShadow: "0 4px 12px rgba(0,0,0,.12)", minWidth: 140, padding: "4px 0" }}>
                  <button type="button" onClick={() => { setAddingFolderParentId(folder.id); setNewFolderName(""); setExpandedFolders(p => new Set([...p, folder.id])); setFolderMenuId(null); }} style={menuItemStyle}>
                    サブフォルダ作成
                  </button>
                  <button type="button" onClick={() => { setEditingFolderId(folder.id); setEditingFolderName(folder.name); setFolderMenuId(null); }} style={menuItemStyle}>
                    名前を変更
                  </button>
                  <button type="button" onClick={() => { setDeleteFolderId(folder.id); setFolderMenuId(null); }} style={{ ...menuItemStyle, color: "#c0392b" }}>
                    削除
                  </button>
                </div>
              )}
            </div>

            {isExpanded && (
              <>
                {renderFolderTree(folder.id, depth + 1)}
                {/* Inline JSX — NOT a React component — so focus is preserved on re-render */}
                {addingFolderParentId === folder.id && newFolderInputJsx(depth + 1)}
              </>
            )}
          </div>
        );
      });
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const visibleItems = catalog.items.filter(i => i.folderId === selectedFolderId);
  const breadcrumb = getBreadcrumb(catalog.folders, selectedFolderId);

  return (
    <section className="panel" style={{ display: "flex", flexDirection: "row", flex: 1, minHeight: 0 }}>

      {/* ── Sidebar ── */}
      <div style={{ width: 240, flexShrink: 0, borderRight: "1px solid var(--line)", display: "flex", flexDirection: "column", background: "var(--panel-deep, #f8f9fa)", borderRadius: "16px 0 0 16px", overflow: "hidden" }}>
        <div style={{ padding: "12px 10px 8px", borderBottom: "1px solid var(--line)", flexShrink: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: "var(--navy-deep)", letterSpacing: "0.04em" }}>保管庫</span>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "6px 6px" }}>
          {/* Root entry */}
          <div
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", borderRadius: 6, background: selectedFolderId === null ? "var(--navy-tint-soft, #eef2f8)" : "transparent", cursor: "pointer", marginBottom: 2 }}
            onClick={() => { setSelectedFolderId(null); setFolderMenuId(null); }}
          >
            <Folder size={13} style={{ color: "var(--navy)" }} />
            <span style={{ fontSize: 12, color: selectedFolderId === null ? "var(--navy)" : "var(--ink-soft)", fontWeight: selectedFolderId === null ? 600 : 400 }}>
              ルート
            </span>
            {catalog.items.filter(i => i.folderId === null).length > 0 && (
              <span style={{ fontSize: 10, color: "var(--ink-muted)", marginLeft: "auto" }}>
                {catalog.items.filter(i => i.folderId === null).length}
              </span>
            )}
          </div>

          {/* Folder tree */}
          {renderFolderTree(null, 0)}

          {/* Root-level new folder input (inline JSX, not a component) */}
          {addingFolderParentId === null && newFolderInputJsx(0)}
        </div>

        {folderError ? (
          <div style={{ padding: "6px 8px", background: "#fff5f5", borderTop: "1px solid #feb2b2", flexShrink: 0 }}>
            <p style={{ margin: 0, fontSize: 11, color: "#c53030", lineHeight: 1.4 }}>{folderError}</p>
            <button type="button" onClick={() => setFolderError(null)} style={{ fontSize: 10, color: "#c53030", background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline" }}>閉じる</button>
          </div>
        ) : null}
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
        <div className="panel-head">
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className="tiny soft">保管庫</span>
            {breadcrumb.map((name, i) => (
              <span key={i} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="tiny soft">/</span>
                <span className="tiny soft">{name}</span>
              </span>
            ))}
          </div>
          <span className="tiny soft">{visibleItems.length} 件</span>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
          {dataLoading ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--ink-faint)", fontSize: 13 }}>
              読み込み中…
            </div>
          ) : visibleItems.length === 0 ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 10, color: "var(--ink-faint)" }}>
              <FileText size={32} strokeWidth={1.2} />
              <p style={{ margin: 0, fontSize: 13 }}>このフォルダにはまだ保存されていません</p>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16 }}>
              {visibleItems.map(item => (
                <ItemCard
                  key={item.id}
                  item={item}
                  onOpen={() => openItem(item)}
                  onDelete={() => { setDeleteItemId(item.id); setItemMenuId(null); }}
                  menuOpen={itemMenuId === item.id}
                  onMenuToggle={() => setItemMenuId(itemMenuId === item.id ? null : item.id)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

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
