import Link from "next/link";
import { FileText } from "lucide-react";
import { ChatPanel } from "@/components/chat-panel";
import { PageHeading } from "@/components/page-heading";
import { Button } from "@/components/ui";

export default function Home() {
  return (
    <>
      <PageHeading
        title="AIアシスタント"
        description="院内マニュアルをもとに、要約、確認問題、対応手順の整理を行うメイン画面です。"
        action={
          <Link href="/manuals">
            <Button variant="secondary">
              <FileText size={17} aria-hidden="true" />
              マニュアルを追加
            </Button>
          </Link>
        }
      />

      <ChatPanel />
    </>
  );
}
