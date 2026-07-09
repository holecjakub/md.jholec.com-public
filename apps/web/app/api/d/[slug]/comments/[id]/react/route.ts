import { z } from "zod";
import { admin } from "@/lib/db/admin";
import { requireDocAccess } from "@/lib/auth/require";
import { scheduleDocumentChangeBroadcast } from "@/lib/realtime/broadcast";
import { clientIp, isIpRateLimited } from "@/lib/auth/rate-limit";
import { error, json } from "@/lib/http";

export const runtime = "nodejs";

// Postgres foreign_key_violation — the composite FK (0011) rejects inserts whose
// comment_id doesn't exist in this document, replacing the old comment-exists SELECT.
const FK_VIOLATION = "23503";

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

  // Toggle semantics: if this participant already reacted with this emoji,
  // remove it (toggle off); otherwise insert it (toggle on). The UI presents
  // reactions as pressed/unpressed toggles, so a second tap must un-react.
  //
  // Perf M10: this used to be comment-exists SELECT + reaction-exists SELECT +
  // (DELETE | INSERT) — four sequential round-trips. Now it's DELETE ... RETURNING
  // (a hit means toggled off), else INSERT ... ON CONFLICT DO NOTHING RETURNING on
  // the UNIQUE(comment_id, participant_id, emoji) index. The composite FK
  // (comment_id, document_id) → comments(id, document_id) rejects unknown and
  // cross-document comment ids, so no existence pre-check is needed.
  //
  // DEPLOY-ORDER: before 0011 lands the single-column FK still rejects unknown
  // ids; a valid comment id from ANOTHER document would insert a benign orphan
  // (this doc's document_id + a foreign comment_id) that is never listed for
  // either document (enrichment joins reactions to the doc's own comments) — no
  // leak, self-corrects once the composite FK is applied. See AI/tools.md.
  const db = admin();
  const { data: removed, error: delErr } = await db
    .from("reactions")
    .delete()
    .eq("comment_id", id)
    .eq("document_id", access.access.documentId)
    .eq("participant_id", access.access.participantId)
    .eq("emoji", parsed.data.emoji)
    .select("id")
    .maybeSingle();
  if (delErr) return error(500, "Failed to react");

  if (removed) {
    scheduleDocumentChangeBroadcast(access.access.documentId, { kind: "reaction", commentId: id });
    return json({ reaction: null, active: false }, 200);
  }

  const { data, error: e } = await db
    .from("reactions")
    .upsert(
      {
        document_id: access.access.documentId,
        comment_id: id,
        participant_id: access.access.participantId,
        emoji: parsed.data.emoji,
      },
      { onConflict: "comment_id,participant_id,emoji", ignoreDuplicates: true },
    )
    .select("id, comment_id, emoji, participant_id, created_at")
    .maybeSingle();
  if (e) {
    if (e.code === FK_VIOLATION) return error(404, "Comment not found");
    return error(500, "Failed to react");
  }
  // `data` is null when ON CONFLICT DO NOTHING hit an existing row: a concurrent
  // toggle-on won the race between our DELETE miss and this INSERT. The reaction
  // is active either way; the broadcast-triggered refetch reconciles the client.
  scheduleDocumentChangeBroadcast(access.access.documentId, { kind: "reaction", commentId: id });

  return data ? json({ reaction: data, active: true }, 201) : json({ reaction: null, active: true }, 200);
}
