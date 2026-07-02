import { admin } from "@/lib/db/admin";
import { requireDocAccess } from "@/lib/auth/require";
import { error, json } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const access = await requireDocAccess(req, slug, "docs:read");
  if (!access.ok) return error(access.status, access.message);

  const db = admin();
  const { data: doc } = await db
    .from("documents")
    .select("slug, title, current_version_id")
    .eq("id", access.access.documentId)
    .single();
  if (!doc) return error(404, "Document not found");

  const { data: version } = await db
    .from("document_versions")
    .select("version_no, content")
    .eq("id", doc.current_version_id)
    .single();
  if (!version) return error(404, "Version not found");

  // Participant roster (names only) for the owner toolbar. Cheap single query;
  // names are not secret to a session holder for this document.
  const { data: participantRows } = await db
    .from("participants")
    .select("id, display_name, role")
    .eq("document_id", access.access.documentId)
    .order("created_at", { ascending: true });

  return json({
    document: { slug: doc.slug, title: doc.title },
    documentId: access.access.documentId,
    version: { versionNo: version.version_no, content: version.content },
    role: access.access.role,
    participantId: access.access.participantId,
    participants: (participantRows ?? []).map((p) => ({
      id: p.id,
      name: p.display_name,
      role: p.role,
    })),
  });
}
