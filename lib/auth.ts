import { appEnv } from "@/lib/env";

export const AUTH_COOKIE_NAME = "dental-share-session";
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isAuthSecretConfigured() {
  return Boolean(appEnv.sharePassword && appEnv.authSecret);
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

async function importSigningKey() {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(appEnv.authSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export function isAuthEnabled() {
  return isAuthSecretConfigured();
}

export async function createSessionToken() {
  const payload = JSON.stringify({ exp: Date.now() + SESSION_TTL_MS });
  const key = await importSigningKey();
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));

  return `${base64UrlEncode(encoder.encode(payload))}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifySessionToken(token: string) {
  if (!isAuthSecretConfigured()) {
    return true;
  }

  const [payloadPart, signaturePart] = token.split(".");
  if (!payloadPart || !signaturePart) {
    return false;
  }

  try {
    const payloadBytes = base64UrlDecode(payloadPart);
    const payload = decoder.decode(payloadBytes);
    const parsed = JSON.parse(payload) as { exp?: number };
    if (typeof parsed.exp !== "number" || Date.now() > parsed.exp) {
      return false;
    }

    const key = await importSigningKey();
    return crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlDecode(signaturePart),
      encoder.encode(payload)
    );
  } catch {
    return false;
  }
}

export function getRedirectTarget(nextPath?: string | null) {
  const fallback = "/";
  if (!nextPath) {
    return fallback;
  }

  if (!nextPath.startsWith("/")) {
    return fallback;
  }

  return nextPath;
}
