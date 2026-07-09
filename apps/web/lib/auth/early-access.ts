import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { env } from "../env";

const COOKIE = "md_early_access";

function secret(): Uint8Array {
  const value = process.env.SESSION_SIGNING_SECRET;
  if (!value) throw new Error("Missing required env var: SESSION_SIGNING_SECRET");
  return new TextEncoder().encode(value);
}

function ttlSeconds(): number {
  return env.earlyAccessTtlSeconds;
}

/**
 * Signs a minimal HS256 JWT with claim `{ ea: true }` and exp = now + TTL.
 * The payload carries no password, no PII — it is only a tamper-evident
 * "passed the gate" marker.
 */
export async function signEarlyAccessGrant(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = ttlSeconds();
  return new SignJWT({ ea: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + ttl)
    .sign(secret());
}

/**
 * Sets the `md_early_access` httpOnly signed cookie per spec §4.1.
 * Mirrors the same options as `md_session` in cookies.ts.
 */
export async function setEarlyAccessCookie(): Promise<void> {
  const token = await signEarlyAccessGrant();
  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    // Enable in production EXCEPT over an explicit http:// origin (CI e2e serves a
    // prod build over http://localhost; WebKit refuses Secure cookies there).
    // Never weakens real prod (https://). Mirrors lib/auth/cookies.ts.
    secure: process.env.NODE_ENV === "production" && !env.baseUrl.startsWith("http://"),
    sameSite: "lax",
    path: "/",
    maxAge: ttlSeconds(),
  });
}

/**
 * Reads the `md_early_access` cookie and verifies the HS256 JWT.
 * Returns true only when the token is present, has a valid signature,
 * carries the `ea: true` claim, and is not expired.
 * Returns false on any failure — POST /api/documents treats false as "locked".
 */
export async function readEarlyAccessGrant(): Promise<boolean> {
  try {
    const jar = await cookies();
    const raw = jar.get(COOKIE)?.value;
    if (!raw) return false;
    const { payload } = await jwtVerify(raw, secret(), { algorithms: ["HS256"] });
    return payload["ea"] === true;
  } catch {
    return false;
  }
}
