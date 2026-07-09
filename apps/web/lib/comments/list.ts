import { admin } from "@/lib/db/admin";

/**
 * Columns every comment payload carries. Shared by GET /comments and the
 * comments array embedded in GET /api/d/[slug] (perf H1: one round trip on load).
 */
export const COMMENT_COLUMNS =
  "id, document_id, version_id, participant_id, anchor, body, parent_id, status, created_at";

export interface ReactionGroup {
  emoji: string;
  count: number;
  mine: boolean;
}

/** A comment row enriched with author display_name + grouped reactions. */
export type EnrichedComment = Record<string, unknown> & {
  id: string;
  author_name: string;
  reactions: ReactionGroup[];
};

interface RawRow extends Record<string, unknown> {
  id: string;
  participant: { display_name: string } | { display_name: string }[] | null;
}

interface RawReactionRow {
  comment_id: unknown;
  emoji: unknown;
  participant_id: unknown;
}

/**
 * PostgREST silently truncates any un-ranged select at `max_rows` (1000 on
 * Supabase), so a very active document would drop comments/reactions with no
 * error (audit M4). Page through explicitly instead.
 */
export const PAGE_SIZE = 1000;

/**
 * Hard safety ceiling so a pathological document cannot make us page forever.
 * 20k comments/reactions is far beyond any real document here; if we ever hit
 * it we log loudly and return the bounded prefix (deterministic — callers
 * order by created_at,id) instead of hanging or silently truncating at 1000.
 */
export const MAX_ROWS = 20_000;

interface PageResult {
  data: unknown[] | null;
  error: unknown;
}

/**
 * Fetch every row of a query by paging with .range(). `fetchPage` must apply a
 * stable, total ordering (e.g. created_at + id) so pages never overlap or skip.
 * Exported for unit tests (comments-list.test.ts).
 */
export async function fetchAllRows(
  fetchPage: (from: number, to: number) => PromiseLike<PageResult>,
  label: string,
): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += PAGE_SIZE) {
    const { data, error } = await fetchPage(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(`Failed to list ${label}`);
    const rows = data ?? [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) return all;
  }
  console.warn(`[comments/list] ${label} truncated at MAX_ROWS=${MAX_ROWS}`);
  return all;
}

/** Group raw reaction rows by comment_id + emoji with a `mine` flag for `me`. */
function groupReactions(
  reactionRows: RawReactionRow[],
  me: string | null,
): Map<string, Map<string, ReactionGroup>> {
  const reactionsByComment = new Map<string, Map<string, ReactionGroup>>();
  for (const r of reactionRows) {
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
  return reactionsByComment;
}

/** Flatten the participants embed into author_name and attach reaction groups. */
function enrichRow(
  row: RawRow,
  reactionsByComment: Map<string, Map<string, ReactionGroup>>,
): EnrichedComment {
  const { participant, ...rest } = row;
  const author = Array.isArray(participant) ? participant[0] : participant;
  const groups = reactionsByComment.get(rest.id as string);
  return {
    ...rest,
    author_name: author?.display_name ?? "Unknown",
    reactions: groups ? Array.from(groups.values()) : [],
  } as EnrichedComment;
}

/**
 * List a document's comments enriched with author names and reaction groups.
 * Two independent queries (comments with a participants embed, all reactions)
 * run in parallel; reactions are grouped in JS by comment_id + emoji with a
 * `mine` flag for the requesting participant (`me`, null for PAT callers).
 */
export async function listEnrichedComments(
  documentId: string,
  me: string | null,
  opts: { openOnly?: boolean } = {},
): Promise<EnrichedComment[]> {
  const db = admin();

  // Both fetches page explicitly (M4) with a stable created_at,id ordering so
  // nothing is silently dropped past PostgREST's max_rows.
  const [rows, reactionRows] = await Promise.all([
    fetchAllRows((from, to) => {
      let q = db
        .from("comments")
        .select(`${COMMENT_COLUMNS}, participant:participants(display_name)`)
        .eq("document_id", documentId)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, to);
      if (opts.openOnly) q = q.eq("status", "open");
      return q;
    }, "comments"),
    fetchAllRows(
      (from, to) =>
        db
          .from("reactions")
          .select("comment_id, emoji, participant_id")
          .eq("document_id", documentId)
          .not("comment_id", "is", null)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      "reactions",
    ),
  ]);

  const reactionsByComment = groupReactions(reactionRows as RawReactionRow[], me);
  return (rows as unknown as RawRow[]).map((row) => enrichRow(row, reactionsByComment));
}

/**
 * Fetch ONE comment enriched exactly like `listEnrichedComments` (author name +
 * grouped reactions with the caller's `mine` flag). Backs the delta refetch
 * (perf C4/H9): a realtime signal names a single commentId, so clients fetch
 * just that row instead of the whole list. Returns null when the comment does
 * not exist in this document (deleted, or a foreign id).
 */
export async function getEnrichedComment(
  documentId: string,
  commentId: string,
  me: string | null,
): Promise<EnrichedComment | null> {
  const db = admin();

  const [
    { data: row, error: commentError },
    { data: reactionRows, error: reactionsError },
  ] = await Promise.all([
    db
      .from("comments")
      .select(`${COMMENT_COLUMNS}, participant:participants(display_name)`)
      .eq("document_id", documentId)
      .eq("id", commentId)
      .maybeSingle(),
    db
      .from("reactions")
      .select("comment_id, emoji, participant_id")
      .eq("document_id", documentId)
      .eq("comment_id", commentId),
  ]);
  if (commentError) throw new Error("Failed to load comment");
  if (reactionsError) throw new Error("Failed to list reactions");
  if (!row) return null;

  const reactionsByComment = groupReactions((reactionRows ?? []) as RawReactionRow[], me);
  return enrichRow(row as unknown as RawRow, reactionsByComment);
}
