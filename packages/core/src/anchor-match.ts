/**
 * Pure (DOM-free) text-quote anchor matching.
 *
 * The browser-side DOM glue (building a Selection into an anchor, mapping
 * char-offsets back to a DOM Range) lives in `apps/web/lib/anchor.ts`. This
 * module holds only the string-offset logic so it can be unit-tested without a
 * DOM, and reused by both the web app and any future consumer.
 *
 * W3C text-quote model: an anchor is { quote, prefix, suffix, blockId }. The
 * prefix/suffix are short context windows immediately before/after the quote
 * within the SAME block, used to disambiguate when the quote appears more than
 * once in the block's text.
 */

export const PREFIX_LEN = 32;
export const SUFFIX_LEN = 32;

export interface TextQuoteAnchor {
  quote: string;
  prefix: string;
  suffix: string;
  blockId: string;
}

/**
 * Compute the prefix/suffix context windows for a quote found at [start, end)
 * within `blockText`. Windows are clamped to PREFIX_LEN / SUFFIX_LEN and to the
 * block boundaries (so a quote at the block start yields an empty prefix).
 */
export function contextWindows(
  blockText: string,
  start: number,
  end: number,
): { prefix: string; suffix: string } {
  const prefix = blockText.slice(Math.max(0, start - PREFIX_LEN), start);
  const suffix = blockText.slice(end, end + SUFFIX_LEN);
  return { prefix, suffix };
}

/** All start indices at which `needle` occurs in `haystack` (non-overlapping). */
export function allOccurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    out.push(idx);
    from = idx + needle.length;
  }
  return out;
}

/** Length of the longest common suffix of `a` and `b`. */
function commonSuffixLen(a: string, b: string): number {
  let n = 0;
  const max = Math.min(a.length, b.length);
  while (n < max && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

/** Length of the longest common prefix of `a` and `b`. */
function commonPrefixLen(a: string, b: string): number {
  let n = 0;
  const max = Math.min(a.length, b.length);
  while (n < max && a[n] === b[n]) n++;
  return n;
}

export interface MatchResult {
  /** Index where the chosen occurrence of the quote starts. */
  start: number;
  /** Index just past the chosen occurrence (start + quote.length). */
  end: number;
  /** How the occurrence was chosen: the only one, or disambiguated by context. */
  via: "unique" | "context";
}

/**
 * Locate the best occurrence of `anchor.quote` within `blockText`.
 *
 * - Zero occurrences → null (caller falls back to block start / orphaned).
 * - Exactly one occurrence → that one (`via: "unique"`).
 * - Multiple occurrences → score each by how well its surrounding text matches
 *   the recorded prefix/suffix (longest common boundary wins) and return the
 *   best (`via: "context"`). Ties resolve to the earliest occurrence.
 */
export function findBestQuoteMatch(
  blockText: string,
  anchor: Pick<TextQuoteAnchor, "quote" | "prefix" | "suffix">,
): MatchResult | null {
  const { quote, prefix, suffix } = anchor;
  if (quote.length === 0) return null;

  const occurrences = allOccurrences(blockText, quote);
  if (occurrences.length === 0) return null;
  if (occurrences.length === 1) {
    const start = occurrences[0]!;
    return { start, end: start + quote.length, via: "unique" };
  }

  let bestStart = occurrences[0]!;
  let bestScore = -1;
  for (const start of occurrences) {
    const end = start + quote.length;
    const before = blockText.slice(Math.max(0, start - PREFIX_LEN), start);
    const after = blockText.slice(end, end + SUFFIX_LEN);
    // Match the END of the recorded prefix against the END of the actual
    // before-context, and the START of the recorded suffix against the START of
    // the actual after-context. Longer agreement = better match.
    const score = commonSuffixLen(before, prefix) + commonPrefixLen(after, suffix);
    if (score > bestScore) {
      bestScore = score;
      bestStart = start;
    }
  }
  return { start: bestStart, end: bestStart + quote.length, via: "context" };
}
