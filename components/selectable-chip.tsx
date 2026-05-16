"use client";

import { Check } from "lucide-react";
import { clsx } from "clsx";

type SelectableChipProps = {
  label: string;
  selected: boolean;
  onToggle: () => void;
};

export function SelectableChip({ label, selected, onToggle }: SelectableChipProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={clsx(
        "inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition",
        selected
          ? "border-[#99d4cc] bg-[#e6f3f1] text-[var(--primary-dark)]"
          : "border-[var(--line)] bg-white text-[#394452] hover:bg-[#f5f7f9]"
      )}
      aria-pressed={selected}
    >
      {selected ? <Check size={15} aria-hidden="true" /> : null}
      {label}
    </button>
  );
}
