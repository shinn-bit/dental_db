"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChatPanel } from "@/components/chat-panel";

function HomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("sessionId");

  return (
    <div style={{ flex: 1, display: "flex", alignItems: "stretch", minHeight: 0, minWidth: 0 }}>
      <ChatPanel
        initialSessionId={sessionId}
        onSwitchMode={() => router.push("/manual")}
        onLoadManualSession={(id) => router.push(`/manual?sessionId=${id}`)}
      />
    </div>
  );
}

export default function Home() {
  return (
    <Suspense>
      <HomeContent />
    </Suspense>
  );
}
