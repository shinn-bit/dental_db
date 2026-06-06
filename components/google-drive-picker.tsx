"use client";

import { useCallback, useRef, useState } from "react";
import { HardDrive } from "lucide-react";
import { Button } from "@/components/ui";

// Google-native formats that must be exported (→ PDF)
const EXPORT_TO_PDF = new Set([
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.presentation",
  "application/vnd.google-apps.spreadsheet",
]);

async function loadScript(src: string): Promise<void> {
  if (document.querySelector(`script[src="${src}"]`)) return;
  return new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error(`スクリプトの読み込みに失敗: ${src}`));
    document.head.appendChild(el);
  });
}

async function downloadFromDrive(
  fileId: string,
  fileName: string,
  mimeType: string,
  token: string,
): Promise<File> {
  const isPdfExport = EXPORT_TO_PDF.has(mimeType);
  const url = isPdfExport
    ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=application%2Fpdf`
    : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`"${fileName}" のダウンロードに失敗しました (HTTP ${res.status})`);
  }

  const finalName =
    isPdfExport && !fileName.toLowerCase().endsWith(".pdf")
      ? `${fileName}.pdf`
      : fileName;

  return new File([await res.blob()], finalName, {
    type: isPdfExport ? "application/pdf" : mimeType,
  });
}

type Phase = "idle" | "loading" | "downloading";

type Props = {
  onFilesSelected: (files: File[]) => void;
  disabled?: boolean;
};

export function GoogleDrivePicker({ onFilesSelected, disabled }: Props) {
  const [phase, setPhase] = useState<Phase>("idle");
  const tokenClientRef = useRef<google.accounts.oauth2.TokenClient | null>(null);
  const pickerLoadedRef = useRef(false);

  const clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_API_KEY;

  function openPicker(token: string) {
    new google.picker.PickerBuilder()
      .addView(
        new google.picker.DocsView()
          .setIncludeFolders(false)
          .setSelectFolderEnabled(false),
      )
      .setOAuthToken(token)
      .setDeveloperKey(apiKey!)
      .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
      .setCallback(async (data) => {
        if (data.action !== google.picker.Action.PICKED) return;
        setPhase("downloading");
        try {
          const files = await Promise.all(
            (data.docs ?? []).map((d) =>
              downloadFromDrive(d.id, d.name, d.mimeType, token),
            ),
          );
          onFilesSelected(files);
        } catch (err) {
          alert(err instanceof Error ? err.message : "ダウンロードに失敗しました");
        } finally {
          setPhase("idle");
        }
      })
      .build()
      .setVisible(true);
  }

  const handleClick = useCallback(async () => {
    if (!clientId || !apiKey || phase !== "idle") return;
    setPhase("loading");
    try {
      await Promise.all([
        loadScript("https://accounts.google.com/gsi/client"),
        loadScript("https://apis.google.com/js/api.js"),
      ]);
      if (!pickerLoadedRef.current) {
        await new Promise<void>((resolve) => window.gapi.load("picker", resolve));
        pickerLoadedRef.current = true;
      }
      if (!tokenClientRef.current) {
        tokenClientRef.current = google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: "https://www.googleapis.com/auth/drive.readonly",
          callback: (resp) => {
            if (!resp.access_token) {
              setPhase("idle");
              return;
            }
            setPhase("idle");
            openPicker(resp.access_token);
          },
        });
      }
      tokenClientRef.current.requestAccessToken({ prompt: "" });
    } catch (err) {
      console.error("[google-drive-picker]", err);
      setPhase("idle");
    }
  }, [clientId, apiKey, phase]);

  // 環境変数が設定されていなければ表示しない
  if (!clientId || !apiKey) return null;

  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={handleClick}
      disabled={disabled || phase !== "idle"}
      style={{ gap: 6, width: "100%", marginTop: 8 }}
    >
      <HardDrive size={14} aria-hidden="true" />
      {phase === "downloading"
        ? "ダウンロード中…"
        : phase === "loading"
          ? "接続中…"
          : "Google Driveから追加"}
    </Button>
  );
}
