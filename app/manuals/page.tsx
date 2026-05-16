import { PageHeading } from "@/components/page-heading";
import { ManualsManager } from "@/components/manuals-manager";

export default function ManualsPage() {
  return (
    <>
      <PageHeading
        title="マニュアル管理"
        description="資料の追加、分類付け、AI読み込み対象の確認を行います。"
      />

      <ManualsManager />
    </>
  );
}
