import { serializeComments } from "@md/core";
import { admin } from "@/lib/db/admin";
import { hasOwnerContentAuthority, requireDocAccess } from "@/lib/auth/require";
import { buildEmbeddedThreads } from "@/lib/comments/embedded";
import { error } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const access = await requireDocAccess(req, slug, "docs:read");
  if (!access.ok) return error(access.status, access.message);
  // Owner session or a docs:read-scoped PAT (owner-minted, doc-bound); blocks
  // reviewer sessions. PATs no longer carry a synthesized owner role (M1).
  if (!hasOwnerContentAuthority(access.access)) return error(403, "Owner role required");

  const db = admin();
  const { data: doc, error: docErr } = await db
    .from("documents")
    .select("slug, title, current_version_id")
    .eq("id", access.access.documentId)
    .maybeSingle();
  // A DB error is an outage, not a missing row — don't mask it as 404 (audit 3.5).
  if (docErr) return error(500, "Failed to load document");
  if (!doc?.current_version_id) return error(404, "Document not found");

  const { data: version, error: versionErr } = await db
    .from("document_versions")
    .select("content")
    .eq("id", doc.current_version_id)
    .maybeSingle();
  if (versionErr) return error(500, "Failed to load version");
  if (!version) return error(404, "Version not found");

  // Embed the document's comments as an HTML-comment appendix so the downloaded
  // .md is a self-contained record (invisible in any renderer; round-trips via
  // @md/core parseComments). md.jholec.com/comments v1.
  const threads = await buildEmbeddedThreads(access.access.documentId);
  const content = serializeComments(version.content, threads);

  return new Response(content, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${doc.slug}.md"`,
      "Cache-Control": "no-store",
    },
  });
}
