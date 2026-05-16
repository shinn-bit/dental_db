import { clsx } from "clsx";

export function Button({
  children,
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
}) {
  return (
    <button
      className={clsx(
        "inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-55",
        variant === "primary" && "bg-[var(--primary)] text-white hover:bg-[var(--primary-dark)]",
        variant === "secondary" &&
          "border border-[var(--line)] bg-white text-[#253041] hover:bg-[#f0f3f6]",
        variant === "ghost" && "text-[#394452] hover:bg-[#eef2f6]",
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="mb-1.5 block text-sm font-semibold text-[#253041]">{children}</label>;
}

export function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-[#d7e7e4] bg-[#eef8f6] px-2 py-1 text-xs font-medium text-[var(--primary-dark)]">
      {children}
    </span>
  );
}
