import { cookies } from "next/headers";
import { env } from "../env";
import { signSession, verifySession, type SessionClaims } from "./session";

const COOKIE = "md_session";

export async function setSessionCookie(claims: SessionClaims): Promise<void> {
  const token = await signSession(claims);
  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    // Secure cookies are dropped by browsers over plain http (WebKit is strict:
    // it refuses Secure cookies even on http://localhost, unlike Chromium), which
    // breaks the session round-trip. Enable in production EXCEPT when the origin is
    // explicitly http:// (CI e2e serves a prod build over http://localhost) — a
    // Secure cookie over http is inoperable anyway, so this never weakens real prod
    // (APP_BASE_URL there is https://).
    secure: process.env.NODE_ENV === "production" && !env.baseUrl.startsWith("http://"),
    sameSite: "lax",
    path: "/",
    maxAge: env.sessionTtlSeconds,
  });
}

export async function readSession(): Promise<SessionClaims | null> {
  const jar = await cookies();
  const raw = jar.get(COOKIE)?.value;
  if (!raw) return null;
  return verifySession(raw);
}

export async function clearSessionCookie(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}
