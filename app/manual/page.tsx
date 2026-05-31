"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ManualGeneratorPanel } from "@/components/manual-generator-panel";

function ManualContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("sessionId");
  const repoItemId = searchParams.get("repoItemId");

  return (
    <div style={{ flex: 1, display: "flex", alignItems: "stretch", minHeight: 0 }}>
      <ManualGeneratorPanel
        onSwitchMode={() => router.push("/")}
        initialSessionId={sessionId}
        initialRepoItemId={repoItemId}
        onLoadChatSession={(id) => router.push(`/?sessionId=${id}`)}
      />
    </div>
  );
}

export default function ManualPage() {
  return (
    <Suspense>
      <ManualContent />
    </Suspense>
  );
}
