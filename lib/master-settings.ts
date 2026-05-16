export type MasterGroupKey = "categories" | "clinicalAreas" | "roles";

export type MasterItem = {
  id: string;
  label: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MasterSettings = Record<MasterGroupKey, MasterItem[]>;

export const masterGroupLabels: Record<MasterGroupKey, string> = {
  categories: "カテゴリ",
  clinicalAreas: "診療領域",
  roles: "対象職種"
};

export const masterGroupDescriptions: Record<MasterGroupKey, string> = {
  categories: "資料の大分類。アップロード時に複数選択できます。",
  clinicalAreas: "治療分野や業務領域。医院独自の分類を追加できます。",
  roles: "資料を主に参照する職種。複数選択を前提にします。"
};

const now = "2026-05-16T00:00:00.000Z";

function item(id: string, label: string): MasterItem {
  return {
    id,
    label,
    active: true,
    createdAt: now,
    updatedAt: now
  };
}

export const defaultMasterSettings: MasterSettings = {
  categories: [
    item("treatment-manual", "治療マニュアル"),
    item("internal-rule", "院内ルール"),
    item("new-staff-training", "新人教育"),
    item("equipment", "器材"),
    item("interview", "問診"),
    item("other", "その他")
  ],
  clinicalAreas: [
    item("periodontal", "歯周病"),
    item("prosthodontics", "補綴"),
    item("operative", "保存"),
    item("orthodontics", "矯正"),
    item("pediatric", "小児"),
    item("implant", "インプラント"),
    item("common", "共通")
  ],
  roles: [
    item("dentist", "歯科医師"),
    item("hygienist", "歯科衛生士"),
    item("assistant", "助手"),
    item("reception", "受付"),
    item("all", "全員")
  ]
};

export const masterStorageKey = "dental-master-settings-v1";

export function createMasterId(label: string) {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]/gu, "");

  return `${slug || "item"}-${crypto.randomUUID().slice(0, 8)}`;
}
