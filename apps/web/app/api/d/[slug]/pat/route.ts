import { z } from "zod";
import { admin } from "@/lib/db/admin";
import { generateToken, sha256hex } from "@/lib/crypto/tokens";
import { requireDocAccess } from "@/lib/auth/require";
import { mintExportToken } from "@/lib/auth/pat";
import { error, json, noStore } from "@/lib/http";

export const runtime = "nodejs";

// Server-side scope allow-list (security review C1): the client can no longer
// request arbitrary scope strings.
const ALLOWED_SCOPES = [
  "docs:read",
  "docs:write",
  "comments:read",
  "comments:write",
] as const;

const Body = z
  .object({
    name: z.string().min(1).max(120),
    // Existing free-form mint (CLI write tokens) still allowed.
    scopes: z.array(z.enum(ALLOWED_SCOPES)).min(1).optional(),
    // NEW: when kind === 'export', server FORCES read-only scopes and ignores `scopes`.
    // Client cannot widen or change the scopes for an export token.
    kind: z.enum(["cli", "export"]).default("cli"),
  })
  .refine((b) => b.kind === "export" || (b.scopes && b.scopes.length > 0), {
    message: "scopes required for cli tokens",
  });

/**
 * Mint a CLI Personal Access Token or a read-only export token. The endpoint is
 * OWNER-gated and the token is bound to THIS document only (security review C1 + C2).
 *
 * kind === 'cli'    → scopes provided by the client (must be non-empty).
 * kind === 'export' → scopes SERVER-PINNED to ['docs:read','comments:read'].
 *                     Client cannot inject or widen scopes. TTL = 30 days.
 *                     This is the token an owner hands to an AI agent.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;

  const access = await requireDocAccess(req, slug, "docs:write");
  if (!access.ok) return error(access.status, access.message);
  if (access.access.role !== "owner") return error(403, "Owner access required");

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(400, "Invalid body");

  // Export tokens: delegate to the shared mintExportToken helper — scopes are
  // SERVER-PINNED to ['docs:read','comments:read'], TTL is 30 days. The name field
  // is ignored for export tokens (the helper supplies a fixed name).
  if (parsed.data.kind === "export") {
    let token: string;
    try {
      ({ token } = await mintExportToken(access.access.documentId));
    } catch {
      return error(500, "Failed to create token");
    }
    const res = noStore(json({ token }, 201));
    res.headers.set("Referrer-Policy", "no-referrer");
    return res;
  }

  // CLI token: scopes provided by the client; no expiry.
  const scopes = parsed.data.scopes!;
  const token = `pat_${generateToken()}`;
  const db = admin();
  const { error: e } = await db.from("personal_access_tokens").insert({
    token_hash: sha256hex(token),
    name: parsed.data.name,
    scopes: [...scopes],
    document_id: access.access.documentId,
    expires_at: null,
  });
  if (e) return error(500, "Failed to create token");

  const res = noStore(json({ token }, 201)); // shown once
  // No-referrer on both kinds — the token is in the body, not a URL, but set
  // the header for defence-in-depth and parity with the redeem route.
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}
