"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { BookOpen } from "lucide-react";
import { clsx } from "clsx";

const navItems = [
  { href: "/", label: "AIチャット" },
  { href: "/manual", label: "解説書作成" },
  { href: "/repository", label: "資料庫" },
  { href: "/manual-repository", label: "保管庫" },
  { href: "/insurance", label: "保険請求" },
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
    <div className="app">
      <header className="header">
        <div className="header-inner">
          <Link href="/" className="brand">
            <span className="brand-mark" aria-hidden="true">
              <BookOpen size={20} strokeWidth={1.6} />
            </span>
            <span className="brand-text">
              <span className="brand-title serif">院内ナレッジ</span>
              <span className="brand-sub">Clinic Knowledge</span>
            </span>
          </Link>
          <nav className="nav" aria-label="主要メニュー">
            {navItems.map((item) => {
              const active = item.href === "/"
                ? pathname === "/"
                : pathname === item.href || pathname.startsWith(item.href + "/");
              return (
                <Link key={item.href} href={item.href} className={clsx("nav-item", active && "active")}>
                  {item.label}
                </Link>
              );
            })}
            <span className="nav-divider" />
            <button type="button" className="nav-item nav-ghost" onClick={logout}>
              ログアウト
            </button>
          </nav>
        </div>
      </header>
      <main className="main">{children}</main>
    </div>
  );
}
