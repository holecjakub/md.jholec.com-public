/**
 * DOM glue for W3C text-quote anchoring (Plan 04 §6).
 *
 * The pure offset/scoring logic lives in `@md/core` (`anchor-match`) so it can
 * be unit-tested without a DOM. This module turns a live `Selection` into an
 * anchor and re-locates a stored anchor back to a DOM `Range` inside the
 * rendered preview container, scoped to the block carrying `data-block-id`.
 */

import {
  PREFIX_LEN,
  SUFFIX_LEN,
  contextWindows,
  findBestQuoteMatch,
  type TextQuoteAnchor,
} from "@md/core";

export type { TextQuoteAnchor };
export { PREFIX_LEN, SUFFIX_LEN };

const BLOCK_ATTR = "data-block-id";
const BLOCK_SELECTOR = "[data-block-id]";

/** The nearest ancestor element carrying [data-block-id], or null. */
function closestBlock(node: Node | null): HTMLElement | null {
  let el: Element | null =
    node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : (node?.parentElement ?? null);
  el = el?.closest(BLOCK_SELECTOR) ?? null;
  return el instanceof HTMLElement ? el : null;
}

/** Plain text content of a block (matches what the matcher scores against). */
export function getBlockText(block: HTMLElement): string {
  return block.textContent ?? "";
}

/**
 * Character offset of (container, offset) within `block`'s flattened text, by
 * measuring a Range from the block start up to the position. Returns null if the
 * position is not inside the block.
 */
function offsetWithinBlock(block: HTMLElement, container: Node, offset: number): number | null {
  if (!block.contains(container)) return null;
  const range = block.ownerDocument.createRange();
  range.selectNodeContents(block);
  try {
    range.setEnd(container, offset);
  } catch {
    return null;
  }
  return range.toString().length;
}

/**
 * Build a text-quote anchor from the current selection, scoped to the preview
 * `container`. Returns null for collapsed/empty selections, selections outside
 * the container, or selections not resolvable to a [data-block-id] block.
 */
export function buildAnchor(
  selection: Selection | null,
  container: HTMLElement,
): TextQuoteAnchor | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) return null;

  const quote = range.toString();
  if (quote.trim().length === 0) return null;

  const block = closestBlock(range.startContainer);
  if (!block) return null;
  const blockId = block.getAttribute(BLOCK_ATTR);
  if (blockId === null) return null;

  const blockText = getBlockText(block);
  const start = offsetWithinBlock(block, range.startContainer, range.startOffset);
  if (start === null) return null;
  const end = start + quote.length;

  const { prefix, suffix } = contextWindows(blockText, start, end);
  return { quote, prefix, suffix, blockId };
}

export type RelocateResult =
  | { status: "exact"; range: Range; block: HTMLElement }
  | { status: "block"; range: Range; block: HTMLElement }
  | { status: "orphaned"; block: HTMLElement | null };

/** Escape a value for use inside an attribute-equals CSS selector. */
function cssEscapeAttr(value: string): string {
  const w = typeof window !== "undefined" ? window : undefined;
  const cssEscape = w?.CSS?.escape;
  if (cssEscape) return cssEscape(value);
  // Minimal fallback: escape double-quotes and backslashes.
  return value.replace(/["\\]/g, "\\$&");
}

/**
 * Map a [start, end) character range within `block`'s flattened text back to a
 * DOM Range by walking its text nodes and accumulating lengths.
 */
export function rangeFromOffsets(block: HTMLElement, start: number, end: number): Range {
  const doc = block.ownerDocument;
  const range = doc.createRange();
  const walker = doc.createTreeWalker(block, NodeFilter.SHOW_TEXT);

  let acc = 0;
  let startSet = false;
  let endSet = false;
  let node = walker.nextNode();
  while (node) {
    const len = node.textContent?.length ?? 0;
    const nodeStart = acc;
    const nodeEnd = acc + len;

    if (!startSet && start <= nodeEnd) {
      range.setStart(node, Math.max(0, start - nodeStart));
      startSet = true;
    }
    if (!endSet && end <= nodeEnd) {
      range.setEnd(node, Math.max(0, end - nodeStart));
      endSet = true;
      break;
    }
    acc = nodeEnd;
    node = walker.nextNode();
  }

  if (!startSet) range.setStart(block, block.childNodes.length);
  if (!endSet) range.setEnd(block, block.childNodes.length);
  return range;
}

/** A collapsed range at the very start of a block. */
function blockStartRange(block: HTMLElement): Range {
  const range = block.ownerDocument.createRange();
  range.selectNodeContents(block);
  range.collapse(true);
  return range;
}

/**
 * Re-locate a stored anchor inside the rendered `container`.
 * - exact   → quote found (disambiguated by prefix/suffix when repeated)
 * - block   → block present but quote absent; range collapses to block start
 * - orphaned→ block element no longer exists
 */
export function relocateAnchor(
  anchor: TextQuoteAnchor,
  container: HTMLElement,
): RelocateResult {
  const block = container.querySelector<HTMLElement>(
    `[${BLOCK_ATTR}="${cssEscapeAttr(anchor.blockId)}"]`,
  );
  if (!block) return { status: "orphaned", block: null };

  const blockText = getBlockText(block);
  const match = findBestQuoteMatch(blockText, anchor);
  if (!match) return { status: "block", range: blockStartRange(block), block };

  try {
    const range = rangeFromOffsets(block, match.start, match.end);
    // Verify the walk reproduced the quote; if the DOM mutated mid-walk and the
    // text drifted, downgrade to a block-start fallback rather than mis-anchor.
    if (range.toString() === anchor.quote) {
      return { status: "exact", range, block };
    }
    return { status: "block", range: blockStartRange(block), block };
  } catch {
    return { status: "block", range: blockStartRange(block), block };
  }
}
