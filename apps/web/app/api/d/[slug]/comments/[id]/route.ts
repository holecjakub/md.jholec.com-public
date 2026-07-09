import { z } from "zod";
import { admin } from "@/lib/db/admin";
import { hasOwnerContentAuthority, requireDocAccess } from "@/lib/auth/require";
import { getEnrichedComment } from "@/lib/comments/list";
import { scheduleDocumentChangeBroadcast } from "@/lib/realtime/broadcast";
import { error, json } from "@/lib/http";

export const runtime = "nodejs";

const Body = z.object({ status: z.enum(["open", "resolved"]) });

/**
 * Single-comment read backing the realtime delta refetch (perf C4/H9): a
 * broadcast signal carries one commentId, so clients fetch just that comment
 * instead of the whole list. Same auth shape as the list route — owner/reviewer
 * session or a comments:read-scoped PAT. Enriched (author_name + reactions)
 * identically to GET /comments so the client can merge it into state verbatim.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const access = await requireDocAccess(req, slug, "comments:read");
  if (!access.ok) return error(access.status, access.message);

  let comment;
  try {
    comment = await getEnrichedComment(access.access.documentId, id, access.access.participantId);
  } catch (err) {
    return error(500, err instanceof Error ? err.message : "Failed to load comment");
  }
  if (!comment) return error(404, "Comment not found");

  return json({ comment });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const access = await requireDocAccess(req, slug, "comments:write");
  if (!access.ok) return error(access.status, access.message);
  // Owner session or a comments:write-scoped PAT (owner-minted, doc-bound); blocks
  // reviewer sessions. PATs no longer carry a synthesized owner role (M1).
  if (!hasOwnerContentAuthority(access.access)) return error(403, "Owner role required");

  const db = admin();
  const { data, error: e } = await db
    .from("comments")
    .delete()
    .eq("id", id)
    .eq("document_id", access.access.documentId)
    .select("id")
    .maybeSingle();
  if (e) return error(500, "Failed to delete comment");
  if (!data) return error(404, "Comment not found");

  scheduleDocumentChangeBroadcast(access.access.documentId, { kind: "delete", commentId: id });

  return json({ ok: true });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const access = await requireDocAccess(req, slug, "comments:write");
  if (!access.ok) return error(access.status, access.message);
  // Same authority rule as DELETE above (M1).
  if (!hasOwnerContentAuthority(access.access)) return error(403, "Owner role required");

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(400, "Invalid body");

  const db = admin();
  const { data, error: e } = await db
    .from("comments")
    .update({ status: parsed.data.status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("document_id", access.access.documentId)
    .select("id, document_id, version_id, participant_id, anchor, body, parent_id, status, created_at")
    .maybeSingle();
  if (e) return error(500, "Failed to update comment");
  if (!data) return error(404, "Comment not found");

  scheduleDocumentChangeBroadcast(access.access.documentId, { kind: "status", commentId: data.id });

  return json({ comment: data });
}
