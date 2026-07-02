import { SignJWT, jwtVerify } from "jose";

export type Role = "reviewer" | "owner";

export interface SessionClaims {
  doc: string;
  pid: string;
  role: Role;
}

function secret(): Uint8Array {
  const value = process.env.SESSION_SIGNING_SECRET;
  if (!value) throw new Error("Missing required env var: SESSION_SIGNING_SECRET");
  return new TextEncoder().encode(value);
}

function defaultTtlSeconds(): number {
  return Number(process.env.SESSION_TTL_SECONDS ?? "3600");
}

export async function signSession(
  claims: SessionClaims,
  ttlSeconds: number = defaultTtlSeconds(),
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ doc: claims.doc, pid: claims.pid, role: claims.role })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSeconds)
    .sign(secret());
}

export async function verifySession(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    const role = payload.role;
    if ((role !== "reviewer" && role !== "owner") || typeof payload.doc !== "string" || typeof payload.pid !== "string") {
      return null;
    }
    return { doc: payload.doc, pid: payload.pid, role };
  } catch {
    return null;
  }
}
