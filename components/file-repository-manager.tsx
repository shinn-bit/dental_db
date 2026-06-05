"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Check, ChevronDown, ChevronRight, Clipboard, Edit,
  Folder, FolderOpen, Images, MoreHorizontal, Plus,
  RefreshCw, Search, Trash2, Upload, X,
} from "lucide-react";
import { Button, FileSpine, FieldLabel } from "@/components/ui";
import { formatFileSize, getThumbnailLabel, type StoredFileMetadata } from "@/lib/file-assets";

// ── Types ────────────────────────────────────────────────────────
type RepoFolder = { id: string; name: string; parentId: string | null };
type FileAssignments = Record<string, string | null>; // fileId → folderId

type RepositoryFile = {
  id: string; name: string; contentType: string; date: string;
  sizeLabel: string; thumbnailLabel: string; tags: string[];
  version: string; memo: string; summary: string;
  summaryStatus: StoredFileMetadata["summaryStatus"];
  summaryMode: StoredFileMetadata["summaryMode"];
  summaryUpdatedAt: string;
  preparationStatus: StoredFileMetadata["preparationStatus"];
  ragSyncStatus: StoredFileMetadata["ragSyncStatus"];
  thumbnailUrl: string | null;
  textExtractionStatus: StoredFileMetadata["textExtractionStatus"];
  imageCount: number;
  imageProcessingStatus: StoredFileMetadata["imageProcessingStatus"];
  imageProcessingError: string;
};

type DetailDraft = { folderId: string | null; memo: string };

type DragCtx = {
  draggedId: string | null;
  setDraggedId: (id: string | null) => void;
  dropTargetId: string | null;
  setDropTargetId: (id: string | null) => void;
  onDropFile: (fileId: string, folderId: string | null) => void;
  onExternalDrop: (files: FileList, folderId: string | null) => void;
};

type FileGridCommonProps = {
  onOpenSummary: (f: RepositoryFile) => void;
  onDetail: (f: RepositoryFile) => void;
  onDelete: (f: RepositoryFile) => void;
  onProcessImages: (f: RepositoryFile) => void;
  summaryProcessingId: string | null;
  blockedSummaryId: string | null;
  deletingId: string | null;
  drag: DragCtx;
};

// ── Storage ──────────────────────────────────────────────────────
const FOLDERS_KEY = "dental-repo-folders-v2";
const ASSIGNMENTS_KEY = "dental-repo-assignments-v2";

function readFolders(): RepoFolder[] {
  try {
    const v2 = localStorage.getItem(FOLDERS_KEY);
    if (v2) return JSON.parse(v2) as RepoFolder[];
    // Migrate from old 2-level format
    const oldLib = localStorage.getItem("dental-library-tree");
    if (!oldLib) return [];
    const lib = JSON.parse(oldLib) as Array<{ id: string; label: string; subs?: Array<{ id: string; label: string }> }>;
    const folders: RepoFolder[] = [];
    for (const cat of lib) {
      folders.push({ id: cat.id, name: cat.label, parentId: null });
      for (const sub of cat.subs ?? []) {
        folders.push({ id: sub.id, name: sub.label, parentId: cat.id });
      }
    }
    writeFolders(folders);
    return folders;
  } catch { return []; }
}
function writeFolders(f: RepoFolder[]) {
  try { localStorage.setItem(FOLDERS_KEY, JSON.stringify(f)); } catch {}
}

function readAssignments(): FileAssignments {
  try {
    const v2 = localStorage.getItem(ASSIGNMENTS_KEY);
    if (v2) return JSON.parse(v2) as FileAssignments;
    // Migrate from old { catId, subId } format
    const old = localStorage.getItem("dental-file-folders");
    if (!old) return {};
    const parsed = JSON.parse(old) as Record<string, { catId?: string; subId?: string | null }>;
    const result: FileAssignments = {};
    for (const [fid, val] of Object.entries(parsed)) {
      result[fid] = val.subId || val.catId || null;
    }
    writeAssignments(result);
    return result;
  } catch { return {}; }
}
function writeAssignments(a: FileAssignments) {
  try { localStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(a)); } catch {}
}

// ── Folder helpers ───────────────────────────────────────────────
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

