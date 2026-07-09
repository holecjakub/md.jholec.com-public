import { admin } from "../db/admin";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

// Per-scope thresholds for the IP-only limiter (brief §5.1).
// early_access: 10 — mirrors the per-document password limit; stops brute force while
//   tolerating typos on a single shared tester secret.
// upload: 20 — looser; a legitimate unlocked tester might upload several docs in a
//   sitting; 20/15min stops a script spamming the create path.
// export: 30 — read-only credential; legitimate agents poll occasionally (on-demand),
//   30/15min comfortably covers agent re-reads + human testing while capping scripted
//   token guessing (defense-in-depth; the 256-bit token space makes guessing infeasible
//   regardless). Higher than early_access/upload since reads are cheaper and more frequent.
// redeem: 20 — token-redeem path that mints an owner/reviewer session; throttled before
//   the access_tokens lookup so a leaked-link guesser can't grind it. Moderate: a real
//   user redeems a handful of times (typos on the name gate), not dozens.
// write: 60 — comment/reply/react POSTs. A legitimate reviewer in a session posts several
//   times a minute; 60/15min (~4/min) tolerates active reviewing while capping a script
//   that floods multi-KB rows + realtime fan-out from one IP.
const IP_SCOPE_LIMITS: Record<AttemptScope, number> = {
  early_access: 10,
  upload: 20,
  export: 30,
  redeem: 20,
  write: 60,
};

/** Discriminates IP-only attempt classes from the existing per-document 'password' path. */
export type AttemptScope = "early_access" | "upload" | "export" | "redeem" | "write";

/**
 * Resolve the client IP used as the rate-limit key.
 *
 * SECURITY: the LEFTMOST `x-forwarded-for` entry is set by the client and is freely
 * spoofable — keying on it lets an attacker rotate the header per request and bypass the
 * limiter entirely. So we never trust it. `x-real-ip` is only trustworthy when a proxy
 * we control OVERWRITES it: Vercel's edge does (it stamps the real connecting IP over
 * any client-sent value), so we trust it there — gated on the platform-set VERCEL env.
 * We also honor it outside production (local dev / e2e, where Playwright forges it to
 * isolate rate-limit buckets — not a security boundary). In a NON-Vercel production
 * deploy an unknown proxy may pass a client-forged `x-real-ip` straight through, so we
 * ignore it there. ASSUMPTION: production runs on Vercel; any other deployment target
 * must add its own trusted-header gate here. When untrusted/absent, we fall back to the
 * LAST `x-forwarded-for` hop (the entry the nearest trusted proxy appended), never the
 * first.
 */
export function clientIp(req: Request): string {
  // E2E_TRUST_XRI is set ONLY by the CI e2e webServer (playwright.config.ts) so the
  // suite can forge a per-test x-real-ip to isolate rate-limit buckets. It runs a
  // PRODUCTION build (NODE_ENV=production) over http://localhost, where the two
  // conditions below would otherwise be false; it is never set in Vercel prod.
  const trustRealIp =
    process.env.VERCEL === "1" ||
    process.env.NODE_ENV !== "production" ||
    process.env.E2E_TRUST_XRI === "1";
  if (trustRealIp) {
    const realIp = req.headers.get("x-real-ip")?.trim();
    if (realIp) return realIp;
  }
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const hops = fwd.split(",").map((s) => s.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1] as string;
  }
  return "0.0.0.0";
}

/**
 * Records an attempt and returns its 15-minute-window count in ONE round-trip via the
 * record_auth_attempt RPC (0010 migration) — previously an INSERT plus an exact COUNT
 * as two sequential PostgREST calls on every gated request (perf M9).
 *
 * DEPLOY-ORDER SAFETY: if 0010 hasn't been applied yet the RPC is missing, so we detect
 * that specific error and fall back to the original INSERT-then-COUNT path. This keeps
 * rate limiting fully functional regardless of whether code or migration ships first —
 * the perf win applies once 0010 lands, and there is never a window where limiting is
 * silently off. Any OTHER failure keeps the original tolerant fail-open behavior
 * (switching to fail-closed is a separate hardening decision).
 */
async function recordAttempt(
  documentId: string | null,
  ip: string,
  scope: "password" | AttemptScope,
): Promise<number> {
  const db = admin();
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const { data, error } = await db.rpc("record_auth_attempt", {
    p_document_id: documentId,
    p_ip: ip,
    p_scope: scope,
    p_since: since,
  });
  if (!error && typeof data === "number") return data;

  // PGRST202 (PostgREST: function not in schema cache) / 42883 (undefined_function):
  // migration 0010 not applied yet — fall back to the pre-0010 two-query path.
  if (error && (error.code === "PGRST202" || error.code === "42883")) {
    return recordAttemptFallback(documentId, ip, scope, since);
  }

  console.error("[rate-limit] record_auth_attempt failed", error);
  return 0; // fail-open, see note above
}

/** Pre-0010 path: INSERT the attempt, then COUNT the window (two round-trips). */
async function recordAttemptFallback(
  documentId: string | null,
  ip: string,
  scope: "password" | AttemptScope,
  since: string,
): Promise<number> {
  const db = admin();
  const { error: insErr } = await db
    .from("auth_attempts")
    .insert({ document_id: documentId, ip, scope });
  if (insErr) {
    console.error("[rate-limit] fallback insert failed", insErr);
    return 0; // fail-open
  }
  let q = db
    .from("auth_attempts")
    .select("*", { count: "exact", head: true })
    .eq("ip", ip)
    .eq("scope", scope)
    .gte("created_at", since);
  q = documentId === null ? q.is("document_id", null) : q.eq("document_id", documentId);
  const { count, error: cntErr } = await q;
  if (cntErr || typeof count !== "number") {
    console.error("[rate-limit] fallback count failed", cntErr);
    return 0; // fail-open
  }
  return count;
}

/**
 * Records an attempt and returns true if the caller is over the limit.
 *
 * THRESHOLD INVARIANT (audit 3.7): `recordAttempt` returns the window count INCLUDING
 * the attempt just recorded, so with `count > LIMIT` attempts 1..LIMIT proceed and
 * attempt LIMIT+1 is the first one blocked — exactly "LIMIT attempts per window" as
 * documented above and pinned by e2e/rate-limit-hardening.spec.ts. Do NOT "tidy" this
 * to `>=`: that would silently shrink every budget by one.
 */
export async function isRateLimited(documentId: string, ip: string): Promise<boolean> {
  // scope 'password' matches the DB column default (0005 migration), so these rows stay
  // isolated from the IP-only scopes exactly as before.
  const count = await recordAttempt(documentId, ip, "password");
  return count > MAX_ATTEMPTS;
}

/**
 * Records an IP-only attempt (document_id = null) for the given scope and returns true
 * if the IP is over the per-scope limit for the 15-minute window.
 * Uses idx_auth_attempts_ip_scope (scope, ip, created_at) introduced in 0005.
 * Same threshold invariant as isRateLimited: the count includes the current attempt,
 * so `>` allows exactly LIMIT attempts per window.
 */
export async function isIpRateLimited(ip: string, scope: AttemptScope): Promise<boolean> {
  const count = await recordAttempt(null, ip, scope);
  return count > IP_SCOPE_LIMITS[scope];
}
