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

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Compute the prefix/suffix context windows for a quote found at [start, end)
 * within `blockText`. Windows are clamped to PREFIX_LEN / SUFFIX_LEN and to the
 * block boundaries (so a quote at the block start yields an empty prefix).
 *
 * Window edges are snapped to code-point boundaries: a fixed code-unit window
 * can otherwise split a surrogate pair (emoji, astral CJK), producing a lone
 * surrogate — a malformed string that JSON/Postgres reject.
 */
export function contextWindows(
  blockText: string,
  start: number,
  end: number,
): { prefix: string; suffix: string } {
  let from = Math.max(0, start - PREFIX_LEN);
  // Drop a leading low surrogate whose high half falls outside the window.
  if (from < start && isLowSurrogate(blockText.charCodeAt(from))) from++;
  let to = Math.min(blockText.length, end + SUFFIX_LEN);
  // Drop a trailing high surrogate whose low half falls outside the window.
  if (to > end && isHighSurrogate(blockText.charCodeAt(to - 1))) to--;
  return { prefix: blockText.slice(from, start), suffix: blockText.slice(end, to) };
}

/**
 * All start indices at which `needle` occurs in `haystack`, including
 * overlapping occurrences (e.g. "1.1" in "1.1.1" → [0, 2]). Overlaps must be
 * visible so repeated quotes are disambiguated by context instead of the later
 * occurrence being silently invisible.
 */
export function allOccurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) break;
    out.push(idx);
    from = idx + 1;
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

/**
 * Minimum context-agreement score for a multi-occurrence match to count as
 * disambiguated. Below this (i.e. zero agreement with the recorded
 * prefix/suffix) every occurrence is equally plausible, so the result is
 * flagged `via: "ambiguous"` and callers should degrade to a block-level
 * fallback instead of highlighting a guessed occurrence.
 */
export const MIN_CONTEXT_SCORE = 1;

export interface MatchResult {
  /** Index where the chosen occurrence of the quote starts. */
  start: number;
  /** Index just past the chosen occurrence (start + quote.length). */
  end: number;
  /**
   * How the occurrence was chosen: the only one, disambiguated by context, or
   * an arbitrary (earliest) pick with no context agreement — a guess the
   * caller should not present as an exact match.
   */
  via: "unique" | "context" | "ambiguous";
}

/**
 * Locate the best occurrence of `anchor.quote` within `blockText`.
 *
 * - Zero occurrences → null (caller falls back to block start / orphaned).
 * - Exactly one occurrence → that one (`via: "unique"`).
 * - Multiple occurrences → score each by how well its surrounding text matches
 *   the recorded prefix/suffix (longest common boundary wins) and return the
 *   best (`via: "context"`). Ties resolve to the earliest occurrence. When the
 *   best score is below MIN_CONTEXT_SCORE the pick is a pure guess and is
 *   flagged `via: "ambiguous"`.
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
  const via = bestScore >= MIN_CONTEXT_SCORE ? "context" : "ambiguous";
  return { start: bestStart, end: bestStart + quote.length, via };
}
