import { z } from "zod";
import { admin } from "@/lib/db/admin";
import { requireDocAccess } from "@/lib/auth/require";
import { broadcastDocumentChange } from "@/lib/realtime/broadcast";
import { clientIp, isIpRateLimited } from "@/lib/auth/rate-limit";
import { error, json } from "@/lib/http";

export const runtime = "nodejs";

const Body = z.object({ emoji: z.string().min(1).max(16) });

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const access = await requireDocAccess(req, slug, "comments:write");
  if (!access.ok) return error(access.status, access.message);
  if (!access.access.participantId) return error(403, "A participant session is required to react");

  // Throttle write floods per IP.
  if (await isIpRateLimited(clientIp(req), "write")) return error(429, "Too many requests");

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(400, "Invalid body");

  const db = admin();
  const { data: comment } = await db
    .from("comments")
    .select("id")
    .eq("id", id)
    .eq("document_id", access.access.documentId)
    .maybeSingle();
  if (!comment) return error(404, "Comment not found");

  // Toggle semantics: if this participant already reacted with this emoji,
  // remove it (toggle off); otherwise insert it (toggle on). The UI presents
  // reactions as pressed/unpressed toggles, so a second tap must un-react.
  const { data: existing, error: lookupErr } = await db
    .from("reactions")
    .select("id")
    .eq("comment_id", comment.id)
    .eq("participant_id", access.access.participantId)
    .eq("emoji", parsed.data.emoji)
    .maybeSingle();
  if (lookupErr) return error(500, "Failed to react");

  if (existing) {
    const { error: delErr } = await db.from("reactions").delete().eq("id", existing.id);
    if (delErr) return error(500, "Failed to react");

    await broadcastDocumentChange(access.access.documentId, {
      kind: "reaction",
      commentId: comment.id,
    });

    return json({ reaction: null, active: false }, 200);
  }

  const { data, error: e } = await db
    .from("reactions")
    .insert({
      document_id: access.access.documentId,
      comment_id: comment.id,
      participant_id: access.access.participantId,
      emoji: parsed.data.emoji,
    })
    .select("id, comment_id, emoji, participant_id, created_at")
    .single();
  if (e || !data) return error(500, "Failed to react");

  await broadcastDocumentChange(access.access.documentId, { kind: "reaction", commentId: comment.id });

  return json({ reaction: data, active: true }, 201);
}
