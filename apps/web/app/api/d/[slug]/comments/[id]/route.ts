import { z } from "zod";
import { admin } from "@/lib/db/admin";
import { requireDocAccess } from "@/lib/auth/require";
import { broadcastDocumentChange } from "@/lib/realtime/broadcast";
import { error, json } from "@/lib/http";

export const runtime = "nodejs";

const Body = z.object({ status: z.enum(["open", "resolved"]) });

export async function DELETE(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const access = await requireDocAccess(req, slug, "comments:write");
  if (!access.ok) return error(access.status, access.message);
  if (access.access.role !== "owner") return error(403, "Owner role required");

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

  await broadcastDocumentChange(access.access.documentId, { kind: "delete", commentId: id });

  return json({ ok: true });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const access = await requireDocAccess(req, slug, "comments:write");
  if (!access.ok) return error(access.status, access.message);
  if (access.access.role !== "owner") return error(403, "Owner role required");

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

  await broadcastDocumentChange(access.access.documentId, { kind: "status", commentId: data.id });

  return json({ comment: data });
}
