"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Clipboard, Edit, Plus, RefreshCw, Search, Trash2, Upload, X } from "lucide-react";
import { Button, FileSpine, FieldLabel } from "@/components/ui";
import { SelectableChip } from "@/components/selectable-chip";
import { useMasterSettings } from "@/hooks/use-master-settings";
import { type MasterGroupKey } from "@/lib/master-settings";
import { formatFileSize, getThumbnailLabel, type ManualMetadata } from "@/lib/manuals";

type ManualFile = {
  id: string;
  name: string;
  contentType: string;
  date: string;
  sizeLabel: string;
  thumbnailLabel: string;
  categoryIds: string[];
  categories: string[];
  clinicalAreaIds: string[];
  areas: string[];
  roleIds: string[];
  roles: string[];
  tags: string[];
  version: string;
  memo: string;
  summary: string;
  summaryStatus: ManualMetadata["summaryStatus"];
  summaryUpdatedAt: string;
  preparationStatus: ManualMetadata["preparationStatus"];
  textExtractionStatus: ManualMetadata["textExtractionStatus"];
};

type SelectionState = Record<MasterGroupKey, string[]>;
type DetailDraft = SelectionState & {
  tags: string;
  version: string;
  memo: string;
};

const initialSelection: SelectionState = {
  categories: ["treatment-manual"],
  clinicalAreas: ["periodontal", "common"],
  roles: ["hygienist"]
};

