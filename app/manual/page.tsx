"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ManualGeneratorPanel } from "@/components/manual-generator-panel";
import { PageHeading } from "@/components/page-heading";

function ManualContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get("sessionId");

  return (
    <>
      <PageHeading title="マニュアル作成" />
      <div style={{ flex: 1, display: "flex", alignItems: "stretch", minHeight: 0 }}>
        <ManualGeneratorPanel
          onSwitchMode={() => router.push("/")}
          initialSessionId={sessionId}
        />
      </div>
    </>
  );
}

export default function ManualPage() {
  return (
    <Suspense>
      <ManualContent />
    </Suspense>
  );
}
