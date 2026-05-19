"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  CalendarClock,
  Clipboard,
  ClipboardCheck,
  FileText,
  FileUp,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  UploadCloud,
  X
} from "lucide-react";
import { Badge, Button, FieldLabel } from "@/components/ui";
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
  categories: string[];
  areas: string[];
  roles: string[];
  tags: string[];
  version: string;
  memo: string;
  summary: string;
  summaryStatus: ManualMetadata["summaryStatus"];
  summaryUpdatedAt: string;
  textExtractionStatus: ManualMetadata["textExtractionStatus"];
  extractedTextLength: number;
};

type SelectionState = Record<MasterGroupKey, string[]>;

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
  const [selectedDetail, setSelectedDetail] = useState<ManualFile | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [selectedSummary, setSelectedSummary] = useState<ManualFile | null>(null);
  const [summaryDraft, setSummaryDraft] = useState("");
  const [summaryEditing, setSummaryEditing] = useState(false);
  const [summaryProcessingIds, setSummaryProcessingIds] = useState<Set<string>>(new Set());
  const [summaryCopied, setSummaryCopied] = useState(false);

  const activeSettings = useMemo(
    () => ({
      categories: settings.categories.filter((item) => item.active),
      clinicalAreas: settings.clinicalAreas.filter((item) => item.active),
      roles: settings.roles.filter((item) => item.active)
    }),
    [settings]
  );

  function toggle(group: MasterGroupKey, id: string) {
    setSelection((current) => {
      const selected = current[group].includes(id);
      return {
        ...current,
        [group]: selected
          ? current[group].filter((itemId) => itemId !== id)
          : [...current[group], id]
      };
    });
  }

  useEffect(() => {
    let ignore = false;

    async function loadFiles() {
      try {
        const response = await fetch("/api/files", { cache: "no-store" });
        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(data.error || "S3一覧を読み込めませんでした。");
        }
        const data = (await response.json()) as { files: ManualMetadata[] };
        if (!ignore) {
          setFiles(data.files.map(metadataToManualFile));
        }
      } catch (error) {
        if (!ignore) {
          const message = error instanceof Error ? error.message : "S3一覧を読み込めませんでした。";
          setNotice(`${message} SSO期限、IAMロール、S3設定を確認してください。`);
        }
      } finally {
        if (!ignore) {
          setIsLoadingFiles(false);
        }
      }
    }

    loadFiles();

    return () => {
      ignore = true;
    };
  }, []);

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
      const unique = incoming.filter((file) => !currentKeys.has(`${file.name}-${file.size}`));
      return [...current, ...unique];
    });
    setNotice("");
  }

  function removeSelectedFile(index: number) {
    setSelectedFiles((current) => current.filter((_, fileIndex) => fileIndex !== index));
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
      setNotice("カテゴリ、診療領域、対象職種をそれぞれ1つ以上選択してください。");
      return;
    }

    const tagList = tags
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean);

    setIsUploading(true);
    setNotice("S3へアップロードしています。");

    try {
      const uploaded: ManualFile[] = [];

      for (const file of selectedFiles) {
        const uploadUrlResponse = await fetch("/api/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            fileName: file.name,
            contentType: file.type || "application/octet-stream"
          })
        });

        if (!uploadUrlResponse.ok) {
          throw new Error("Failed to create upload URL");
        }

        const uploadData = (await uploadUrlResponse.json()) as {
          id: string;
          uploadUrl: string;
          s3Key: string;
        };

        const putResponse = await fetch(uploadData.uploadUrl, {
          method: "PUT",
          headers: {
            "Content-Type": file.type || "application/octet-stream"
          },
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
      setSelectedDetail(uploaded[0] || null);
      setSelectedFiles([]);
      setTags("");
      setVersion("");
      setMemo("");
      setNotice(`${uploaded.length}件をS3へ保存しました。`);
    } catch {
      setNotice("アップロードに失敗しました。SSO期限やS3設定を確認してください。");
    } finally {
      setIsUploading(false);
    }
  }

  async function openDetail(file: ManualFile) {
    try {
      const response = await fetch(`/api/files/${file.id}`, { cache: "no-store" });
      if (!response.ok) {
        throw new Error("Failed to load file detail");
      }
      const data = (await response.json()) as { file: ManualMetadata };
      setSelectedDetail(metadataToManualFile(data.file));
      setNotice("");
    } catch {
      setSelectedDetail(file);
      setNotice("詳細をS3から読み込めませんでした。一覧上の情報を表示します。");
    }
  }

  async function deleteFile(file: ManualFile) {
    const confirmed = window.confirm(`${file.name} を削除します。よろしいですか？`);
    if (!confirmed) {
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
      if (selectedDetail?.id === file.id) {
        setSelectedDetail(null);
      }
      if (selectedSummary?.id === file.id) {
        setSelectedSummary(null);
      }
      setNotice(`${file.name} を削除しました。`);
    } catch {
      setNotice("削除に失敗しました。SSO期限やS3設定を確認してください。");
    } finally {
      setDeletingId(null);
    }
  }

  async function openOrCreateSummary(file: ManualFile) {
    const optimisticFile: ManualFile =
      file.summaryStatus === "completed" ? file : { ...file, summaryStatus: "processing" };

    if (file.summaryStatus !== "completed") {
      setSummaryProcessingIds((current) => new Set(current).add(file.id));
    }
    setFiles((current) => current.map((item) => (item.id === file.id ? optimisticFile : item)));
    setSelectedSummary(optimisticFile);
    setSummaryDraft(file.summary || "");
    setSummaryEditing(false);

    try {
      const method = file.summaryStatus === "completed" ? "GET" : "POST";
      const response = await fetch(`/api/files/${file.id}/summary`, { method, cache: "no-store" });
      const data = (await response.json()) as { summary?: string; file?: ManualMetadata; error?: string };

      if (!response.ok) {
        throw new Error(data.error || "要約の取得または作成に失敗しました。");
      }

      const nextFile = metadataToManualFile(data.file as ManualMetadata);
      setFiles((current) => current.map((item) => (item.id === nextFile.id ? nextFile : item)));
      setSelectedSummary(nextFile);
      setSummaryDraft(data.summary || nextFile.summary || "");
      setSummaryEditing(false);

      if (nextFile.summaryStatus === "processing") {
        void pollSummary(nextFile.id);
      } else {
        setSummaryProcessingIds((current) => withoutSetValue(current, nextFile.id));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "要約の取得または作成に失敗しました。";
      setSummaryProcessingIds((current) => withoutSetValue(current, file.id));
      setFiles((current) => current.map((item) => (item.id === file.id ? file : item)));
      setSelectedSummary(file);
      setNotice(message);
    }
  }

  async function pollSummary(fileId: string) {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 5000));

      const response = await fetch(`/api/files/${fileId}/summary`, { cache: "no-store" });
      const data = (await response.json()) as { summary?: string; file?: ManualMetadata; error?: string };

      if (!response.ok) {
        throw new Error(data.error || "要約処理の状態確認に失敗しました。");
      }

      const nextFile = metadataToManualFile(data.file as ManualMetadata);
      setFiles((current) => current.map((item) => (item.id === nextFile.id ? nextFile : item)));
      setSelectedSummary(nextFile);
      setSummaryDraft(data.summary || nextFile.summary || "");

      if (nextFile.summaryStatus === "completed") {
        setNotice("要約が完了しました。OCRテキストがある場合はAI同期後にRAG検索にも使われます。");
        setSummaryProcessingIds((current) => withoutSetValue(current, fileId));
        return;
      }

      if (nextFile.summaryStatus === "failed") {
        setSummaryProcessingIds((current) => withoutSetValue(current, fileId));
        throw new Error(data.error || "要約処理に失敗しました。");
      }

      const extractionLabel =
        nextFile.textExtractionStatus === "processing" ? "OCR中" : "要約中";
      setNotice(`${extractionLabel}です。完了までこの画面で状態を確認します。`);
    }

    setNotice("OCRまたは要約は継続中です。しばらくしてから要約を再度開いてください。");
  }

  async function saveSummary() {
    if (!selectedSummary) {
      return;
    }

    setSummaryProcessingIds((current) => new Set(current).add(selectedSummary.id));
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
      setSummaryDraft(data.summary || nextFile.summary || "");
      setSummaryEditing(false);
      setNotice("要約を保存しました。");
    } catch (error) {
      const message = error instanceof Error ? error.message : "要約の保存に失敗しました。";
      setNotice(message);
    } finally {
      setSummaryProcessingIds((current) => withoutSetValue(current, selectedSummary.id));
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
      const data = (await response.json()) as { job?: { ingestionJobId?: string; status?: string } };
      const jobId = data.job?.ingestionJobId;
      setSyncStatus(`同期ジョブを開始しました。${jobId || ""}`.trim());
      if (jobId) {
        pollSyncJob(jobId);
      }
    } catch {
      setSyncStatus("AI同期の開始に失敗しました。Bedrock設定やSSO期限を確認してください。");
      setSyncing(false);
    }
  }

  async function pollSyncJob(jobId: string) {
    const terminalStatuses = new Set(["COMPLETE", "FAILED", "STOPPED"]);

    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 5000));

      try {
        const response = await fetch(`/api/sync/${jobId}`, { cache: "no-store" });
        if (!response.ok) {
          throw new Error("Failed to load sync job");
        }
        const data = (await response.json()) as {
          job?: {
            status?: string;
            statistics?: {
              numberOfDocumentsScanned?: number;
              numberOfNewDocumentsIndexed?: number;
              numberOfModifiedDocumentsIndexed?: number;
              numberOfDocumentsDeleted?: number;
              numberOfDocumentsFailed?: number;
            };
          };
        };
        const status = data.job?.status || "UNKNOWN";
        const stats = data.job?.statistics;
        const scanned = stats?.numberOfDocumentsScanned ?? 0;
        const indexed =
          (stats?.numberOfNewDocumentsIndexed ?? 0) + (stats?.numberOfModifiedDocumentsIndexed ?? 0);
        const failed = stats?.numberOfDocumentsFailed ?? 0;

        if (status === "COMPLETE") {
          setSyncStatus(`AI同期が完了しました。確認 ${scanned}件 / 反映 ${indexed}件 / 失敗 ${failed}件`);
          setSyncing(false);
          return;
        }

        if (terminalStatuses.has(status)) {
          setSyncStatus(`AI同期が終了しました。状態: ${status} / 失敗 ${failed}件`);
          setSyncing(false);
          return;
        }

        setSyncStatus(`AI同期中です。状態: ${status} / 確認 ${scanned}件`);
      } catch {
        setSyncStatus("AI同期状態を確認できませんでした。数分後に再度確認してください。");
        setSyncing(false);
        return;
      }
    }

    setSyncStatus("AI同期は継続中です。しばらくしてからチャットで確認してください。");
    setSyncing(false);
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[430px_1fr]">
      <section className="rounded-md border border-[var(--line)] bg-white p-5">
        <div className="flex items-center gap-2 text-sm font-semibold text-[#253041]">
          <FileUp size={18} className="text-[var(--primary)]" aria-hidden="true" />
          資料を追加
        </div>

        <div
          className={`mt-4 flex min-h-44 flex-col items-center justify-center rounded-md border border-dashed px-4 text-center transition ${
            isDragging
              ? "border-[var(--primary)] bg-[#e9f6f4]"
              : "border-[#b8c3cf] bg-[#f9fbfc]"
          }`}
          onDragEnter={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            setIsDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragging(false);
            addSelectedFiles(event.dataTransfer.files);
          }}
        >
          <UploadCloud size={32} className="text-[var(--primary)]" aria-hidden="true" />
          <p className="mt-3 text-sm font-semibold text-[#253041]">ここにファイルをドロップ</p>
          <p className="mt-1 text-xs text-[var(--muted)]">PDF、Word、テキスト資料を想定</p>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            accept=".pdf,.doc,.docx,.txt,.md"
            onChange={(event) => {
              if (event.target.files) {
                addSelectedFiles(event.target.files);
              }
              event.currentTarget.value = "";
            }}
          />
          <Button
            className="mt-4"
            variant="secondary"
            onClick={() => fileInputRef.current?.click()}
          >
            <Plus size={16} aria-hidden="true" />
            ファイルを選択
          </Button>
        </div>

        {selectedFiles.length > 0 ? (
          <div className="mt-4 rounded-md border border-[var(--line)] bg-[#fbfcfd]">
            <div className="border-b border-[var(--line)] px-3 py-2 text-xs font-semibold text-[#394452]">
              選択中のファイル
            </div>
            <div className="divide-y divide-[var(--line)]">
              {selectedFiles.map((file, index) => (
                <div key={`${file.name}-${file.size}`} className="flex items-center gap-2 px-3 py-2">
                  <FileText size={16} className="shrink-0 text-[var(--primary)]" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold text-[#253041]">{file.name}</p>
                    <p className="text-xs text-[var(--muted)]">{formatFileSize(file.size)}</p>
                  </div>
                  <Button
                    variant="ghost"
                    className="h-8 w-8 px-0"
                    title="選択から外す"
                    onClick={() => removeSelectedFile(index)}
                  >
                    <X size={15} aria-hidden="true" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-5 space-y-5">
          <SelectorGroup
            title="カテゴリ"
            items={activeSettings.categories}
            selectedIds={selection.categories}
            onToggle={(id) => toggle("categories", id)}
          />
          <SelectorGroup
            title="診療領域"
            items={activeSettings.clinicalAreas}
            selectedIds={selection.clinicalAreas}
            onToggle={(id) => toggle("clinicalAreas", id)}
          />
          <SelectorGroup
            title="対象職種"
            items={activeSettings.roles}
            selectedIds={selection.roles}
            onToggle={(id) => toggle("roles", id)}
          />
          <div>
            <FieldLabel>タグ</FieldLabel>
            <input
              className="h-10 w-full rounded-md border border-[var(--line)] px-3 text-sm outline-none"
              placeholder="例: SRP, 新人教育, 術前説明"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <FieldLabel>版数</FieldLabel>
              <input
                className="h-10 w-full rounded-md border border-[var(--line)] px-3 text-sm outline-none"
                placeholder="例: v1.0"
                value={version}
                onChange={(event) => setVersion(event.target.value)}
              />
            </div>
            <div>
              <FieldLabel>メモ</FieldLabel>
              <input
                className="h-10 w-full rounded-md border border-[var(--line)] px-3 text-sm outline-none"
                placeholder="任意"
                value={memo}
                onChange={(event) => setMemo(event.target.value)}
              />
            </div>
          </div>
          {notice ? (
            <p className="rounded-md border border-[#d9e8e5] bg-[#f4fbfa] px-3 py-2 text-sm text-[#2f4945]">
              {notice}
            </p>
          ) : null}
          <Button className="w-full" onClick={registerFiles}>
            <FileUp size={17} aria-hidden="true" />
            {isUploading ? "アップロード中" : "S3へ保存"}
          </Button>
        </div>
      </section>

      <section className="rounded-md border border-[var(--line)] bg-white">
        <div className="flex flex-col gap-3 border-b border-[var(--line)] px-5 py-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-[#253041]">AI読み込み済みマニュアル一覧</h2>
            <p className="mt-1 text-xs text-[var(--muted)]">
              {isLoadingFiles ? "S3から一覧を読み込み中です。" : "最新のアップロード順に表示します。"}
            </p>
            {syncStatus ? <p className="mt-1 text-xs text-[var(--primary-dark)]">{syncStatus}</p> : null}
          </div>
          <div className="flex w-full flex-col gap-2 md:w-auto md:flex-row">
            <Button variant="secondary" disabled={syncing} onClick={startSync}>
              <RefreshCw size={16} aria-hidden="true" />
              {syncing ? "同期中" : "AI同期"}
            </Button>
            <div className="relative w-full md:w-64">
              <Search
                size={16}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]"
                aria-hidden="true"
              />
              <input
                className="h-10 w-full rounded-md border border-[var(--line)] pl-9 pr-3 text-sm outline-none"
                placeholder="ファイル名で検索"
              />
            </div>
          </div>
        </div>
        <div className="divide-y divide-[var(--line)]">
          {!isLoadingFiles && files.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-[var(--muted)]">
              まだマニュアルがありません。左側から資料をアップロードしてください。
            </div>
          ) : null}
          {files.map((file) => (
            <article key={file.id} className="px-5 py-4">
              <div className="flex gap-4">
                <FilePreview file={file} size="small" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold text-[#1f2933]">
                        {file.name}
                      </h3>
                      <p className="mt-1 flex items-center gap-1 text-xs text-[var(--muted)]">
                        <CalendarClock size={14} aria-hidden="true" />
                        {file.date} / {file.sizeLabel}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <Button variant="ghost" onClick={() => openDetail(file)}>
                        詳細
                      </Button>
                      <Button
                        variant={file.summaryStatus === "completed" ? "secondary" : "primary"}
                        disabled={summaryProcessingIds.has(file.id) || file.summaryStatus === "processing"}
                        onClick={() => openOrCreateSummary(file)}
                      >
                        {summaryProcessingIds.has(file.id) || file.summaryStatus === "processing"
                          ? "処理中"
                          : file.summaryStatus === "completed"
                            ? "要約"
                            : "要約を作成する"}
                      </Button>
                      <Button
                        variant="ghost"
                        className="text-[#a33a2a] hover:bg-[#fbeeed]"
                        disabled={deletingId === file.id}
                        onClick={() => deleteFile(file)}
                      >
                        {deletingId === file.id ? "削除中" : "削除"}
                      </Button>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {[
                      ...file.categories,
                      ...file.areas,
                      ...file.roles,
                      ...file.tags,
                      file.version
                    ]
                      .filter(Boolean)
                      .map((item) => (
                      <Badge key={`${file.name}-${item}`}>{item}</Badge>
                    ))}
                  </div>
                  {file.memo ? (
                    <p className="mt-2 text-xs leading-5 text-[var(--muted)]">{file.memo}</p>
                  ) : null}
                  <div className="mt-2 flex flex-wrap gap-2 text-xs text-[var(--muted)]">
                    <span>要約: {summaryStatusLabel(file.summaryStatus)}</span>
                    {file.textExtractionStatus ? (
                      <span>文字抽出: {textExtractionStatusLabel(file.textExtractionStatus)}</span>
                    ) : null}
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      {selectedDetail ? (
        <section className="lg:col-span-2 rounded-md border border-[var(--line)] bg-white">
          <div className="flex items-start justify-between gap-3 border-b border-[var(--line)] px-5 py-4">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-[#253041]">詳細: {selectedDetail.name}</h2>
              <p className="mt-1 text-xs text-[var(--muted)]">
                {selectedDetail.date} / {selectedDetail.sizeLabel}
              </p>
            </div>
            <Button variant="ghost" className="h-9 w-9 px-0" title="閉じる" onClick={() => setSelectedDetail(null)}>
              <X size={17} aria-hidden="true" />
            </Button>
          </div>
          <div className="grid gap-5 p-5 md:grid-cols-[120px_1fr]">
            <FilePreview key={selectedDetail.id} file={selectedDetail} size="large" />
            <div className="min-w-0 space-y-4">
              <DetailRow label="カテゴリ" values={selectedDetail.categories} />
              <DetailRow label="診療領域" values={selectedDetail.areas} />
              <DetailRow label="対象職種" values={selectedDetail.roles} />
              <DetailRow label="タグ" values={selectedDetail.tags} />
              <DetailRow label="版数" values={selectedDetail.version ? [selectedDetail.version] : []} />
              <div>
                <p className="text-xs font-semibold text-[#394452]">メモ</p>
                <p className="mt-1 rounded-md border border-[var(--line)] bg-[#fbfcfd] px-3 py-2 text-sm leading-6 text-[#253041]">
                  {selectedDetail.memo || "未入力"}
                </p>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {selectedSummary ? (
        <section className="lg:col-span-2 rounded-md border border-[var(--line)] bg-white">
          <div className="flex flex-col gap-3 border-b border-[var(--line)] px-5 py-4 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-[#253041]">要約: {selectedSummary.name}</h2>
              <p className="mt-1 text-xs text-[var(--muted)]">
                {selectedSummary.summaryUpdatedAt
                  ? `更新: ${formatDisplayDate(selectedSummary.summaryUpdatedAt)}`
                  : "未更新"}
              </p>
              <p className="mt-1 text-xs text-[var(--primary-dark)]">
                要約: {summaryStatusLabel(selectedSummary.summaryStatus)}
                {selectedSummary.textExtractionStatus
                  ? ` / 文字抽出: ${textExtractionStatusLabel(selectedSummary.textExtractionStatus)}`
                  : ""}
              </p>
              {selectedSummary.summaryStatus === "processing" || summaryProcessingIds.has(selectedSummary.id) ? (
                <p className="mt-1 flex items-center gap-1 text-xs text-[var(--primary-dark)]">
                  <RefreshCw size={12} className="animate-spin" aria-hidden="true" />
                  {selectedSummary.textExtractionStatus === "processing" ? "OCR中" : "要約中"}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button variant="secondary" onClick={copySummary}>
                {summaryCopied ? <ClipboardCheck size={16} aria-hidden="true" /> : <Clipboard size={16} aria-hidden="true" />}
                コピー
              </Button>
              {summaryEditing ? (
                <Button disabled={summaryProcessingIds.has(selectedSummary.id)} onClick={saveSummary}>
                  <Save size={16} aria-hidden="true" />
                  保存
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => setSummaryEditing(true)}>
                  <Pencil size={16} aria-hidden="true" />
                  編集
                </Button>
              )}
              <Button
                variant="ghost"
                className="h-10 w-10 px-0"
                title="閉じる"
                onClick={() => setSelectedSummary(null)}
              >
                <X size={17} aria-hidden="true" />
              </Button>
            </div>
          </div>
          <div className="p-5">
            {summaryEditing ? (
              <textarea
                className="min-h-[520px] w-full resize-y rounded-md border border-[var(--line)] px-4 py-3 text-sm leading-6 outline-none"
                value={summaryDraft}
                onChange={(event) => setSummaryDraft(event.target.value)}
              />
            ) : (
              <div className="rounded-md border border-[var(--line)] bg-[#fbfcfd] px-4 py-3 text-sm leading-6 text-[#253041]">
                <div className="prose-lite">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>
                    {summaryDraft || "要約はまだありません。"}
                  </ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function SelectorGroup({
  title,
  items,
  selectedIds,
  onToggle
}: {
  title: string;
  items: { id: string; label: string }[];
  selectedIds: string[];
  onToggle: (id: string) => void;
}) {
  return (
    <div>
      <FieldLabel>{title}</FieldLabel>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => (
          <SelectableChip
            key={item.id}
            label={item.label}
            selected={selectedIds.includes(item.id)}
            onToggle={() => onToggle(item.id)}
          />
        ))}
      </div>
      {items.length === 0 ? (
        <p className="mt-2 text-xs text-[var(--muted)]">有効な項目がありません。</p>
      ) : null}
    </div>
  );
}

function DetailRow({ label, values }: { label: string; values: string[] }) {
  return (
    <div>
      <p className="text-xs font-semibold text-[#394452]">{label}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {values.length > 0 ? values.map((value) => <Badge key={`${label}-${value}`}>{value}</Badge>) : <span className="text-sm text-[var(--muted)]">未設定</span>}
      </div>
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
    categories: metadata.categories,
    areas: metadata.clinicalAreas,
    roles: metadata.roles,
    tags: metadata.tags,
    version: metadata.version,
    memo: metadata.memo,
    summary: metadata.summary || "",
    summaryStatus: metadata.summaryStatus || "not_started",
    summaryUpdatedAt: metadata.summaryUpdatedAt || "",
    textExtractionStatus: metadata.textExtractionStatus || "not_started",
    extractedTextLength: metadata.extractedTextLength || 0
  };
}

function FilePreview({ file, size }: { file: ManualFile; size: "small" | "large" }) {
  const [previewUrl, setPreviewUrl] = useState("");
  const [failed, setFailed] = useState(false);
  const isPdf = file.contentType.includes("pdf") || file.name.toLowerCase().endsWith(".pdf");
  const isImage = file.contentType.startsWith("image/");
  const canPreview = isPdf || isImage;
  const frameClass =
    size === "small"
      ? "h-24 w-20"
      : "h-36 w-28";
  const iconSize = size === "small" ? 26 : 34;

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

  return (
    <div
      className={`${frameClass} flex shrink-0 flex-col overflow-hidden rounded-md border border-[var(--line)] bg-white shadow-sm`}
    >
      <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-[#e8f3f1] text-[var(--primary-dark)]">
        {previewUrl && isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={previewUrl} alt="" className="h-full w-full object-cover" />
        ) : null}
        {previewUrl && isPdf ? (
          <iframe
            title={`${file.name} preview`}
            src={`${previewUrl}#page=1&toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
            className="h-[170%] w-[170%] scale-[0.72] border-0"
            aria-hidden="true"
          />
        ) : null}
        {!previewUrl || failed ? <FileText size={iconSize} aria-hidden="true" /> : null}
      </div>
      <div className="border-t border-[var(--line)] bg-[#fbfcfd] px-1 py-1 text-center text-xs font-semibold text-[#394452]">
        {file.thumbnailLabel}
      </div>
    </div>
  );
}

function formatDisplayDate(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  })
    .format(new Date(value))
    .replace(/\//g, "-");
}

function summaryStatusLabel(status: ManualMetadata["summaryStatus"]) {
  if (status === "completed") {
    return "完了";
  }
  if (status === "processing") {
    return "作成中";
  }
  if (status === "failed") {
    return "失敗";
  }
  return "未作成";
}

function textExtractionStatusLabel(status: ManualMetadata["textExtractionStatus"]) {
  if (status === "completed") {
    return "OK";
  }
  if (status === "processing") {
    return "OCR中";
  }
  if (status === "ocr_required") {
    return "OCR推奨";
  }
  if (status === "failed") {
    return "失敗";
  }
  return "未確認";
}

function withoutSetValue<T>(set: Set<T>, value: T) {
  const next = new Set(set);
  next.delete(value);
  return next;
}
