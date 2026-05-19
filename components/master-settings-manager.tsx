"use client";

import { useState } from "react";
import { Edit, Plus, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui";
import { useMasterSettings } from "@/hooks/use-master-settings";
import {
  masterGroupDescriptions,
  type MasterGroupKey,
  type MasterItem
} from "@/lib/master-settings";

const groups: MasterGroupKey[] = ["categories", "clinicalAreas", "roles"];

const labels: Record<MasterGroupKey, string> = {
  categories: "種類",
  clinicalAreas: "診療領域",
  roles: "読む人"
};

const descriptions: Record<MasterGroupKey, string> = {
  categories: "資料の大まかな性質。「治療マニュアル」「受付・接遇」など、本棚で資料を分けるための見出しです。",
  clinicalAreas: "歯周・インプラントなど、診療科目ごとの絞り込みに使います。",
  roles: "資料を読む対象の職種。新人衛生士向け、受付向けなど、AIの参照範囲を調整するときにも使われます。"
};

type EditingState = {
  group: MasterGroupKey;
  id: string;
  value: string;
} | null;

export function MasterSettingsManager() {
  const { settings, addItem, renameItem, toggleItem, reset } = useMasterSettings();
  const [newLabels, setNewLabels] = useState<Record<MasterGroupKey, string>>({
    categories: "",
    clinicalAreas: "",
    roles: ""
  });
  const [editing, setEditing] = useState<EditingState>(null);

  function handleAdd(group: MasterGroupKey) {
    addItem(group, newLabels[group]);
    setNewLabels((current) => ({ ...current, [group]: "" }));
  }

  function startEditing(group: MasterGroupKey, item: MasterItem) {
    setEditing({ group, id: item.id, value: item.label });
  }

  function saveEditing() {
    if (!editing) {
      return;
    }
    renameItem(editing.group, editing.id, editing.value);
    setEditing(null);
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, padding: "12px 16px", background: "var(--navy-tint-soft)", border: "1px solid var(--navy-tint)", borderRadius: 10, marginBottom: 20 }}>
        <div className="small" style={{ color: "var(--navy-deep)", lineHeight: 1.6 }}>
          ここで設定したラベルは、資料管理の「種類」「診療領域」「読む人」、および AIチャットの絞り込みに使われます。
        </div>
        <Button variant="secondary" size="sm" onClick={reset}>
          <RefreshCw size={13} aria-hidden="true" />
          初期値に戻す
        </Button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 20, alignItems: "start" }}>
        {groups.map((group) => (
          <section key={group} className="panel" style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ padding: "18px 22px 16px", borderBottom: "1px solid var(--line)" }}>
              <div className="row" style={{ gap: 8, marginBottom: 4 }}>
                <span className="panel-title">{labels[group]}</span>
                <span className="tiny soft" style={{ letterSpacing: "0.04em" }}>{settings[group].length} 件</span>
              </div>
              <p className="small soft" style={{ margin: 0, lineHeight: 1.65 }}>
                {descriptions[group] || masterGroupDescriptions[group]}
              </p>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  handleAdd(group);
                }}
                style={{ display: "flex", gap: 8, marginTop: 14 }}
              >
                <input
                  className="input"
                  placeholder={`${labels[group]}を追加`}
                  value={newLabels[group]}
                  onChange={(event) => setNewLabels((current) => ({ ...current, [group]: event.target.value }))}
                  style={{ flex: 1, height: 38 }}
                />
                <Button type="submit" size="sm">
                  <Plus size={14} aria-hidden="true" />
                  追加
                </Button>
              </form>
            </div>
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {settings[group].map((item) => {
                const isEditing = editing?.group === group && editing.id === item.id;
                return (
                  <li
                    key={item.id}
                    style={{ padding: "12px 22px", borderBottom: "1px solid var(--line-soft)", display: "flex", alignItems: "center", gap: 12, opacity: item.active ? 1 : 0.55, background: isEditing ? "var(--navy-tint-soft)" : "transparent" }}
                  >
                    {isEditing ? (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault();
                          saveEditing();
                        }}
                        style={{ display: "flex", gap: 6, flex: 1 }}
                      >
                        <input
                          autoFocus
                          className="input"
                          value={editing.value}
                          onChange={(event) => setEditing((current) => current ? { ...current, value: event.target.value } : current)}
                          style={{ flex: 1, height: 34 }}
                        />
                        <Button type="submit" size="sm">
                          保存
                        </Button>
                        <button type="button" className="btn ghost sm icon" title="キャンセル" onClick={() => setEditing(null)}>
                          <X size={13} aria-hidden="true" />
                        </button>
                      </form>
                    ) : (
                      <>
                        <div className="stack" style={{ flex: 1, minWidth: 0, gap: 2 }}>
                          <span style={{ fontSize: 13, fontWeight: 500, color: "var(--ink)" }} className="truncate">
                            {item.label}
                          </span>
                          <span className="tiny soft" style={{ letterSpacing: "0.04em" }}>
                            {item.active ? "有効" : "無効・絞り込み候補から外れます"}
                          </span>
                        </div>
                        <div className="row" style={{ gap: 2 }}>
                          <button type="button" className="btn ghost sm icon" title="名前を変更" onClick={() => startEditing(group, item)}>
                            <Edit size={13} aria-hidden="true" />
                          </button>
                          <ToggleSwitch on={item.active} onChange={() => toggleItem(group, item.id)} />
                        </div>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function ToggleSwitch({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      onClick={onChange}
      title={on ? "無効にする" : "有効にする"}
      style={{ width: 34, height: 20, borderRadius: 999, border: `1px solid ${on ? "var(--navy)" : "var(--line)"}`, background: on ? "var(--navy)" : "var(--panel-deep)", position: "relative", cursor: "pointer", transition: "all .15s ease", padding: 0 }}
    >
      <span style={{ position: "absolute", top: 1, left: on ? 15 : 1, width: 16, height: 16, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,0.12)", transition: "left .15s ease" }} />
      <span className="sr-only">{on ? "有効" : "無効"}</span>
    </button>
  );
}
