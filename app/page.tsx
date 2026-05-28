"use client";

import { useRouter } from "next/navigation";
import { ChatPanel } from "@/components/chat-panel";
import { PageHeading } from "@/components/page-heading";

export default function Home() {
  const router = useRouter();

  return (
    <>
      <PageHeading title="AIアシスタント" />
      <div style={{ flex: 1, display: "flex", alignItems: "stretch", minHeight: 0 }}>
        <ChatPanel
          onSwitchMode={() => router.push("/manual")}
          onLoadManualSession={(id) => router.push(`/manual?sessionId=${id}`)}
        />
      </div>
    </>
  );
}