export function ManualsManager() {
  const { settings } = useMasterSettings();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [files, setFiles] = useState<ManualFile[]>([]);
  const [selection, setSelection] = useState<SelectionState>(initialSelection);
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [tags, setTags] = useState("");
  const [version, setVersion] = useState("");
  const [memo, setMemo] = useState("");
  const [notice, setNotice] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [isLoadingFiles, setIsLoadingFiles] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [selectedDetail, setSelectedDetail] = useState<ManualFile | null>(null);
  const [detailDraft, setDetailDraft] = useState<DetailDraft | null>(null);
  const [detailSaving, setDetailSaving] = useState(false);
  const [sourceViewerFile, setSourceViewerFile] = useState<ManualFile | null>(null);
  const [selectedSummary, setSelectedSummary] = useState<ManualFile | null>(null);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [summaryEditing, setSummaryEditing] = useState(false);
  const [summaryProcessingId, setSummaryProcessingId] = useState<string | null>(null);
  const [blockedSummaryId, setBlockedSummaryId] = useState<string | null>(null);
  const [summaryCopied, setSummaryCopied] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");

  const activeSettings = useMemo(
    () => ({
      categories: settings.categories.filter((item) => item.active),
      clinicalAreas: settings.clinicalAreas.filter((item) => item.active),
      roles: settings.roles.filter((item) => item.active)
    }),
    [settings]
  );

  const filteredFiles = useMemo(
    () =>
      files
        .filter((file) => (query ? file.name.toLowerCase().includes(query.toLowerCase()) : true))
        .filter((file) => {
          if (filter === "needs-summary") {
            return file.summaryStatus !== "completed";
          }
          if (filter === "needs-ocr") {
            return file.preparationStatus !== "completed";
          }
          return true;
        }),
    [files, filter, query]
  );

  async function loadFiles(options: { showLoading?: boolean; updateNotice?: boolean } = {}) {
    if (options.showLoading) {
      setIsLoadingFiles(true);
    }
    try {
      const response = await fetch("/api/files", { cache: "no-store" });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || "S3一覧を読み込めませんでした。");
      }
      const data = (await response.json()) as { files: ManualMetadata[] };
      setFiles(data.files.map(metadataToManualFile));
    } catch (error) {
      if (options.updateNotice !== false) {
        const message = error instanceof Error ? error.message : "S3一覧を読み込めませんでした。";
        setNotice(`${message} SSO期限、IAMロール、S3設定を確認してください。`);
      }
    } finally {
      if (options.showLoading) {
        setIsLoadingFiles(false);
      }
    }
  }

  useEffect(() => {
    let ignore = false;

    async function initialLoad() {
      if (!ignore) {
        await loadFiles({ showLoading: true });
      }
    }

    initialLoad();

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    const hasPendingWork = files.some(
      (file) =>
        file.preparationStatus === "processing" ||
        file.preparationStatus === "syncing" ||
        file.summaryStatus === "processing"
    );
    if (!hasPendingWork) {
      return;
    }

    const timer = window.setInterval(() => {
      loadFiles({ updateNotice: false });
    }, 8000);

    return () => window.clearInterval(timer);
  }, [files]);

  function toggle(group: MasterGroupKey, id: string) {
    setSelection((current) => ({
      ...current,
      [group]: current[group].includes(id)
        ? current[group].filter((itemId) => itemId !== id)
        : [...current[group], id]
    }));
  }

  function getLabels(group: MasterGroupKey, ids: string[]) {
    return ids
      .map((id) => settings[group].find((item) => item.id === id)?.label)
      .filter((label): label is string => Boolean(label));
  }

  function addSelectedFiles(nextFiles: FileList | File[]) {
    const incoming = Array.from(nextFiles).filter((file) => file.size > 0);
    if (incoming.length === 0) {
      return;
    }
    setSelectedFiles((current) => {
      const currentKeys = new Set(current.map((file) => `${file.name}-${file.size}`));
      return [...current, ...incoming.filter((file) => !currentKeys.has(`${file.name}-${file.size}`))];
    });
    setNotice("");
  }

  async function registerFiles() {
    if (selectedFiles.length === 0) {
      setNotice("ファイルを選択してください。");
      return;
    }

    const categories = getLabels("categories", selection.categories);
    const areas = getLabels("clinicalAreas", selection.clinicalAreas);
    const roles = getLabels("roles", selection.roles);
    if (categories.length === 0 || areas.length === 0 || roles.length === 0) {
      setNotice("種類、診療領域、読む人をそれぞれ1つ以上選択してください。");
      return;
    }

    const tagList = tags.split(",").map((tag) => tag.trim()).filter(Boolean);
    setIsUploading(true);
    setNotice("S3へアップロードしています。");

    try {
      const uploaded: ManualFile[] = [];
      for (const file of selectedFiles) {
        const uploadUrlResponse = await fetch("/api/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: file.name, contentType: file.type || "application/octet-stream" })
        });
        if (!uploadUrlResponse.ok) {
          throw new Error("Failed to create upload URL");
        }
        const uploadData = (await uploadUrlResponse.json()) as { id: string; uploadUrl: string; s3Key: string };
        const putResponse = await fetch(uploadData.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file
        });
        if (!putResponse.ok) {
          throw new Error("Failed to upload file");
        }
        const metadataResponse = await fetch("/api/files", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: uploadData.id,
            fileName: file.name,
            s3Key: uploadData.s3Key,
            contentType: file.type || "application/octet-stream",
            size: file.size,
            sizeLabel: formatFileSize(file.size),
            thumbnailLabel: getThumbnailLabel(file.name),
            categoryIds: selection.categories,
            categories,
            clinicalAreaIds: selection.clinicalAreas,
            clinicalAreas: areas,
            roleIds: selection.roles,
            roles,
            tags: tagList,
            version: version.trim(),
            memo: memo.trim(),
            uploadedAt: new Date().toISOString()
          })
        });
        if (!metadataResponse.ok) {
          throw new Error("Failed to save metadata");
        }
        const metadataData = (await metadataResponse.json()) as { file: ManualMetadata };
        uploaded.push(metadataToManualFile(metadataData.file));
      }
      setFiles((current) => [...uploaded, ...current]);
      setSelectedFiles([]);
      setTags("");
      setVersion("");
      setMemo("");
      setNotice(`${uploaded.length}件を本棚に入れました。`);
    } catch {
      setNotice("アップロードに失敗しました。SSO期限やS3設定を確認してください。");
    } finally {
      setIsUploading(false);
    }
  }

  async function deleteFile(file: ManualFile) {
    if (!window.confirm(`${file.name} を削除します。よろしいですか？`)) {
      return;
    }
    setDeletingId(file.id);
    setNotice("S3から削除しています。");
    try {
      const response = await fetch(`/api/files/${file.id}`, { method: "DELETE" });
      if (!response.ok) {
        throw new Error("Failed to delete file");
      }
      setFiles((current) => current.filter((item) => item.id !== file.id));
      setNotice(`${file.name} を削除しました。`);
    } catch {
      setNotice("削除に失敗しました。SSO期限やS3設定を確認してください。");
    } finally {
      setDeletingId(null);
    }
  }

  async function openOrCreateSummary(file: ManualFile) {
    if (file.preparationStatus !== "completed") {
      setBlockedSummaryId(file.id);
      setNotice("");
      window.setTimeout(() => setBlockedSummaryId((current) => (current === file.id ? null : current)), 3600);
      return;
    }

    setSummaryProcessingId(file.id);
    setNotice("");
    try {
      const method = file.summaryStatus === "completed" ? "GET" : "POST";
      const response = await fetch(`/api/files/${file.id}/summary`, { method, cache: "no-store" });
      const data = (await response.json()) as { summary?: string; file?: ManualMetadata; error?: string };
      if (!response.ok) {
        throw new Error(data.error || "要約の取得または作成に失敗しました。");
      }
      const nextFile = metadataToManualFile(data.file as ManualMetadata);
      setFiles((current) => current.map((item) => (item.id === nextFile.id ? nextFile : item)));
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

  async function saveSummary() {
    if (!selectedSummary) {
      return;
    }
    setSummaryProcessingId(selectedSummary.id);
    try {
      const response = await fetch(`/api/files/${selectedSummary.id}/summary`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: summaryDraft })
      });
      const data = (await response.json()) as { summary?: string; file?: ManualMetadata; error?: string };
      if (!response.ok) {
        throw new Error(data.error || "要約の保存に失敗しました。");
      }
      const nextFile = metadataToManualFile(data.file as ManualMetadata);
      setFiles((current) => current.map((item) => (item.id === nextFile.id ? nextFile : item)));
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
    if (!summaryDraft) {
      return;
    }
    try {
      await navigator.clipboard.writeText(summaryDraft);
      setSummaryCopied(true);
      window.setTimeout(() => setSummaryCopied(false), 1600);
    } catch {
      setNotice("コピーに失敗しました。ブラウザのクリップボード権限を確認してください。");
    }
  }

  async function startSync() {
    setSyncing(true);
    setSyncStatus("AI同期を開始しています。");
    try {
      const response = await fetch("/api/sync", { method: "POST" });
      if (!response.ok) {
        throw new Error("Failed to start sync");
      }
      const data = (await response.json()) as { job?: { ingestionJobId?: string } };
      setSyncStatus(`同期ジョブを開始しました。${data.job?.ingestionJobId || ""}`.trim());
    } catch {
      setSyncStatus("AI同期の開始に失敗しました。Bedrock設定やSSO期限を確認してください。");
    } finally {
      setSyncing(false);
    }
  }

  function openDetail(file: ManualFile) {
    setSelectedDetail(file);
    setDetailDraft({
      categories: file.categoryIds,
      clinicalAreas: file.clinicalAreaIds,
      roles: file.roleIds,
      tags: file.tags.join(", "),
      version: file.version,
      memo: file.memo
    });
  }

  function toggleDetail(group: MasterGroupKey, id: string) {
    setDetailDraft((current) => {
      if (!current) {
        return current;
      }
      const selectedIds = current[group];
      return {
        ...current,
        [group]: selectedIds.includes(id)
          ? selectedIds.filter((itemId) => itemId !== id)
          : [...selectedIds, id]
      };
    });
  }

  async function saveDetail() {
    if (!selectedDetail || !detailDraft) {
      return;
    }

    const categories = getLabels("categories", detailDraft.categories);
    const areas = getLabels("clinicalAreas", detailDraft.clinicalAreas);
    const roles = getLabels("roles", detailDraft.roles);
    if (categories.length === 0 || areas.length === 0 || roles.length === 0) {
      setNotice("種類、診療領域、読む人をそれぞれ1つ以上選択してください。");
      return;
    }

    setDetailSaving(true);
    try {
      const response = await fetch(`/api/files/${selectedDetail.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          categoryIds: detailDraft.categories,
          categories,
          clinicalAreaIds: detailDraft.clinicalAreas,
          clinicalAreas: areas,
          roleIds: detailDraft.roles,
          roles,
          tags: detailDraft.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
          version: detailDraft.version.trim(),
          memo: detailDraft.memo.trim()
        })
      });
      const data = (await response.json()) as { file?: ManualMetadata; error?: string };
      if (!response.ok || !data.file) {
        throw new Error(data.error || "詳細を保存できませんでした。");
      }
      const nextFile = metadataToManualFile(data.file);
      setFiles((current) => current.map((file) => (file.id === nextFile.id ? nextFile : file)));
      setSelectedDetail(nextFile);
      setNotice("詳細を保存しました。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "詳細を保存できませんでした。");
    } finally {
      setDetailSaving(false);
    }
  }

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "440px minmax(0,1fr)", gap: 24, alignItems: "stretch", minHeight: 560 }}>
        <section className="panel" style={{ display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
          <div className="panel-head" style={{ flexShrink: 0 }}>
            <span className="panel-title">資料を追加する</span>
            <span className="panel-sub">PDF・Word・テキスト</span>
          </div>
          <div className="panel-pad" style={{ paddingTop: 18, overflowY: "auto", flex: 1, minHeight: 0 }}>
            <div
              onDragEnter={(event) => { event.preventDefault(); setIsDragging(true); }}
              onDragOver={(event) => { event.preventDefault(); setIsDragging(true); }}
              onDragLeave={(event) => { event.preventDefault(); setIsDragging(false); }}
              onDrop={(event) => {
                event.preventDefault();
                setIsDragging(false);
                addSelectedFiles(event.dataTransfer.files);
              }}
              style={{ border: `1.5px dashed ${isDragging ? "var(--navy)" : "#cbc7b8"}`, background: isDragging ? "var(--navy-tint-soft)" : "var(--panel-deep)", borderRadius: 12, padding: "28px 18px", textAlign: "center", transition: "all .15s ease" }}
            >
              <div style={{ color: "var(--navy)", display: "inline-flex" }}><Upload size={28} aria-hidden="true" /></div>
              <div className="serif" style={{ fontSize: 16, marginTop: 10, color: "var(--navy-deep)", fontWeight: 600, letterSpacing: "0.04em" }}>ここにファイルを置く</div>
              <div className="small soft" style={{ marginTop: 4 }}>または下のボタンで選択</div>
              <input ref={fileInputRef} type="file" multiple style={{ display: "none" }} accept=".pdf,.doc,.docx,.txt,.md" onChange={(event) => {
                if (event.target.files) {
                  addSelectedFiles(event.target.files);
                }
                event.currentTarget.value = "";
              }} />
              <Button variant="secondary" size="sm" style={{ marginTop: 14 }} onClick={() => fileInputRef.current?.click()}>
                <Plus size={13} aria-hidden="true" />
                ファイルを選択
              </Button>
            </div>

            {selectedFiles.length > 0 ? (
              <div style={{ marginTop: 14, border: "1px solid var(--line)", borderRadius: 10, overflow: "hidden" }}>
                <div className="tiny" style={{ padding: "8px 12px", background: "var(--panel-deep)", color: "var(--ink-soft)", letterSpacing: "0.12em", fontWeight: 600 }}>追加する予定の資料</div>
                <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {selectedFiles.map((file, index) => (
                    <li key={`${file.name}-${file.size}`} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderTop: "1px solid var(--line-soft)" }}>
                      <span style={{ width: 26, height: 26, borderRadius: 4, background: "var(--navy-tint)", color: "var(--navy-deep)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontFamily: "ui-monospace,monospace", letterSpacing: "0.06em", fontWeight: 600 }}>{(file.name.split(".").pop() || "FILE").toUpperCase().slice(0, 4)}</span>
                      <div className="stack" style={{ flex: 1, minWidth: 0 }}>
                        <span className="truncate" style={{ fontSize: 12.5, fontWeight: 500 }}>{file.name}</span>
                        <span className="tiny soft">{formatFileSize(file.size)}</span>
                      </div>
                      <button type="button" className="btn ghost sm icon" onClick={() => setSelectedFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))} title="選択から外す">
                        <X size={13} aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="divider" />
            <SelectorGroup title="種類" items={activeSettings.categories} selectedIds={selection.categories} onToggle={(id) => toggle("categories", id)} />
            <div style={{ height: 18 }} />
            <SelectorGroup title="診療領域" items={activeSettings.clinicalAreas} selectedIds={selection.clinicalAreas} onToggle={(id) => toggle("clinicalAreas", id)} />
            <div style={{ height: 18 }} />
            <SelectorGroup title="読む人" items={activeSettings.roles} selectedIds={selection.roles} onToggle={(id) => toggle("roles", id)} />

            <div style={{ height: 20 }} />
            <FieldLabel>タグ（任意）</FieldLabel>
            <input className="input" placeholder="カンマで区切って入力" value={tags} onChange={(event) => setTags(event.target.value)} />
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 14 }}>
              <div>
                <FieldLabel>版数</FieldLabel>
                <input className="input" placeholder="v1.0" value={version} onChange={(event) => setVersion(event.target.value)} />
              </div>
              <div>
                <FieldLabel>メモ</FieldLabel>
                <input className="input" placeholder="任意" value={memo} onChange={(event) => setMemo(event.target.value)} />
              </div>
            </div>
            {notice ? <p className="tag accent" style={{ marginTop: 14 }}>{notice}</p> : null}
            <Button style={{ width: "100%", marginTop: 20, height: 44 }} onClick={registerFiles} disabled={isUploading}>
              <Upload size={15} aria-hidden="true" />
              {selectedFiles.length > 0 ? `${selectedFiles.length}件を本棚に入れる` : "本棚に入れる"}
            </Button>
            <div className="tiny soft" style={{ textAlign: "center", marginTop: 8, letterSpacing: "0.06em" }}>追加後、AIが自動で内容を読み取ります</div>
          </div>
        </section>

        <section className="panel" style={{ overflow: "hidden", display: "flex", flexDirection: "column", minHeight: 0 }}>
          <div className="panel-head" style={{ flexWrap: "wrap", flexShrink: 0 }}>
            <div className="stack">
              <span className="panel-title">本棚</span>
              <span className="panel-sub">{isLoadingFiles ? "S3から一覧を読み込み中です。" : "追加した順に並んでいます"}</span>
              {syncStatus ? <span className="panel-sub" style={{ color: "var(--navy-deep)" }}>{syncStatus}</span> : null}
            </div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <div className="row" style={{ gap: 4, background: "var(--panel-deep)", padding: 3, borderRadius: 8, border: "1px solid var(--line)" }}>
                {[
                  { id: "all", label: "すべて" },
                  { id: "needs-summary", label: "要約待ち" },
                  { id: "needs-ocr", label: "文字読み取り要" }
                ].map((item) => (
                  <button key={item.id} type="button" onClick={() => setFilter(item.id)} style={{ border: 0, padding: "6px 12px", borderRadius: 6, background: filter === item.id ? "#fff" : "transparent", color: filter === item.id ? "var(--navy-deep)" : "var(--ink-muted)", fontSize: 12, fontWeight: filter === item.id ? 600 : 500, letterSpacing: "0.04em", cursor: "pointer", boxShadow: filter === item.id ? "var(--shadow-sm)" : "none" }}>
                    {item.label}
                  </button>
                ))}
              </div>
              <div style={{ position: "relative" }}>
                <Search size={14} style={{ position: "absolute", left: 12, top: 12, color: "var(--ink-muted)" }} aria-hidden="true" />
                <input className="input" placeholder="ファイル名で探す" value={query} onChange={(event) => setQuery(event.target.value)} style={{ paddingLeft: 34, height: 38, width: 220 }} />
              </div>
              <Button variant="secondary" onClick={startSync} disabled={syncing}>
                <RefreshCw size={14} aria-hidden="true" />
                AIに覚えさせる
              </Button>
            </div>
          </div>

          {filteredFiles.length === 0 ? (
            <div style={{ padding: "60px 24px", textAlign: "center" }}>
              <div className="serif" style={{ fontSize: 22, color: "var(--ink-muted)", marginBottom: 8 }}>該当する資料はありません</div>
              <div className="small soft">検索条件を変えるか、左から資料を追加してください。</div>
            </div>
          ) : (
            <div style={{ padding: 24, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 18, overflowY: "auto", flex: 1, minHeight: 0 }}>
              {filteredFiles.map((file) => (
                <ManualCard
                  key={file.id}
                  file={file}
                  processing={summaryProcessingId === file.id}
                  blocked={blockedSummaryId === file.id}
                  deleting={deletingId === file.id}
                  onSummary={() => openOrCreateSummary(file)}
                  onDetail={() => openDetail(file)}
                  onDelete={() => deleteFile(file)}
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {selectedDetail && detailDraft ? (
        <DetailOverlay
          file={selectedDetail}
          draft={detailDraft}
          settings={activeSettings}
          saving={detailSaving}
          onToggle={toggleDetail}
          onDraft={setDetailDraft}
          onSave={saveDetail}
          onOpenSource={() => setSourceViewerFile(selectedDetail)}
          onClose={() => setSelectedDetail(null)}
        />
      ) : null}

      {sourceViewerFile ? (
        <SourceViewerOverlay file={sourceViewerFile} onClose={() => setSourceViewerFile(null)} />
      ) : null}

      {selectedSummary ? (
        <SummaryOverlay
          file={selectedSummary}
          draft={summaryDraft}
          editing={summaryEditing}
          copied={summaryCopied}
          processing={summaryProcessingId === selectedSummary.id}
          onDraft={setSummaryDraft}
          onEdit={() => setSummaryEditing(true)}
          onSave={saveSummary}
          onCopy={copySummary}
          onClose={() => setSelectedSummary(null)}
        />
      ) : null}
    </>
  );
}

function SelectorGroup({ title, items, selectedIds, onToggle }: { title: string; items: { id: string; label: string }[]; selectedIds: string[]; onToggle: (id: string) => void }) {
  return (
    <div>
      <FieldLabel>{title}</FieldLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {items.map((item) => (
          <SelectableChip key={item.id} label={item.label} selected={selectedIds.includes(item.id)} onToggle={() => onToggle(item.id)} />
        ))}
      </div>
    </div>
  );
}

function ManualCard({ file, processing, blocked, deleting, onSummary, onDetail, onDelete }: { file: ManualFile; processing: boolean; blocked: boolean; deleting: boolean; onSummary: () => void; onDetail: () => void; onDelete: () => void }) {
  const needsOcr = file.textExtractionStatus === "ocr_required";
  const canCreateSummary = file.preparationStatus === "completed";
  const summaryInProgress = file.summaryStatus === "processing" || processing;
  const preparationLabel =
    file.preparationStatus === "completed"
      ? "AI参照可"
      : file.preparationStatus === "syncing"
        ? "同期中"
        : file.preparationStatus === "processing"
          ? "準備中"
          : file.preparationStatus === "failed"
            ? "準備失敗"
            : needsOcr
              ? "文字の読み取りが必要"
              : "読み取り待ち";
  const preparationColor = file.preparationStatus === "failed" ? "var(--warn)" : "var(--ink-muted)";
  return (
    <article style={{ background: "#fff", border: "1px solid var(--line)", borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 12, position: "relative" }}>
      <div className="row" style={{ alignItems: "flex-start", gap: 14 }}>
        <FilePreview file={file} />
        <div className="stack" style={{ minWidth: 0, flex: 1, gap: 6 }}>
          <h3 className="serif" style={{ margin: 0, fontSize: 15, fontWeight: 600, lineHeight: 1.45, color: "var(--ink)", letterSpacing: "0.02em" }}>{file.name.replace(/\.[^.]+$/, "")}</h3>
          <div className="tiny soft" style={{ letterSpacing: "0.06em" }}>{file.date} ・ {file.sizeLabel}</div>
          {file.memo ? <div style={{ fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.6, marginTop: 2 }}>{file.memo}</div> : null}
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
        {file.categories.map((item) => <span className="tag" key={item}>{item}</span>)}
        {file.areas.map((item) => <span className="tag ghost" key={item}>{item}</span>)}
        {file.roles.slice(0, 2).map((item) => <span className="tag ghost" key={item}>{item}</span>)}
      </div>
      <div className="row" style={{ gap: 4, fontSize: 11, color: "var(--ink-muted)", flexWrap: "wrap" }}>
        {file.preparationStatus === "completed" ? (
          <span className="row" style={{ gap: 5 }}><span className="dot ok" />{preparationLabel}</span>
        ) : file.preparationStatus === "processing" || file.preparationStatus === "syncing" ? (
          <span className="row" style={{ gap: 5 }}><RefreshCw size={11} aria-hidden="true" />{preparationLabel}</span>
        ) : (
          <span className="row" style={{ gap: 4, color: preparationColor, background: "var(--warn-tint)", padding: "3px 8px", borderRadius: 4, fontWeight: 500 }}>{preparationLabel}</span>
        )}
        <span style={{ color: "var(--ink-faint)" }}>・</span>
        <span>{file.summaryStatus === "completed" ? "要約あり" : "要約まだ"}</span>
        {file.version ? <><span style={{ color: "var(--ink-faint)" }}>・</span><span>{file.version}</span></> : null}
      </div>
      <div className="row" style={{ gap: 6, borderTop: "1px solid var(--line-soft)", paddingTop: 12 }}>
        <Button
          variant={file.summaryStatus === "completed" ? "secondary" : canCreateSummary ? "primary" : "secondary"}
          size="sm"
          style={{ flex: 1, opacity: canCreateSummary || file.summaryStatus === "completed" ? 1 : 0.58 }}
          disabled={summaryInProgress}
          onClick={onSummary}
        >
          {summaryInProgress ? "要約作成中" : file.summaryStatus === "completed" ? "要約を見る" : "要約をつくる"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDetail}>
          <Edit size={13} aria-hidden="true" />
          詳細
        </Button>
        <button type="button" className="btn ghost sm icon" title="削除" disabled={deleting} onClick={onDelete}>
          <Trash2 size={13} aria-hidden="true" />
        </button>
      </div>
      {blocked ? (
        <div style={{ border: "1px solid var(--line)", background: "var(--panel-deep)", borderRadius: 8, padding: "9px 10px", color: "var(--ink-soft)", fontSize: 12.5, lineHeight: 1.55 }}>
          AI参照の準備が完了すると要約を作成できます。読み取りと同期が終わるまでお待ちください。
        </div>
      ) : null}
    </article>
  );
}

function DetailOverlay({
  file,
  draft,
  settings,
  saving,
  onToggle,
  onDraft,
  onSave,
  onOpenSource,
  onClose
}: {
  file: ManualFile;
  draft: DetailDraft;
  settings: Record<MasterGroupKey, { id: string; label: string }[]>;
  saving: boolean;
  onToggle: (group: MasterGroupKey, id: string) => void;
  onDraft: React.Dispatch<React.SetStateAction<DetailDraft | null>>;
  onSave: () => void;
  onOpenSource: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div onClick={(event) => event.stopPropagation()} style={{ width: "100%", maxWidth: 820, background: "var(--panel)", borderRadius: 16, overflow: "hidden", boxShadow: "var(--shadow-lg)", animation: "slide-up .25s ease", maxHeight: "calc(100vh - 64px)", display: "flex", flexDirection: "column" }}>
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
            <Button variant="secondary" size="sm" onClick={onOpenSource}>
              原本を見る
            </Button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18 }}>
            <DetailSelector title="種類" items={settings.categories} selectedIds={draft.categories} onToggle={(id) => onToggle("categories", id)} />
            <DetailSelector title="読む人" items={settings.roles} selectedIds={draft.roles} onToggle={(id) => onToggle("roles", id)} />
          </div>
          <div style={{ marginTop: 18 }}>
            <DetailSelector title="診療領域" items={settings.clinicalAreas} selectedIds={draft.clinicalAreas} onToggle={(id) => onToggle("clinicalAreas", id)} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 20 }}>
            <div>
              <FieldLabel>タグ</FieldLabel>
              <input className="input" value={draft.tags} placeholder="カンマで区切って入力" onChange={(event) => onDraft((current) => current ? { ...current, tags: event.target.value } : current)} />
            </div>
            <div>
              <FieldLabel>版数</FieldLabel>
              <input className="input" value={draft.version} placeholder="v1.0" onChange={(event) => onDraft((current) => current ? { ...current, version: event.target.value } : current)} />
            </div>
          </div>
          <div style={{ marginTop: 16 }}>
            <FieldLabel>メモ</FieldLabel>
            <textarea className="textarea" value={draft.memo} placeholder="資料の補足、運用メモなど" style={{ minHeight: 110 }} onChange={(event) => onDraft((current) => current ? { ...current, memo: event.target.value } : current)} />
          </div>
          <div style={{ marginTop: 18, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
            <MetaRow label="AI参照" value={file.preparationStatus === "completed" ? "可" : file.preparationStatus || "未開始"} />
            <MetaRow label="要約" value={file.summaryStatus === "completed" ? "作成済み" : file.summaryStatus || "未作成"} />
            <MetaRow label="OCR" value={file.textExtractionStatus || "未開始"} />
          </div>
        </div>
        <div style={{ padding: "14px 24px", borderTop: "1px solid var(--line)", background: "var(--panel-deep)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="secondary" onClick={onClose}>閉じる</Button>
          <Button onClick={onSave} disabled={saving}><Check size={14} aria-hidden="true" />{saving ? "保存中" : "保存"}</Button>
        </div>
      </div>
    </div>
  );
}

function SourceViewerOverlay({ file, onClose }: { file: ManualFile; onClose: () => void }) {
  const [previewUrl, setPreviewUrl] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let ignore = false;

    async function loadPreviewUrl() {
      try {
        const response = await fetch(`/api/files/${file.id}/preview-url`, { cache: "no-store" });
        if (!response.ok) {
          throw new Error("Failed to load source URL");
        }
        const data = (await response.json()) as { url: string };
        if (!ignore) {
          setPreviewUrl(data.url);
          setFailed(false);
        }
      } catch {
        if (!ignore) {
          setFailed(true);
        }
      }
    }

    loadPreviewUrl();

    return () => {
      ignore = true;
    };
  }, [file.id]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div onClick={(event) => event.stopPropagation()} style={{ width: "min(1180px, calc(100vw - 40px))", height: "calc(100vh - 56px)", background: "var(--panel)", borderRadius: 16, overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "var(--shadow-lg)", animation: "slide-up .25s ease" }}>
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
              <span className="small soft">署名付きURLの取得に失敗しました。時間をおいて再度お試しください。</span>
            </div>
          ) : previewUrl ? (
            file.contentType.startsWith("image/") ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={previewUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "contain", background: "#fff" }} />
            ) : (
              <iframe title={`${file.name} source`} src={previewUrl} style={{ width: "100%", height: "100%", border: 0, background: "#fff" }} />
            )
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

function DetailSelector({ title, items, selectedIds, onToggle }: { title: string; items: { id: string; label: string }[]; selectedIds: string[]; onToggle: (id: string) => void }) {
  return (
    <div>
      <FieldLabel>{title}</FieldLabel>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {items.map((item) => (
          <SelectableChip key={item.id} label={item.label} selected={selectedIds.includes(item.id)} onToggle={() => onToggle(item.id)} />
        ))}
      </div>
    </div>
  );
}

function FilePreview({ file }: { file: ManualFile }) {
  const [previewUrl, setPreviewUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const isPdf = file.contentType.includes("pdf") || file.name.toLowerCase().endsWith(".pdf");
  const isImage = file.contentType.startsWith("image/");
  const canPreview = isPdf || isImage;

  useEffect(() => {
    let ignore = false;

    async function loadPreviewUrl() {
      if (!canPreview) {
        return;
      }

      try {
        const response = await fetch(`/api/files/${file.id}/preview-url`, { cache: "no-store" });
        if (!response.ok) {
          throw new Error("Failed to load preview URL");
        }
        const data = (await response.json()) as { url: string };
        if (!ignore) {
          setPreviewUrl(data.url);
          setFailed(false);
        }
      } catch {
        if (!ignore) {
          setFailed(true);
        }
      }
    }

    loadPreviewUrl();

    return () => {
      ignore = true;
    };
  }, [canPreview, file.id]);

  if (!canPreview || failed) {
    return (
      <FileSpine
        name={file.name}
        ext={file.thumbnailLabel || file.name.split(".").pop() || "FILE"}
        version={file.version}
      />
    );
  }

  return (
    <div
      style={{
        width: 92,
        height: 128,
        flexShrink: 0,
        overflow: "hidden",
        border: "1px solid var(--line)",
        borderRadius: 8,
        background: "#fff",
        boxShadow: "var(--shadow-sm)"
      }}
    >
      <div style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden", background: "var(--panel-deep)" }}>
        {previewUrl && isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : null}
        {previewUrl && isPdf ? (
          <iframe
            title={`${file.name} preview`}
            src={`${previewUrl}#page=1&toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
            style={{
              width: "178%",
              height: "178%",
              border: 0,
              transform: "scale(0.64)",
              transformOrigin: "top left",
              pointerEvents: "none"
            }}
            aria-hidden="true"
          />
        ) : null}
        {!previewUrl ? (
          <div className="stack" style={{ height: "100%", alignItems: "center", justifyContent: "center", gap: 6, color: "var(--ink-muted)" }}>
            <span className="dot ok" style={{ animation: "pulse 1.2s infinite" }} />
            <span className="tiny soft">読み込み中</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function SummaryOverlay({ file, draft, editing, copied, processing, onDraft, onEdit, onSave, onCopy, onClose }: { file: ManualFile; draft: string; editing: boolean; copied: boolean; processing: boolean; onDraft: (value: string) => void; onEdit: () => void; onSave: () => void; onCopy: () => void; onClose: () => void }) {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div onClick={(event) => event.stopPropagation()} style={{ width: "100%", maxWidth: 1080, background: "var(--panel)", borderRadius: 16, overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: "var(--shadow-lg)", animation: "slide-up .25s ease", maxHeight: "calc(100vh - 64px)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 20, alignItems: "center", padding: "20px 28px", borderBottom: "1px solid var(--line)", background: "var(--panel-deep)" }}>
          <FileSpine name={file.name} ext={file.thumbnailLabel || "FILE"} version={file.version} size="sm" />
          <div className="stack" style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 8 }}>
              <span className="tiny" style={{ letterSpacing: "0.18em", color: "var(--accent)", fontWeight: 600, textTransform: "uppercase" }}>要約</span>
              <span className="dot" style={{ background: "var(--ink-faint)" }} />
              <span className="tiny soft">{file.summaryUpdatedAt ? `最終更新 ${formatDisplayDate(file.summaryUpdatedAt)}` : "最終更新 —"}</span>
            </div>
            <h2 className="serif truncate" style={{ margin: "4px 0 2px", fontSize: 20, fontWeight: 600, color: "var(--navy-deep)", letterSpacing: "0.04em" }}>{file.name.replace(/\.[^.]+$/, "")}</h2>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              {file.categories.map((item) => <span className="tag" key={item}>{item}</span>)}
              {file.areas.map((item) => <span className="tag ghost" key={item}>{item}</span>)}
              {file.roles.map((item) => <span className="tag ghost" key={item}>{item}</span>)}
            </div>
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
            <MetaRow label="種類" value={file.categories.join("・")} />
            <MetaRow label="診療領域" value={file.areas.join("・")} />
            <MetaRow label="読む人" value={file.roles.join("・")} />
            <MetaRow label="版数" value={file.version || "—"} />
            <MetaRow label="ファイル" value={`${file.thumbnailLabel} ・ ${file.sizeLabel}`} />
            <MetaRow label="追加日" value={file.date} />
            {file.memo ? <><div className="divider" style={{ margin: "16px 0" }} /><div className="tiny" style={{ letterSpacing: "0.18em", color: "var(--ink-muted)", fontWeight: 600, textTransform: "uppercase", marginBottom: 8 }}>メモ</div><p style={{ fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.7, margin: 0 }}>{file.memo}</p></> : null}
          </aside>
          <div style={{ overflowY: "auto", padding: "32px 44px" }}>
            {editing ? <textarea value={draft} onChange={(event) => onDraft(event.target.value)} className="textarea" style={{ minHeight: "60vh", fontSize: 14, lineHeight: 1.85, fontFamily: "inherit" }} /> : <div className="prose"><ReactMarkdown remarkPlugins={[remarkGfm]}>{draft}</ReactMarkdown></div>}
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

function metadataToManualFile(metadata: ManualMetadata): ManualFile {
  return {
    id: metadata.id,
    name: metadata.fileName,
    contentType: metadata.contentType,
    date: formatDisplayDate(metadata.uploadedAt),
    sizeLabel: metadata.sizeLabel,
    thumbnailLabel: metadata.thumbnailLabel,
    categoryIds: metadata.categoryIds || [],
    categories: metadata.categories,
    clinicalAreaIds: metadata.clinicalAreaIds || [],
    areas: metadata.clinicalAreas,
    roleIds: metadata.roleIds || [],
    roles: metadata.roles,
    tags: metadata.tags,
    version: metadata.version,
    memo: metadata.memo,
    summary: metadata.summary || "",
    summaryStatus: metadata.summaryStatus || "not_started",
    summaryUpdatedAt: metadata.summaryUpdatedAt || "",
    preparationStatus: metadata.preparationStatus || "not_started",
    textExtractionStatus: metadata.textExtractionStatus || "not_started"
  };
}

function formatDisplayDate(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(new Date(value)).replace(/\//g, "-");
}
