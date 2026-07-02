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
 * limiter entirely. So we never trust it. On Vercel the platform sets `x-real-ip` to the
 * real connecting IP (overwriting any client-sent value at the edge), so we prefer that.
 * If absent (local dev / tests — not a security boundary), we fall back to the LAST
 * `x-forwarded-for` hop (the entry the nearest trusted proxy appended), never the first.
 */
export function clientIp(req: Request): string {
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const hops = fwd.split(",").map((s) => s.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1] as string;
  }
  return "0.0.0.0";
}

/** Records an attempt and returns true if the caller is over the limit. */
export async function isRateLimited(documentId: string, ip: string): Promise<boolean> {
  const db = admin();
  // scope defaults to 'password' at the DB level (0005 migration), so existing rows and
  // new inserts here are isolated from the early_access / upload scopes.
  await db.from("auth_attempts").insert({ document_id: documentId, ip });
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const { count } = await db
    .from("auth_attempts")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .eq("ip", ip)
    .gte("created_at", since);
  // NOTE: a robust fail-closed-on-DB-error variant was attempted but reverted — this
  // head+count query returns a null `count` (and an occasional non-null `error`) on
  // normal/under-load success, so neither signal can distinguish "DB outage" from "0
  // rows". Doing it safely needs a different query shape (count rows in JS or an RPC);
  // tracked as follow-up hardening. Keep the original tolerant behavior for now.
  return (count ?? 0) > MAX_ATTEMPTS;
}

/**
 * Records an IP-only attempt (document_id = null) for the given scope and returns true
 * if the IP is over the per-scope limit for the 15-minute window.
 * Uses idx_auth_attempts_ip_scope (scope, ip, created_at) introduced in 0005.
 */
export async function isIpRateLimited(ip: string, scope: AttemptScope): Promise<boolean> {
  const db = admin();
  await db.from("auth_attempts").insert({ document_id: null, ip, scope });
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const { count } = await db
    .from("auth_attempts")
    .select("id", { count: "exact", head: true })
    .eq("scope", scope)
    .eq("ip", ip)
    .gte("created_at", since);
  // See isRateLimited: fail-closed-on-error was reverted because this head+count query's
  // count/error signals can't distinguish a DB outage from a 0-row result here. Follow-up.
  const max = IP_SCOPE_LIMITS[scope];
  return (count ?? 0) > max;
}
