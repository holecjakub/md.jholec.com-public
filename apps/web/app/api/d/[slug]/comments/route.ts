import { z } from "zod";
import { admin } from "@/lib/db/admin";
import { requireDocAccess } from "@/lib/auth/require";
import { broadcastDocumentChange } from "@/lib/realtime/broadcast";
import { clientIp, isIpRateLimited } from "@/lib/auth/rate-limit";
import { error, json } from "@/lib/http";

export const runtime = "nodejs";

const Anchor = z.object({
  quote: z.string(),
  prefix: z.string(),
  suffix: z.string(),
  blockId: z.string(),
});
const CreateBody = z.object({
  anchor: Anchor,
  body: z.string().min(1).max(10000),
  // Optional client-generated UUID so the optimistic comment keeps a STABLE id
  // through the round-trip (no temp→real swap that would churn the inline-highlight
  // rebuild). Scoped to the caller's own document; a duplicate id just fails the insert.
  id: z.string().uuid().optional(),
});

const BASE_COLUMNS =
  "id, document_id, version_id, participant_id, anchor, body, parent_id, status, created_at";

interface ReactionGroup {
  emoji: string;
  count: number;
  mine: boolean;
}

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const access = await requireDocAccess(req, slug, "comments:read");
  if (!access.ok) return error(access.status, access.message);

  const url = new URL(req.url);
  const db = admin();
  const documentId = access.access.documentId;
  const me = access.access.participantId;

  // (1) comments + author display_name via a PostgREST embed — single query.
  let q = db
    .from("comments")
    .select(`${BASE_COLUMNS}, participant:participants(display_name)`)
    .eq("document_id", documentId)
    .order("created_at", { ascending: true });
  if (url.searchParams.get("open") === "true") q = q.eq("status", "open");

  const { data: rows, error: e } = await q;
  if (e) return error(500, "Failed to list comments");

  // (2) all reactions for the document — single query, grouped in JS by
  //     comment_id + emoji with counts and a `mine` flag for the requester.
  const { data: reactionRows, error: rErr } = await db
    .from("reactions")
    .select("comment_id, emoji, participant_id")
    .eq("document_id", documentId)
    .not("comment_id", "is", null);
  if (rErr) return error(500, "Failed to list reactions");

  const reactionsByComment = new Map<string, Map<string, ReactionGroup>>();
  for (const r of reactionRows ?? []) {
    const commentId = r.comment_id as string | null;
    if (!commentId) continue;
    const emoji = r.emoji as string;
    let byEmoji = reactionsByComment.get(commentId);
    if (!byEmoji) {
      byEmoji = new Map();
      reactionsByComment.set(commentId, byEmoji);
    }
    const group = byEmoji.get(emoji) ?? { emoji, count: 0, mine: false };
    group.count += 1;
    if (me && r.participant_id === me) group.mine = true;
    byEmoji.set(emoji, group);
  }

  const comments = (rows ?? []).map((row) => {
    const { participant, ...rest } = row as Record<string, unknown> & {
      id: string;
      participant: { display_name: string } | { display_name: string }[] | null;
    };
    const author = Array.isArray(participant) ? participant[0] : participant;
    const groups = reactionsByComment.get(rest.id as string);
    return {
      ...rest,
      author_name: author?.display_name ?? "Unknown",
      reactions: groups ? Array.from(groups.values()) : [],
    };
  });

  return json({ comments });
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const access = await requireDocAccess(req, slug, "comments:write");
  if (!access.ok) return error(access.status, access.message);
  if (!access.access.participantId) return error(403, "A participant session is required to comment");

  // Throttle write floods (multi-KB rows + realtime fan-out) per IP.
  if (await isIpRateLimited(clientIp(req), "write")) return error(429, "Too many requests");

  const parsed = CreateBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return error(400, "Invalid body");

  const db = admin();
  const { data: doc } = await db
    .from("documents")
    .select("current_version_id")
    .eq("id", access.access.documentId)
    .single();
  if (!doc?.current_version_id) return error(404, "Document not found");

  const { data, error: e } = await db
    .from("comments")
    .insert({
      // Honour a client-provided id (stable optimistic id); else the DB default gens one.
      ...(parsed.data.id ? { id: parsed.data.id } : {}),
      document_id: access.access.documentId,
      version_id: doc.current_version_id,
      participant_id: access.access.participantId,
      anchor: parsed.data.anchor,
      body: parsed.data.body,
    })
    // Embed the author's display_name (same as GET) so the response carries author_name.
    .select(`${BASE_COLUMNS}, participant:participants(display_name)`)
    .single();
  if (e || !data) return error(500, "Failed to create comment");

  // Flatten to the same shape GET returns. Without author_name the client's optimistic
  // insert falls back to "You", so the new comment's avatar briefly shows the wrong
  // initials + identity colour and then visibly flickers to the real author on refetch.
  const { participant, ...rest } = data as Record<string, unknown> & {
    participant: { display_name: string } | { display_name: string }[] | null;
  };
  const author = Array.isArray(participant) ? participant[0] : participant;
  const comment = { ...rest, author_name: author?.display_name ?? "Unknown", reactions: [] };

  await broadcastDocumentChange(access.access.documentId, { kind: "comment", commentId: rest.id as string });

  return json({ comment }, 201);
}
