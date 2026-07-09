import { admin } from "@/lib/db/admin";
import { requireDocAccess } from "@/lib/auth/require";
import { OWNER_SCOPE } from "@/lib/auth/pat";
import { generateToken, sha256hex } from "@/lib/crypto/tokens";
import { env } from "@/lib/env";
import { error, json, noStore } from "@/lib/http";

export const runtime = "nodejs";

/**
 * Owner-only: mint a fresh reusable invite access token for the document and
 * return a shareable URL. Mirrors the token scheme used by POST /api/documents:
 * the plaintext token is shown once (embedded in the URL) and only its SHA-256
 * hash is persisted.
 *
 * Credential-minting route: requires TRUE owner authority — an owner cookie
 * session, or a PAT explicitly granted the "tokens:mint" scope. Content-scoped
 * PATs must not be able to mint invite links (security review M1).
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const access = await requireDocAccess(req, slug, "comments:write");
  if (!access.ok) return error(access.status, access.message);
  if (!access.access.ownerAuthority) return error(403, "Owner role required");

  const db = admin();
  const token = generateToken();
  // 30 days (security review L7) — aligned with POST /api/documents and the 30-day
  // document retention window, so an invite never outlives the document it unlocks.
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();

  const { error: tErr } = await db.from("access_tokens").insert({
    document_id: access.access.documentId,
    token_hash: sha256hex(token),
    kind: "invite",
    reusable: true,
    expires_at: expires,
  });
  if (tErr) return error(500, "Failed to create share link");

  const res = noStore(json({ shareUrl: `${env.baseUrl}/d/${slug}#t=${token}` }, 201));
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}

/**
 * Revoke ALL reusable invite links for this document (security review M2): sets
 * revoked_at = now() on every live invite access token, killing shared URLs
 * immediately (the redeem route already rejects revoked tokens).
 *
 * Deliberately scoped to kind = 'invite': owner capability tokens are how the owner
 * re-enters their own document — revoking them here would lock the owner out.
 *
 * Credential-revoking route: gated exactly like minting (M1) — TRUE owner authority
 * only (owner cookie session, or a PAT granted "tokens:mint").
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const access = await requireDocAccess(req, slug, OWNER_SCOPE);
  if (!access.ok) return error(access.status, access.message);
  if (!access.access.ownerAuthority) return error(403, "Owner role required");

  const db = admin();
  const { data, error: e } = await db
    .from("access_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("document_id", access.access.documentId)
    .eq("kind", "invite")
    .is("revoked_at", null)
    .select("id");
  if (e) return error(500, "Failed to revoke share links");

  return noStore(json({ revoked: data?.length ?? 0 }));
}
