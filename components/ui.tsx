import { clsx } from "clsx";

export function Button({
  children,
  variant = "primary",
  size,
  className = "",
  type = "button",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm";
}) {
  return (
    <button
      type={type}
      className={clsx(
        "btn",
        variant !== "primary" && variant,
        size,
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return <label className="label">{children}</label>;
}

export function Badge({ children }: { children: React.ReactNode }) {
  return <span className="tag">{children}</span>;
}

export function FileSpine({
  name,
  ext,
  version,
  size = "md"
}: {
  name: string;
  ext: string;
  version?: string;
  size?: "sm" | "md";
}) {
  const colors = ["#324a6b", "#4a3f5e", "#3f5e54", "#5e4a32", "#2c4a4a", "#4d3f3f"];
  const hash = Array.from(name).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  const title = name.replace(/\.[^.]+$/, "");

  return (
    <div className={clsx("file-spine", size)} style={{ background: colors[hash % colors.length] }}>
      <div className="file-spine-meta">{ext.toUpperCase().slice(0, 4)}</div>
      <div className="file-spine-title">{title}</div>
      <div className="file-spine-meta">{version || "-"}</div>
    </div>
  );
}
