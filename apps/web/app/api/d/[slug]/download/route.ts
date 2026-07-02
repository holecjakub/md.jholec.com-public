import { serializeComments } from "@md/core";
import { admin } from "@/lib/db/admin";
import { requireDocAccess } from "@/lib/auth/require";
import { buildEmbeddedThreads } from "@/lib/comments/embedded";
import { error } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const access = await requireDocAccess(req, slug, "docs:read");
  if (!access.ok) return error(access.status, access.message);
  if (access.access.role !== "owner") return error(403, "Owner role required");

  const db = admin();
  const { data: doc } = await db
    .from("documents")
    .select("slug, title, current_version_id")
    .eq("id", access.access.documentId)
    .single();
  if (!doc?.current_version_id) return error(404, "Document not found");

  const { data: version } = await db
    .from("document_versions")
    .select("content")
    .eq("id", doc.current_version_id)
    .single();
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
