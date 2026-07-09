import type { CommentThreadDTO } from "@/lib/comments-api";

/** A block's worth of comment threads, plus derived overview data. */
export interface BlockGroup {
  blockId: string;
  threads: CommentThreadDTO[];
  /** Unique participant display names that authored anything on this block. */
  participants: string[];
  /** Distinct emoji used across all threads/replies on this block, with totals. */
  reactions: { emoji: string; count: number }[];
  /** True when every thread on the block is resolved. */
  resolved: boolean;
}

/**
 * Group top-level threads by their anchor block. Each badge in the right margin
 * represents one block; this builds the testimonial-style overview (avatar stack
 * + reaction summary) the badge needs, plus the resolved flag for fading.
 *
 * Threads are kept in their incoming order so the gutter ordering stays stable.
 * Orphaned anchors are NOT excluded here (the caller decides placement); a block
 * id always exists on every thread's anchor.
 */
export function groupThreadsByBlock(threads: CommentThreadDTO[]): BlockGroup[] {
  const byBlock = new Map<string, CommentThreadDTO[]>();
  for (const thread of threads) {
    const id = thread.root.anchor.blockId;
    const list = byBlock.get(id);
    if (list) list.push(thread);
    else byBlock.set(id, [thread]);
  }

  const groups: BlockGroup[] = [];
  for (const [blockId, blockThreads] of byBlock) {
    const participants: string[] = [];
    const seen = new Set<string>();
    const reactionCounts = new Map<string, number>();

    for (const thread of blockThreads) {
      for (const comment of [thread.root, ...thread.replies]) {
        if (!seen.has(comment.author_name)) {
          seen.add(comment.author_name);
          participants.push(comment.author_name);
        }
        for (const r of comment.reactions) {
          if (r.count > 0) {
            reactionCounts.set(r.emoji, (reactionCounts.get(r.emoji) ?? 0) + r.count);
          }
        }
      }
    }

    const reactions = [...reactionCounts.entries()].map(([emoji, count]) => ({
      emoji,
      count,
    }));

    groups.push({
      blockId,
      threads: blockThreads,
      participants,
      reactions,
      resolved: blockThreads.every((t) => t.root.status === "resolved"),
    });
  }

  return groups;
}
