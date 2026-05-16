import { timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, createSessionToken, isAuthEnabled } from "@/lib/auth";
import { appEnv } from "@/lib/env";

export async function POST(request: Request) {
  if (!isAuthEnabled()) {
    return NextResponse.json({ ok: true, disabled: true });
  }

  const body = (await request.json().catch(() => ({}))) as { password?: string };
  const password = body.password || "";

  const expected = Buffer.from(appEnv.sharePassword, "utf8");
  const actual = Buffer.from(password, "utf8");
  const matches =
    expected.length === actual.length && timingSafeEqual(expected, actual);

  if (!matches) {
    return NextResponse.json({ error: "パスワードが違います。" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: AUTH_COOKIE_NAME,
    value: await createSessionToken(),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 14
  });

  return response;
}
