import { admin } from "@/lib/db/admin";
import { requireDocAccess } from "@/lib/auth/require";
import { generateToken, sha256hex } from "@/lib/crypto/tokens";
import { env } from "@/lib/env";
import { error, json, noStore } from "@/lib/http";

export const runtime = "nodejs";

/**
 * Owner-only: mint a fresh reusable invite access token for the document and
 * return a shareable URL. Mirrors the token scheme used by POST /api/documents:
 * the plaintext token is shown once (embedded in the URL) and only its SHA-256
 * hash is persisted.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const access = await requireDocAccess(req, slug, "comments:write");
  if (!access.ok) return error(access.status, access.message);
  if (access.access.role !== "owner") return error(403, "Owner role required");

  const db = admin();
  const token = generateToken();
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 90).toISOString(); // 90 days

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
