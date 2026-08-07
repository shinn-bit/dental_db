import { Suspense } from "react";
import { DataVaultAnalyzer } from "@/components/data-vault-analyzer";
import { PageHeading } from "@/components/page-heading";

export default function DataVaultAnalyzePage() {
  return (
    <>
      <PageHeading title="資料を分析する" />
      <Suspense>
        <DataVaultAnalyzer />
      </Suspense>
    </>
  );
}
