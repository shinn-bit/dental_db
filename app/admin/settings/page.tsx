import { PageHeading } from "@/components/page-heading";
import { MasterSettingsManager } from "@/components/master-settings-manager";

export default function AdminSettingsPage() {
  return (
    <>
      <PageHeading title="分類設定" />
      <MasterSettingsManager />
    </>
  );
}
