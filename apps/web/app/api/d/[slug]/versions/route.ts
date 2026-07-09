import { z } from "zod";
import { stripComments } from "@md/core";
import { admin } from "@/lib/db/admin";
import { hasOwnerContentAuthority, requireDocAccess } from "@/lib/auth/require";
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
  // Owner session or a docs:write-scoped PAT (owner-minted, doc-bound); blocks
  // reviewer sessions. PATs no longer carry a synthesized owner role (M1).
  if (!hasOwnerContentAuthority(access.access)) return error(403, "Owner role required");

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

  // Strip any embedded-comments appendix so an edited/pushed file never
  // stores the raw block as document body.
  const content = stripComments(parsed.data.content);

  // Read-max-then-insert is racy: two concurrent pushes can compute the same
  // nextNo, and the loser trips unique(document_id, version_no) with 23505
  // (audit 3.6). Retry the read+insert so the loser lands on max+2 instead of a
  // generic 500 that silently drops the edit; if contention persists past the
  // retries, surface an explicit 409 the client can retry.
  const MAX_VERSION_INSERT_ATTEMPTS = 3;
  let version: { id: string; version_no: number } | null = null;
  for (let attempt = 0; attempt < MAX_VERSION_INSERT_ATTEMPTS && !version; attempt++) {
    const { data: last, error: lastErr } = await db
      .from("document_versions")
      .select("version_no")
      .eq("document_id", access.access.documentId)
      .order("version_no", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastErr) return error(500, "Failed to create version");
    const nextNo = (last?.version_no ?? 0) + 1;

    const { data: inserted, error: vErr } = await db
      .from("document_versions")
      .insert({
        document_id: access.access.documentId,
        version_no: nextNo,
        content,
      })
      .select("id, version_no")
      .single();
    if (vErr) {
      // 23505 unique_violation: a concurrent push claimed this version_no —
      // re-read the max and try again.
      if (vErr.code === "23505") continue;
      return error(500, "Failed to create version");
    }
    version = inserted;
  }
  if (!version) return error(409, "Version conflict — a concurrent edit won; retry the push");

  const patch: Record<string, unknown> = { current_version_id: version.id, updated_at: new Date().toISOString() };
  if (parsed.data.title) patch.title = parsed.data.title;
  // If this pointer flip fails the document still serves the previous version —
  // surface that instead of reporting a success the reader will never see.
  const { error: updErr } = await db
    .from("documents")
    .update(patch)
    .eq("id", access.access.documentId);
  if (updErr) return error(500, "Failed to update document");

  return noStore(json({ versionNo: version.version_no }, 201));
}
