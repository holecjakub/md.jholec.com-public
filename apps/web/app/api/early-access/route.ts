import { z } from "zod";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { error, json, noStore } from "@/lib/http";
import { clientIp, isIpRateLimited } from "@/lib/auth/rate-limit";
import { setEarlyAccessCookie } from "@/lib/auth/early-access";
import { sha256hex, constantTimeEqualHex } from "@/lib/crypto/tokens";

export const runtime = "nodejs";

const Body = z.object({
  password: z.string().min(1).max(200),
});

function withSecurityHeaders(res: NextResponse): NextResponse {
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}

export async function POST(req: Request): Promise<Response> {
  // All responses must carry no-store and no-referrer (brief §2.1).
  // Parse body first; if unparseable we still need both headers on the 400.
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return withSecurityHeaders(noStore(error(400, "Invalid body")));
  }

  // Rate-limit BEFORE password compare (brief §2.2 step 3): a throttled client is
  // rejected regardless of password correctness — no oracle possible.
  const ip = clientIp(req);
  if (await isIpRateLimited(ip, "early_access")) {
    return withSecurityHeaders(noStore(error(429, "Too many attempts")));
  }

  // Read the expected password from env (brief §2.2 step 4). The value is provisioned
  // outside git (apps/web/.env.local for dev/tests, host env in production) — there is no
  // literal fallback in source. If it resolves to an empty string, treat as misconfig and
  // fail closed so a misconfigured deploy can never open the gate.
  const expected = env.earlyAccessPassword;
  if (!expected) {
    // Non-secret misconfig log only — never log the submitted or expected password value.
    console.error("EARLY_ACCESS_PASSWORD not set");
    return withSecurityHeaders(noStore(error(500, "Server misconfiguration")));
  }

  // Timing-safe compare: hash both sides to fixed-width SHA-256 hex (64 chars) then use
  // constantTimeEqualHex (wraps node:crypto.timingSafeEqual). Avoids length short-circuit
  // that === would have on strings of differing lengths (brief §2.2 step 5).
  const match = constantTimeEqualHex(sha256hex(parsed.data.password), sha256hex(expected));
  if (!match) {
    return withSecurityHeaders(noStore(error(401, "Wrong password")));
  }

  // On match: set the unlock cookie, then return 200. The cookie is set via next/headers
  // cookies() which emits Set-Cookie on the response (brief §4, §4.3).
  await setEarlyAccessCookie();
  return withSecurityHeaders(noStore(json({ ok: true }, 200)));
}
