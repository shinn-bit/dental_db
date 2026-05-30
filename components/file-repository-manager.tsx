"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Check, ChevronRight, Clipboard, Edit, Images, Plus, RefreshCw, Search, Trash2, Upload, X
} from "lucide-react";
import { Button, FileSpine, FieldLabel } from "@/components/ui";
import { formatFileSize, getThumbnailLabel, type StoredFileMetadata } from "@/lib/file-assets";

// ── Types ───────────────────────────────────────────────────────
type LibrarySub = { id: string; label: string };
type LibraryCategory = { id: string; label: string; sub: string; subs: LibrarySub[] };
type FileAssignments = Record<string, { catId: string; subId: string | null }>;

type RepositoryFile = {
  id: string;
  name: string;
  contentType: string;
  date: string;
  sizeLabel: string;
  thumbnailLabel: string;
  tags: string[];
  version: string;
  memo: string;
  summary: string;
  summaryStatus: StoredFileMetadata["summaryStatus"];
  summaryMode: StoredFileMetadata["summaryMode"];
  summaryUpdatedAt: string;
  preparationStatus: StoredFileMetadata["preparationStatus"];
  textExtractionStatus: StoredFileMetadata["textExtractionStatus"];
  imageCount: number;
  imageProcessingStatus: StoredFileMetadata["imageProcessingStatus"];
  imageProcessingError: string;
};

type DetailDraft = { catId: string; subId: string; memo: string };

// ── Default library ─────────────────────────────────────────────
const DEFAULT_LIBRARY: LibraryCategory[] = [
  {
    id: "cat-general", label: "一般診療", sub: "基本処置・応急処置",
    subs: [{ id: "sub-basic", label: "基本処置" }, { id: "sub-emergency", label: "応急処置" }]
  },
  {
    id: "cat-perio", label: "歯周治療", sub: "スケーリング・外科処置",
    subs: [{ id: "sub-srp", label: "SRP・スケーリング" }, { id: "sub-surgery", label: "歯周外科" }]
  },
  {
    id: "cat-education", label: "患者教育・予防", sub: "口腔衛生・予防処置",
    subs: [{ id: "sub-oral", label: "口腔衛生指導" }, { id: "sub-prevention", label: "予防処置" }]
  }
];

const LIBRARY_KEY = "dental-library-tree";
const ASSIGNMENTS_KEY = "dental-file-folders";

function readLibrary(): LibraryCategory[] {
  try { const r = localStorage.getItem(LIBRARY_KEY); if (r) return JSON.parse(r) as LibraryCategory[]; } catch {}
  return DEFAULT_LIBRARY;
}
function writeLibrary(lib: LibraryCategory[]) {
  try { localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib)); } catch {}
}
function readAssignments(): FileAssignments {
  try { const r = localStorage.getItem(ASSIGNMENTS_KEY); if (r) return JSON.parse(r) as FileAssignments; } catch {}
  return {};
}
function writeAssignments(a: FileAssignments) {
  try { localStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(a)); } catch {}
}

