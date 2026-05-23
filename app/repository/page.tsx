import { FileRepositoryManager } from "@/components/file-repository-manager";
import { PageHeading } from "@/components/page-heading";

export default function RepositoryPage() {
  return (
    <>
      <PageHeading title="資料庫" />
      <FileRepositoryManager />
    </>
  );
}
