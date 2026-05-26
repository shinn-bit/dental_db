"use client";

import { useState } from "react";
import { ChatPanel } from "@/components/chat-panel";
import { ManualGeneratorPanel } from "@/components/manual-generator-panel";
import { PageHeading } from "@/components/page-heading";

type Mode = "chat" | "manual";

export default function Home() {
  const [mode, setMode] = useState<Mode>("chat");

  if (mode === "manual") {
    return (
      <>
        <PageHeading title="マニュアル作成" />
        <div style={{ flex: 1, display: "flex", alignItems: "stretch", minHeight: 0 }}>
          <ManualGeneratorPanel onSwitchMode={() => setMode("chat")} />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeading title="AIアシスタント" />
      <div style={{ flex: 1, display: "flex", alignItems: "stretch", minHeight: 0 }}>
        <ChatPanel onSwitchMode={() => setMode("manual")} />
      </div>
    </>
  );
}
