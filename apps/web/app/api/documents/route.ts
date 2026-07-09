import { z } from "zod";
import { stripComments } from "@md/core";
import { admin } from "@/lib/db/admin";
import { generateSlug } from "@/lib/db/slug";
import { generateToken, sha256hex } from "@/lib/crypto/tokens";
import { hashPassword } from "@/lib/crypto/password";
import { mintExportToken } from "@/lib/auth/pat";
import { env } from "@/lib/env";
import { error, json, noStore } from "@/lib/http";
import { clientIp, isIpRateLimited } from "@/lib/auth/rate-limit";
import { readEarlyAccessGrant } from "@/lib/auth/early-access";

export const runtime = "nodejs";

// ~2 MB cap aligned with the UX 2 MB file cap (brief §3.2).
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2,097,152

const Body = z.object({
  title: z.string().min(1).max(300),
  content: z.string().min(1),
  // Min 8 (security review L1): the prior 4-char floor amplified an offline
  // crack of a leaked password_hash.
  password: z.string().min(8).max(200),
});

export async function POST(req: Request) {
  // §3.1 Gate enforcement: require a valid unlock cookie before any processing.
  // Returns false on missing cookie, bad signature, wrong claim, or expiry.
  const granted = await readEarlyAccessGrant();
  if (!granted) {
    return noStore(error(403, "Upload is locked"));
  }

  // §3.2 Content-Length pre-check: reject a large body without buffering it.
  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader !== null && Number(contentLengthHeader) > MAX_UPLOAD_BYTES) {
    return noStore(error(413, "File too large"));
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(400, "Invalid body");
  const { title, password } = parsed.data;

  // §3.2 Decoded-content check: enforce cap on the markdown content field (the actual
  // file payload), measured in UTF-8 bytes to match a 2 MB file on disk.
  if (Buffer.byteLength(parsed.data.content, "utf8") > MAX_UPLOAD_BYTES) {
    return noStore(error(413, "File too large"));
  }

  // Strip any embedded-comments appendix so re-uploading a downloaded .md never
  // stores the raw block as document body (md.jholec.com/comments convention).
  const content = stripComments(parsed.data.content);

  // §3.5 Upload rate limiting: per-IP, looser threshold than the password path.
  // Runs after body parse so we don't pay DB cost for blatantly malformed requests.
  const ip = clientIp(req);
  if (await isIpRateLimited(ip, "upload")) {
    return noStore(error(429, "Too many uploads"));
  }

  const db = admin();
  const slug = generateSlug();
  const passwordHash = await hashPassword(password);

  const { data: doc, error: dErr } = await db
    .from("documents")
    .insert({ slug, title, password_hash: passwordHash })
    .select("id, slug, expires_at")
    .single();
  if (dErr || !doc) return error(500, "Failed to create document");

  const { data: version, error: vErr } = await db
    .from("document_versions")
    .insert({ document_id: doc.id, version_no: 1, content })
    .select("id")
    .single();
  if (vErr || !version) return error(500, "Failed to create version");

  await db.from("documents").update({ current_version_id: version.id }).eq("id", doc.id);

  const inviteToken = generateToken();
  const ownerToken = generateToken();
  // §3.3 Token expiry aligned to 30 days — matches documents.expires_at retention.
  // (Was 90 days; shortened so a token never outlives the document it unlocks.)
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString(); // 30 days — matches documents.expires_at retention

  const { error: tErr } = await db.from("access_tokens").insert([
    { document_id: doc.id, token_hash: sha256hex(inviteToken), kind: "invite", reusable: true, expires_at: expires },
    { document_id: doc.id, token_hash: sha256hex(ownerToken), kind: "owner", reusable: true, expires_at: expires },
  ]);
  if (tErr) return error(500, "Failed to create access tokens");

  // Mint a read-only agent export PAT bound to this document. Scopes are server-pinned
  // to ['docs:read','comments:read'] with a 30-day TTL. The agent link is a GET
  // capability URL (token in the path) so it works when pasted into a generic LLM
  // (ChatGPT etc.) that just fetches the URL. Read-only / single-doc / revocable.
  let exportToken: string;
  try {
    ({ token: exportToken } = await mintExportToken(doc.id));
  } catch {
    return error(500, "Failed to create export token");
  }

  // §3.4 Return expiresAt (ISO timestamptz read back from DB default) for the UI
  // ExpiryHint ("Auto-deletes on <date>"). §3.6 Add Referrer-Policy: no-referrer.
  const res = noStore(
    json(
      {
        slug: doc.slug,
        shareUrl: `${env.baseUrl}/d/${doc.slug}#t=${inviteToken}`,
        ownerUrl: `${env.baseUrl}/d/${doc.slug}#o=${ownerToken}`,
        // GET capability URL: a plain fetch of this path returns the document +
        // comments as static HTML, so it works pasted into ChatGPT/any LLM. The
        // read-only token is in the path (acceptable: read-only, single-doc, revocable).
        agentUrl: `${env.baseUrl}/d/${doc.slug}/agent/${exportToken}`,
        expiresAt: doc.expires_at, // ISO timestamptz, for the UI ExpiryHint ("Auto-deletes on <date>")
      },
      201,
    ),
  );
  res.headers.set("Referrer-Policy", "no-referrer");
  return res;
}
