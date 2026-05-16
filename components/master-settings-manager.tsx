"use client";

import { useState } from "react";
import { CirclePlus, Pencil, RotateCcw, Settings, ToggleLeft, ToggleRight, X } from "lucide-react";
import { Button } from "@/components/ui";
import { useMasterSettings } from "@/hooks/use-master-settings";
import {
  masterGroupDescriptions,
  masterGroupLabels,
  type MasterGroupKey,
  type MasterItem
} from "@/lib/master-settings";

const groups: MasterGroupKey[] = ["categories", "clinicalAreas", "roles"];

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
    <div className="space-y-4">
      <div className="flex items-center justify-between rounded-md border border-[#d9e8e5] bg-[#f4fbfa] px-4 py-3">
        <p className="text-sm leading-6 text-[#2f4945]">
          変更はこのブラウザに保存されます。次のAWS連携段階でS3上の設定JSONに移します。
        </p>
        <Button variant="secondary" onClick={reset}>
          <RotateCcw size={16} aria-hidden="true" />
          初期値に戻す
        </Button>
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        {groups.map((group) => (
          <section key={group} className="rounded-md border border-[var(--line)] bg-white">
            <div className="border-b border-[var(--line)] p-5">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#253041]">
                <Settings size={18} className="text-[var(--primary)]" aria-hidden="true" />
                {masterGroupLabels[group]}
              </div>
              <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
                {masterGroupDescriptions[group]}
              </p>
              <form
                className="mt-4 flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  handleAdd(group);
                }}
              >
                <input
                  className="h-10 min-w-0 flex-1 rounded-md border border-[var(--line)] px-3 text-sm outline-none"
                  placeholder={`${masterGroupLabels[group]}を追加`}
                  value={newLabels[group]}
                  onChange={(event) =>
                    setNewLabels((current) => ({ ...current, [group]: event.target.value }))
                  }
                />
                <Button type="submit">
                  <CirclePlus size={17} aria-hidden="true" />
                  追加
                </Button>
              </form>
            </div>
            <div className="divide-y divide-[var(--line)]">
              {settings[group].map((item) => {
                const isEditing = editing?.group === group && editing.id === item.id;

                return (
                  <div key={item.id} className="px-5 py-3">
                    {isEditing ? (
                      <form
                        className="flex items-center gap-2"
                        onSubmit={(event) => {
                          event.preventDefault();
                          saveEditing();
                        }}
                      >
                        <input
                          className="h-10 min-w-0 flex-1 rounded-md border border-[var(--line)] px-3 text-sm outline-none"
                          value={editing.value}
                          onChange={(event) =>
                            setEditing((current) =>
                              current ? { ...current, value: event.target.value } : current
                            )
                          }
                          autoFocus
                        />
                        <Button type="submit" className="px-3">
                          保存
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-10 w-10 px-0"
                          title="キャンセル"
                          onClick={() => setEditing(null)}
                        >
                          <X size={17} aria-hidden="true" />
                        </Button>
                      </form>
                    ) : (
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <span className="block truncate text-sm font-medium text-[#253041]">
                            {item.label}
                          </span>
                          <span className="mt-1 block text-xs text-[var(--muted)]">
                            {item.active ? "有効" : "無効"}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            variant="ghost"
                            className="h-9 w-9 px-0"
                            title="編集"
                            onClick={() => startEditing(group, item)}
                          >
                            <Pencil size={16} aria-hidden="true" />
                          </Button>
                          <Button
                            variant="ghost"
                            className="h-9 w-9 px-0"
                            title={item.active ? "無効化" : "有効化"}
                            onClick={() => toggleItem(group, item.id)}
                          >
                            {item.active ? (
                              <ToggleRight
                                size={19}
                                className="text-[var(--primary)]"
                                aria-hidden="true"
                              />
                            ) : (
                              <ToggleLeft
                                size={19}
                                className="text-[var(--muted)]"
                                aria-hidden="true"
                              />
                            )}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
