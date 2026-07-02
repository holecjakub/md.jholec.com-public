import { z } from "zod";
import { stripComments } from "@md/core";
import { admin } from "@/lib/db/admin";
import { requireDocAccess } from "@/lib/auth/require";
import { error, json, noStore } from "@/lib/http";

export const runtime = "nodejs";

// Mirror the create path's cap (documents/route.ts) so an edit can't store a body
// larger than an original upload.
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2,097,152

// Create a NEW version of the document (edit-via-CLI / agent). Owner/PAT only.
// Reviewers never reach this — it requires docs:write and the owner role.
const Body = z.object({
  content: z.string().min(1).max(MAX_UPLOAD_BYTES),
  title: z.string().min(1).max(300).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const access = await requireDocAccess(req, slug, "docs:write");
  if (!access.ok) return error(access.status, access.message);
  if (access.access.role !== "owner") return error(403, "Owner role required");

  // Content-Length pre-check: reject a large body without buffering it.
  const contentLengthHeader = req.headers.get("content-length");
  if (contentLengthHeader !== null && Number(contentLengthHeader) > MAX_UPLOAD_BYTES) {
    return noStore(error(413, "File too large"));
  }

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(400, "Invalid body");

  if (Buffer.byteLength(parsed.data.content, "utf8") > MAX_UPLOAD_BYTES) {
    return noStore(error(413, "File too large"));
  }

  const db = admin();

  const { data: last } = await db
    .from("document_versions")
    .select("version_no")
    .eq("document_id", access.access.documentId)
    .order("version_no", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextNo = (last?.version_no ?? 0) + 1;

  const { data: version, error: vErr } = await db
    .from("document_versions")
    .insert({
      document_id: access.access.documentId,
      version_no: nextNo,
      // Strip any embedded-comments appendix so an edited/pushed file never
      // stores the raw block as document body.
      content: stripComments(parsed.data.content),
    })
    .select("id, version_no")
    .single();
  if (vErr || !version) return error(500, "Failed to create version");

  const patch: Record<string, unknown> = { current_version_id: version.id, updated_at: new Date().toISOString() };
  if (parsed.data.title) patch.title = parsed.data.title;
  await db.from("documents").update(patch).eq("id", access.access.documentId);

  return noStore(json({ versionNo: version.version_no }, 201));
}
