import { ChatPanel } from "@/components/chat-panel";
import { ManualGeneratorPanel } from "@/components/manual-generator-panel";
import { PageHeading } from "@/components/page-heading";

export default function Home() {
  return (
    <>
      <PageHeading title="AIアシスタント" />
      <div style={{ flex: 1, display: "flex", gap: 20, alignItems: "stretch", minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <ChatPanel />
        </div>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <ManualGeneratorPanel />
        </div>
      </div>
    </>
  );
}
