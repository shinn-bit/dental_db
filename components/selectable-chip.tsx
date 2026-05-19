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
        "chip",
        selected && "on"
      )}
      aria-pressed={selected}
    >
      {selected ? <Check size={15} aria-hidden="true" /> : null}
      {label}
    </button>
  );
}
