"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { InsuranceChatPanel } from "@/components/insurance-chat-panel";

function InsuranceContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("sessionId");

  return (
    <div style={{ flex: 1, display: "flex", alignItems: "stretch", minHeight: 0 }}>
      <InsuranceChatPanel
        initialSessionId={sessionId}
        onLoadChatSession={(id) => router.push(`/?sessionId=${id}`)}
      />
    </div>
  );
}

export default function InsurancePage() {
  return (
    <Suspense>
      <InsuranceContent />
    </Suspense>
  );
}
