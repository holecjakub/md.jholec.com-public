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
 * the container, selections not resolvable to a [data-block-id] block, or
 * selections spanning more than one block (an anchor is scoped to a single
 * block, so a cross-block quote could never be relocated).
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
  // Anchors are relocated within ONE block, but `quote` concatenates text
  // across every block the range touches — a cross-block quote never matches
  // the start block's text, so the anchor would degrade to a block-start
  // fallback forever. Reject it and let the caller keep the composer hidden.
  if (closestBlock(range.endContainer) !== block) return null;
  const blockId = block.getAttribute(BLOCK_ATTR);
  if (blockId === null) return null;

  const blockText = getBlockText(block);
  const start = offsetWithinBlock(block, range.startContainer, range.startOffset);
  if (start === null) return null;
  const end = start + quote.length;

  const { prefix, suffix } = contextWindows(blockText, start, end);
  return { quote, prefix, suffix, blockId };
}

/**
 * Server-side anchors cap `quote` at 2000 chars (comments POST schema). A
 * keyboard-created block anchor quotes the block's leading text, so it must
 * stay under that cap — longer blocks anchor to their leading range instead.
 */
const BLOCK_QUOTE_MAX = 2000;

/**
 * Build a text-quote anchor covering a whole [data-block-id] block (keyboard
 * comment creation — WCAG 2.1.1: no pointer selection required). The quote is
 * the block's flattened text from offset 0, clamped to the server's quote cap;
 * the suffix disambiguates a clamped quote exactly like a selection-built
 * anchor would. Returns null for blocks without an id or without any text
 * (e.g. an <hr>), where a quote anchor could never relocate.
 */
export function buildBlockAnchor(block: HTMLElement): TextQuoteAnchor | null {
  const blockId = block.getAttribute(BLOCK_ATTR);
  if (blockId === null) return null;

  const blockText = getBlockText(block);
  if (blockText.trim().length === 0) return null;

  const end = Math.min(blockText.length, BLOCK_QUOTE_MAX);
  const quote = blockText.slice(0, end);
  const { prefix, suffix } = contextWindows(blockText, 0, end);
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

/** Locate `anchor` inside `block`, given the block's (pre-computed) flat text. */
function locateInBlock(
  block: HTMLElement,
  blockText: string,
  anchor: TextQuoteAnchor,
): RelocateResult {
  const match = findBestQuoteMatch(blockText, anchor);
  // Ambiguous = repeated quote with zero context agreement; highlighting one
  // occurrence would be a guess, so degrade to the block-start fallback.
  if (!match || match.via === "ambiguous") {
    return { status: "block", range: blockStartRange(block), block };
  }

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
  return locateInBlock(block, getBlockText(block), anchor);
}

/**
 * One relocation batch (perf H5). All resolutions inside a pass share a single
 * `[data-block-id]` container query and compute each block's flattened text at
 * most once, instead of every `relocateAnchor` call re-walking the container.
 */
export interface RelocationPass {
  /** Resolve an anchor, reusing a still-valid cached result when possible. */
  resolve(threadId: string, anchor: TextQuoteAnchor): RelocateResult;
  /**
   * Force-recompute an anchor and replace its cache entry. Callers use this
   * right after mutating the resolved Range's text nodes (wrapping a highlight
   * moves them into the new span, which collapses the Range) so later
   * consumers of the shared cache get a live Range back.
   */
  refresh(threadId: string, anchor: TextQuoteAnchor): RelocateResult;
}

/**
 * Shared relocation cache (perf H5): resolved anchors are memoized per thread
 * across passes, keyed by anchor value and validated against the live DOM, so
 * the highlight layer and the badge layer consume ONE resolved Range set
 * instead of each re-running the full match per thread per refetch/resize.
 */
export interface RelocationCache {
  /**
   * Start a pass. `activeThreadIds` is the full current thread-id set; entries
   * for dropped threads are pruned so cached Ranges never pin detached DOM.
   */
  beginPass(activeThreadIds: ReadonlySet<string>): RelocationPass;
}

interface RelocationEntry {
  anchor: TextQuoteAnchor;
  /** Block text at resolution time ("" when orphaned) — the validity witness. */
  blockText: string;
  result: RelocateResult;
}

/** Value equality — a re-fetched row carries a fresh anchor object w/ same fields. */
function sameAnchor(a: TextQuoteAnchor, b: TextQuoteAnchor): boolean {
  return (
    a === b ||
    (a.quote === b.quote &&
      a.prefix === b.prefix &&
      a.suffix === b.suffix &&
      a.blockId === b.blockId)
  );
}

/** Create a relocation cache bound to one preview `container`. */
export function createRelocationCache(container: HTMLElement): RelocationCache {
  const entries = new Map<string, RelocationEntry>();

  const beginPass = (activeThreadIds: ReadonlySet<string>): RelocationPass => {
    for (const id of Array.from(entries.keys())) {
      if (!activeThreadIds.has(id)) entries.delete(id);
    }

    // ONE container-wide block query per pass, built lazily on first use.
    let blocks: Map<string, HTMLElement> | null = null;
    const blockOf = (blockId: string): HTMLElement | null => {
      if (!blocks) {
        blocks = new Map();
        for (const el of Array.from(
          container.querySelectorAll<HTMLElement>(BLOCK_SELECTOR),
        )) {
          const id = el.getAttribute(BLOCK_ATTR);
          if (id !== null && !blocks.has(id)) blocks.set(id, el);
        }
      }
      return blocks.get(blockId) ?? null;
    };

    // Flattened block text computed at most once per block per pass.
    const blockTexts = new Map<HTMLElement, string>();
    const textOf = (block: HTMLElement): string => {
      let text = blockTexts.get(block);
      if (text === undefined) {
        text = getBlockText(block);
        blockTexts.set(block, text);
      }
      return text;
    };

    const refresh = (threadId: string, anchor: TextQuoteAnchor): RelocateResult => {
      const block = blockOf(anchor.blockId);
      const blockText = block ? textOf(block) : "";
      const result: RelocateResult = block
        ? locateInBlock(block, blockText, anchor)
        : { status: "orphaned", block: null };
      entries.set(threadId, { anchor, blockText, result });
      return result;
    };

    const resolve = (threadId: string, anchor: TextQuoteAnchor): RelocateResult => {
      const entry = entries.get(threadId);
      if (entry && sameAnchor(entry.anchor, anchor)) {
        const { result } = entry;
        if (result.status === "orphaned") {
          // Still valid only while the block remains absent.
          if (!blockOf(anchor.blockId)) return result;
        } else if (
          result.block.isConnected &&
          blockOf(anchor.blockId) === result.block &&
          textOf(result.block) === entry.blockText
        ) {
          // Unchanged block text ⇒ the text match itself still holds. For exact
          // results additionally verify the LIVE Range still spans the quote —
          // wrapping/stripping highlight spans moves text nodes, which can
          // collapse a Range without changing the flattened text.
          if (result.status !== "exact" || result.range.toString() === anchor.quote) {
            return result;
          }
        }
      }
      return refresh(threadId, anchor);
    };

    return { resolve, refresh };
  };

  return { beginPass };
}
