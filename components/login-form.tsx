"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { LockKeyhole, LogIn } from "lucide-react";
import { Button } from "@/components/ui";

export function LoginForm({ nextPath }: { nextPath: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password })
      });
      const data = (await response.json()) as { error?: string; disabled?: boolean };

      if (!response.ok) {
        throw new Error(data.error || "ログインに失敗しました。");
      }

      setPassword("");
      router.replace(nextPath);
      router.refresh();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "ログインに失敗しました。");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={handleSubmit}>
      <div>
        <label className="mb-1.5 block text-sm font-semibold text-[#253041]">共有パスワード</label>
        <div className="flex items-center gap-2 rounded-md border border-[var(--line)] bg-white px-3">
          <LockKeyhole size={16} className="shrink-0 text-[var(--muted)]" aria-hidden="true" />
          <input
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            autoComplete="current-password"
            className="h-11 w-full border-0 bg-transparent text-sm outline-none"
            placeholder="パスワードを入力"
          />
        </div>
      </div>

      {error ? <p className="text-sm text-[#b42318]">{error}</p> : null}

      <Button type="submit" className="w-full" disabled={loading}>
        <LogIn size={16} aria-hidden="true" />
        {loading ? "確認中..." : "入室"}
      </Button>
    </form>
  );
}
