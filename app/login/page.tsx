import { LoginForm } from "@/components/login-form";
import { getRedirectTarget } from "@/lib/auth";

export default function LoginPage({
  searchParams
}: {
  searchParams?: { next?: string | string[] };
}) {
  const nextPath = getRedirectTarget(
    typeof searchParams?.next === "string" ? searchParams.next : null
  );
  return (
    <div className="mx-auto flex min-h-[calc(100vh-3rem)] max-w-5xl items-center px-4 py-8">
      <div className="grid w-full gap-0 overflow-hidden rounded-md border border-[var(--line)] bg-white shadow-[0_18px_60px_rgba(17,24,39,0.08)] md:grid-cols-[1.15fr_0.85fr]">
        <section className="bg-[linear-gradient(135deg,#0f766e_0%,#115e59_48%,#0f3b39_100%)] px-7 py-8 text-white md:px-10 md:py-12">
          <p className="mb-3 text-sm font-semibold tracking-wide text-white/75">Clinic Knowledge Repository</p>
          <h1 className="text-2xl font-semibold leading-tight md:text-3xl">院内ナレッジAI</h1>
          <p className="mt-4 max-w-xl text-sm leading-6 text-white/85">
            マニュアル、院内ルール、新人教育資料をまとめて扱う共有画面です。入室には共有パスワードが必要です。
          </p>
        </section>

        <section className="px-7 py-8 md:px-10 md:py-12">
          <h2 className="text-lg font-semibold text-[#253041]">ログイン</h2>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">
            共有リンクで開くときは、ここでパスワードを入力してください。
          </p>
          <div className="mt-6">
            <LoginForm nextPath={nextPath} />
          </div>
        </section>
      </div>
    </div>
  );
}
