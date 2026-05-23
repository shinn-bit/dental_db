import { ChatPanel } from "@/components/chat-panel";
import { ManualGeneratorPanel } from "@/components/manual-generator-panel";
import { PageHeading } from "@/components/page-heading";

export default function Home() {
  return (
    <>
      <PageHeading title="AIアシスタント" />
      <div style={{ display: "flex", gap: 20, alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <ChatPanel />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <ManualGeneratorPanel />
        </div>
      </div>
    </>
  );
}
