"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { usePathname } from "next/navigation";
import { BotMessageSquare, FolderUp, LogOut, Settings, ShieldCheck } from "lucide-react";
import { clsx } from "clsx";
import { Button } from "@/components/ui";

const navItems = [
  { href: "/", label: "AIアシスタント", icon: BotMessageSquare },
  { href: "/manuals", label: "マニュアル管理", icon: FolderUp },
  { href: "/admin/settings", label: "分類設定", icon: Settings }
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  if (pathname === "/login") {
    return <div className="min-h-screen">{children}</div>;
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--line)] bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-3">
          <Link href="/" className="flex min-w-0 items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-md bg-[var(--primary)] text-white">
              <ShieldCheck size={20} aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block text-base font-semibold leading-5">院内ナレッジAI</span>
              <span className="block text-xs text-[var(--muted)]">Dental Manual Assistant</span>
            </span>
          </Link>
          <nav className="flex items-center gap-1" aria-label="主要メニュー">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active =
                item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={clsx(
                    "flex h-10 items-center gap-2 rounded-md px-3 text-sm font-medium transition",
                    active
                      ? "bg-[#e6f3f1] text-[var(--primary-dark)]"
                      : "text-[#394452] hover:bg-[#eef2f6]"
                  )}
                >
                  <Icon size={17} aria-hidden="true" />
                  <span className="hidden sm:inline">{item.label}</span>
                </Link>
              );
            })}
            <Button variant="ghost" onClick={logout} className="ml-1">
              <LogOut size={17} aria-hidden="true" />
              <span className="hidden sm:inline">ログアウト</span>
            </Button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-5 py-6">{children}</main>
    </div>
  );
}
