import { PageHeading } from "@/components/page-heading";
import { MasterSettingsManager } from "@/components/master-settings-manager";

export default function AdminSettingsPage() {
  return (
    <>
      <PageHeading
        title="分類設定"
        description="カテゴリ、診療領域、対象職種を管理します。削除ではなく無効化で履歴を保ちます。"
      />

      <MasterSettingsManager />
    </>
  );
}
