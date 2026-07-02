import { z } from "zod";
import { admin } from "@/lib/db/admin";
import { requireDocAccess } from "@/lib/auth/require";
import { broadcastDocumentChange } from "@/lib/realtime/broadcast";
import { clientIp, isIpRateLimited } from "@/lib/auth/rate-limit";
import { error, json } from "@/lib/http";

export const runtime = "nodejs";

const Body = z.object({ body: z.string().min(1).max(10000) });

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const access = await requireDocAccess(req, slug, "comments:write");
  if (!access.ok) return error(access.status, access.message);
  if (!access.access.participantId) return error(403, "A participant session is required to reply");

  // Throttle write floods per IP.
  if (await isIpRateLimited(clientIp(req), "write")) return error(429, "Too many requests");

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(400, "Invalid body");

  const db = admin();
  const { data: parent } = await db
    .from("comments")
    .select("id, document_id, version_id, anchor")
    .eq("id", id)
    .eq("document_id", access.access.documentId)
    .maybeSingle();
  if (!parent) return error(404, "Parent comment not found");

  const { data, error: e } = await db
    .from("comments")
    .insert({
      document_id: access.access.documentId,
      version_id: parent.version_id,
      participant_id: access.access.participantId,
      anchor: parent.anchor,
      body: parsed.data.body,
      parent_id: parent.id,
    })
    .select("id, document_id, version_id, participant_id, anchor, body, parent_id, status, created_at")
    .single();
  if (e || !data) return error(500, "Failed to create reply");

  await broadcastDocumentChange(access.access.documentId, { kind: "reply", commentId: data.id });

  return json({ comment: data }, 201);
}