// ── Main component ───────────────────────────────────────────────
export function FileRepositoryManager() {
  // Folder state
  const [folders, setFoldersState] = useState<RepoFolder[]>([]);
  const [assignments, setAssignmentsState] = useState<FileAssignments>({});
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [destFolderId, setDestFolderId] = useState<string | null>(null);
  const [addingParentId, setAddingParentId] = useState<string | null | undefined>(undefined);
  const [newFolderName, setNewFolderName] = useState("");
  const [folderMenuId, setFolderMenuId] = useState<string | null>(null);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [editingFolderName, setEditingFolderName] = useState("");
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  // File state
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [files, setFiles] = useState<RepositoryFile[]>([]);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [memo, setMemo] = useState("");
  const [notice, setNotice] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [isLoadingFiles, setIsLoadingFiles] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<RepositoryFile | null>(null);
  const [detailDraft, setDetailDraft] = useState<DetailDraft | null>(null);
  const [detailSaving, setDetailSaving] = useState(false);
  const [sourceViewerFile, setSourceViewerFile] = useState<RepositoryFile | null>(null);
  const [selectedSummary, setSelectedSummary] = useState<RepositoryFile | null>(null);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [summaryEditing, setSummaryEditing] = useState(false);
  const [summaryProcessingId, setSummaryProcessingId] = useState<string | null>(null);
  const [blockedSummaryId, setBlockedSummaryId] = useState<string | null>(null);
  const [summaryCopied, setSummaryCopied] = useState(false);
  const [libQuery, setLibQuery] = useState("");

  // Load from localStorage on mount
  useEffect(() => {
    setFoldersState(readFolders());
    setAssignmentsState(readAssignments());
  }, []);

  // ── Storage setters ───────────────────────────────────────────
  function setFolders(fn: (prev: RepoFolder[]) => RepoFolder[]) {
    setFoldersState(prev => { const next = fn(prev); writeFolders(next); return next; });
  }
  function setAssignments(fn: (prev: FileAssignments) => FileAssignments) {
    setAssignmentsState(prev => { const next = fn(prev); writeAssignments(next); return next; });
  }

  // ── Folder CRUD ───────────────────────────────────────────────
  function addFolder(name: string, parentId: string | null) {
    if (!name.trim()) return;
    const id = `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    setFolders(prev => [...prev, { id, name: name.trim(), parentId }]);
    if (parentId) setExpandedIds(prev => new Set([...prev, parentId]));
    setAddingParentId(undefined);
    setNewFolderName("");
  }
  function renameFolder(id: string, name: string) {
    if (!name.trim()) { setEditingFolderId(null); return; }
    setFolders(prev => prev.map(f => f.id === id ? { ...f, name: name.trim() } : f));
    setEditingFolderId(null);
  }
  function deleteFolder(id: string) {
    if (!window.confirm("このフォルダを削除します。フォルダ内のファイルは未整理に移動されます。")) return;
    const descendants = collectDescendants(folders, id);
    setFolders(prev => prev.filter(f => !descendants.has(f.id)));
    setAssignments(prev => {
      const next = { ...prev };
      for (const fid of Object.keys(next)) {
        if (next[fid] && descendants.has(next[fid]!)) next[fid] = null;
      }
      return next;
    });
    if (selectedFolderId && descendants.has(selectedFolderId)) setSelectedFolderId(null);
    setFolderMenuId(null);
  }
  function moveFile(fileId: string, folderId: string | null) {
    setAssignments(prev => ({ ...prev, [fileId]: folderId }));
    setDraggedId(null);
    setDropTargetId(null);
  }

  // ── File operations (unchanged) ───────────────────────────────
  async function loadFiles(opts: { showLoading?: boolean; updateNotice?: boolean } = {}) {
    if (opts.showLoading) setIsLoadingFiles(true);
    try {
      const res = await fetch("/api/files", { cache: "no-store" });
      if (!res.ok) throw new Error("S3一覧を読み込めませんでした。");
      const data = (await res.json()) as { files: Array<StoredFileMetadata & { thumbnailUrl?: string | null }> };
      setFiles(data.files.map(toRepositoryFile));
    } catch (error) {
      if (opts.updateNotice !== false) setNotice(error instanceof Error ? error.message : "S3一覧を読み込めませんでした。");
    } finally {
      if (opts.showLoading) setIsLoadingFiles(false);
    }
  }

  useEffect(() => {
    let ignore = false;
    async function init() { if (!ignore) await loadFiles({ showLoading: true }); }
    init();
    return () => { ignore = true; };
  }, []);

  const prevPreparingCountRef = useRef(-1);

  async function triggerKbSync() {
    try {
      await fetch("/api/kb-sync", { method: "POST" });
      await loadFiles({ updateNotice: false });
    } catch (e) {
      console.error("[kb-sync]", e);
    }
  }

  useEffect(() => {
    const preparingCount = files.filter(
      f => f.preparationStatus === "processing"
    ).length;

    const needsSync = files.some(
      f => f.preparationStatus === "completed" && f.ragSyncStatus === "not_started"
    );

    if (prevPreparingCountRef.current > 0 && preparingCount === 0 && needsSync) {
      triggerKbSync();
    }
    prevPreparingCountRef.current = preparingCount;

    const hasPending = preparingCount > 0 ||
      files.some(f => f.ragSyncStatus === "syncing" ||
                      f.summaryStatus === "processing" ||
                      f.imageProcessingStatus === "processing");
    if (!hasPending) return;
    const timer = window.setInterval(() => loadFiles({ updateNotice: false }), 8000);
    return () => window.clearInterval(timer);
  }, [files]);

  useEffect(() => {
    for (const f of files) {
      if (f.preparationStatus === "completed" && f.contentType.includes("pdf") && !f.imageProcessingStatus) {
        fetch(`/api/files/${f.id}/process-images`, { method: "POST" }).catch(() => {});
      }
    }
  }, [files]);

  function addPendingFiles(nextFiles: FileList | File[]) {
    const incoming = Array.from(nextFiles).filter(f => f.size > 0);
    if (!incoming.length) return;
    setPendingFiles(cur => {
      const keys = new Set(cur.map(f => `${f.name}-${f.size}`));
      return [...cur, ...incoming.filter(f => !keys.has(`${f.name}-${f.size}`))];
    });
    setNotice("");
  }

  async function registerFiles() {
    if (!pendingFiles.length) { setNotice("ファイルを選択してください。"); return; }
    // 同名ファイルの重複チェック
    const duplicates = pendingFiles.filter(f =>
      files.some(existing => existing.name === f.name)
    );
    if (duplicates.length > 0) {
      const names = duplicates.map(f => f.name.replace(/\.[^.]+$/, "")).join("、");
      const ok = window.confirm(`「${names}」はすでに資料庫に存在します。\n重複して追加しますか？`);
      if (!ok) return;
    }
    setIsUploading(true);
    setNotice("資料庫へアップロードしています。");
    try {
      const uploaded: RepositoryFile[] = [];
      for (const file of pendingFiles) {
        const urlRes = await fetch("/api/upload-url", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: file.name, contentType: file.type || "application/octet-stream" })
        });
        if (!urlRes.ok) throw new Error("Failed to create upload URL");
        const urlData = (await urlRes.json()) as { id: string; uploadUrl: string; s3Key: string };
        const putRes = await fetch(urlData.uploadUrl, {
          method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file
        });
        if (!putRes.ok) throw new Error("Failed to upload file");
        const metaRes = await fetch("/api/files", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: urlData.id, fileName: file.name, s3Key: urlData.s3Key,
            contentType: file.type || "application/octet-stream",
            size: file.size, sizeLabel: formatFileSize(file.size),
            thumbnailLabel: getThumbnailLabel(file.name),
            memo: memo.trim(), uploadedAt: new Date().toISOString(),
          })
        });
        if (!metaRes.ok) throw new Error("Failed to save metadata");
        const metaData = (await metaRes.json()) as { file: StoredFileMetadata };
        const rf = toRepositoryFile(metaData.file);
        uploaded.push(rf);
        if (destFolderId !== undefined) {
          setAssignments(a => ({ ...a, [rf.id]: destFolderId }));
        }
      }
      setPendingFiles([]);
      setMemo("");
      setNotice(`${uploaded.length}件を資料庫に追加しました。`);
      await loadFiles({ updateNotice: false });
    } catch {
      setNotice("アップロードに失敗しました。時間をおいて再度お試しください。");
    } finally {
      setIsUploading(false);
    }
  }

  async function deleteFile(file: RepositoryFile) {
    if (!window.confirm(`${file.name} を削除します。よろしいですか？`)) return;
    setDeletingId(file.id);
    setNotice("S3から削除しています。");
    try {
      const res = await fetch(`/api/files/${file.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete file");
      setFiles(cur => cur.filter(f => f.id !== file.id));
      setAssignments(a => { const next = { ...a }; delete next[file.id]; return next; });
      setNotice(`${file.name} を削除しました。`);
    } catch {
      setNotice("削除に失敗しました。時間をおいて再度お試しください。");
    } finally {
      setDeletingId(null);
    }
  }

  async function openOrCreateSummary(file: RepositoryFile) {
    if (file.summaryStatus !== "completed" && file.preparationStatus !== "completed") {
      setBlockedSummaryId(file.id);
      window.setTimeout(() => setBlockedSummaryId(cur => cur === file.id ? null : cur), 3600);
      return;
    }
    setSummaryProcessingId(file.id);
    setNotice("");
    try {
      const method = file.summaryStatus === "completed" ? "GET" : "POST";
      const res = await fetch(`/api/files/${file.id}/summary`, { method, cache: "no-store" });
      const data = (await res.json()) as { summary?: string; file?: StoredFileMetadata; error?: string };
      if (!res.ok) throw new Error(data.error || "要約の取得または作成に失敗しました。");
      const nextFile = toRepositoryFile(data.file as StoredFileMetadata);
      setFiles(cur => cur.map(f => f.id === nextFile.id ? nextFile : f));
      if (nextFile.summaryStatus === "completed") {
        setSelectedSummary(nextFile);
        setSummaryDraft(data.summary || nextFile.summary);
        setSummaryEditing(false);
      } else {
        setNotice("要約作成を開始しました。完了するとボタンが「要約を見る」に変わります。");
        await loadFiles({ updateNotice: false });
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "要約の取得または作成に失敗しました。");
    } finally {
      setSummaryProcessingId(null);
    }
  }

  async function processImages(file: RepositoryFile) {
    setNotice("");
    try {
      const res = await fetch(`/api/files/${file.id}/process-images`, { method: "POST" });
      const data = (await res.json()) as { status?: string; error?: string };
      if (!res.ok) throw new Error(data.error || "画像処理の開始に失敗しました。");
      await loadFiles({ updateNotice: false });
      setNotice("画像処理を開始しました。完了まで数分かかります。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "画像処理に失敗しました。");
    }
  }

  async function saveSummary() {
    if (!selectedSummary) return;
    setSummaryProcessingId(selectedSummary.id);
    try {
      const res = await fetch(`/api/files/${selectedSummary.id}/summary`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: summaryDraft })
      });
      const data = (await res.json()) as { summary?: string; file?: StoredFileMetadata; error?: string };
      if (!res.ok) throw new Error(data.error || "要約の保存に失敗しました。");
      const nextFile = toRepositoryFile(data.file as StoredFileMetadata);
      setFiles(cur => cur.map(f => f.id === nextFile.id ? nextFile : f));
      setSelectedSummary(nextFile);
      setSummaryEditing(false);
      setNotice("要約を保存しました。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "要約の保存に失敗しました。");
    } finally {
      setSummaryProcessingId(null);
    }
  }

  async function copySummary() {
    if (!summaryDraft) return;
    try {
      await navigator.clipboard.writeText(summaryDraft);
      setSummaryCopied(true);
      window.setTimeout(() => setSummaryCopied(false), 1600);
    } catch { setNotice("コピーに失敗しました。"); }
  }

  function openDetail(file: RepositoryFile) {
    setSelectedDetail(file);
    setDetailDraft({ folderId: assignments[file.id] ?? null, memo: file.memo });
  }

  async function saveDetail() {
    if (!selectedDetail || !detailDraft) return;
    setDetailSaving(true);
    try {
      const res = await fetch(`/api/files/${selectedDetail.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memo: detailDraft.memo.trim() })
      });
      const data = (await res.json()) as { file?: StoredFileMetadata; error?: string };
      if (!res.ok || !data.file) throw new Error(data.error || "詳細を保存できませんでした。");
      const nextFile = toRepositoryFile(data.file);
      setFiles(cur => cur.map(f => f.id === nextFile.id ? nextFile : f));
      setSelectedDetail(nextFile);
      moveFile(selectedDetail.id, detailDraft.folderId);
      setNotice("詳細を保存しました。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "詳細を保存できませんでした。");
    } finally {
      setDetailSaving(false);
    }
  }

  // ── Drag context ──────────────────────────────────────────────
  const dragCtx: DragCtx = {
    draggedId, setDraggedId,
    dropTargetId, setDropTargetId,
    onDropFile: moveFile,
    onExternalDrop: (files, folderId) => {
      setDestFolderId(folderId);
      addPendingFiles(files);
    },
  };

  // ── Computed ──────────────────────────────────────────────────
  const searching = libQuery.trim().length > 0;
  const searchHits = searching ? files.filter(f => f.name.toLowerCase().includes(libQuery.toLowerCase())) : [];
  const ancestors = getAncestors(folders, selectedFolderId);
  const subFolders = folders.filter(f => f.parentId === selectedFolderId);
  const folderFiles = files.filter(f => (assignments[f.id] ?? null) === selectedFolderId);
  const pickerFolders = flattenForPicker(folders, new Set(), null, 0);

  // ── Inline folder input (not a component to preserve focus) ───
  function newFolderInputRow(depth: number) {
    const indent = 10 + depth * 14;
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 3, padding: `3px 6px 3px ${indent}px` }}>
        <Folder size={12} style={{ color: "var(--navy)", flexShrink: 0 }} />
        <input
          autoFocus
          value={newFolderName}
          onChange={e => setNewFolderName(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); addFolder(newFolderName, addingParentId ?? null); }
            if (e.key === "Escape") { setAddingParentId(undefined); setNewFolderName(""); }
          }}
          placeholder="フォルダ名"
          style={{ flex: 1, minWidth: 0, fontSize: 11.5, padding: "2px 6px", border: "1px solid var(--navy)", borderRadius: 4, outline: "none" }}
        />
        <button type="button" onClick={() => addFolder(newFolderName, addingParentId ?? null)}
          style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "var(--navy)", borderRadius: 4, cursor: "pointer", color: "#fff", flexShrink: 0 }}>
          <Check size={11} />
        </button>
        <button type="button" onClick={() => { setAddingParentId(undefined); setNewFolderName(""); }}
          style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", border: "1px solid var(--line)", background: "transparent", borderRadius: 4, cursor: "pointer", color: "var(--ink-muted)", flexShrink: 0 }}>
          <X size={11} />
        </button>
      </div>
    );
  }

  // ── Folder tree renderer ──────────────────────────────────────
  function renderFolderTree(parentId: string | null, depth: number): React.ReactNode {
    return folders.filter(f => f.parentId === parentId).map(folder => {
      const hasChildren = folders.some(f => f.parentId === folder.id);
      const isExpanded = expandedIds.has(folder.id);
      const isSelected = selectedFolderId === folder.id;
      const isDropTarget = dropTargetId === folder.id;
      const indent = 10 + depth * 14;

      return (
        <div key={folder.id}>
          <div
            onDragOver={e => { e.preventDefault(); e.stopPropagation(); setDropTargetId(folder.id); }}
            onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTargetId(null); }}
            onDrop={e => {
              e.preventDefault(); e.stopPropagation(); setDropTargetId(null);
              if (e.dataTransfer.files?.length) dragCtx.onExternalDrop(e.dataTransfer.files, folder.id);
              else if (draggedId) dragCtx.onDropFile(draggedId, folder.id);
            }}
            style={{
              display: "flex", alignItems: "center", gap: 3,
              padding: `4px 4px 4px ${indent}px`,
              borderRadius: 6,
              background: isDropTarget ? "var(--navy)" : isSelected ? "var(--navy-tint, #c8d9ee)" : "transparent",
              color: isDropTarget ? "#fff" : isSelected ? "var(--navy-deep)" : "var(--ink-soft)",
              outline: isDropTarget ? "2px solid var(--navy-deep)" : "none",
              outlineOffset: -2, position: "relative",
            }}
            onMouseLeave={() => { if (folderMenuId === folder.id) setFolderMenuId(null); }}
          >
            {editingFolderId === folder.id ? (
              <input autoFocus value={editingFolderName}
                onChange={e => setEditingFolderName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") renameFolder(folder.id, editingFolderName); if (e.key === "Escape") setEditingFolderId(null); }}
                onBlur={() => renameFolder(folder.id, editingFolderName)}
                style={{ flex: 1, fontSize: 12, padding: "2px 5px", border: "1px solid var(--navy)", borderRadius: 4, outline: "none" }}
              />
            ) : (
              <>
                <button type="button"
                  onClick={() => {
                    setExpandedIds(prev => { const s = new Set(prev); s.has(folder.id) ? s.delete(folder.id) : s.add(folder.id); return s; });
                    setSelectedFolderId(folder.id);
                    setFolderMenuId(null);
                  }}
                  style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, background: "none", border: "none", cursor: "pointer", minWidth: 0, padding: 0, color: "inherit" }}>
                  <span style={{ width: 13, flexShrink: 0, display: "flex", justifyContent: "center" }}>
                    {hasChildren ? (isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />) : null}
                  </span>
                  {isExpanded
                    ? <FolderOpen size={13} style={{ flexShrink: 0, color: isDropTarget ? "#fff" : "var(--navy)" }} />
                    : <Folder size={13} style={{ flexShrink: 0, color: isDropTarget ? "#fff" : "var(--navy)" }} />}
                  <span style={{ fontSize: 12.5, fontWeight: isSelected ? 600 : 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, textAlign: "left" }}>
                    {folder.name}
                  </span>
                </button>
                <button type="button"
                  onClick={e => { e.stopPropagation(); setFolderMenuId(folderMenuId === folder.id ? null : folder.id); }}
                  style={{ width: 16, height: 16, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "transparent", cursor: "pointer", color: "inherit", flexShrink: 0, opacity: 0.7 }}>
                  <MoreHorizontal size={10} />
                </button>
              </>
            )}

            {folderMenuId === folder.id && (
              <div style={{ position: "absolute", right: 0, top: "100%", zIndex: 100, background: "#fff", border: "1px solid var(--line)", borderRadius: 6, boxShadow: "0 4px 12px rgba(0,0,0,.14)", minWidth: 140, padding: "4px 0" }}>
                <button type="button" style={treeMenuItemSt} onClick={() => { setAddingParentId(folder.id); setNewFolderName(""); setExpandedIds(p => new Set([...p, folder.id])); setFolderMenuId(null); }}>
                  サブフォルダ作成
                </button>
                <button type="button" style={treeMenuItemSt} onClick={() => { setEditingFolderId(folder.id); setEditingFolderName(folder.name); setFolderMenuId(null); }}>
                  名前を変更
                </button>
                <button type="button" style={{ ...treeMenuItemSt, color: "#c0392b" }} onClick={() => deleteFolder(folder.id)}>
                  削除
                </button>
              </div>
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

  // ── Render ────────────────────────────────────────────────────
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "320px minmax(0,1fr)", gap: 20, alignItems: "stretch", height: "calc(100vh - 200px)", minHeight: 560 }}>

        {/* ── Upload panel (left) ── */}
        <section className="panel" style={{ display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
          <div className="panel-head" style={{ flexShrink: 0 }}>
            <span className="panel-title">資料を追加する</span>
            <span className="panel-sub">PDF・Word・テキスト</span>
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
              <input ref={fileInputRef} type="file" multiple style={{ display: "none" }} accept=".pdf,.doc,.docx,.txt,.md,image/*,video/*"
                onChange={e => { if (e.target.files) addPendingFiles(e.target.files); e.currentTarget.value = ""; }} />
              <Button variant="secondary" size="sm" style={{ marginTop: 14 }} onClick={() => fileInputRef.current?.click()}>
                <Plus size={13} aria-hidden="true" />ファイルを選択
              </Button>
            </div>

            {/* Pending file list */}
            {pendingFiles.length > 0 ? (
              <div style={{ marginTop: 14, border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden" }}>
                <div className="tiny" style={{ padding: "8px 12px", background: "var(--panel-deep)", color: "var(--ink-soft)", letterSpacing: "0.12em", fontWeight: 600 }}>追加する予定の資料</div>
                <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {pendingFiles.map((file, idx) => (
                    <li key={`${file.name}-${file.size}`} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderTop: "1px solid var(--line-soft)" }}>
                      <span style={{ width: 26, height: 26, borderRadius: 4, background: "var(--navy-tint)", color: "var(--navy-deep)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontFamily: "ui-monospace,monospace", letterSpacing: "0.06em", fontWeight: 600 }}>
                        {(file.name.split(".").pop() || "FILE").toUpperCase().slice(0, 4)}
                      </span>
                      <div className="stack" style={{ flex: 1, minWidth: 0 }}>
                        <span className="truncate" style={{ fontSize: 12.5, fontWeight: 500 }}>{file.name}</span>
                        <span className="tiny soft">{formatFileSize(file.size)}</span>
                      </div>
                      <button type="button" className="btn ghost sm icon" onClick={() => setPendingFiles(cur => cur.filter((_, i) => i !== idx))} title="選択から外す">
                        <X size={13} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="divider" />

            {/* Destination folder picker */}
            <FieldLabel>保存先フォルダー</FieldLabel>
            <div style={{ border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden auto", maxHeight: 140, background: "#fff" }}>
              <button type="button" onClick={() => setDestFolderId(null)}
                style={{ width: "100%", textAlign: "left", padding: "7px 12px", fontSize: 12, border: "none", display: "flex", alignItems: "center", gap: 6, background: destFolderId === null ? "var(--navy-tint-soft)" : "transparent", cursor: "pointer", color: destFolderId === null ? "var(--navy)" : "var(--ink-soft)", fontWeight: destFolderId === null ? 600 : 400 }}>
                <Folder size={12} />未整理（フォルダーなし）
              </button>
              {pickerFolders.map(({ id, name, depth }) => (
                <button key={id} type="button" onClick={() => setDestFolderId(id)}
                  style={{ width: "100%", textAlign: "left", paddingTop: 7, paddingBottom: 7, paddingLeft: 12 + depth * 14, paddingRight: 12, fontSize: 12, border: "none", display: "flex", alignItems: "center", gap: 6, background: destFolderId === id ? "var(--navy-tint-soft)" : "transparent", cursor: "pointer", color: destFolderId === id ? "var(--navy)" : "var(--ink-soft)", fontWeight: destFolderId === id ? 600 : 400 }}>
                  <Folder size={12} />{name}
                </button>
              ))}
            </div>

            <div className="divider" />
            <FieldLabel>メモ（任意）</FieldLabel>
            <input className="input" placeholder="任意" value={memo} onChange={e => setMemo(e.target.value)} />

            {notice ? <p className="tag accent" style={{ marginTop: 14, display: "block" }}>{notice}</p> : null}
            <Button style={{ width: "100%", marginTop: 20, height: 44 }} onClick={registerFiles} disabled={isUploading}>
              <Upload size={15} aria-hidden="true" />
              {pendingFiles.length > 0 ? `${pendingFiles.length}件を資料庫に追加` : "資料庫に追加"}
            </Button>
            <div className="tiny soft" style={{ textAlign: "center", marginTop: 8, letterSpacing: "0.06em" }}>対応ファイルは追加後にAIが自動で内容を読み取ります</div>
          </div>
        </section>

        {/* ── Library panel (right) ── */}
        <section className="panel" style={{ display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
          {/* Header */}
          <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexShrink: 0 }}>
            {/* Breadcrumb */}
            <nav style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", minWidth: 0 }}>
              <Crumb active={selectedFolderId === null} onClick={() => setSelectedFolderId(null)}>資料庫</Crumb>
              {ancestors.map(f => (
                <span key={f.id} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <CrumbSep />
                  <Crumb active={selectedFolderId === f.id} onClick={() => setSelectedFolderId(f.id)}>{f.name}</Crumb>
                </span>
              ))}
            </nav>
            <div className="row" style={{ gap: 8, flexShrink: 0 }}>
              {(() => {
                const isSyncing = files.some(f => f.ragSyncStatus === "syncing");
                const hasUnsynced = files.some(f => f.preparationStatus === "completed" && f.ragSyncStatus === "not_started");
                return (
                  <Button variant="secondary" size="sm"
                    disabled={isSyncing}
                    onClick={triggerKbSync}
                    title="準備完了ファイルをBedrockナレッジベースに一括同期します"
                    style={{ gap: 5, opacity: (!isSyncing && !hasUnsynced) ? 0.5 : 1 }}>
                    {isSyncing
                      ? <><RefreshCw size={12} style={{ animation: "spin 1s linear infinite" }} aria-hidden="true" />AI同期中</>
                      : <><RefreshCw size={12} aria-hidden="true" />AI同期</>}
                  </Button>
                );
              })()}
              <div style={{ position: "relative" }}>
                <Search size={14} style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", color: "var(--ink-muted)", pointerEvents: "none" }} aria-hidden="true" />
                <input className="input" placeholder="資料庫全体から探す" value={libQuery} onChange={e => setLibQuery(e.target.value)} style={{ paddingLeft: 32, height: 36, width: 200 }} />
              </div>
            </div>
          </div>

          {/* Body: sidebar + content */}
          <div style={{ flex: 1, display: "grid", gridTemplateColumns: "200px 1fr", minHeight: 0, overflow: "hidden" }}>

            {/* Sidebar */}
            <div
              style={{ overflowY: "auto", background: "var(--panel-deep)", borderRight: "1px solid var(--line)", display: "flex", flexDirection: "column" }}
              onDragOver={e => { e.preventDefault(); setDropTargetId("__root__"); }}
              onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTargetId(null); }}
              onDrop={e => {
                e.preventDefault(); setDropTargetId(null);
                if (e.dataTransfer.files?.length) dragCtx.onExternalDrop(e.dataTransfer.files, null);
                else if (draggedId) dragCtx.onDropFile(draggedId, null);
              }}
            >
              <div style={{ flex: 1, overflowY: "auto", padding: "10px 6px" }}>
                {/* Root entry */}
                <div
                  onClick={() => { setSelectedFolderId(null); setFolderMenuId(null); }}
                  style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 8px", borderRadius: 6, cursor: "pointer", marginBottom: 2, background: dropTargetId === "__root__" ? "var(--navy)" : selectedFolderId === null ? "var(--navy-tint)" : "transparent", color: dropTargetId === "__root__" ? "#fff" : selectedFolderId === null ? "var(--navy-deep)" : "var(--ink-soft)", fontWeight: selectedFolderId === null ? 600 : 500, fontSize: 12.5, letterSpacing: "0.02em" }}
                  onMouseEnter={e => { if (selectedFolderId !== null && dropTargetId !== "__root__") e.currentTarget.style.background = "var(--navy-tint-soft)"; }}
                  onMouseLeave={e => { if (selectedFolderId !== null && dropTargetId !== "__root__") e.currentTarget.style.background = "transparent"; }}
                >
                  <Folder size={13} style={{ color: dropTargetId === "__root__" ? "#fff" : "var(--navy)", flexShrink: 0 }} />
                  <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>資料庫</span>
                </div>

                {renderFolderTree(null, 0)}
                {addingParentId === null && newFolderInputRow(0)}
              </div>
              <div style={{ padding: 8, borderTop: "1px solid var(--line)", flexShrink: 0 }}>
                <button type="button"
                  onClick={() => { setAddingParentId(null); setNewFolderName(""); }}
                  style={{ width: "100%", display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", border: "1px dashed var(--line)", borderRadius: 6, background: "transparent", cursor: "pointer", color: "var(--ink-soft)", fontSize: 12 }}>
                  <Plus size={12} />フォルダ作成
                </button>
              </div>
            </div>

            {/* Content area */}
            <div style={{ overflowY: "auto", minHeight: 0 }}>
              {searching ? (
                <SearchResults hits={searchHits} query={libQuery}
                  onOpenSummary={openOrCreateSummary} onDetail={openDetail} onDelete={deleteFile}
                  onProcessImages={processImages} summaryProcessingId={summaryProcessingId}
                  blockedSummaryId={blockedSummaryId} deletingId={deletingId} drag={dragCtx} />
              ) : (
                <FolderContentView
                  subFolders={subFolders}
                  allFolders={folders}
                  files={folderFiles}
                  assignments={assignments}
                  onSelectFolder={id => { setSelectedFolderId(id); setExpandedIds(p => new Set([...p, id])); }}
                  onRenameFolder={renameFolder}
                  onDeleteFolder={deleteFolder}
                  drag={dragCtx}
                  onOpenSummary={openOrCreateSummary}
                  onDetail={openDetail}
                  onDelete={deleteFile}
                  onProcessImages={processImages}
                  summaryProcessingId={summaryProcessingId}
                  blockedSummaryId={blockedSummaryId}
                  deletingId={deletingId}
                  isLoadingFiles={isLoadingFiles}
                  selectedFolderId={selectedFolderId}
                />
              )}
            </div>
          </div>
        </section>
      </div>

      {/* Overlays */}
      {selectedDetail && detailDraft ? (
        <DetailOverlay file={selectedDetail} draft={detailDraft} saving={detailSaving}
          folders={folders} onDraft={setDetailDraft} onSave={saveDetail}
          onOpenSource={() => setSourceViewerFile(selectedDetail)} onClose={() => setSelectedDetail(null)} />
      ) : null}
      {sourceViewerFile ? <SourceViewerOverlay file={sourceViewerFile} onClose={() => setSourceViewerFile(null)} /> : null}
      {selectedSummary ? (
        <SummaryOverlay file={selectedSummary} draft={summaryDraft} editing={summaryEditing}
          copied={summaryCopied} processing={summaryProcessingId === selectedSummary.id}
          onDraft={setSummaryDraft} onEdit={() => setSummaryEditing(true)} onSave={saveSummary}
          onCopy={copySummary} onClose={() => setSelectedSummary(null)} />
      ) : null}
    </>
  );
}

const treeMenuItemSt: React.CSSProperties = {
  width: "100%", textAlign: "left", padding: "6px 12px", fontSize: 12,
  border: "none", background: "none", cursor: "pointer", color: "var(--ink)", whiteSpace: "nowrap",
};

// ── Folder content view ──────────────────────────────────────────
function FolderContentView({
  subFolders, allFolders, files, assignments, onSelectFolder, onRenameFolder, onDeleteFolder,
  drag, onOpenSummary, onDetail, onDelete, onProcessImages,
  summaryProcessingId, blockedSummaryId, deletingId, isLoadingFiles, selectedFolderId,
}: {
  subFolders: RepoFolder[]; allFolders: RepoFolder[]; files: RepositoryFile[];
  assignments: FileAssignments;
  onSelectFolder: (id: string) => void;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  drag: DragCtx; onOpenSummary: (f: RepositoryFile) => void; onDetail: (f: RepositoryFile) => void;
  onDelete: (f: RepositoryFile) => void; onProcessImages: (f: RepositoryFile) => void;
  summaryProcessingId: string | null; blockedSummaryId: string | null; deletingId: string | null;
  isLoadingFiles: boolean; selectedFolderId: string | null;
}) {
  const [over, setOver] = useState(false);

  const isEmpty = subFolders.length === 0 && files.length === 0 && !isLoadingFiles;

  function folderFileCount(fid: string): number {
    return Object.values(assignments).filter(v => v === fid).length
      + allFolders.filter(f => f.parentId === fid).length;
  }

  return (
    <div
      style={{ padding: 20, minHeight: "100%" }}
      onDragOver={e => { if (Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={e => { if (e.dataTransfer.files?.length) { e.preventDefault(); setOver(false); drag.onExternalDrop(e.dataTransfer.files, selectedFolderId); } }}
    >
      {isLoadingFiles && files.length === 0 && subFolders.length === 0 ? (
        <div style={{ padding: "60px 24px", textAlign: "center", color: "var(--ink-muted)" }}>
          <div className="serif" style={{ fontSize: 16 }}>読み込み中…</div>
        </div>
      ) : isEmpty ? (
        <div style={{ padding: "80px 24px", textAlign: "center", border: `1.5px dashed ${over ? "var(--navy)" : "var(--line)"}`, background: over ? "var(--navy-tint-soft)" : "transparent", borderRadius: 12, transition: "all .12s ease" }}>
          <div className="serif" style={{ fontSize: 18, color: "var(--ink-soft)", marginBottom: 8 }}>
            {over ? "ここにドロップして追加" : "このフォルダにはまだ資料がありません"}
          </div>
          <div className="small soft">PCからファイルを直接ドロップ、または他のフォルダからドラッグで移動できます。</div>
        </div>
      ) : (
        <>
          {subFolders.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 14, marginBottom: files.length > 0 ? 24 : 0 }}>
              {subFolders.map(folder => (
                <RepoFolderCard
                  key={folder.id}
                  folder={folder}
                  fileCount={folderFileCount(folder.id)}
                  isDropTarget={drag.dropTargetId === folder.id}
                  isDragging={false}
                  onClick={() => onSelectFolder(folder.id)}
                  onRename={name => onRenameFolder(folder.id, name)}
                  onDelete={() => onDeleteFolder(folder.id)}
                  onDragOver={e => { e.preventDefault(); drag.setDropTargetId(folder.id); }}
                  onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) drag.setDropTargetId(null); }}
                  onDrop={e => {
                    e.preventDefault(); drag.setDropTargetId(null);
                    if (e.dataTransfer.files?.length) drag.onExternalDrop(e.dataTransfer.files, folder.id);
                    else if (drag.draggedId) drag.onDropFile(drag.draggedId, folder.id);
                  }}
                />
              ))}
            </div>
          )}
          {files.length > 0 && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14, outline: over ? "2px dashed var(--navy)" : "none", outlineOffset: 6, borderRadius: 8, padding: over ? 4 : 0 }}>
              {files.map(f => (
                <DraggableFileCard key={f.id} file={f} drag={drag}
                  onOpenSummary={onOpenSummary} onDetail={onDetail} onDelete={onDelete}
                  onProcessImages={onProcessImages}
                  summaryProcessingId={summaryProcessingId} blockedSummaryId={blockedSummaryId} deletingId={deletingId} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Repo folder card ─────────────────────────────────────────────
function RepoFolderCard({ folder, fileCount, isDropTarget, isDragging, onClick, onRename, onDelete, onDragOver, onDragLeave, onDrop }: {
  folder: RepoFolder; fileCount: number; isDropTarget: boolean; isDragging: boolean;
  onClick: () => void; onRename: (name: string) => void; onDelete: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(folder.name);
  const [hover, setHover] = useState(false);

  function commit() {
    const v = draft.trim();
    if (v && v !== folder.name) onRename(v);
    setRenaming(false);
  }

  return (
    <div
      onClick={() => !renaming && onClick()}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        background: isDropTarget ? "var(--navy-tint)" : "var(--panel)",
        border: `1px solid ${isDropTarget ? "var(--navy)" : hover ? "var(--navy-soft)" : "var(--line)"}`,
        outline: isDropTarget ? "2px solid var(--navy)" : "none", outlineOffset: -2,
        borderRadius: 12, padding: "18px 16px 14px",
        cursor: renaming ? "default" : "pointer", position: "relative",
        display: "flex", flexDirection: "column", gap: 12, minHeight: 140,
        opacity: isDragging ? 0.4 : 1,
        transition: "border-color .15s ease, transform .15s ease, box-shadow .15s ease",
        boxShadow: hover ? "var(--shadow-md)" : "none",
        transform: hover ? "translateY(-2px)" : "translateY(0)",
      }}
    >
      {/* Actions */}
      <div onClick={e => e.stopPropagation()} style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 2, opacity: hover && !renaming ? 1 : 0, transition: "opacity .15s ease", background: "var(--panel)", borderRadius: 6, padding: 2, border: "1px solid var(--line)" }}>
        <SmallIconButton title="名前を変更" onClick={() => { setDraft(folder.name); setRenaming(true); }}><Edit size={12} /></SmallIconButton>
        <SmallIconButton title="削除" onClick={onDelete} danger><Trash2 size={12} /></SmallIconButton>
      </div>

      <FolderGlyph open={hover || isDropTarget} />

      <div className="stack" style={{ gap: 4, flex: 1 }}>
        {renaming ? (
          <input autoFocus className="input" value={draft} onChange={e => setDraft(e.target.value)}
            onBlur={commit} onClick={e => e.stopPropagation()}
            onKeyDown={e => { if (e.key === "Enter") commit(); if (e.key === "Escape") setRenaming(false); }}
            style={{ height: 32, padding: "0 8px", fontSize: 15 }} />
        ) : (
          <span className="serif" style={{ fontSize: 16, fontWeight: 600, color: "var(--ink)", letterSpacing: "0.04em", lineHeight: 1.3 }}>{folder.name}</span>
        )}
      </div>

      <div className="between" style={{ paddingTop: 10, borderTop: "1px solid var(--line-soft)", fontSize: 11, color: "var(--ink-muted)", letterSpacing: "0.04em" }}>
        <span>{fileCount} 件</span>
        <ChevronRight size={13} style={{ color: "var(--navy-soft)" }} />
      </div>
    </div>
  );
}

// ── Search results ───────────────────────────────────────────────
function SearchResults({ hits, query, ...props }: FileGridCommonProps & { hits: RepositoryFile[]; query: string }) {
  return (
    <div style={{ padding: 20 }}>
      <div className="between" style={{ marginBottom: 14 }}>
        <span className="small soft">「{query}」の検索結果</span>
        <span className="small soft">{hits.length} 件</span>
      </div>
      {hits.length === 0 ? (
        <div style={{ padding: "60px 24px", textAlign: "center" }}>
          <div className="serif" style={{ fontSize: 20, color: "var(--ink-muted)", marginBottom: 6 }}>該当する資料はありません</div>
          <div className="small soft">別のキーワードで試してください。</div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
          {hits.map(f => <DraggableFileCard key={f.id} file={f} {...props} />)}
        </div>
      )}
    </div>
  );
}

// ── File card ────────────────────────────────────────────────────
function FileCard({ file, processing, blocked, deleting, onOpenSummary, onDetail, onDelete, onProcessImages }: FileGridCommonProps & { file: RepositoryFile; processing?: boolean; blocked?: boolean; deleting?: boolean }) {
  const canSummary = file.preparationStatus === "completed";
  const summaryInProgress = file.summaryStatus === "processing" || processing;
  const needsOcr = file.textExtractionStatus === "ocr_required";
  const { ragSyncStatus, preparationStatus } = file;

  return (
    <article style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 12, position: "relative", transition: "border-color .15s ease, transform .15s ease, box-shadow .15s ease" }}
      onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--navy-soft)"; e.currentTarget.style.boxShadow = "var(--shadow-md)"; e.currentTarget.style.transform = "translateY(-1px)"; }}
      onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--line)"; e.currentTarget.style.boxShadow = "none"; e.currentTarget.style.transform = "translateY(0)"; }}>
      <div className="row" style={{ alignItems: "flex-start", gap: 14 }}>
        <FilePreview file={file} />
        <div className="stack" style={{ minWidth: 0, flex: 1, gap: 6 }}>
          <h3 className="serif" style={{ margin: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.45, color: "var(--ink)", letterSpacing: "0.02em" }}>{file.name.replace(/\.[^.]+$/, "")}</h3>
          <div className="tiny soft" style={{ letterSpacing: "0.06em" }}>{file.date} ・ {file.sizeLabel}</div>
          {file.memo ? <div style={{ fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.6, marginTop: 2 }}>{file.memo}</div> : null}
        </div>
      </div>
      {file.tags.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {file.tags.map(t => <span className="tag" key={t}>{t}</span>)}
        </div>
      ) : null}
      <div className="row" style={{ gap: 4, fontSize: 11, color: "var(--ink-muted)", flexWrap: "wrap" }}>
        {ragSyncStatus === "completed" ? (
          <span className="row" style={{ gap: 5 }}><span className="dot ok" />AI参照可</span>
        ) : ragSyncStatus === "syncing" ? (
          <span className="row" style={{ gap: 5 }}><RefreshCw size={11} style={{ animation: "spin 1s linear infinite" }} aria-hidden="true" />AI同期中</span>
        ) : preparationStatus === "processing" ? (
          <span className="row" style={{ gap: 5 }}><RefreshCw size={11} aria-hidden="true" />準備中</span>
        ) : preparationStatus === "completed" ? (
          <span className="row" style={{ gap: 4 }}>AI同期待ち</span>
        ) : needsOcr ? (
          <span className="row" style={{ gap: 4, color: "var(--warn)", background: "var(--warn-tint)", padding: "3px 8px", borderRadius: 4, fontWeight: 500 }}>文字の読み取りが必要</span>
        ) : (
          <span className="row" style={{ gap: 4, background: "var(--warn-tint)", color: "var(--warn)", padding: "3px 8px", borderRadius: 4, fontWeight: 500 }}>読み取り待ち</span>
        )}
        <span style={{ color: "var(--ink-faint)" }}>・</span>
        <span>{file.summaryStatus === "completed" ? "要約あり" : "要約まだ"}</span>
        {file.version ? <><span style={{ color: "var(--ink-faint)" }}>・</span><span>{file.version}</span></> : null}
      </div>
      <div className="row" style={{ gap: 6, borderTop: "1px solid var(--line-soft)", paddingTop: 12 }}>
        <Button variant={file.summaryStatus === "completed" ? "secondary" : canSummary ? "primary" : "secondary"} size="sm"
          style={{ flex: 1, opacity: canSummary || file.summaryStatus === "completed" ? 1 : 0.58 }}
          disabled={!!summaryInProgress} onClick={() => onOpenSummary(file)}>
          {summaryInProgress ? "要約作成中" : file.summaryStatus === "completed" ? "要約を見る" : "要約をつくる"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onDetail(file)}><Edit size={13} aria-hidden="true" />詳細</Button>
        <button type="button" className="btn ghost sm icon" title="削除" disabled={!!deleting} onClick={() => onDelete(file)}><Trash2 size={13} aria-hidden="true" /></button>
      </div>
      {blocked ? (
        <div style={{ border: "1px solid var(--line)", background: "var(--panel-deep)", borderRadius: 8, padding: "9px 10px", color: "var(--ink-soft)", fontSize: 12.5, lineHeight: 1.55 }}>
          AI参照の準備が完了すると要約を作成できます。
        </div>
      ) : null}
    </article>
  );
}

function DraggableFileCard({ file, summaryProcessingId, blockedSummaryId, deletingId, onOpenSummary, onDetail, onDelete, onProcessImages, drag }: FileGridCommonProps & { file: RepositoryFile }) {
  return (
    <div draggable
      onDragStart={e => { drag.setDraggedId(file.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", file.id); }}
      onDragEnd={() => { drag.setDraggedId(null); drag.setDropTargetId(null); }}
      style={{ opacity: drag.draggedId === file.id ? 0.4 : 1, cursor: "grab", transition: "opacity .12s ease" }}>
      <FileCard file={file} drag={drag}
        processing={summaryProcessingId === file.id}
        blocked={blockedSummaryId === file.id}
        deleting={deletingId === file.id}
        onOpenSummary={onOpenSummary} onDetail={onDetail} onDelete={onDelete}
        onProcessImages={onProcessImages}
        summaryProcessingId={summaryProcessingId} blockedSummaryId={blockedSummaryId} deletingId={deletingId} />
    </div>
  );
}

// ── Small helpers ────────────────────────────────────────────────
function FolderGlyph({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 32 24" width={36} height={28} fill="none" stroke="var(--navy-deep)" strokeWidth="1.3" strokeLinejoin="round" aria-hidden="true">
      <path
        d={open
          ? "M2 5a1.5 1.5 0 0 1 1.5-1.5h7l2 2h15a1.5 1.5 0 0 1 1.5 1.5v1l-2.5 12a2 2 0 0 1-2 1.5h-21a1.5 1.5 0 0 1-1.5-1.5z"
          : "M2 5a1.5 1.5 0 0 1 1.5-1.5h7l2 2h15a1.5 1.5 0 0 1 1.5 1.5v12.5a1.5 1.5 0 0 1-1.5 1.5h-24a1.5 1.5 0 0 1-1.5-1.5z"
        }
        fill="var(--navy-tint-soft)"
      />
    </svg>
  );
}

function SmallIconButton({ children, onClick, title, danger }: { children: React.ReactNode; onClick: () => void; title: string; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} title={title}
      style={{ width: 22, height: 22, borderRadius: 4, border: 0, background: "transparent", color: danger ? "#8a3a2d" : "var(--ink-soft)", cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center" }}
      onMouseEnter={e => { e.currentTarget.style.background = danger ? "#f3e3df" : "var(--navy-tint-soft)"; e.currentTarget.style.color = danger ? "#7a2d22" : "var(--navy-deep)"; }}
      onMouseLeave={e => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = danger ? "#8a3a2d" : "var(--ink-soft)"; }}>
      {children}
    </button>
  );
}

function Crumb({ children, onClick, active }: { children: React.ReactNode; onClick: () => void; active: boolean }) {
  return (
    <button type="button" onClick={onClick}
      style={{ background: "transparent", border: 0, cursor: "pointer", padding: "2px 6px", borderRadius: 6, color: active ? "var(--navy-deep)" : "var(--ink-muted)", fontWeight: active ? 600 : 500, fontSize: 13, letterSpacing: "0.02em", display: "inline-flex", alignItems: "center" }}>
      {children}
    </button>
  );
}

function CrumbSep() { return <ChevronRight size={12} style={{ color: "var(--ink-faint)" }} />; }

function InlineEdit({ value, placeholder, onSave, className, isPlaceholder }: {
  value: string; placeholder?: string; onSave: (v: string) => void; className?: string; isPlaceholder?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  function commit() { const v = draft.trim(); if (v && v !== value) onSave(v); setEditing(false); }
  if (editing) {
    return (
      <input autoFocus className="input" value={draft} onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); commit(); } if (e.key === "Escape") { setDraft(value); setEditing(false); } }}
        style={{ height: 32, padding: "0 8px", fontSize: 14 }} />
    );
  }
  return (
    <span className={className} onClick={() => setEditing(true)}
      style={{ cursor: "text", borderRadius: 4, padding: "1px 4px", margin: "0 -4px", color: isPlaceholder ? "var(--ink-faint)" : undefined, fontStyle: isPlaceholder ? "italic" : undefined }}
      onMouseEnter={e => (e.currentTarget.style.background = "var(--navy-tint-soft)")}
      onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>
      {value || placeholder}
    </span>
  );
}

// ── FilePreview ──────────────────────────────────────────────────
function FilePreview({ file }: { file: RepositoryFile }) {
  // サムネイルJPEGがあれば即表示（APIコールなし）
  if (file.thumbnailUrl) {
    return (
      <div style={{ width: 92, height: 128, flexShrink: 0, overflow: "hidden", border: "1px solid var(--line)", borderRadius: 8, background: "#fff", boxShadow: "var(--shadow-sm)" }}>
        <img src={file.thumbnailUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
    );
  }
  // サムネイル未生成はラベル表示にフォールバック
  return <FileSpine name={file.name} ext={file.thumbnailLabel || file.name.split(".").pop() || "FILE"} version={file.version} />;
}

// ── Image Gallery Overlay ────────────────────────────────────────
function ImageGalleryOverlay({ gallery, onClose }: {
  gallery: { file: RepositoryFile; images: { index: number; page: number; description: string; url: string }[] };
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<number | null>(null);
  const selectedImage = selected !== null ? gallery.images[selected] : null;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "stretch", justifyContent: "flex-end" }}
      onClick={e => { if (e.target === e.currentTarget) { setSelected(null); onClose(); } }}>
      <div style={{ width: "min(860px, 95vw)", background: "#fff", display: "flex", flexDirection: "column", boxShadow: "-4px 0 24px rgba(0,0,0,.18)" }}>
        <div className="panel-head" style={{ flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--navy-deep)" }}>{gallery.file.name.replace(/\.[^.]+$/, "")}</div>
            <div className="tiny soft" style={{ marginTop: 2 }}>{gallery.images.length}枚の画像</div>
          </div>
          <button type="button" onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-soft)", padding: 4 }}><X size={18} /></button>
        </div>
        <div style={{ flex: 1, overflow: "hidden", display: "flex", minHeight: 0 }}>
          <div style={{ width: 200, flexShrink: 0, overflowY: "auto", borderRight: "1px solid var(--line)", padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            {gallery.images.map((img, i) => (
              <button key={i} type="button" onClick={() => setSelected(i)}
                style={{ border: `2px solid ${selected === i ? "var(--navy)" : "var(--line)"}`, borderRadius: 8, padding: 0, background: "none", cursor: "pointer", overflow: "hidden", textAlign: "left" }}>
                <img src={img.url} alt={`画像${img.index + 1}`} style={{ width: "100%", height: 100, objectFit: "cover", display: "block" }} />
                <div style={{ padding: "4px 6px", fontSize: 10, color: "var(--ink-muted)" }}>p.{img.page} 画像{img.index + 1}</div>
              </button>
            ))}
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
            {selectedImage ? (
              <>
                <img src={selectedImage.url} alt={`画像${selectedImage.index + 1}`} style={{ maxWidth: "100%", height: "auto", borderRadius: 8, border: "1px solid var(--line)", display: "block" }} />
                <div>
                  <div className="tiny" style={{ color: "var(--ink-muted)", marginBottom: 6, letterSpacing: "0.08em" }}>{selectedImage.page}ページ目・画像{selectedImage.index + 1}</div>
                  <p style={{ margin: 0, fontSize: 13, lineHeight: 1.8, color: "var(--ink)", background: "var(--panel-deep)", borderRadius: 8, padding: "12px 14px" }}>{selectedImage.description}</p>
                </div>
              </>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 10, color: "var(--ink-faint)" }}>
                <Images size={32} strokeWidth={1.2} />
                <p style={{ margin: 0, fontSize: 13 }}>左の一覧から画像を選択してください</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Detail overlay ───────────────────────────────────────────────
function DetailOverlay({ file, draft, saving, folders, onDraft, onSave, onOpenSource, onClose }: {
  file: RepositoryFile; draft: DetailDraft; saving: boolean;
  folders: RepoFolder[];
  onDraft: React.Dispatch<React.SetStateAction<DetailDraft | null>>;
  onSave: () => void; onOpenSource: () => void; onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose]);

  const [showImages, setShowImages] = useState(false);
  const [detailImages, setDetailImages] = useState<{ index: number; page: number; description: string; url: string }[]>([]);
  const [selectedImgIndex, setSelectedImgIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!showImages || file.imageCount === 0 || detailImages.length > 0) return;
    fetch(`/api/files/${file.id}/images`)
      .then(r => r.json())
      .then((d: { images?: { index: number; page: number; description: string; url: string }[] }) => {
        setDetailImages(d.images ?? []);
      })
      .catch(() => {});
  }, [showImages, file.id, file.imageCount, detailImages.length]);

  const pickerFolders = flattenForPicker(folders, new Set(), null, 0);

  return (
    <div className="overlay" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: 920, background: "var(--panel)", borderRadius: 16, overflow: "hidden", boxShadow: "var(--shadow-lg)", animation: "slide-up .25s ease", maxHeight: "calc(100vh - 64px)", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 18, alignItems: "center", padding: "20px 24px", borderBottom: "1px solid var(--line)", background: "var(--panel-deep)" }}>
          <FilePreview file={file} />
          <div className="stack" style={{ minWidth: 0 }}>
            <span className="tiny" style={{ letterSpacing: "0.18em", color: "var(--accent)", fontWeight: 600, textTransform: "uppercase" }}>詳細</span>
            <h2 className="serif truncate" style={{ margin: "4px 0 2px", fontSize: 20, fontWeight: 600, color: "var(--navy-deep)", letterSpacing: "0.04em" }}>{file.name.replace(/\.[^.]+$/, "")}</h2>
            <span className="tiny soft">{file.thumbnailLabel} ・ {file.sizeLabel} ・ {file.date}</span>
          </div>
          <button type="button" className="btn ghost icon" onClick={onClose} title="閉じる (Esc)"><X size={16} /></button>
        </div>
        <div style={{ overflowY: "auto", padding: 24 }}>
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 16 }}>
            <Button variant="secondary" size="sm" onClick={onOpenSource}>原本を見る</Button>
          </div>
          <FieldLabel>保存先フォルダー</FieldLabel>
          <div style={{ border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden auto", maxHeight: 160, marginBottom: 16 }}>
            <button type="button" onClick={() => onDraft(cur => cur ? { ...cur, folderId: null } : cur)}
              style={{ width: "100%", textAlign: "left", padding: "7px 12px", fontSize: 12, border: "none", display: "flex", alignItems: "center", gap: 6, background: draft.folderId === null ? "var(--navy-tint-soft)" : "transparent", cursor: "pointer", color: draft.folderId === null ? "var(--navy)" : "var(--ink-soft)", fontWeight: draft.folderId === null ? 600 : 400 }}>
              <Folder size={12} />未整理（フォルダーなし）
            </button>
            {pickerFolders.map(({ id, name, depth }) => (
              <button key={id} type="button" onClick={() => onDraft(cur => cur ? { ...cur, folderId: id } : cur)}
                style={{ width: "100%", textAlign: "left", paddingTop: 7, paddingBottom: 7, paddingLeft: 12 + depth * 14, paddingRight: 12, fontSize: 12, border: "none", display: "flex", alignItems: "center", gap: 6, background: draft.folderId === id ? "var(--navy-tint-soft)" : "transparent", cursor: "pointer", color: draft.folderId === id ? "var(--navy)" : "var(--ink-soft)", fontWeight: draft.folderId === id ? 600 : 400 }}>
                <Folder size={12} />{name}
              </button>
            ))}
          </div>
          <div style={{ marginTop: 4 }}>
            <FieldLabel>メモ</FieldLabel>
            <textarea className="textarea" value={draft.memo} placeholder="資料の補足、運用メモなど" style={{ minHeight: 110 }} onChange={e => onDraft(cur => cur ? { ...cur, memo: e.target.value } : cur)} />
          </div>
          <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
            <MetaRow label="AI参照" value={file.ragSyncStatus === "completed" ? "可" : file.ragSyncStatus === "syncing" ? "同期中" : file.preparationStatus === "completed" ? "同期待ち" : file.preparationStatus || "未開始"} />
            <MetaRow label="要約" value={file.summaryStatus === "completed" ? "作成済み" : file.summaryStatus || "未作成"} />
            <MetaRow label="OCR" value={file.textExtractionStatus || "未開始"} />
            {file.contentType.includes("pdf") ? (
              <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 10, padding: "6px 0", borderBottom: "1px solid var(--line-soft)" }}>
                <dt className="tiny" style={{ color: "var(--ink-muted)", letterSpacing: "0.1em", paddingTop: 2 }}>画像処理</dt>
                <dd style={{ margin: 0 }}>
                  {file.imageProcessingStatus === "completed" && file.imageCount > 0 ? (
                    <button type="button" onClick={() => setShowImages(v => !v)}
                      style={{ background: "none", border: "none", cursor: "pointer", color: "var(--navy)", fontSize: 12.5, fontWeight: 600, padding: 0, textDecoration: "underline" }}>
                      {showImages ? "▲ 閉じる" : `▶ ${file.imageCount}枚を見る`}
                    </button>
                  ) : (
                    <span style={{ fontSize: 12.5, color: "var(--ink)" }}>
                      {file.imageProcessingStatus === "processing" ? "処理中…" :
                       file.imageProcessingStatus === "failed" ? "失敗" : "未処理"}
                    </span>
                  )}
                </dd>
              </div>
            ) : null}
          </div>
          {showImages && detailImages.length > 0 ? (
            <div style={{ marginTop: 20, borderTop: "1px solid var(--line-soft)", paddingTop: 16 }}>
              <div className="tiny" style={{ letterSpacing: "0.14em", color: "var(--ink-muted)", fontWeight: 600, textTransform: "uppercase", marginBottom: 10 }}>資料内の画像（{detailImages.length}枚）</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {detailImages.map((img, i) => (
                  <button key={i} type="button" onClick={() => setSelectedImgIndex(selectedImgIndex === i ? null : i)}
                    style={{ border: `2px solid ${selectedImgIndex === i ? "var(--navy)" : "var(--line)"}`, borderRadius: 8, padding: 0, background: "none", cursor: "pointer", overflow: "hidden", flexShrink: 0 }}>
                    <img src={img.url} alt={`p.${img.page}`} style={{ width: 80, height: 64, objectFit: "cover", display: "block" }} />
                    <div style={{ fontSize: 9, color: "var(--ink-muted)", padding: "2px 4px", textAlign: "center" }}>p.{img.page}</div>
                  </button>
                ))}
              </div>
              {selectedImgIndex !== null && detailImages[selectedImgIndex] ? (
                <div style={{ marginTop: 12, border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden" }}>
                  <img src={detailImages[selectedImgIndex].url} alt={detailImages[selectedImgIndex].description}
                    style={{ width: "100%", maxHeight: 360, objectFit: "contain", display: "block", background: "#f8f9fa" }} />
                  <div style={{ padding: "10px 14px", background: "var(--panel-deep)", borderTop: "1px solid var(--line-soft)" }}>
                    <div className="tiny soft" style={{ marginBottom: 4 }}>{detailImages[selectedImgIndex].page}ページ目</div>
                    <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.7 }}>{detailImages[selectedImgIndex].description}</p>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div style={{ padding: "14px 24px", borderTop: "1px solid var(--line)", background: "var(--panel-deep)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="secondary" onClick={onClose}>閉じる</Button>
          <Button onClick={onSave} disabled={saving}><Check size={14} aria-hidden="true" />{saving ? "保存中" : "保存"}</Button>
        </div>
      </div>
    </div>
  );
}

// ── Source viewer overlay ────────────────────────────────────────
function SourceViewerOverlay({ file, onClose }: { file: RepositoryFile; onClose: () => void }) {
  const [previewUrl, setPreviewUrl] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let ignore = false;
    async function load() {
      try {
        const res = await fetch(`/api/files/${file.id}/preview-url`, { cache: "no-store" });
        if (!res.ok) throw new Error("");
        const data = (await res.json()) as { url: string };
        if (!ignore) { setPreviewUrl(data.url); setFailed(false); }
      } catch { if (!ignore) setFailed(true); }
    }
    load();
    return () => { ignore = true; };
  }, [file.id]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: "min(1180px, calc(100vw - 40px))", height: "calc(100vh - 56px)", background: "var(--panel)", borderRadius: 16, overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "var(--shadow-lg)", animation: "slide-up .25s ease" }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", alignItems: "center", gap: 16, padding: "14px 18px", borderBottom: "1px solid var(--line)", background: "var(--panel-deep)" }}>
          <div className="stack" style={{ minWidth: 0 }}>
            <span className="tiny" style={{ letterSpacing: "0.18em", color: "var(--accent)", fontWeight: 600, textTransform: "uppercase" }}>原本</span>
            <h2 className="serif truncate" style={{ margin: 0, fontSize: 18, fontWeight: 600, color: "var(--navy-deep)", letterSpacing: "0.04em" }}>{file.name.replace(/\.[^.]+$/, "")}</h2>
          </div>
          <button type="button" className="btn ghost icon" onClick={onClose} title="閉じる (Esc)"><X size={16} /></button>
        </div>
        <div style={{ flex: 1, minHeight: 0, background: "var(--panel-deep)" }}>
          {failed ? (
            <div className="stack" style={{ height: "100%", alignItems: "center", justifyContent: "center", color: "var(--ink-muted)", gap: 8 }}>
              <span className="serif" style={{ fontSize: 20, color: "var(--ink-soft)" }}>原本を表示できませんでした</span>
            </div>
          ) : previewUrl ? (
            file.contentType.startsWith("image/") ? <img src={previewUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "contain", background: "#fff" }} /> :
            file.contentType.startsWith("video/") ? <video src={previewUrl} controls style={{ width: "100%", height: "100%", background: "#000" }} /> :
            <iframe title={`${file.name} source`} src={previewUrl} style={{ width: "100%", height: "100%", border: 0, background: "#fff" }} />
          ) : (
            <div className="stack" style={{ height: "100%", alignItems: "center", justifyContent: "center", color: "var(--ink-muted)", gap: 8 }}>
              <span className="dot ok" style={{ animation: "pulse 1.2s infinite" }} />
              <span className="small soft">原本を読み込んでいます</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Summary overlay ──────────────────────────────────────────────
function SummaryOverlay({ file, draft, editing, copied, processing, onDraft, onEdit, onSave, onCopy, onClose }: {
  file: RepositoryFile; draft: string; editing: boolean; copied: boolean; processing: boolean;
  onDraft: (v: string) => void; onEdit: () => void; onSave: () => void; onCopy: () => void; onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: 1080, background: "var(--panel)", borderRadius: 16, overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "var(--shadow-lg)", animation: "slide-up .25s ease", maxHeight: "calc(100vh - 64px)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 20, alignItems: "center", padding: "20px 28px", borderBottom: "1px solid var(--line)", background: "var(--panel-deep)" }}>
          <FileSpine name={file.name} ext={file.thumbnailLabel || "FILE"} version={file.version} size="sm" />
          <div className="stack" style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 8 }}>
              <span className="tiny" style={{ letterSpacing: "0.18em", color: "var(--accent)", fontWeight: 600, textTransform: "uppercase" }}>要約</span>
              <span className="dot" style={{ background: "var(--ink-faint)" }} />
              <span className="tiny soft">{file.summaryUpdatedAt ? `最終更新 ${formatDisplayDate(file.summaryUpdatedAt)}` : "最終更新 —"}</span>
            </div>
            <h2 className="serif truncate" style={{ margin: "4px 0 2px", fontSize: 20, fontWeight: 600, color: "var(--navy-deep)", letterSpacing: "0.04em" }}>{file.name.replace(/\.[^.]+$/, "")}</h2>
            {file.tags.length > 0 ? <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>{file.tags.map(t => <span className="tag" key={t}>{t}</span>)}</div> : null}
          </div>
          <div className="row" style={{ gap: 6 }}>
            <Button variant="secondary" size="sm" onClick={onCopy}>{copied ? <Check size={13} /> : <Clipboard size={13} />}{copied ? "コピーしました" : "コピー"}</Button>
            {editing ? <Button size="sm" disabled={processing} onClick={onSave}><Check size={13} />保存</Button> : <Button variant="secondary" size="sm" onClick={onEdit}><Edit size={13} />編集</Button>}
            <button type="button" className="btn ghost icon" onClick={onClose} title="閉じる (Esc)"><X size={16} /></button>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", flex: 1, overflow: "hidden" }}>
          <aside style={{ borderRight: "1px solid var(--line)", padding: "24px 22px", background: "var(--panel-deep)", overflowY: "auto" }}>
            <div className="tiny" style={{ letterSpacing: "0.18em", color: "var(--ink-muted)", fontWeight: 600, textTransform: "uppercase", marginBottom: 10 }}>この資料について</div>
            <MetaRow label="版数" value={file.version || "—"} />
            <MetaRow label="ファイル" value={`${file.thumbnailLabel} ・ ${file.sizeLabel}`} />
            <MetaRow label="追加日" value={file.date} />
            {file.tags.length > 0 ? <MetaRow label="タグ" value={file.tags.join("・")} /> : null}
            {file.memo ? <><div className="divider" style={{ margin: "16px 0" }} /><div className="tiny" style={{ letterSpacing: "0.18em", color: "var(--ink-muted)", fontWeight: 600, textTransform: "uppercase", marginBottom: 8 }}>メモ</div><p style={{ fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.7, margin: 0 }}>{file.memo}</p></> : null}
          </aside>
          <div style={{ overflowY: "auto", padding: "32px 44px" }}>
            {editing ? <textarea value={draft} onChange={e => onDraft(e.target.value)} className="textarea" style={{ minHeight: "60vh", fontSize: 14, lineHeight: 1.85, fontFamily: "inherit" }} /> : <div className="prose"><ReactMarkdown remarkPlugins={[remarkGfm]}>{draft}</ReactMarkdown></div>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Utilities ────────────────────────────────────────────────────
function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 10, padding: "6px 0", borderBottom: "1px solid var(--line-soft)" }}>
      <dt className="tiny" style={{ color: "var(--ink-muted)", letterSpacing: "0.1em", paddingTop: 2 }}>{label}</dt>
      <dd style={{ margin: 0, color: "var(--ink)", fontSize: 12.5, lineHeight: 1.55 }}>{value || "—"}</dd>
    </div>
  );
}

function toRepositoryFile(m: StoredFileMetadata & { thumbnailUrl?: string | null }): RepositoryFile {
  return {
    id: m.id, name: m.fileName, contentType: m.contentType,
    date: formatDisplayDate(m.uploadedAt),
    sizeLabel: m.sizeLabel, thumbnailLabel: m.thumbnailLabel,
    tags: m.tags || [], version: m.version, memo: m.memo,
    summary: m.summary || "",
    summaryStatus: m.summaryStatus || "not_started",
    summaryMode: m.summaryMode || "legacy",
    summaryUpdatedAt: m.summaryUpdatedAt || "",
    preparationStatus: m.preparationStatus || "not_started",
    ragSyncStatus: m.ragSyncStatus || "not_started",
    thumbnailUrl: m.thumbnailUrl ?? null,
    textExtractionStatus: m.textExtractionStatus || "not_started",
    imageCount: m.images?.length ?? 0,
    imageProcessingStatus: m.imageProcessingStatus,
    imageProcessingError: m.imageProcessingError || "",
  };
}

function formatDisplayDate(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).format(new Date(value)).replace(/\//g, "-");
}