// ── Main component ──────────────────────────────────────────────
export function FileRepositoryManager() {
  // Library
  const [library, setLibraryState] = useState<LibraryCategory[]>(DEFAULT_LIBRARY);
  const [assignments, setAssignmentsState] = useState<FileAssignments>({});
  const [path, setPath] = useState<string[]>([]);
  const [libQuery, setLibQuery] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ cat: string; sub: string | null } | null>(null);
  const [destCat, setDestCat] = useState(DEFAULT_LIBRARY[0]?.id || "");
  const [destSub, setDestSub] = useState(DEFAULT_LIBRARY[0]?.subs[0]?.id || "");

  // Files
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
  const [imageGallery, setImageGallery] = useState<{ file: RepositoryFile; images: { index: number; page: number; description: string; url: string }[] } | null>(null);

  // Load from localStorage on mount
  useEffect(() => {
    setLibraryState(readLibrary());
    setAssignmentsState(readAssignments());
  }, []);

  // Keep destSub valid when destCat changes
  useEffect(() => {
    const cat = library.find((c) => c.id === destCat);
    if (!cat) { setDestCat(library[0]?.id || ""); return; }
    if (destSub && !cat.subs.find((s) => s.id === destSub)) {
      setDestSub(cat.subs[0]?.id || "");
    }
  }, [destCat, library]);

  function setLibrary(fn: (prev: LibraryCategory[]) => LibraryCategory[]) {
    setLibraryState((prev) => { const next = fn(prev); writeLibrary(next); return next; });
  }
  function setAssignments(fn: (prev: FileAssignments) => FileAssignments) {
    setAssignmentsState((prev) => { const next = fn(prev); writeAssignments(next); return next; });
  }

  // ── Library CRUD ──
  function addCategory(label: string) {
    if (!label.trim()) return;
    const id = `cat-${Date.now()}`;
    setLibrary((l) => [...l, { id, label: label.trim(), sub: "", subs: [] }]);
  }
  function renameCategory(id: string, label: string) {
    setLibrary((l) => l.map((c) => c.id === id ? { ...c, label } : c));
  }
  function renameCategorySub(id: string, sub: string) {
    setLibrary((l) => l.map((c) => c.id === id ? { ...c, sub } : c));
  }
  function deleteCategory(id: string) {
    if (!window.confirm("このカテゴリーを削除します。")) return;
    setLibrary((l) => l.filter((c) => c.id !== id));
    setAssignments((a) => {
      const next = { ...a };
      Object.keys(next).forEach((fid) => { if (next[fid].catId === id) delete next[fid]; });
      return next;
    });
    if (path[0] === id) setPath([]);
  }
  function addSub(catId: string, label: string) {
    if (!label.trim()) return;
    const id = `sub-${Date.now()}`;
    setLibrary((l) => l.map((c) => c.id === catId ? { ...c, subs: [...c.subs, { id, label: label.trim() }] } : c));
  }
  function renameSub(catId: string, subId: string, label: string) {
    setLibrary((l) => l.map((c) => c.id === catId ? { ...c, subs: c.subs.map((s) => s.id === subId ? { ...s, label } : s) } : c));
  }
  function deleteSub(catId: string, subId: string) {
    if (!window.confirm("このフォルダーを削除します。")) return;
    setLibrary((l) => l.map((c) => c.id === catId ? { ...c, subs: c.subs.filter((s) => s.id !== subId) } : c));
    setAssignments((a) => {
      const next = { ...a };
      Object.keys(next).forEach((fid) => { if (next[fid].catId === catId && next[fid].subId === subId) delete next[fid]; });
      return next;
    });
    if (path[0] === catId && path[1] === subId) setPath([catId]);
  }

  // ── Drag-drop assignment ──
  function moveFile(fileId: string, catId: string, subId: string | null) {
    setAssignments((a) => ({ ...a, [fileId]: { catId, subId } }));
    setDraggedId(null);
    setDropTarget(null);
  }

  function handleExternalDrop(droppedFiles: FileList, catId: string, subId: string | null) {
    if (catId) setDestCat(catId);
    if (subId) setDestSub(subId);
    addPendingFiles(droppedFiles);
  }

  // ── File operations ──
  async function loadFiles(opts: { showLoading?: boolean; updateNotice?: boolean } = {}) {
    if (opts.showLoading) setIsLoadingFiles(true);
    try {
      const res = await fetch("/api/files", { cache: "no-store" });
      if (!res.ok) throw new Error("S3一覧を読み込めませんでした。");
      const data = (await res.json()) as { files: StoredFileMetadata[] };
      const mapped = data.files.map(toRepositoryFile);
      setFiles(mapped);
      // 準備完了済みPDFで未処理のものを自動的に画像処理起動
      for (const f of mapped) {
        if (f.preparationStatus === "completed" && f.contentType.includes("pdf") && !f.imageProcessingStatus) {
          fetch(`/api/files/${f.id}/process-images`, { method: "POST" }).catch(() => {});
        }
      }
    } catch (error) {
      if (opts.updateNotice !== false) {
        setNotice(error instanceof Error ? error.message : "S3一覧を読み込めませんでした。");
      }
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

  useEffect(() => {
    const hasPending = files.some(
      (f) => f.preparationStatus === "processing" || f.preparationStatus === "syncing" || f.summaryStatus === "processing" || f.imageProcessingStatus === "processing"
    );
    if (!hasPending) return;
    const timer = window.setInterval(() => loadFiles({ updateNotice: false }), 8000);
    return () => window.clearInterval(timer);
  }, [files]);


  function addPendingFiles(nextFiles: FileList | File[]) {
    const incoming = Array.from(nextFiles).filter((f) => f.size > 0);
    if (!incoming.length) return;
    setPendingFiles((cur) => {
      const keys = new Set(cur.map((f) => `${f.name}-${f.size}`));
      return [...cur, ...incoming.filter((f) => !keys.has(`${f.name}-${f.size}`))];
    });
    setNotice("");
  }

  async function registerFiles() {
    if (!pendingFiles.length) { setNotice("ファイルを選択してください。"); return; }
    setIsUploading(true);
    setNotice("S3へアップロードしています。");
    try {
      const uploaded: RepositoryFile[] = [];
      for (const file of pendingFiles) {
        const urlRes = await fetch("/api/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: file.name, contentType: file.type || "application/octet-stream" })
        });
        if (!urlRes.ok) throw new Error("Failed to create upload URL");
        const urlData = (await urlRes.json()) as { id: string; uploadUrl: string; s3Key: string };
        const putRes = await fetch(urlData.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file
        });
        if (!putRes.ok) throw new Error("Failed to upload file");
        const metaRes = await fetch("/api/files", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: urlData.id, fileName: file.name, s3Key: urlData.s3Key,
            contentType: file.type || "application/octet-stream",
            size: file.size, sizeLabel: formatFileSize(file.size),
            thumbnailLabel: getThumbnailLabel(file.name),
            memo: memo.trim(),
            uploadedAt: new Date().toISOString()
          })
        });
        if (!metaRes.ok) throw new Error("Failed to save metadata");
        const metaData = (await metaRes.json()) as { file: StoredFileMetadata };
        const rf = toRepositoryFile(metaData.file);
        uploaded.push(rf);
        // assign to selected folder
        if (destCat) {
          setAssignments((a) => ({ ...a, [rf.id]: { catId: destCat, subId: destSub || null } }));
        }
      }
      setFiles((cur) => [...uploaded, ...cur]);
      setPendingFiles([]);
      setMemo("");
      setNotice(`${uploaded.length}件を資料庫に追加しました。`);
    } catch {
      setNotice("アップロードに失敗しました。SSO期限やS3設定を確認してください。");
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
      setFiles((cur) => cur.filter((f) => f.id !== file.id));
      setAssignments((a) => { const next = { ...a }; delete next[file.id]; return next; });
      setNotice(`${file.name} を削除しました。`);
    } catch {
      setNotice("削除に失敗しました。SSO期限やS3設定を確認してください。");
    } finally {
      setDeletingId(null);
    }
  }

  async function openOrCreateSummary(file: RepositoryFile) {
    if (file.summaryStatus !== "completed" && file.preparationStatus !== "completed") {
      setBlockedSummaryId(file.id);
      window.setTimeout(() => setBlockedSummaryId((cur) => cur === file.id ? null : cur), 3600);
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
      setFiles((cur) => cur.map((f) => f.id === nextFile.id ? nextFile : f));
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
      // API がメタデータに "processing" を書いた後に返るので、
      // loadFiles() するとボタンが「処理中…」に変わる
      await loadFiles({ updateNotice: false });
      setNotice("画像処理を開始しました。完了まで数分かかります。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "画像処理に失敗しました。");
    }
  }

  async function openImages(file: RepositoryFile) {
    setNotice("");
    try {
      const res = await fetch(`/api/files/${file.id}/images`);
      const data = (await res.json()) as { images?: { index: number; page: number; description: string; url: string }[]; error?: string };
      if (!res.ok) throw new Error(data.error || "画像の取得に失敗しました。");
      setImageGallery({ file, images: data.images ?? [] });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "画像の取得に失敗しました。");
    }
  }

  async function saveSummary() {
    if (!selectedSummary) return;
    setSummaryProcessingId(selectedSummary.id);
    try {
      const res = await fetch(`/api/files/${selectedSummary.id}/summary`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: summaryDraft })
      });
      const data = (await res.json()) as { summary?: string; file?: StoredFileMetadata; error?: string };
      if (!res.ok) throw new Error(data.error || "要約の保存に失敗しました。");
      const nextFile = toRepositoryFile(data.file as StoredFileMetadata);
      setFiles((cur) => cur.map((f) => f.id === nextFile.id ? nextFile : f));
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
    } catch {
      setNotice("コピーに失敗しました。");
    }
  }

  function openDetail(file: RepositoryFile) {
    const a = assignments[file.id];
    setSelectedDetail(file);
    setDetailDraft({
      catId: a?.catId ?? library[0]?.id ?? "",
      subId: a?.subId ?? library[0]?.subs[0]?.id ?? "",
      memo: file.memo
    });
  }

  async function saveDetail() {
    if (!selectedDetail || !detailDraft) return;
    setDetailSaving(true);
    try {
      const res = await fetch(`/api/files/${selectedDetail.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ memo: detailDraft.memo.trim() })
      });
      const data = (await res.json()) as { file?: StoredFileMetadata; error?: string };
      if (!res.ok || !data.file) throw new Error(data.error || "詳細を保存できませんでした。");
      const nextFile = toRepositoryFile(data.file);
      setFiles((cur) => cur.map((f) => f.id === nextFile.id ? nextFile : f));
      setSelectedDetail(nextFile);
      if (detailDraft.catId) moveFile(selectedDetail.id, detailDraft.catId, detailDraft.subId || null);
      setNotice("詳細を保存しました。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "詳細を保存できませんでした。");
    } finally {
      setDetailSaving(false);
    }
  }

  // ── Counts ──
  function filesInFolder(catId: string, subId: string) {
    return files.filter((f) => assignments[f.id]?.catId === catId && assignments[f.id]?.subId === subId).length;
  }
  function filesInCategory(catId: string) {
    return files.filter((f) => assignments[f.id]?.catId === catId).length;
  }

  const dragCtx = {
    draggedId, setDraggedId, dropTarget, setDropTarget,
    moveFile, onExternalDrop: handleExternalDrop
  };

  const cat = path[0] ? library.find((c) => c.id === path[0]) : null;
  const sub = path[1] && cat ? cat.subs.find((s) => s.id === path[1]) : null;
  const searching = libQuery.trim().length > 0;
  const searchHits = searching ? files.filter((f) => f.name.toLowerCase().includes(libQuery.toLowerCase())) : [];
  const filesInSub = sub && cat ? files.filter((f) => assignments[f.id]?.catId === cat.id && assignments[f.id]?.subId === sub.id) : [];
  const unassignedFiles = files.filter((f) => {
    const a = assignments[f.id];
    if (!a) return true;
    const assignedCat = library.find((c) => c.id === a.catId);
    if (!assignedCat) return true;
    if (!a.subId) return true;
    if (!assignedCat.subs.find((s) => s.id === a.subId)) return true;
    return false;
  });

  const currentCat = library.find((c) => c.id === destCat);

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
              onDragEnter={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
              onDrop={(e) => { e.preventDefault(); setIsDragging(false); addPendingFiles(e.dataTransfer.files); }}
              style={{ border: `1.5px dashed ${isDragging ? "var(--navy)" : "#cbc7b8"}`, background: isDragging ? "var(--navy-tint-soft)" : "var(--panel-deep)", borderRadius: 12, padding: "28px 18px", textAlign: "center", transition: "all .15s ease" }}
            >
              <div style={{ color: "var(--navy)", display: "inline-flex" }}><Upload size={28} aria-hidden="true" /></div>
              <div className="serif" style={{ fontSize: 16, marginTop: 10, color: "var(--navy-deep)", fontWeight: 600, letterSpacing: "0.04em" }}>ここにファイルを置く</div>
              <div className="small soft" style={{ marginTop: 4 }}>または下のボタンで選択</div>
              <input ref={fileInputRef} type="file" multiple style={{ display: "none" }} accept=".pdf,.doc,.docx,.txt,.md,image/*,video/*"
                onChange={(e) => { if (e.target.files) addPendingFiles(e.target.files); e.currentTarget.value = ""; }} />
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
                      <button type="button" className="btn ghost sm icon" onClick={() => setPendingFiles((cur) => cur.filter((_, i) => i !== idx))} title="選択から外す">
                        <X size={13} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="divider" />

            {/* Destination folder */}
            <FieldLabel>保存先フォルダー</FieldLabel>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <FolderSelect
                value={destCat}
                onChange={setDestCat}
                options={library.map((c) => ({ id: c.id, label: c.label }))}
                placeholder="カテゴリーを選択"
              />
              <FolderSelect
                value={destSub}
                onChange={setDestSub}
                options={(currentCat?.subs || []).map((s) => ({ id: s.id, label: s.label }))}
                placeholder="フォルダーを選択"
                disabled={!currentCat || (currentCat?.subs || []).length === 0}
              />
            </div>
            {currentCat && (currentCat.subs || []).length === 0 ? (
              <p className="tiny soft" style={{ marginTop: 6 }}>このカテゴリーにはフォルダーがありません。資料庫で追加してください。</p>
            ) : null}

            <div className="divider" />

            <FieldLabel>メモ（任意）</FieldLabel>
            <input className="input" placeholder="任意" value={memo} onChange={(e) => setMemo(e.target.value)} />

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
          {/* Library header */}
          <div style={{ padding: "16px 22px", borderBottom: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 12, flexShrink: 0 }}>
            {/* Breadcrumb */}
            <nav className="row" style={{ gap: 4, fontSize: 13, flexWrap: "wrap" }}>
              <Crumb active={path.length === 0} onClick={() => setPath([])}>資料庫</Crumb>
              {cat ? (<><CrumbSep /><Crumb active={path.length === 1} onClick={() => setPath([cat.id])}>{cat.label}</Crumb></>) : null}
              {sub ? (<><CrumbSep /><Crumb active={path.length === 2} onClick={() => setPath([cat!.id, sub.id])}>{sub.label}</Crumb></>) : null}
            </nav>
            <div className="between" style={{ gap: 12, flexWrap: "wrap" }}>
              <div className="stack" style={{ minWidth: 0 }}>
                {!cat ? (
                  <>
                    <span className="panel-title">資料庫</span>
                    <span className="panel-sub">{isLoadingFiles ? "読み込み中…" : "カテゴリーから資料をたどる"}</span>
                  </>
                ) : !sub ? (
                  <>
                    <InlineEdit value={cat.label} onSave={(v) => renameCategory(cat.id, v)} className="panel-title" />
                    <InlineEdit value={cat.sub || "説明を追加"} placeholder="ひとことの説明" onSave={(v) => renameCategorySub(cat.id, v)} className="panel-sub" isPlaceholder={!cat.sub} />
                  </>
                ) : (
                  <>
                    <InlineEdit value={sub.label} onSave={(v) => renameSub(cat!.id, sub.id, v)} className="panel-title" />
                    <span className="panel-sub">{cat?.label}</span>
                  </>
                )}
              </div>
              <div className="row" style={{ gap: 8 }}>
                <div style={{ position: "relative" }}>
                  <Search size={14} style={{ position: "absolute", left: 12, top: 12, color: "var(--ink-muted)" }} aria-hidden="true" />
                  <input className="input" placeholder="資料庫全体から探す" value={libQuery} onChange={(e) => setLibQuery(e.target.value)} style={{ paddingLeft: 34, height: 38, width: 200 }} />
                </div>
              </div>
            </div>
          </div>

          {/* Folder tree + content */}
          <div style={{ flex: 1, display: "grid", gridTemplateColumns: "200px 1fr", minHeight: 0, overflow: "hidden" }}>
            <FolderTree
              library={library}
              path={path}
              expanded={expanded}
              setExpanded={setExpanded}
              onNavigate={setPath}
              filesInFolder={filesInFolder}
              filesInCategory={filesInCategory}
              drag={dragCtx}
            />
            <div style={{ overflowY: "auto", minHeight: 0, borderLeft: "1px solid var(--line)" }}>
              {searching ? (
                <SearchResults hits={searchHits} onOpenSummary={openOrCreateSummary} onDetail={openDetail} onDelete={deleteFile} onProcessImages={processImages} onOpenImages={openImages} query={libQuery} summaryProcessingId={summaryProcessingId} blockedSummaryId={blockedSummaryId} deletingId={deletingId} drag={dragCtx} />
              ) : !cat ? (
                <CategoryGrid
                  library={library}
                  onPick={(c) => setPath([c.id])}
                  onAdd={addCategory}
                  onRename={renameCategory}
                  onDelete={deleteCategory}
                  filesInCategory={filesInCategory}
                  drag={dragCtx}
                  unassignedFiles={unassignedFiles}
                  onOpenSummary={openOrCreateSummary}
                  onDetail={openDetail}
                  onDeleteFile={deleteFile}
                  onProcessImages={processImages}
                  onOpenImages={openImages}
                  summaryProcessingId={summaryProcessingId}
                  blockedSummaryId={blockedSummaryId}
                  deletingId={deletingId}
                 
                />
              ) : !sub ? (
                <SubcategoryView
                  cat={cat}
                  onPick={(s) => setPath([cat!.id, s.id])}
                  onAdd={(label) => addSub(cat!.id, label)}
                  onRename={(subId, label) => renameSub(cat!.id, subId, label)}
                  onDelete={(subId) => deleteSub(cat!.id, subId)}
                  filesInFolder={filesInFolder}
                  drag={dragCtx}
                />
              ) : (
                <FileGrid
                  cat={cat}
                  sub={sub}
                  files={filesInSub}
                  onOpenSummary={openOrCreateSummary}
                  onDetail={openDetail}
                  onDelete={deleteFile}
                  onProcessImages={processImages}
                  onOpenImages={openImages}
                  summaryProcessingId={summaryProcessingId}
                  blockedSummaryId={blockedSummaryId}
                  deletingId={deletingId}
                 
                  drag={dragCtx}
                />
              )}
            </div>
          </div>
        </section>
      </div>

      {/* ── Overlays ── */}
      {imageGallery ? (
        <ImageGalleryOverlay gallery={imageGallery} onClose={() => setImageGallery(null)} />
      ) : null}
      {selectedDetail && detailDraft ? (
        <DetailOverlay file={selectedDetail} draft={detailDraft} saving={detailSaving} library={library} onDraft={setDetailDraft} onSave={saveDetail} onOpenSource={() => setSourceViewerFile(selectedDetail)} onClose={() => setSelectedDetail(null)} />
      ) : null}
      {sourceViewerFile ? (
        <SourceViewerOverlay file={sourceViewerFile} onClose={() => setSourceViewerFile(null)} />
      ) : null}
      {selectedSummary ? (
        <SummaryOverlay file={selectedSummary} draft={summaryDraft} editing={summaryEditing} copied={summaryCopied} processing={summaryProcessingId === selectedSummary.id} onDraft={setSummaryDraft} onEdit={() => setSummaryEditing(true)} onSave={saveSummary} onCopy={copySummary} onClose={() => setSelectedSummary(null)} />
      ) : null}
    </>
  );
}

// ── Shared folder select ────────────────────────────────────────
function FolderSelect({ value, onChange, options, placeholder, disabled }: {
  value: string; onChange: (v: string) => void;
  options: { id: string; label: string }[];
  placeholder: string; disabled?: boolean;
}) {
  return (
    <div style={{ position: "relative" }}>
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className="input"
        style={{ appearance: "none", paddingRight: 28, cursor: disabled ? "not-allowed" : "pointer", background: "#fff", opacity: disabled ? 0.55 : 1 }}>
        {!value ? <option value="">{placeholder}</option> : null}
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
      <span style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%) rotate(90deg)", color: "var(--ink-muted)", pointerEvents: "none" }}>
        <ChevronRight size={12} />
      </span>
    </div>
  );
}

// ── Drag context type ───────────────────────────────────────────
type DragCtx = {
  draggedId: string | null;
  setDraggedId: (id: string | null) => void;
  dropTarget: { cat: string; sub: string | null } | null;
  setDropTarget: (t: { cat: string; sub: string | null } | null) => void;
  moveFile: (fileId: string, catId: string, subId: string | null) => void;
  onExternalDrop: (files: FileList, catId: string, subId: string | null) => void;
};

// ── Folder tree (left sidebar) ──────────────────────────────────
function FolderTree({ library, path, expanded, setExpanded, onNavigate, filesInFolder, filesInCategory, drag }: {
  library: LibraryCategory[];
  path: string[];
  expanded: Record<string, boolean>;
  setExpanded: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onNavigate: (p: string[]) => void;
  filesInFolder: (catId: string, subId: string) => number;
  filesInCategory: (catId: string) => number;
  drag: DragCtx;
}) {
  return (
    <div style={{ overflowY: "auto", padding: "12px 10px", background: "var(--panel-deep)", minHeight: 0 }}>
      <TreeNode label="資料庫" isRoot active={path.length === 0} onClick={() => onNavigate([])} />
      {library.map((c) => {
        const isExpanded = !!expanded[c.id];
        const isActive = path[0] === c.id && path.length === 1;
        return (
          <Fragment key={c.id}>
            <TreeNode
              label={c.label} count={filesInCategory(c.id)} active={isActive}
              chevron={c.subs.length > 0 ? (isExpanded ? "down" : "right") : undefined}
              onChevron={() => setExpanded((e) => ({ ...e, [c.id]: !e[c.id] }))}
              onClick={() => { onNavigate([c.id]); if (!isExpanded) setExpanded((e) => ({ ...e, [c.id]: true })); }}
              drag={drag} dropCat={c.id} dropSub={null}
            />
            {isExpanded ? c.subs.map((s) => (
              <TreeNode
                key={s.id} label={s.label} count={filesInFolder(c.id, s.id)}
                active={path[0] === c.id && path[1] === s.id}
                onClick={() => onNavigate([c.id, s.id])}
                indent={2} drag={drag} dropCat={c.id} dropSub={s.id}
              />
            )) : null}
          </Fragment>
        );
      })}
    </div>
  );
}

function TreeNode({ label, count, active, onClick, chevron, onChevron, indent = 1, isRoot, drag, dropCat, dropSub }: {
  label: string; count?: number; active?: boolean; onClick: () => void;
  chevron?: "down" | "right"; onChevron?: () => void;
  indent?: number; isRoot?: boolean;
  drag?: DragCtx; dropCat?: string; dropSub?: string | null;
}) {
  const acceptsDrop = !!(drag && dropCat);
  const isDropTarget = acceptsDrop && drag.dropTarget?.cat === dropCat && drag.dropTarget?.sub === (dropSub ?? null);

  function handleOver(e: React.DragEvent) {
    if (!acceptsDrop) return;
    e.preventDefault();
    drag.setDropTarget({ cat: dropCat!, sub: dropSub ?? null });
  }
  function handleDrop(e: React.DragEvent) {
    if (!acceptsDrop) return;
    e.preventDefault();
    drag.setDropTarget(null);
    if (e.dataTransfer.files?.length && drag.onExternalDrop) {
      drag.onExternalDrop(e.dataTransfer.files, dropCat!, dropSub ?? null);
    } else if (drag.draggedId) {
      drag.moveFile(drag.draggedId, dropCat!, dropSub ?? null);
    }
  }

  return (
    <div
      onClick={onClick}
      onDragOver={dropCat ? handleOver : undefined}
      onDragLeave={dropCat ? () => drag?.setDropTarget(null) : undefined}
      onDrop={dropCat ? handleDrop : undefined}
      style={{
        display: "flex", alignItems: "center", gap: 4,
        padding: `5px ${8 * indent}px 5px ${8 * indent}px`,
        borderRadius: 6, cursor: "pointer", marginBottom: 1,
        background: isDropTarget ? "var(--navy)" : active ? "var(--navy-tint)" : "transparent",
        color: isDropTarget ? "#fff" : active ? "var(--navy-deep)" : "var(--ink-soft)",
        fontWeight: active || isRoot ? 600 : 500, fontSize: 12.5, letterSpacing: "0.02em",
        outline: isDropTarget ? "2px solid var(--navy-deep)" : "none", outlineOffset: -2,
        transition: "background .1s ease"
      }}
      onMouseEnter={(e) => { if (!active && !isDropTarget) e.currentTarget.style.background = "var(--navy-tint-soft)"; }}
      onMouseLeave={(e) => { if (!active && !isDropTarget) e.currentTarget.style.background = "transparent"; }}
    >
      {chevron ? (
        <button onClick={(e) => { e.stopPropagation(); onChevron?.(); }}
          style={{ background: "transparent", border: 0, color: "inherit", cursor: "pointer", padding: 0, width: 14, height: 14, display: "inline-flex", alignItems: "center", justifyContent: "center", transform: chevron === "down" ? "rotate(90deg)" : "none", transition: "transform .15s ease" }}>
          <ChevronRight size={11} />
        </button>
      ) : (
        <span style={{ width: 14, display: "inline-block" }} />
      )}
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      {typeof count === "number" && count > 0 ? (
        <span style={{ fontSize: 10, color: isDropTarget ? "rgba(255,255,255,0.8)" : "var(--ink-faint)", fontVariantNumeric: "tabular-nums" }}>{count}</span>
      ) : null}
    </div>
  );
}

// ── Category grid (root) ────────────────────────────────────────
function CategoryGrid({ library, onPick, onAdd, onRename, onDelete, filesInCategory, drag, unassignedFiles, onOpenSummary, onDetail, onDeleteFile, onProcessImages, onOpenImages, summaryProcessingId, blockedSummaryId, deletingId }: {
  library: LibraryCategory[];
  onPick: (c: LibraryCategory) => void;
  onAdd: (label: string) => void;
  onRename: (id: string, label: string) => void;
  onDelete: (id: string) => void;
  filesInCategory: (catId: string) => number;
  drag: DragCtx;
  unassignedFiles: RepositoryFile[];
  onOpenSummary: (f: RepositoryFile) => void;
  onDetail: (f: RepositoryFile) => void;
  onDeleteFile: (f: RepositoryFile) => void;
  onProcessImages: (f: RepositoryFile) => void;
  onOpenImages: (f: RepositoryFile) => void;
  summaryProcessingId: string | null;
  blockedSummaryId: string | null;
  deletingId: string | null;
 
}) {
  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 14 }}>
        {library.map((c) => (
          <CategoryCard key={c.id} cat={c} fileCount={filesInCategory(c.id)} onClick={() => onPick(c)} onRename={(v) => onRename(c.id, v)} onDelete={() => onDelete(c.id)} drag={drag} />
        ))}
        <AddCategoryCard onAdd={onAdd} />
      </div>
      {unassignedFiles.length > 0 ? (
        <div style={{ marginTop: 28 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
            <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
            <span className="tiny" style={{ color: "var(--ink-muted)", letterSpacing: "0.12em", fontWeight: 600, whiteSpace: "nowrap" }}>
              未整理 ({unassignedFiles.length} 件) — フォルダーにドラッグして整理
            </span>
            <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
            {unassignedFiles.map((f) => (
              <DraggableFileCard
                key={f.id} file={f} drag={drag}
                onOpenSummary={onOpenSummary} onDetail={onDetail} onDelete={onDeleteFile}
                onProcessImages={onProcessImages} onOpenImages={onOpenImages}
                summaryProcessingId={summaryProcessingId} blockedSummaryId={blockedSummaryId} deletingId={deletingId}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CategoryCard({ cat, fileCount, onClick, onRename, onDelete, drag }: {
  cat: LibraryCategory; fileCount: number; onClick: () => void;
  onRename: (v: string) => void; onDelete: () => void; drag: DragCtx;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(cat.label);
  const [hover, setHover] = useState(false);

  const dropSub = cat.subs[0]?.id || null;
  const isDropTarget = drag.dropTarget?.cat === cat.id && drag.dropTarget?.sub === dropSub;

  function handleOver(e: React.DragEvent) { e.preventDefault(); drag.setDropTarget({ cat: cat.id, sub: dropSub }); }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault(); drag.setDropTarget(null);
    if (e.dataTransfer.files?.length) drag.onExternalDrop(e.dataTransfer.files, cat.id, dropSub);
    else if (drag.draggedId) drag.moveFile(drag.draggedId, cat.id, dropSub);
  }
  function commit() { const v = draft.trim(); if (v && v !== cat.label) onRename(v); setRenaming(false); }

  return (
    <div
      onClick={() => !renaming && onClick()}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onDragOver={handleOver} onDragLeave={() => drag.setDropTarget(null)} onDrop={handleDrop}
      style={{
        background: isDropTarget ? "var(--navy-tint)" : "var(--panel)",
        border: `1px solid ${isDropTarget ? "var(--navy)" : hover ? "var(--navy-soft)" : "var(--line)"}`,
        outline: isDropTarget ? "2px solid var(--navy)" : "none", outlineOffset: -2,
        borderRadius: 12, padding: "18px 16px 14px", cursor: renaming ? "default" : "pointer",
        position: "relative", display: "flex", flexDirection: "column", gap: 12, minHeight: 140,
        transition: "border-color .15s ease, transform .15s ease, box-shadow .15s ease",
        boxShadow: hover ? "var(--shadow-md)" : "none",
        transform: hover ? "translateY(-2px)" : "translateY(0)"
      }}
    >
      {/* Actions */}
      <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", top: 8, right: 8, display: "flex", gap: 2, opacity: hover && !drag.draggedId ? 1 : 0, transition: "opacity .15s ease", background: "var(--panel)", borderRadius: 6, padding: 2, border: "1px solid var(--line)" }}>
        <SmallIconButton title="名前を変更" onClick={() => { setDraft(cat.label); setRenaming(true); }}><Edit size={12} /></SmallIconButton>
        <SmallIconButton title="削除" onClick={onDelete} danger><Trash2 size={12} /></SmallIconButton>
      </div>

      <FolderGlyph open={hover || isDropTarget} />

      <div className="stack" style={{ gap: 4, flex: 1 }}>
        {renaming ? (
          <input autoFocus className="input" value={draft} onChange={(e) => setDraft(e.target.value)}
            onBlur={commit} onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setRenaming(false); }}
            style={{ height: 32, padding: "0 8px", fontSize: 15 }} />
        ) : (
          <span className="serif" style={{ fontSize: 16, fontWeight: 600, color: "var(--ink)", letterSpacing: "0.04em", lineHeight: 1.3 }}>{cat.label}</span>
        )}
        {cat.sub ? <span className="tiny soft" style={{ letterSpacing: "0.04em" }}>{cat.sub}</span> : null}
      </div>

      <div className="between" style={{ paddingTop: 10, borderTop: "1px solid var(--line-soft)", fontSize: 11, color: "var(--ink-muted)", letterSpacing: "0.04em" }}>
        <span>{cat.subs.length} フォルダー ・ {fileCount} 件</span>
        <ChevronRight size={13} style={{ color: "var(--navy-soft)" }} />
      </div>
    </div>
  );
}

function AddCategoryCard({ onAdd }: { onAdd: (label: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  function commit() { if (draft.trim()) onAdd(draft); setDraft(""); setAdding(false); }

  if (adding) {
    return (
      <div style={{ background: "var(--panel)", border: "1.5px dashed var(--navy-soft)", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 10, minHeight: 140, justifyContent: "center" }}>
        <input autoFocus className="input" placeholder="カテゴリー名" value={draft} onChange={(e) => setDraft(e.target.value)}
          onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(""); setAdding(false); } }} />
        <div className="row" style={{ gap: 6 }}>
          <Button size="sm" onClick={commit}>追加</Button>
          <Button variant="ghost" size="sm" onClick={() => { setDraft(""); setAdding(false); }}>キャンセル</Button>
        </div>
      </div>
    );
  }
  return (
    <button type="button" onClick={() => setAdding(true)}
      style={{ background: "transparent", border: "1.5px dashed var(--line)", borderRadius: 12, padding: 14, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--ink-muted)", minHeight: 140, transition: "all .15s ease" }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--navy-soft)"; e.currentTarget.style.color = "var(--navy-deep)"; e.currentTarget.style.background = "var(--navy-tint-soft)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--line)"; e.currentTarget.style.color = "var(--ink-muted)"; e.currentTarget.style.background = "transparent"; }}>
      <span style={{ width: 36, height: 36, borderRadius: 10, background: "rgba(0,0,0,0.03)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}><Plus size={18} /></span>
      <span className="serif" style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.04em" }}>カテゴリーを追加</span>
    </button>
  );
}

// ── Subcategory view ────────────────────────────────────────────
function SubcategoryView({ cat, onPick, onAdd, onRename, onDelete, filesInFolder, drag }: {
  cat: LibraryCategory;
  onPick: (s: LibrarySub) => void;
  onAdd: (label: string) => void;
  onRename: (subId: string, label: string) => void;
  onDelete: (subId: string) => void;
  filesInFolder: (catId: string, subId: string) => number;
  drag: DragCtx;
}) {
  return (
    <div style={{ padding: "20px 22px" }}>
      <div style={{ padding: "14px 18px", background: "var(--navy-tint-soft)", borderRadius: 12, marginBottom: 18, border: "1px solid var(--navy-tint)" }}>
        <span className="tiny" style={{ color: "var(--accent)", fontWeight: 600, letterSpacing: "0.14em", textTransform: "uppercase" }}>カテゴリー</span>
        <div className="serif" style={{ fontSize: 20, fontWeight: 600, color: "var(--navy-deep)", letterSpacing: "0.04em", marginTop: 2 }}>{cat.label}</div>
        {cat.sub ? <div className="small soft" style={{ marginTop: 2 }}>{cat.sub}</div> : null}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
        {cat.subs.map((s) => (
          <SubcategoryCard key={s.id} catId={cat.id} sub={s} fileCount={filesInFolder(cat.id, s.id)} onClick={() => onPick(s)} onRename={(v) => onRename(s.id, v)} onDelete={() => onDelete(s.id)} drag={drag} />
        ))}
        <AddSubCard onAdd={onAdd} />
      </div>
    </div>
  );
}

function SubcategoryCard({ catId, sub, fileCount, onClick, onRename, onDelete, drag }: {
  catId: string; sub: LibrarySub; fileCount: number; onClick: () => void;
  onRename: (v: string) => void; onDelete: () => void; drag: DragCtx;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(sub.label);
  const [hover, setHover] = useState(false);

  const isDropTarget = drag.dropTarget?.cat === catId && drag.dropTarget?.sub === sub.id;
  function handleOver(e: React.DragEvent) { e.preventDefault(); drag.setDropTarget({ cat: catId, sub: sub.id }); }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault(); drag.setDropTarget(null);
    if (e.dataTransfer.files?.length) drag.onExternalDrop(e.dataTransfer.files, catId, sub.id);
    else if (drag.draggedId) drag.moveFile(drag.draggedId, catId, sub.id);
  }
  function commit() { const v = draft.trim(); if (v && v !== sub.label) onRename(v); setRenaming(false); }

  return (
    <div onClick={() => !renaming && onClick()} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      onDragOver={handleOver} onDragLeave={() => drag.setDropTarget(null)} onDrop={handleDrop}
      style={{
        background: isDropTarget ? "var(--navy-tint)" : hover ? "var(--navy-tint-soft)" : "var(--panel)",
        border: `1px solid ${isDropTarget ? "var(--navy)" : hover ? "var(--navy-soft)" : "var(--line)"}`,
        outline: isDropTarget ? "2px solid var(--navy)" : "none", outlineOffset: -2,
        borderRadius: 10, padding: "14px 16px", cursor: renaming ? "default" : "pointer",
        display: "flex", alignItems: "center", gap: 12, position: "relative", transition: "all .12s ease"
      }}>
      <div onClick={(e) => e.stopPropagation()} style={{ position: "absolute", top: 6, right: 6, display: "flex", gap: 2, opacity: hover && !drag.draggedId ? 1 : 0, transition: "opacity .15s ease", background: "var(--panel)", borderRadius: 6, padding: 2, border: "1px solid var(--line)" }}>
        <SmallIconButton title="名前を変更" onClick={() => { setDraft(sub.label); setRenaming(true); }}><Edit size={11} /></SmallIconButton>
        <SmallIconButton title="削除" onClick={onDelete} danger><Trash2 size={11} /></SmallIconButton>
      </div>
      <FolderGlyph open={hover || isDropTarget} />
      <div className="stack" style={{ flex: 1, minWidth: 0, gap: 2 }}>
        {renaming ? (
          <input autoFocus className="input" value={draft} onChange={(e) => setDraft(e.target.value)}
            onBlur={commit} onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setRenaming(false); }}
            style={{ height: 32, padding: "0 8px", fontSize: 14 }} />
        ) : (
          <span className="serif truncate" style={{ fontSize: 14.5, fontWeight: 600, color: "var(--ink)", letterSpacing: "0.02em" }}>{sub.label}</span>
        )}
        <span className="tiny soft" style={{ letterSpacing: "0.04em" }}>{fileCount} 件</span>
      </div>
    </div>
  );
}

function AddSubCard({ onAdd }: { onAdd: (label: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  function commit() { if (draft.trim()) onAdd(draft); setDraft(""); setAdding(false); }

  if (adding) {
    return (
      <div style={{ background: "var(--panel)", border: "1.5px dashed var(--navy-soft)", borderRadius: 10, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
        <input autoFocus className="input" placeholder="フォルダー名" value={draft} onChange={(e) => setDraft(e.target.value)}
          onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(""); setAdding(false); } }}
          style={{ height: 32, padding: "0 8px" }} />
        <div className="row" style={{ gap: 6 }}>
          <Button size="sm" onClick={commit}>追加</Button>
          <Button variant="ghost" size="sm" onClick={() => { setDraft(""); setAdding(false); }}>キャンセル</Button>
        </div>
      </div>
    );
  }
  return (
    <button type="button" onClick={() => setAdding(true)}
      style={{ background: "transparent", border: "1.5px dashed var(--line)", borderRadius: 10, padding: "14px 16px", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, color: "var(--ink-muted)", transition: "all .15s ease" }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--navy-soft)"; e.currentTarget.style.color = "var(--navy-deep)"; e.currentTarget.style.background = "var(--navy-tint-soft)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--line)"; e.currentTarget.style.color = "var(--ink-muted)"; e.currentTarget.style.background = "transparent"; }}>
      <Plus size={14} />
      <span className="serif" style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.04em" }}>フォルダーを追加</span>
    </button>
  );
}

// ── File grid (subfolder) ───────────────────────────────────────
type FileGridCommonProps = {
  onOpenSummary: (f: RepositoryFile) => void;
  onDetail: (f: RepositoryFile) => void;
  onDelete: (f: RepositoryFile) => void;
  onProcessImages: (f: RepositoryFile) => void;
  onOpenImages: (f: RepositoryFile) => void;
  summaryProcessingId: string | null;
  blockedSummaryId: string | null;
  deletingId: string | null;
  drag: DragCtx;
};

function FileGrid({ cat, sub, files, ...props }: FileGridCommonProps & { cat: LibraryCategory; sub: LibrarySub; files: RepositoryFile[] }) {
  const [over, setOver] = useState(false);

  function handleOver(e: React.DragEvent) {
    const types = e.dataTransfer.types;
    if (Array.from(types).includes("Files")) { e.preventDefault(); setOver(true); }
  }
  function handleDrop(e: React.DragEvent) {
    if (e.dataTransfer.files?.length) {
      e.preventDefault(); setOver(false);
      props.drag.onExternalDrop(e.dataTransfer.files, cat.id, sub.id);
    }
  }

  return (
    <div style={{ padding: 20, minHeight: "100%" }} onDragOver={handleOver} onDragLeave={() => setOver(false)} onDrop={handleDrop}>
      {files.length === 0 ? (
        <div style={{ padding: "80px 24px", textAlign: "center", border: `1.5px dashed ${over ? "var(--navy)" : "var(--line)"}`, background: over ? "var(--navy-tint-soft)" : "transparent", borderRadius: 12, transition: "all .12s ease" }}>
          <div className="serif" style={{ fontSize: 18, color: "var(--ink-soft)", marginBottom: 8 }}>
            {over ? "ここにドロップして追加" : "このフォルダーにはまだ資料がありません"}
          </div>
          <div className="small soft">PCからファイルを直接ドロップ、または他のフォルダーからドラッグで移動できます。</div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14, outline: over ? "2px dashed var(--navy)" : "none", outlineOffset: 6, borderRadius: 8, padding: over ? 4 : 0 }}>
          {files.map((f) => (
            <DraggableFileCard key={f.id} file={f} {...props} />
          ))}
        </div>
      )}
    </div>
  );
}

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
          {hits.map((f) => <DraggableFileCard key={f.id} file={f} {...props} />)}
        </div>
      )}
    </div>
  );
}

function FileCard({ file, processing, blocked, deleting, onOpenSummary, onDetail, onDelete, onProcessImages, onOpenImages }: FileGridCommonProps & { file: RepositoryFile; processing?: boolean; blocked?: boolean; deleting?: boolean }) {
  const needsOcr = file.textExtractionStatus === "ocr_required";
  const canSummary = file.preparationStatus === "completed";
  const summaryInProgress = file.summaryStatus === "processing" || processing;
  const imageProcessing = file.imageProcessingStatus === "processing";
  const imageFailed = file.imageProcessingStatus === "failed";
  const canProcessImages = file.contentType.includes("pdf") && file.preparationStatus === "completed";

  return (
    <article style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 12, position: "relative", transition: "border-color .15s ease, transform .15s ease, box-shadow .15s ease" }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--navy-soft)"; e.currentTarget.style.boxShadow = "var(--shadow-md)"; e.currentTarget.style.transform = "translateY(-1px)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--line)"; e.currentTarget.style.boxShadow = "none"; e.currentTarget.style.transform = "translateY(0)"; }}>
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
          {file.tags.map((t) => <span className="tag" key={t}>{t}</span>)}
        </div>
      ) : null}
      <div className="row" style={{ gap: 4, fontSize: 11, color: "var(--ink-muted)", flexWrap: "wrap" }}>
        {file.preparationStatus === "completed" ? (
          <span className="row" style={{ gap: 5 }}><span className="dot ok" />AI参照可</span>
        ) : file.preparationStatus === "processing" || file.preparationStatus === "syncing" ? (
          <span className="row" style={{ gap: 5 }}><RefreshCw size={11} aria-hidden="true" />準備中</span>
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
        <Button variant={file.summaryStatus === "completed" ? "secondary" : canSummary ? "primary" : "secondary"} size="sm" style={{ flex: 1, opacity: canSummary || file.summaryStatus === "completed" ? 1 : 0.58 }} disabled={!!summaryInProgress} onClick={() => onOpenSummary(file)}>
          {summaryInProgress ? "要約作成中" : file.summaryStatus === "completed" ? "要約を見る" : "要約をつくる"}
        </Button>
        {file.imageCount > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => onOpenImages(file)} title={`${file.imageCount}枚の画像`}>
            <Images size={13} aria-hidden="true" />{file.imageCount}枚
          </Button>
        ) : null}
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

function DraggableFileCard({ file, summaryProcessingId, blockedSummaryId, deletingId,  onOpenSummary, onDetail, onDelete, onProcessImages, onOpenImages, drag }: FileGridCommonProps & { file: RepositoryFile }) {
  return (
    <div draggable onDragStart={(e) => { drag.setDraggedId(file.id); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", file.id); }}
      onDragEnd={() => { drag.setDraggedId(null); drag.setDropTarget(null); }}
      style={{ opacity: drag.draggedId === file.id ? 0.4 : 1, cursor: "grab", transition: "opacity .12s ease" }}>
      <FileCard
        file={file} drag={drag}
        processing={summaryProcessingId === file.id}
        blocked={blockedSummaryId === file.id}
        deleting={deletingId === file.id}
        onOpenSummary={onOpenSummary} onDetail={onDetail} onDelete={onDelete}
        onProcessImages={onProcessImages} onOpenImages={onOpenImages}
        summaryProcessingId={summaryProcessingId} blockedSummaryId={blockedSummaryId} deletingId={deletingId}
      />
    </div>
  );
}

// ── Small helpers ───────────────────────────────────────────────
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
      onMouseEnter={(e) => { e.currentTarget.style.background = danger ? "#f3e3df" : "var(--navy-tint-soft)"; e.currentTarget.style.color = danger ? "#7a2d22" : "var(--navy-deep)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = danger ? "#8a3a2d" : "var(--ink-soft)"; }}>
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

function CrumbSep() {
  return <ChevronRight size={12} style={{ color: "var(--ink-faint)" }} />;
}

function InlineEdit({ value, placeholder, onSave, className, isPlaceholder }: {
  value: string; placeholder?: string; onSave: (v: string) => void; className?: string; isPlaceholder?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  function commit() { const v = draft.trim(); if (v && v !== value) onSave(v); setEditing(false); }

  if (editing) {
    return (
      <input autoFocus className="input" value={draft} onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } if (e.key === "Escape") { setDraft(value); setEditing(false); } }}
        style={{ height: 32, padding: "0 8px", fontSize: 14 }} />
    );
  }
  return (
    <span className={className} onClick={() => setEditing(true)}
      style={{ cursor: "text", borderRadius: 4, padding: "1px 4px", margin: "0 -4px", color: isPlaceholder ? "var(--ink-faint)" : undefined, fontStyle: isPlaceholder ? "italic" : undefined }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--navy-tint-soft)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
      {value || placeholder}
    </span>
  );
}

// ── FilePreview (unchanged) ─────────────────────────────────────
function FilePreview({ file }: { file: RepositoryFile }) {
  const [previewUrl, setPreviewUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const isPdf = file.contentType.includes("pdf") || file.name.toLowerCase().endsWith(".pdf");
  const isImage = file.contentType.startsWith("image/");
  const canPreview = isPdf || isImage;

  useEffect(() => {
    let ignore = false;
    async function load() {
      if (!canPreview) return;
      try {
        const res = await fetch(`/api/files/${file.id}/preview-url`, { cache: "no-store" });
        if (!res.ok) throw new Error("");
        const data = (await res.json()) as { url: string };
        if (!ignore) { setPreviewUrl(data.url); setFailed(false); }
      } catch { if (!ignore) setFailed(true); }
    }
    load();
    return () => { ignore = true; };
  }, [canPreview, file.id]);

  if (!canPreview || failed) {
    return <FileSpine name={file.name} ext={file.thumbnailLabel || file.name.split(".").pop() || "FILE"} version={file.version} />;
  }
  return (
    <div style={{ width: 92, height: 128, flexShrink: 0, overflow: "hidden", border: "1px solid var(--line)", borderRadius: 8, background: "#fff", boxShadow: "var(--shadow-sm)" }}>
      <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden", background: "var(--panel-deep)" }}>
        {previewUrl && isImage ? <img src={previewUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : null}
        {previewUrl && isPdf ? <iframe title={`${file.name} preview`} src={`${previewUrl}#page=1&toolbar=0&navpanes=0&scrollbar=0&view=FitH`} style={{ width: "178%", height: "178%", border: 0, transform: "scale(0.64)", transformOrigin: "top left", pointerEvents: "none" }} aria-hidden="true" /> : null}
        {!previewUrl ? <div className="stack" style={{ height: "100%", alignItems: "center", justifyContent: "center", gap: 6, color: "var(--ink-muted)" }}><span className="dot ok" style={{ animation: "pulse 1.2s infinite" }} /><span className="tiny soft">読み込み中</span></div> : null}
      </div>
    </div>
  );
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
      onClick={(e) => { if (e.target === e.currentTarget) { setSelected(null); onClose(); } }}>
      <div style={{ width: "min(860px, 95vw)", background: "#fff", display: "flex", flexDirection: "column", boxShadow: "-4px 0 24px rgba(0,0,0,.18)" }}>
        {/* ヘッダー */}
        <div className="panel-head" style={{ flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--navy-deep)" }}>{gallery.file.name.replace(/\.[^.]+$/, "")}</div>
            <div className="tiny soft" style={{ marginTop: 2 }}>{gallery.images.length}枚の画像</div>
          </div>
          <button type="button" onClick={onClose} style={{ border: "none", background: "transparent", cursor: "pointer", color: "var(--ink-soft)", padding: 4 }}><X size={18} /></button>
        </div>

        <div style={{ flex: 1, overflow: "hidden", display: "flex", minHeight: 0 }}>
          {/* サムネイルグリッド */}
          <div style={{ width: 200, flexShrink: 0, overflowY: "auto", borderRight: "1px solid var(--line)", padding: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            {gallery.images.map((img, i) => (
              <button key={i} type="button" onClick={() => setSelected(i)}
                style={{ border: `2px solid ${selected === i ? "var(--navy)" : "var(--line)"}`, borderRadius: 8, padding: 0, background: "none", cursor: "pointer", overflow: "hidden", textAlign: "left" }}>
                <img src={img.url} alt={`画像${img.index + 1}`} style={{ width: "100%", height: 100, objectFit: "cover", display: "block" }} />
                <div style={{ padding: "4px 6px", fontSize: 10, color: "var(--ink-muted)" }}>p.{img.page} 画像{img.index + 1}</div>
              </button>
            ))}
          </div>

          {/* メインビュー */}
          <div style={{ flex: 1, overflowY: "auto", padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
            {selectedImage ? (
              <>
                <img src={selectedImage.url} alt={`画像${selectedImage.index + 1}`} style={{ maxWidth: "100%", height: "auto", borderRadius: 8, border: "1px solid var(--line)", display: "block" }} />
                <div>
                  <div className="tiny" style={{ color: "var(--ink-muted)", marginBottom: 6, letterSpacing: "0.08em" }}>
                    {selectedImage.page}ページ目・画像{selectedImage.index + 1}
                  </div>
                  <p style={{ margin: 0, fontSize: 13, lineHeight: 1.8, color: "var(--ink)", background: "var(--panel-deep)", borderRadius: 8, padding: "12px 14px" }}>
                    {selectedImage.description}
                  </p>
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

// ── Overlays ────────────────────────────────────────────────────
function DetailOverlay({ file, draft, saving, library, onDraft, onSave, onOpenSource, onClose }: {
  file: RepositoryFile; draft: DetailDraft; saving: boolean;
  library: LibraryCategory[];
  onDraft: React.Dispatch<React.SetStateAction<DetailDraft | null>>;
  onSave: () => void; onOpenSource: () => void; onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [onClose]);

  // 画像ギャラリー
  const [detailImages, setDetailImages] = useState<{ index: number; page: number; description: string; url: string }[]>([]);
  const [selectedImgIndex, setSelectedImgIndex] = useState<number | null>(null);

  useEffect(() => {
    if (file.imageCount === 0) return;
    fetch(`/api/files/${file.id}/images`)
      .then(r => r.json())
      .then((d: { images?: { index: number; page: number; description: string; url: string }[] }) => {
        setDetailImages(d.images ?? []);
      })
      .catch(() => {});
  }, [file.id, file.imageCount]);

  const selectedCat = library.find((c) => c.id === draft.catId);

  function handleCatChange(catId: string) {
    const cat = library.find((c) => c.id === catId);
    onDraft((cur) => cur ? { ...cur, catId, subId: cat?.subs[0]?.id ?? "" } : cur);
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 920, background: "var(--panel)", borderRadius: 16, overflow: "hidden", boxShadow: "var(--shadow-lg)", animation: "slide-up .25s ease", maxHeight: "calc(100vh - 64px)", display: "flex", flexDirection: "column" }}>
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
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <FolderSelect
              value={draft.catId}
              onChange={handleCatChange}
              options={library.map((c) => ({ id: c.id, label: c.label }))}
              placeholder="カテゴリーを選択"
            />
            <FolderSelect
              value={draft.subId}
              onChange={(subId) => onDraft((cur) => cur ? { ...cur, subId } : cur)}
              options={(selectedCat?.subs || []).map((s) => ({ id: s.id, label: s.label }))}
              placeholder="フォルダーを選択"
              disabled={!selectedCat || (selectedCat.subs || []).length === 0}
            />
          </div>
          <div style={{ marginTop: 16 }}>
            <FieldLabel>メモ</FieldLabel>
            <textarea className="textarea" value={draft.memo} placeholder="資料の補足、運用メモなど" style={{ minHeight: 110 }} onChange={(e) => onDraft((cur) => cur ? { ...cur, memo: e.target.value } : cur)} />
          </div>
          <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
            <MetaRow label="AI参照" value={file.preparationStatus === "completed" ? "可" : file.preparationStatus || "未開始"} />
            <MetaRow label="要約" value={file.summaryStatus === "completed" ? "作成済み" : file.summaryStatus || "未作成"} />
            <MetaRow label="OCR" value={file.textExtractionStatus || "未開始"} />
            {file.contentType.includes("pdf") ? (
              <MetaRow
                label="画像処理"
                value={
                  file.imageProcessingStatus === "completed" ? `完了 ${file.imageCount}枚` :
                  file.imageProcessingStatus === "processing" ? "処理中…" :
                  file.imageProcessingStatus === "failed" ? "失敗" :
                  "未処理"
                }
              />
            ) : null}
          </div>

          {/* 画像ギャラリー */}
          {detailImages.length > 0 ? (
            <div style={{ marginTop: 20, borderTop: "1px solid var(--line-soft)", paddingTop: 16 }}>
              <div className="tiny" style={{ letterSpacing: "0.14em", color: "var(--ink-muted)", fontWeight: 600, textTransform: "uppercase", marginBottom: 10 }}>
                資料内の画像（{detailImages.length}枚）
              </div>
              {/* サムネイルグリッド */}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {detailImages.map((img, i) => (
                  <button
                    key={i} type="button"
                    onClick={() => setSelectedImgIndex(selectedImgIndex === i ? null : i)}
                    style={{
                      border: `2px solid ${selectedImgIndex === i ? "var(--navy)" : "var(--line)"}`,
                      borderRadius: 8, padding: 0, background: "none", cursor: "pointer",
                      overflow: "hidden", flexShrink: 0,
                    }}
                  >
                    <img src={img.url} alt={`p.${img.page}`}
                      style={{ width: 80, height: 64, objectFit: "cover", display: "block" }} />
                    <div style={{ fontSize: 9, color: "var(--ink-muted)", padding: "2px 4px", textAlign: "center" }}>
                      p.{img.page}
                    </div>
                  </button>
                ))}
              </div>
              {/* 選択した画像の拡大表示 */}
              {selectedImgIndex !== null && detailImages[selectedImgIndex] ? (
                <div style={{ marginTop: 12, border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden" }}>
                  <img
                    src={detailImages[selectedImgIndex].url}
                    alt={detailImages[selectedImgIndex].description}
                    style={{ width: "100%", maxHeight: 360, objectFit: "contain", display: "block", background: "#f8f9fa" }}
                  />
                  <div style={{ padding: "10px 14px", background: "var(--panel-deep)", borderTop: "1px solid var(--line-soft)" }}>
                    <div className="tiny soft" style={{ marginBottom: 4 }}>
                      {detailImages[selectedImgIndex].page}ページ目
                    </div>
                    <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.7 }}>
                      {detailImages[selectedImgIndex].description}
                    </p>
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
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(1180px, calc(100vw - 40px))", height: "calc(100vh - 56px)", background: "var(--panel)", borderRadius: 16, overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "var(--shadow-lg)", animation: "slide-up .25s ease" }}>
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
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 1080, background: "var(--panel)", borderRadius: 16, overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "var(--shadow-lg)", animation: "slide-up .25s ease", maxHeight: "calc(100vh - 64px)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 20, alignItems: "center", padding: "20px 28px", borderBottom: "1px solid var(--line)", background: "var(--panel-deep)" }}>
          <FileSpine name={file.name} ext={file.thumbnailLabel || "FILE"} version={file.version} size="sm" />
          <div className="stack" style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 8 }}>
              <span className="tiny" style={{ letterSpacing: "0.18em", color: "var(--accent)", fontWeight: 600, textTransform: "uppercase" }}>要約</span>
              <span className="dot" style={{ background: "var(--ink-faint)" }} />
              <span className="tiny soft">{file.summaryUpdatedAt ? `最終更新 ${formatDisplayDate(file.summaryUpdatedAt)}` : "最終更新 —"}</span>
            </div>
            <h2 className="serif truncate" style={{ margin: "4px 0 2px", fontSize: 20, fontWeight: 600, color: "var(--navy-deep)", letterSpacing: "0.04em" }}>{file.name.replace(/\.[^.]+$/, "")}</h2>
            {file.tags.length > 0 ? <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>{file.tags.map((t) => <span className="tag" key={t}>{t}</span>)}</div> : null}
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
            {editing ? <textarea value={draft} onChange={(e) => onDraft(e.target.value)} className="textarea" style={{ minHeight: "60vh", fontSize: 14, lineHeight: 1.85, fontFamily: "inherit" }} /> : <div className="prose"><ReactMarkdown remarkPlugins={[remarkGfm]}>{draft}</ReactMarkdown></div>}
          </div>
        </div>
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", gap: 10, padding: "6px 0", borderBottom: "1px solid var(--line-soft)" }}>
      <dt className="tiny" style={{ color: "var(--ink-muted)", letterSpacing: "0.1em", paddingTop: 2 }}>{label}</dt>
      <dd style={{ margin: 0, color: "var(--ink)", fontSize: 12.5, lineHeight: 1.55 }}>{value || "—"}</dd>
    </div>
  );
}

// ── Conversion helpers ──────────────────────────────────────────
function toRepositoryFile(m: StoredFileMetadata): RepositoryFile {
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
