import { admin } from "@/lib/db/admin";
import type { EmbeddedThread } from "@md/core";

interface Row {
  id: string;
  anchor: EmbeddedThread["anchor"];
  body: string;
  parent_id: string | null;
  status: "open" | "resolved";
  created_at: string;
  participant: { display_name: string } | { display_name: string }[] | null;
}

const authorOf = (p: Row["participant"]): string =>
  (Array.isArray(p) ? p[0]?.display_name : p?.display_name) ?? "Unknown";

/**
 * Build the source-embeddable thread list for a document (root comments with
 * their replies + reaction tallies + author names), for the download / CLI-pull
 * appendix. Mirrors the GET /comments enrichment but shapes it for @md/core's
 * serializeComments.
 */
export async function buildEmbeddedThreads(documentId: string): Promise<EmbeddedThread[]> {
  const db = admin();

  const { data: rowData } = await db
    .from("comments")
    .select(
      "id, anchor, body, parent_id, status, created_at, participant:participants(display_name)",
    )
    .eq("document_id", documentId)
    .order("created_at", { ascending: true });
  const rows = (rowData ?? []) as unknown as Row[];

  const { data: reactionData } = await db
    .from("reactions")
    .select("comment_id, emoji")
    .eq("document_id", documentId)
    .not("comment_id", "is", null);

  const tallies = new Map<string, Map<string, number>>();
  for (const r of (reactionData ?? []) as { comment_id: string | null; emoji: string }[]) {
    if (!r.comment_id) continue;
    const byEmoji = tallies.get(r.comment_id) ?? new Map<string, number>();
    byEmoji.set(r.emoji, (byEmoji.get(r.emoji) ?? 0) + 1);
    tallies.set(r.comment_id, byEmoji);
  }

  const repliesByParent = new Map<string, Row[]>();
  for (const r of rows) {
    if (!r.parent_id) continue;
    const list = repliesByParent.get(r.parent_id) ?? [];
    list.push(r);
    repliesByParent.set(r.parent_id, list);
  }

  return rows
    .filter((r) => !r.parent_id)
    .map((r) => ({
      anchor: r.anchor,
      author: authorOf(r.participant),
      body: r.body,
      at: r.created_at,
      status: r.status,
      reactions: Array.from((tallies.get(r.id) ?? new Map()).entries()).map(
        ([emoji, count]) => ({ emoji, count: count as number }),
      ),
      replies: (repliesByParent.get(r.id) ?? []).map((rep) => ({
        author: authorOf(rep.participant),
        body: rep.body,
        at: rep.created_at,
      })),
    }));
}
