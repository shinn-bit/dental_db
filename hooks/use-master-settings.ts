"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createMasterId,
  defaultMasterSettings,
  masterStorageKey,
  type MasterGroupKey,
  type MasterSettings
} from "@/lib/master-settings";

function loadSettings(): MasterSettings {
  if (typeof window === "undefined") {
    return defaultMasterSettings;
  }

  const raw = window.localStorage.getItem(masterStorageKey);
  if (!raw) {
    return defaultMasterSettings;
  }

  try {
    return JSON.parse(raw) as MasterSettings;
  } catch {
    return defaultMasterSettings;
  }
}

export function useMasterSettings() {
  const [settings, setSettings] = useState<MasterSettings>(() => loadSettings());

  useEffect(() => {
    window.localStorage.setItem(masterStorageKey, JSON.stringify(settings));
  }, [settings]);

  const actions = useMemo(
    () => ({
      addItem(group: MasterGroupKey, label: string) {
        const trimmed = label.trim();
        if (!trimmed) {
          return;
        }

        setSettings((current) => {
          const exists = current[group].some(
            (item) => item.label.trim().toLowerCase() === trimmed.toLowerCase()
          );
          if (exists) {
            return current;
          }

          const timestamp = new Date().toISOString();
          return {
            ...current,
            [group]: [
              ...current[group],
              {
                id: createMasterId(trimmed),
                label: trimmed,
                active: true,
                createdAt: timestamp,
                updatedAt: timestamp
              }
            ]
          };
        });
      },
      renameItem(group: MasterGroupKey, id: string, label: string) {
        const trimmed = label.trim();
        if (!trimmed) {
          return;
        }

        setSettings((current) => ({
          ...current,
          [group]: current[group].map((item) =>
            item.id === id
              ? {
                  ...item,
                  label: trimmed,
                  updatedAt: new Date().toISOString()
                }
              : item
          )
        }));
      },
      toggleItem(group: MasterGroupKey, id: string) {
        setSettings((current) => ({
          ...current,
          [group]: current[group].map((item) =>
            item.id === id
              ? {
                  ...item,
                  active: !item.active,
                  updatedAt: new Date().toISOString()
                }
              : item
          )
        }));
      },
      reset() {
        setSettings(defaultMasterSettings);
      }
    }),
    []
  );

  return { settings, ...actions };
}
