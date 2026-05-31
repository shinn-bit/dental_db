import { ManualRepositoryPanel } from "@/components/manual-repository-panel";

export default function ManualRepositoryPage() {
  return (
    <div style={{ flex: 1, display: "flex", alignItems: "stretch", minHeight: 0 }}>
      <ManualRepositoryPanel />
    </div>
  );
}
