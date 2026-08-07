import { DataVaultManager } from "@/components/data-vault-manager";
import { PageHeading } from "@/components/page-heading";

export default function DataVaultPage() {
  return (
    <>
      <PageHeading title="データ保管庫" />
      <DataVaultManager />
    </>
  );
}
