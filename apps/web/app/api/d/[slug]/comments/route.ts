import { z } from "zod";
import { admin } from "@/lib/db/admin";
import { requireDocAccess } from "@/lib/auth/require";
import { COMMENT_COLUMNS, listEnrichedComments } from "@/lib/comments/list";
import { scheduleDocumentChangeBroadcast } from "@/lib/realtime/broadcast";
import { clientIp, isIpRateLimited } from "@/lib/auth/rate-limit";
import { error, ifNoneMatch, json, jsonWithEtag, notModified, weakEtag } from "@/lib/http";

export const runtime = "nodejs";

// Bound every anchor field so a single comment can't smuggle megabytes of JSONB
// past the body cap (storage DoS). The quote is the selected text; prefix/suffix
// are short context windows (PREFIX_LEN/SUFFIX_LEN = 32 chars in
// packages/core/src/anchor-match.ts) — 2000 leaves generous slack for wide
// selections/context while staying orders of magnitude below abuse territory.
// blockId is a stable element id, so 256 is ample.
const Anchor = z.object({
  quote: z.string().max(2000),
  prefix: z.string().max(2000),
  suffix: z.string().max(2000),
  blockId: z.string().max(256),
});
const CreateBody = z.object({
  anchor: Anchor,
  body: z.string().min(1).max(10000),
  // Optional client-generated UUID so the optimistic comment keeps a STABLE id
  // through the round-trip (no temp→real swap that would churn the inline-highlight
  // rebuild). A duplicate id replays the caller's own existing row (idempotent
  // retry) or 409s — see the 23505 handling in POST.
  id: z.string().uuid().optional(),
});

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const access = await requireDocAccess(req, slug, "comments:read");
  if (!access.ok) return error(access.status, access.message);

  const url = new URL(req.url);
  const openOnly = url.searchParams.get("open") === "true";
  const documentId = access.access.documentId;

  const db = admin();
  // Cheap freshness probe BEFORE the enriched fetch: comment/reaction counts +
  // latest mutation timestamps — no bodies, anchors, or joins (perf M2). A comment
  // status change bumps comments.updated_at; an add/delete or reply moves the
  // count; a react/unreact moves the reaction count (± its latest created_at).
  // `open` is folded in because it changes which rows the body returns.
  const [cAgg, rAgg] = await Promise.all([
    db
      .from("comments")
      .select("updated_at", { count: "exact" })
      .eq("document_id", documentId)
      .order("updated_at", { ascending: false })
      .limit(1),
    db
      .from("reactions")
      .select("created_at", { count: "exact" })
      .eq("document_id", documentId)
      .not("comment_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1),
  ]);
  const cMax = (cAgg.data?.[0] as { updated_at?: string } | undefined)?.updated_at ?? "";
  const rMax = (rAgg.data?.[0] as { created_at?: string } | undefined)?.created_at ?? "";
  const etag = weakEtag([
    "c",
    cAgg.count ?? 0,
    cMax,
    "r",
    rAgg.count ?? 0,
    rMax,
    openOnly ? "o1" : "o0",
  ]);
  // A reconnect/mutation-trailing refetch that finds the same state pays ~0 bytes.
  // The body is `private` (reaction `mine` flags), so each client caches its own.
  if (ifNoneMatch(req, etag)) return notModified(etag);

  // Comments + authors + reactions, enriched via the shared helper (two
  // parallel queries; also embedded in GET /api/d/[slug] for the initial load).
  let comments;
  try {
    comments = await listEnrichedComments(documentId, access.access.participantId, {
      openOnly,
    });
  } catch (err) {
    return error(500, err instanceof Error ? err.message : "Failed to list comments");
  }

  return jsonWithEtag({ comments }, etag);
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

  // requireDocAccess already carries current_version_id — no re-select (perf H10).
  if (!access.access.currentVersionId) return error(404, "Document not found");

  const db = admin();
  // Embed the author's display_name (same as GET) so the response carries author_name.
  const returning = `${COMMENT_COLUMNS}, participant:participants(display_name)`;
  const { data: inserted, error: e } = await db
    .from("comments")
    .insert({
      // Honour a client-provided id (stable optimistic id); else the DB default gens one.
      ...(parsed.data.id ? { id: parsed.data.id } : {}),
      document_id: access.access.documentId,
      version_id: access.access.currentVersionId,
      participant_id: access.access.participantId,
      anchor: parsed.data.anchor,
      body: parsed.data.body,
    })
    .select(returning)
    .single();
  // A unique violation (Postgres 23505) on a client-provided id is the
  // IDEMPOTENT-RETRY case (audit 3.8/1.6): the first POST persisted the row but
  // its response was lost, and the client's Retry re-sent the SAME UUID. Replay
  // the existing row — scoped to this participant in this document so a foreign
  // id collision can't leak or hijack someone else's comment; that case is a
  // plain 409 conflict. Any other insert failure stays a 500.
  let data = inserted;
  let replayed = false;
  if (e?.code === "23505" && parsed.data.id) {
    const { data: existing } = await db
      .from("comments")
      .select(returning)
      .eq("id", parsed.data.id)
      .eq("document_id", access.access.documentId)
      .eq("participant_id", access.access.participantId)
      .maybeSingle();
    if (!existing) return error(409, "Comment id already exists");
    data = existing;
    replayed = true;
  }
  if (!data) return error(500, "Failed to create comment");

  // Flatten to the same shape GET returns. Without author_name the client's optimistic
  // insert falls back to "You", so the new comment's avatar briefly shows the wrong
  // initials + identity colour and then visibly flickers to the real author on refetch.
  const { participant, ...rest } = data as Record<string, unknown> & {
    participant: { display_name: string } | { display_name: string }[] | null;
  };
  const author = Array.isArray(participant) ? participant[0] : participant;
  const comment = { ...rest, author_name: author?.display_name ?? "Unknown", reactions: [] };

  // A replayed retry created nothing new — the original insert already
  // broadcast, so don't fan the signal out a second time.
  if (!replayed) {
    scheduleDocumentChangeBroadcast(access.access.documentId, { kind: "comment", commentId: rest.id as string });
  }

  return json({ comment }, replayed ? 200 : 201);
}
