"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check, ChevronDown, ChevronRight, FileText, Folder, FolderOpen,
  LayoutTemplate, MoreHorizontal, Plus, Upload, X,
} from "lucide-react";
import { Button, FieldLabel } from "@/components/ui";
import { formatFileSize } from "@/lib/file-assets";

type RepoFolder = { id: string; name: string; parentId: string | null };
type RepoItem = {
  id: string; title: string; folderId: string | null; savedAt: string;
  source: "generated" | "uploaded";
  // generated
  sessionId?: string; type?: "word" | "slide";
  docMode?: "summary" | "procedure" | "free"; firstSlideHtml?: string;
  // uploaded
  s3Key?: string; contentType?: string; sizeLabel?: string; fileName?: string;
};
type RepoCatalog = { folders: RepoFolder[]; items: RepoItem[] };

const MODE_LABELS: Record<string, string> = {
  summary: "病気の要約", procedure: "手順作成", free: "自由作成",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function collectDescendants(folders: RepoFolder[], id: string): Set<string> {
  const s = new Set<string>();
  const go = (fid: string) => { s.add(fid); folders.filter(f => f.parentId === fid).forEach(f => go(f.id)); };
  go(id);
  return s;
}

function getAncestors(folders: RepoFolder[], folderId: string | null): RepoFolder[] {
  if (!folderId) return [];
  const path: RepoFolder[] = [];
  let cur: string | null = folderId;
  while (cur) { const f = folders.find(x => x.id === cur); if (!f) break; path.unshift(f); cur = f.parentId; }
  return path;
}

function flattenForPicker(
  folders: RepoFolder[], excludeIds: Set<string>, parentId: string | null, depth: number
): { id: string; name: string; depth: number }[] {
  return folders
    .filter(f => f.parentId === parentId && !excludeIds.has(f.id))
    .flatMap(f => [{ id: f.id, name: f.name, depth }, ...flattenForPicker(folders, excludeIds, f.id, depth + 1)]);
}

function fileExtLabel(fileName: string): string {
  return (fileName.split(".").pop() ?? "FILE").toUpperCase().slice(0, 4);
}

// ── Sub-components (outside parent) ──────────────────────────────────────────

function UploadedFilePreview({ s3Key, contentType, fileName }: {
  s3Key: string; contentType?: string; fileName?: string;
}) {
  const [url, setUrl] = useState("");
  const [failed, setFailed] = useState(false);

  const isImage = contentType?.startsWith("image/");
  const isPdf = contentType === "application/pdf" || fileName?.toLowerCase().endsWith(".pdf");
  const canPreview = isImage || isPdf;

  useEffect(() => {
    if (!canPreview) return;
    fetch("/api/manual-repository", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get-download-url", s3Key }),
    })
      .then(r => r.json())
      .then((d: { url?: string }) => { if (d.url) setUrl(d.url); else setFailed(true); })
      .catch(() => setFailed(true));
  }, [s3Key, canPreview]);

  if (!canPreview || failed) {
    return <FileTypeBadge fileName={fileName} contentType={contentType} />;
  }
  if (!url) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, color: "var(--ink-muted)" }}>
        <div className="dot ok" style={{ animation: "pulse 1.2s infinite" }} />
        <span style={{ fontSize: 10 }}>読み込み中</span>
      </div>
    );
  }
  if (isImage) {
    return <img src={url} alt={fileName ?? ""} style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />;
  }
  // PDF
  return (
    <div style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative" }}>
      <iframe
        title={fileName ?? "preview"}
        src={`${url}#page=1&toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
        style={{ width: "178%", height: "178%", border: 0, transform: "scale(0.56)", transformOrigin: "top left", pointerEvents: "none" }}
        aria-hidden="true"
      />
    </div>
  );
}

function SlidePreview({ html }: { html: string }) {
  return (
    <div style={{ width: 192, height: 108, overflow: "hidden", flexShrink: 0, background: "#111827" }}>
      <div style={{ width: 960, height: 540, transform: "scale(0.2)", transformOrigin: "top left", pointerEvents: "none" }}
        dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function FileTypeBadge({ fileName, contentType }: { fileName?: string; contentType?: string }) {
  const ext = fileName ? fileExtLabel(fileName) : "FILE";
  const isImage = contentType?.startsWith("image/");
  if (isImage) return <div style={{ fontSize: 28, textAlign: "center", lineHeight: 1 }}>🖼</div>;
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: 48, height: 56, borderRadius: 6, background: "var(--navy-tint-soft,#eef2f8)",
      color: "var(--navy-deep)", fontSize: 10, fontWeight: 700, fontFamily: "ui-monospace,monospace",
      letterSpacing: "0.06em", border: "1px solid var(--navy-tint,#c8d9ee)",
    }}>
      {ext}
    </div>
  );
}

const cardMenuItemSt: React.CSSProperties = {
  width: "100%", textAlign: "left", padding: "6px 12px", fontSize: 12,
  border: "none", background: "none", cursor: "pointer", color: "var(--ink)", whiteSpace: "nowrap",
};

function ItemCard({ item, onOpen, onDelete }: {
  item: RepoItem; onOpen: () => void; onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const date = new Date(item.savedAt).toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
  const isSlide = item.source === "generated" && item.type === "slide";
  const isUpload = item.source === "uploaded";

  return (
    <div
      style={{ border: "1px solid var(--line)", borderRadius: 10, overflow: "visible", background: "#fff", cursor: "pointer", position: "relative" }}
      onClick={onOpen}
      onMouseLeave={() => setMenuOpen(false)}
    >
      {/* Preview */}
      <div style={{ height: 88, background: "#f0f4f8", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", borderRadius: "8px 8px 0 0" }}>
        {isSlide && item.firstSlideHtml ? (
          <SlidePreview html={item.firstSlideHtml} />
        ) : isUpload && item.s3Key ? (
          <UploadedFilePreview s3Key={item.s3Key} contentType={item.contentType} fileName={item.fileName} />
        ) : (
          <FileText size={36} strokeWidth={1.1} style={{ color: "#7ba3cc" }} />
        )}
      </div>
      {/* Info */}
      <div style={{ padding: "8px 10px" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 4 }}>
          {item.title}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {isUpload ? (
            <span style={{ fontSize: 10, color: "var(--ink-muted)", background: "#f0f4f8", padding: "1px 6px", borderRadius: 8, whiteSpace: "nowrap" }}>
              {item.sizeLabel ?? ""}
            </span>
          ) : (
            <span style={{ fontSize: 10, color: "var(--ink-muted)", background: "var(--navy-tint-soft,#eef2f8)", padding: "1px 6px", borderRadius: 8, whiteSpace: "nowrap" }}>
              {item.docMode ? (MODE_LABELS[item.docMode] ?? item.docMode) : (item.type === "slide" ? "スライド" : "Word")}
            </span>
          )}
          <span style={{ fontSize: 10, color: "var(--ink-muted)", marginLeft: "auto" }}>{date}</span>
        </div>
      </div>
      {/* Menu */}
      <div style={{ position: "absolute", top: 6, right: 6 }} onClick={e => e.stopPropagation()}>
        <button type="button" onClick={() => setMenuOpen(v => !v)}
          style={{ width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "rgba(240,244,248,0.9)", borderRadius: 6, cursor: "pointer", color: "var(--ink-soft)" }}>
          <MoreHorizontal size={13} />
        </button>
        {menuOpen && (
          <div style={{ position: "absolute", right: 0, top: "100%", zIndex: 50, background: "#fff", border: "1px solid var(--line)", borderRadius: 6, boxShadow: "0 4px 12px rgba(0,0,0,.14)", padding: "4px 0" }}>
            <button type="button" onClick={onOpen} style={cardMenuItemSt}>
              {isUpload ? "プレビュー" : "開いて編集"}
            </button>
            <button type="button" onClick={onDelete} style={{ ...cardMenuItemSt, color: "#c0392b" }}>削除</button>
          </div>
        )}
      </div>
    </div>
  );
}

function FolderCard({ folder, itemCount, isDropTarget, onOpen, onRename, onDelete, onDragOver, onDragLeave, onDrop }: {
  folder: RepoFolder; itemCount: number; isDropTarget: boolean;
  onOpen: () => void; onRename: () => void; onDelete: () => void;
  onDragOver: (e: React.DragEvent) => void; onDragLeave: (e: React.DragEvent) => void; onDrop: (e: React.DragEvent) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div
      style={{ border: `2px solid ${isDropTarget ? "var(--navy)" : "var(--line)"}`, borderRadius: 10, background: isDropTarget ? "var(--navy-tint-soft,#eef2f8)" : "#fff", cursor: "pointer", position: "relative", transition: "border-color .1s" }}
      onClick={onOpen} onMouseLeave={() => setMenuOpen(false)}
      onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
    >
      <div style={{ height: 88, background: isDropTarget ? "var(--navy-tint,#c8d9ee)" : "var(--navy-tint-soft,#eef2f8)", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "8px 8px 0 0", transition: "background .1s" }}>
        <Folder size={36} strokeWidth={1.2} style={{ color: "var(--navy)" }} />
      </div>
      <div style={{ padding: "8px 10px" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginBottom: 3 }}>{folder.name}</div>
        <div style={{ fontSize: 11, color: "var(--ink-muted)" }}>{itemCount} 件</div>
      </div>
      <div style={{ position: "absolute", top: 6, right: 6 }} onClick={e => e.stopPropagation()}>
        <button type="button" onClick={() => setMenuOpen(v => !v)}
          style={{ width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "rgba(238,242,248,0.9)", borderRadius: 6, cursor: "pointer", color: "var(--navy)" }}>
          <MoreHorizontal size={13} />
        </button>
        {menuOpen && (
          <div style={{ position: "absolute", right: 0, top: "100%", zIndex: 50, background: "#fff", border: "1px solid var(--line)", borderRadius: 6, boxShadow: "0 4px 12px rgba(0,0,0,.14)", padding: "4px 0" }}>
            <button type="button" onClick={() => { onOpen(); setMenuOpen(false); }} style={cardMenuItemSt}>開く</button>
            <button type="button" onClick={() => { onRename(); setMenuOpen(false); }} style={cardMenuItemSt}>名前を変更</button>
            <button type="button" onClick={() => { onDelete(); setMenuOpen(false); }} style={{ ...cardMenuItemSt, color: "#c0392b" }}>削除</button>
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
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onCancel}>
      <div style={{ background: "#fff", borderRadius: 14, padding: 24, width: 320, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }} onClick={e => e.stopPropagation()}>
        <p style={{ margin: "0 0 6px", fontWeight: 600, fontSize: 15, color: "var(--ink)" }}>{title}</p>
        <p style={{ margin: "0 0 20px", fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.6 }}>{message}</p>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onCancel} style={{ padding: "7px 16px", fontSize: 13, border: "1px solid var(--line)", borderRadius: "var(--radius)", background: "transparent", cursor: "pointer", color: "var(--ink-soft)" }}>キャンセル</button>
          <button type="button" onClick={onConfirm} style={{ padding: "7px 16px", fontSize: 13, border: "none", borderRadius: "var(--radius)", background: "#c53030", cursor: "pointer", color: "#fff", fontWeight: 600 }}>削除</button>
        </div>
      </div>
    </div>
  );
}

function FilePreviewOverlay({ item, onClose }: { item: RepoItem; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!item.s3Key) { setLoading(false); setError(true); return; }
    fetch("/api/manual-repository", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get-download-url", s3Key: item.s3Key }),
    })
      .then(r => r.json())
      .then((d: { url?: string }) => { if (d.url) setUrl(d.url); else setError(true); })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [item.s3Key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isImage = item.contentType?.startsWith("image/");

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div style={{ width: "min(1100px, 95vw)", height: "calc(100vh - 56px)", background: "#fff", borderRadius: 16, overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" }} onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", borderBottom: "1px solid var(--line)", background: "var(--panel-deep)", flexShrink: 0 }}>
          <div>
            <div style={{ fontWeight: 600, color: "var(--navy-deep)", fontSize: 15 }}>{item.title}</div>
            {item.fileName && item.fileName !== item.title && (
              <div style={{ fontSize: 11, color: "var(--ink-muted)", marginTop: 1 }}>{item.fileName} {item.sizeLabel ? `・ ${item.sizeLabel}` : ""}</div>
            )}
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {url && (
              <a href={url} download={item.fileName ?? item.title}
                style={{ fontSize: 12, color: "var(--navy)", textDecoration: "underline", cursor: "pointer" }}
                onClick={e => e.stopPropagation()}>
                ダウンロード
              </a>
            )}
            <button type="button" onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-soft)", display: "flex" }}>
              <X size={18} />
            </button>
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, background: "#f0f0f0", display: "flex", alignItems: "center", justifyContent: "center" }}>
          {loading ? (
            <span style={{ color: "var(--ink-muted)", fontSize: 13 }}>読み込み中…</span>
          ) : error ? (
            <span style={{ color: "var(--ink-muted)", fontSize: 13 }}>プレビューを表示できませんでした</span>
          ) : isImage ? (
            <img src={url} alt={item.title} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
          ) : (
            <iframe src={url} title={item.title} style={{ width: "100%", height: "100%", border: 0, background: "#fff" }} />
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function ManualRepositoryPanel() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [catalog, setCatalog] = useState<RepoCatalog>({ folders: [], items: [] });
  const [dataLoading, setDataLoading] = useState(true);
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [folderMenuId, setFolderMenuId] = useState<string | null>(null);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingFolderName, setEditingFolderName] = useState("");
  const [addingFolderParentId, setAddingFolderParentId] = useState<string | null | undefined>(undefined);
  const [newFolderName, setNewFolderName] = useState("");
  const [folderError, setFolderError] = useState<string | null>(null);
  const [deleteItemId, setDeleteItemId] = useState<string | null>(null);
  const [deleteFolderId, setDeleteFolderId] = useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renamingFolderName, setRenamingFolderName] = useState("");
  const [previewItem, setPreviewItem] = useState<RepoItem | null>(null);

  // Upload state
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadDestFolderId, setUploadDestFolderId] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadNotice, setUploadNotice] = useState("");

  useEffect(() => {
    fetch("/api/manual-repository")
      .then(r => r.json())
      .then((d: RepoCatalog) => setCatalog(d))
      .catch(() => {})
      .finally(() => setDataLoading(false));
  }, []);

  async function apiPost(body: object): Promise<Record<string, unknown>> {
    const res = await fetch("/api/manual-repository", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({})) as { error?: string };
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    return res.json() as Promise<Record<string, unknown>>;
  }

  // ── Upload ────────────────────────────────────────────────────
  function addPendingFiles(fileList: FileList | File[]) {
    const incoming = Array.from(fileList).filter(f => f.size > 0);
    if (!incoming.length) return;
    setPendingFiles(prev => {
      const keys = new Set(prev.map(f => `${f.name}-${f.size}`));
      return [...prev, ...incoming.filter(f => !keys.has(`${f.name}-${f.size}`))];
    });
    setUploadNotice("");
  }

  async function uploadFiles() {
    if (!pendingFiles.length) { setUploadNotice("ファイルを選択してください。"); return; }
    setIsUploading(true);
    setUploadNotice("アップロード中…");
    try {
      const uploaded: RepoItem[] = [];
      for (const file of pendingFiles) {
        const { uploadUrl, s3Key, id } = await apiPost({
          action: "get-upload-url", fileName: file.name, contentType: file.type || "application/octet-stream",
        }) as { uploadUrl: string; s3Key: string; id: string };

        const putRes = await fetch(uploadUrl, {
          method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file,
        });
        if (!putRes.ok) throw new Error(`${file.name} のアップロードに失敗しました`);

        const { id: itemId } = await apiPost({
          action: "save-item",
          item: {
            title: file.name.replace(/\.[^.]+$/, ""),
            folderId: uploadDestFolderId,
            source: "uploaded",
            s3Key,
            contentType: file.type || "application/octet-stream",
            sizeLabel: formatFileSize(file.size),
            fileName: file.name,
          },
        }) as { id: string };

        uploaded.push({
          id: itemId, title: file.name.replace(/\.[^.]+$/, ""),
          folderId: uploadDestFolderId, savedAt: new Date().toISOString(),
          source: "uploaded", s3Key, contentType: file.type, sizeLabel: formatFileSize(file.size), fileName: file.name,
        });
        void id; // suppress unused warning
      }
      setCatalog(prev => ({ ...prev, items: [...prev.items, ...uploaded] }));
      setPendingFiles([]);
      setUploadNotice(`${uploaded.length}件を追加しました。`);
    } catch (e) {
      setUploadNotice(e instanceof Error ? e.message : "アップロードに失敗しました。");
    } finally {
      setIsUploading(false);
    }
  }

  // ── Folder CRUD ───────────────────────────────────────────────
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
    } catch (e) { setFolderError(e instanceof Error ? e.message : "作成に失敗しました"); }
  }

  async function renameFolder(id: string, name: string) {
    if (!name.trim()) { setRenamingFolderId(null); setEditingFolderId(null); return; }
    await apiPost({ action: "rename-folder", id, name: name.trim() }).catch(() => {});
    setCatalog(prev => ({ ...prev, folders: prev.folders.map(f => f.id === id ? { ...f, name: name.trim() } : f) }));
    setRenamingFolderId(null); setEditingFolderId(null);
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

  function openItem(item: RepoItem) {
    if (item.source === "uploaded") {
      setPreviewItem(item);
    } else if (item.sessionId) {
      router.push(`/manual?sessionId=${item.sessionId}&repoItemId=${item.id}`);
    }
  }

  function selectFolder(id: string | null) {
    setSelectedFolderId(id);
    setFolderMenuId(null);
  }

  // ── Inline folder input (not a component to preserve focus) ───
  function newFolderInputRow(depth: number) {
    const indent = 6 + depth * 14;
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 3, padding: `3px 6px 3px ${indent}px` }}>
        <Folder size={12} style={{ color: "var(--navy)", flexShrink: 0 }} />
        <input
          autoFocus value={newFolderName}
          onChange={e => setNewFolderName(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); createFolder(); } if (e.key === "Escape") { setAddingFolderParentId(undefined); setNewFolderName(""); } }}
          placeholder="フォルダ名"
          style={{ flex: 1, minWidth: 0, fontSize: 11, padding: "2px 5px", border: "1px solid var(--navy)", borderRadius: 4, outline: "none" }}
        />
        <button type="button" onClick={createFolder} title="確定"
          style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "var(--navy)", borderRadius: 4, cursor: "pointer", color: "#fff", flexShrink: 0 }}>
          <Check size={11} />
        </button>
        <button type="button" onClick={() => { setAddingFolderParentId(undefined); setNewFolderName(""); }} title="キャンセル"
          style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--line)", background: "transparent", borderRadius: 4, cursor: "pointer", color: "var(--ink-muted)", flexShrink: 0 }}>
          <X size={11} />
        </button>
      </div>
    );
  }

  // ── Folder tree renderer ──────────────────────────────────────
  function renderFolderTree(parentId: string | null, depth: number): React.ReactNode {
    return catalog.folders.filter(f => f.parentId === parentId).map(folder => {
      const hasChildren = catalog.folders.some(f => f.parentId === folder.id);
      const isExpanded = expandedFolders.has(folder.id);
      const isSelected = selectedFolderId === folder.id;
      const indent = 6 + depth * 14;

      return (
        <div key={folder.id}>
          <div
            style={{ display: "flex", alignItems: "center", gap: 2, padding: `3px 4px 3px ${indent}px`, borderRadius: 6, background: isSelected ? "var(--navy-tint-soft,#eef2f8)" : "transparent", position: "relative" }}
            onMouseLeave={() => { if (folderMenuId === folder.id) setFolderMenuId(null); }}
          >
            {editingFolderId === folder.id ? (
              <input autoFocus value={editingFolderName}
                onChange={e => setEditingFolderName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") renameFolder(folder.id, editingFolderName); if (e.key === "Escape") setEditingFolderId(null); }}
                onBlur={() => renameFolder(folder.id, editingFolderName)}
                style={{ flex: 1, fontSize: 11, padding: "2px 5px", border: "1px solid var(--navy)", borderRadius: 4, outline: "none" }}
              />
            ) : (
              <>
                <button type="button"
                  onClick={() => { const next = !isExpanded; setExpandedFolders(p => { const s = new Set(p); next ? s.add(folder.id) : s.delete(folder.id); return s; }); selectFolder(folder.id); }}
                  style={{ display: "flex", alignItems: "center", gap: 3, flex: 1, background: "none", border: "none", cursor: "pointer", minWidth: 0, padding: 0 }}>
                  <span style={{ width: 12, flexShrink: 0, display: "flex", justifyContent: "center", color: "var(--ink-faint)" }}>
                    {hasChildren ? (isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />) : null}
                  </span>
                  {isExpanded
                    ? <FolderOpen size={12} style={{ color: "var(--navy)", flexShrink: 0 }} />
                    : <Folder size={12} style={{ color: "var(--navy)", flexShrink: 0 }} />}
                  <span style={{ fontSize: 12, color: isSelected ? "var(--navy)" : "var(--ink-soft)", fontWeight: isSelected ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, textAlign: "left" }}>
                    {folder.name}
                  </span>
                </button>
                <button type="button"
                  onClick={e => { e.stopPropagation(); setFolderMenuId(folderMenuId === folder.id ? null : folder.id); }}
                  style={{ width: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-faint)", flexShrink: 0 }}>
                  <MoreHorizontal size={10} />
                </button>
              </>
            )}

            {folderMenuId === folder.id && (
              <div style={{ position: "absolute", right: 0, top: "100%", zIndex: 100, background: "#fff", border: "1px solid var(--line)", borderRadius: 6, boxShadow: "0 4px 12px rgba(0,0,0,.14)", minWidth: 140, padding: "4px 0" }}>
                <button type="button" onClick={() => { setAddingFolderParentId(folder.id); setNewFolderName(""); setExpandedFolders(p => new Set([...p, folder.id])); setFolderMenuId(null); }} style={cardMenuItemSt}>サブフォルダ作成</button>
                <button type="button" onClick={() => { setEditingFolderId(folder.id); setEditingFolderName(folder.name); setFolderMenuId(null); }} style={cardMenuItemSt}>名前を変更</button>
                <button type="button" onClick={() => { setDeleteFolderId(folder.id); setFolderMenuId(null); }} style={{ ...cardMenuItemSt, color: "#c0392b" }}>削除</button>
              </div>
            )}
          </div>

          {isExpanded && (
            <>
              {renderFolderTree(folder.id, depth + 1)}
              {addingFolderParentId === folder.id && newFolderInputRow(depth + 1)}
            </>
          )}
        </div>
      );
    });
  }

  // ── Render ────────────────────────────────────────────────────
  const subFolders = catalog.folders.filter(f => f.parentId === selectedFolderId);
  const visibleItems = catalog.items.filter(i => i.folderId === selectedFolderId);
  const ancestors = getAncestors(catalog.folders, selectedFolderId);
  const pickerFolders = flattenForPicker(catalog.folders, new Set(), null, 0);

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "320px minmax(0,1fr)", gap: 20, alignItems: "stretch", height: "calc(100vh - 200px)", minHeight: 560, width: "100%" }}>

        {/* ── Upload panel (left) ── */}
        <section className="panel" style={{ display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
          <div className="panel-head" style={{ flexShrink: 0 }}>
            <span className="panel-title">ファイルを追加する</span>
            <span className="panel-sub">PDF・Word・画像など</span>
          </div>
          <div className="panel-pad" style={{ paddingTop: 18, overflowY: "auto", flex: 1, minHeight: 0 }}>
            {/* Drop zone */}
            <div
              onDragEnter={e => { e.preventDefault(); setIsDragging(true); }}
              onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={e => { e.preventDefault(); setIsDragging(false); }}
              onDrop={e => { e.preventDefault(); setIsDragging(false); addPendingFiles(e.dataTransfer.files); }}
              style={{ border: `1.5px dashed ${isDragging ? "var(--navy)" : "#cbc7b8"}`, background: isDragging ? "var(--navy-tint-soft)" : "var(--panel-deep)", borderRadius: 12, padding: "28px 18px", textAlign: "center", transition: "all .15s ease" }}
            >
              <div style={{ color: "var(--navy)", display: "inline-flex" }}><Upload size={28} aria-hidden="true" /></div>
              <div className="serif" style={{ fontSize: 16, marginTop: 10, color: "var(--navy-deep)", fontWeight: 600, letterSpacing: "0.04em" }}>ここにファイルを置く</div>
              <div className="small soft" style={{ marginTop: 4 }}>または下のボタンで選択</div>
              <input ref={fileInputRef} type="file" multiple style={{ display: "none" }}
                onChange={e => { if (e.target.files) addPendingFiles(e.target.files); e.currentTarget.value = ""; }} />
              <Button variant="secondary" size="sm" style={{ marginTop: 14 }} onClick={() => fileInputRef.current?.click()}>
                <Plus size={13} aria-hidden="true" />ファイルを選択
              </Button>
            </div>

            {/* Pending files */}
            {pendingFiles.length > 0 && (
              <div style={{ marginTop: 14, border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden" }}>
                <div className="tiny" style={{ padding: "8px 12px", background: "var(--panel-deep)", color: "var(--ink-soft)", letterSpacing: "0.12em", fontWeight: 600 }}>追加する予定のファイル</div>
                <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {pendingFiles.map((file, idx) => (
                    <li key={`${file.name}-${file.size}`} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderTop: "1px solid var(--line-soft)" }}>
                      <span style={{ width: 26, height: 26, borderRadius: 4, background: "var(--navy-tint)", color: "var(--navy-deep)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontFamily: "ui-monospace,monospace", letterSpacing: "0.06em", fontWeight: 600 }}>
                        {(file.name.split(".").pop() ?? "FILE").toUpperCase().slice(0, 4)}
                      </span>
                      <div className="stack" style={{ flex: 1, minWidth: 0 }}>
                        <span className="truncate" style={{ fontSize: 12.5, fontWeight: 500 }}>{file.name}</span>
                        <span className="tiny soft">{formatFileSize(file.size)}</span>
                      </div>
                      <button type="button" className="btn ghost sm icon" onClick={() => setPendingFiles(p => p.filter((_, i) => i !== idx))}>
                        <X size={13} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="divider" />

            {/* Folder picker */}
            <FieldLabel>保存先フォルダー</FieldLabel>
            <div style={{ border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden auto", maxHeight: 140, background: "#fff" }}>
              <button type="button" onClick={() => setUploadDestFolderId(null)}
                style={{ width: "100%", textAlign: "left", padding: "7px 12px", fontSize: 12, border: "none", display: "flex", alignItems: "center", gap: 6, background: uploadDestFolderId === null ? "var(--navy-tint-soft)" : "transparent", cursor: "pointer", color: uploadDestFolderId === null ? "var(--navy)" : "var(--ink-soft)", fontWeight: uploadDestFolderId === null ? 600 : 400 }}>
                <Folder size={12} />未整理（フォルダーなし）
              </button>
              {pickerFolders.map(({ id, name, depth }) => (
                <button key={id} type="button" onClick={() => setUploadDestFolderId(id)}
                  style={{ width: "100%", textAlign: "left", paddingTop: 7, paddingBottom: 7, paddingLeft: 12 + depth * 14, paddingRight: 12, fontSize: 12, border: "none", display: "flex", alignItems: "center", gap: 6, background: uploadDestFolderId === id ? "var(--navy-tint-soft)" : "transparent", cursor: "pointer", color: uploadDestFolderId === id ? "var(--navy)" : "var(--ink-soft)", fontWeight: uploadDestFolderId === id ? 600 : 400 }}>
                  <Folder size={12} />{name}
                </button>
              ))}
            </div>

            {uploadNotice && <p className="tag accent" style={{ marginTop: 14, display: "block" }}>{uploadNotice}</p>}
            <Button style={{ width: "100%", marginTop: 20, height: 44 }} onClick={uploadFiles} disabled={isUploading}>
              <Upload size={15} aria-hidden="true" />
              {pendingFiles.length > 0 ? `${pendingFiles.length}件を保管庫に追加` : "保管庫に追加"}
            </Button>
            <div className="tiny soft" style={{ textAlign: "center", marginTop: 8, letterSpacing: "0.06em" }}>
              ※ AI処理なし・フォルダ保管のみ
            </div>
          </div>
        </section>

        {/* ── Repository panel (right) ── */}
        <section className="panel" style={{ display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
          {/* Header */}
          <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexShrink: 0 }}>
            <nav style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", minWidth: 0 }}>
              <button type="button" onClick={() => selectFolder(null)}
                style={{ background: "none", border: "none", cursor: "pointer", padding: "2px 6px", borderRadius: 6, color: selectedFolderId === null ? "var(--navy-deep)" : "var(--ink-muted)", fontWeight: selectedFolderId === null ? 600 : 500, fontSize: 13 }}>
                保管庫
              </button>
              {ancestors.map(f => (
                <span key={f.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <ChevronRight size={11} style={{ color: "var(--ink-faint)", flexShrink: 0 }} />
                  <button type="button" onClick={() => selectFolder(f.id)}
                    style={{ background: "none", border: "none", cursor: "pointer", padding: "2px 6px", borderRadius: 6, color: selectedFolderId === f.id ? "var(--navy-deep)" : "var(--ink-muted)", fontWeight: selectedFolderId === f.id ? 600 : 500, fontSize: 13 }}>
                    {f.name}
                  </button>
                </span>
              ))}
            </nav>
            <span className="tiny soft">{subFolders.length + visibleItems.length} 件</span>
          </div>

          {/* Body: sidebar + content */}
          <div style={{ flex: 1, display: "grid", gridTemplateColumns: "200px 1fr", minHeight: 0, overflow: "hidden" }}>

            {/* Sidebar */}
            <div style={{ overflowY: "auto", background: "var(--panel-deep)", borderRight: "1px solid var(--line)", display: "flex", flexDirection: "column" }}>
              <div style={{ flex: 1, overflowY: "auto", padding: "6px 4px" }}>
                <div
                  onClick={() => selectFolder(null)}
                  style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 8px", borderRadius: 6, cursor: "pointer", marginBottom: 2, background: selectedFolderId === null ? "var(--navy-tint-soft,#eef2f8)" : "transparent" }}
                  onMouseEnter={e => { if (selectedFolderId !== null) e.currentTarget.style.background = "var(--navy-tint-soft,#eef2f8)"; }}
                  onMouseLeave={e => { if (selectedFolderId !== null) e.currentTarget.style.background = "transparent"; }}
                >
                  <Folder size={12} style={{ color: "var(--navy)" }} />
                  <span style={{ fontSize: 12, color: selectedFolderId === null ? "var(--navy)" : "var(--ink-soft)", fontWeight: selectedFolderId === null ? 600 : 400 }}>保管庫</span>
                </div>
                {renderFolderTree(null, 0)}
                {addingFolderParentId === null && newFolderInputRow(0)}
              </div>

              {folderError && (
                <div style={{ padding: "6px 8px", background: "#fff5f5", borderTop: "1px solid #feb2b2", flexShrink: 0 }}>
                  <p style={{ margin: "0 0 2px", fontSize: 11, color: "#c53030" }}>{folderError}</p>
                  <button type="button" onClick={() => setFolderError(null)} style={{ fontSize: 10, color: "#c53030", background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline" }}>閉じる</button>
                </div>
              )}
              <div style={{ padding: 8, borderTop: "1px solid var(--line)", flexShrink: 0 }}>
                <button type="button" onClick={() => { setAddingFolderParentId(null); setNewFolderName(""); setFolderError(null); }}
                  style={{ width: "100%", display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", border: "1px dashed var(--line)", borderRadius: 6, background: "transparent", cursor: "pointer", color: "var(--ink-soft)", fontSize: 12 }}>
                  <Plus size={12} />フォルダ作成
                </button>
              </div>
            </div>

            {/* Grid */}
            <div style={{ flex: 1, overflowY: "auto", padding: 20 }}>
              {dataLoading ? (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--ink-faint)", fontSize: 13 }}>読み込み中…</div>
              ) : subFolders.length === 0 && visibleItems.length === 0 ? (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 10, color: "var(--ink-faint)" }}>
                  <Folder size={32} strokeWidth={1.2} />
                  <p style={{ margin: 0, fontSize: 13 }}>空です</p>
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 14 }}>
                  {subFolders.map(folder => {
                    const count = catalog.items.filter(i => i.folderId === folder.id).length
                      + catalog.folders.filter(f => f.parentId === folder.id).length;
                    return (
                      <FolderCard
                        key={folder.id} folder={folder} itemCount={count} isDropTarget={false}
                        onOpen={() => { selectFolder(folder.id); setExpandedFolders(p => new Set([...p, folder.id])); }}
                        onRename={() => { setRenamingFolderId(folder.id); setRenamingFolderName(folder.name); }}
                        onDelete={() => setDeleteFolderId(folder.id)}
                        onDragOver={e => e.preventDefault()} onDragLeave={() => {}} onDrop={() => {}}
                      />
                    );
                  })}
                  {visibleItems.map(item => (
                    <ItemCard
                      key={item.id} item={item}
                      onOpen={() => openItem(item)}
                      onDelete={() => setDeleteItemId(item.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>

      {/* ── Modals ── */}
      {renamingFolderId && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setRenamingFolderId(null)}>
          <div style={{ background: "#fff", borderRadius: 14, padding: 24, width: 300, boxShadow: "0 20px 60px rgba(0,0,0,0.2)" }} onClick={e => e.stopPropagation()}>
            <p style={{ margin: "0 0 12px", fontWeight: 600, fontSize: 15, color: "var(--ink)" }}>フォルダ名を変更</p>
            <input autoFocus className="input" value={renamingFolderName}
              onChange={e => setRenamingFolderName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") renameFolder(renamingFolderId, renamingFolderName); if (e.key === "Escape") setRenamingFolderId(null); }}
              style={{ marginBottom: 16, height: 36 }} />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" onClick={() => setRenamingFolderId(null)} style={{ padding: "7px 16px", fontSize: 13, border: "1px solid var(--line)", borderRadius: "var(--radius)", background: "transparent", cursor: "pointer", color: "var(--ink-soft)" }}>キャンセル</button>
              <button type="button" onClick={() => renameFolder(renamingFolderId, renamingFolderName)} style={{ padding: "7px 16px", fontSize: 13, border: "none", borderRadius: "var(--radius)", background: "var(--navy)", cursor: "pointer", color: "#fff", fontWeight: 600 }}>変更</button>
            </div>
          </div>
        </div>
      )}

      {deleteItemId && (
        <ConfirmModal title="アイテムを削除"
          message="保管庫からこのアイテムを削除します。アップロードファイルの場合はS3からも削除されます。チャット履歴（AI生成の場合）は削除されません。"
          onCancel={() => setDeleteItemId(null)} onConfirm={() => deleteItem(deleteItemId)} />
      )}
      {deleteFolderId && (
        <ConfirmModal title="フォルダを削除"
          message="このフォルダを削除します。フォルダ内のアイテムはルートに移動します。サブフォルダも削除されます。"
          onCancel={() => setDeleteFolderId(null)} onConfirm={() => deleteFolder(deleteFolderId)} />
      )}
      {previewItem && (
        <FilePreviewOverlay item={previewItem} onClose={() => setPreviewItem(null)} />
      )}
    </>
  );
}
