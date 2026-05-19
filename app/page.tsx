import { ChatPanel } from "@/components/chat-panel";
import { PageHeading } from "@/components/page-heading";

export default function Home() {
  return (
    <>
      <PageHeading title="AIアシスタント" />
      <ChatPanel />
    </>
  );
}
