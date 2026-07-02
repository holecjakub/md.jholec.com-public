"use client";

import { useEffect } from "react";
import { relocateAnchor } from "@/lib/anchor";
import { identityColor } from "@/lib/identity-color";
import type { CommentThread } from "@/lib/comments-api";

const HIGHLIGHT_CLASS = "md-comment-highlight";

/**
 * Wraps each comment's anchored text in the rendered preview with a clickable
 * <span.md-comment-highlight> (a thin, low-opacity accent underline locator).
 *
 * This is a DOM side-effect layer, not a rendered tree: react-markdown owns the
 * preview subtree, so we decorate it imperatively after each paint via a
 * (idempotent) layout effect. On every content/thread change we first strip any
 * previous wrappers (restoring the original text nodes) and then re-wrap from
 * the current threads — so the operation is fully rebuildable and never
 * accumulates stale spans.
 *
 * A range can span several text nodes; we surround each fully/partially covered
 * text node slice with its own span (splitting text nodes at the range
 * boundaries) so wrapping never has to reparent element boundaries. Each span
 * carries data-thread-id + data-block-id so click + hover-coupling can map back
 * to the thread/block. Resolved threads render fainter (data-resolved).
 *
 * Interaction (click to open the thread at the text, hover to emphasise the
 * matching badge) is delegated by the parent CommentsLayer via event listeners
 * on the container, keyed off these data attributes — keeping this layer purely
 * about decoration.
 */
export function InlineHighlightLayer({
  container,
  threads,
}: {
  container: HTMLElement | null;
  threads: CommentThread[];
}) {
  useEffect(() => {
    if (!container) return;

    decorate(container, threads);
    // Re-decorate if the preview subtree changes underneath us (e.g. a re-render
    // of MarkdownPreview replaces nodes), so highlights survive content updates.
    const observer = new MutationObserver(() => {
      // Ignore our own mutations: a quick strip+rebuild is idempotent, but to
      // avoid an observer loop we disconnect during the rebuild.
      observer.disconnect();
      decorate(container, threads);
      observer.observe(container, { childList: true, subtree: true, characterData: true });
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });

    return () => {
      observer.disconnect();
      stripHighlights(container);
    };
  }, [container, threads]);

  return null;
}

InlineHighlightLayer.displayName = "InlineHighlightLayer";

/** Remove all highlight wrappers, restoring original text nodes (idempotent). */
function stripHighlights(container: HTMLElement): void {
  const spans = container.querySelectorAll<HTMLSpanElement>(`span.${HIGHLIGHT_CLASS}`);
  spans.forEach((span) => {
    const parent = span.parentNode;
    if (!parent) return;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  });
}

/** Strip any previous wrappers then wrap the current threads' ranges. */
function decorate(container: HTMLElement, threads: CommentThread[]): void {
  // Idempotency guard: if the DOM already carries exactly the spans these threads
  // want, do NOTHING. The MutationObserver fires for unrelated preview re-renders
  // too, and a needless strip+rebuild here would DETACH the very span a user is
  // mid-click on — the browser would then dispatch `click` on the ancestor, not
  // the (removed) span, and the thread would silently fail to open. Skipping the
  // rebuild keeps the live span attached so the delegated click handler sees it.
  if (isAlreadyDecorated(container, threads)) return;

  stripHighlights(container);

  for (const thread of threads) {
    const result = relocateAnchor(thread.root.anchor, container);
    // Only mark text we can locate precisely; block-fallback/orphaned anchors
    // have no concrete text run to underline (the badge / top-bar handle those).
    if (result.status !== "exact") continue;

    wrapRange(result.range, {
      threadId: thread.root.id,
      blockId: thread.root.anchor.blockId,
      resolved: thread.root.status === "resolved",
      // Per-author tint: the mark takes the comment author's identity color (the
      // same hue as their avatar), so multiple authors are distinguishable.
      color: identityColor(thread.root.author_name),
    });
  }
}

/**
 * True when the container's existing highlight spans already represent exactly
 * the given threads (same set of thread ids, same resolved flag per thread).
 * Used to skip a destructive strip+rebuild when nothing relevant changed.
 */
function isAlreadyDecorated(container: HTMLElement, threads: CommentThread[]): boolean {
  // Signature per thread = resolved flag + author tint, so a status OR color
  // change forces a clean rebuild (a stale --hl-color would never recolor
  // otherwise).
  const wanted = new Map<string, string>();
  for (const thread of threads) {
    // We only ever wrap "exact"-locatable anchors; approximate which threads
    // those are by the same status check decorate() uses below.
    const result = relocateAnchor(thread.root.anchor, container);
    if (result.status !== "exact") continue;
    const resolved = thread.root.status === "resolved";
    wanted.set(thread.root.id, `${resolved}|${identityColor(thread.root.author_name)}`);
  }

  const present = new Map<string, string>();
  const spans = container.querySelectorAll<HTMLSpanElement>(`span.${HIGHLIGHT_CLASS}`);
  for (const span of spans) {
    const id = span.getAttribute("data-thread-id");
    if (!id) return false; // unexpected span shape → force a clean rebuild
    const resolved = span.getAttribute("data-resolved") === "true";
    present.set(id, `${resolved}|${span.style.getPropertyValue("--hl-color").trim()}`);
  }

  if (wanted.size !== present.size) return false;
  for (const [id, sig] of wanted) {
    if (present.get(id) !== sig) return false;
  }
  return true;
}

interface WrapMeta {
  threadId: string;
  blockId: string;
  resolved: boolean;
  /** The comment author's identity color (verbatim HSL) — set as `--hl-color`. */
  color: string;
}

/**
 * Wrap every text-node slice intersecting `range` in its own highlight span.
 *
 * We snapshot the intersecting text nodes (with their per-node start/end offsets)
 * BEFORE mutating, because splitText() changes the tree. For each node we trim to
 * the covered slice (split off the head before `start` and the tail after `end`)
 * and wrap the middle. Capturing the offsets up front means the start/end-node
 * splits never invalidate each other.
 */
function wrapRange(range: Range, meta: WrapMeta): void {
  const doc = range.startContainer.ownerDocument;
  if (!doc) return;

  const rootEl =
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentNode
      : range.commonAncestorContainer;
  if (!rootEl) return;

  const walker = doc.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);

  // Snapshot: each text node and the [start,end) slice of it inside the range.
  const targets: { node: Text; start: number; end: number }[] = [];
  let node = walker.nextNode();
  while (node) {
    const text = node as Text;
    const len = text.textContent?.length ?? 0;
    if (len > 0 && range.intersectsNode(text)) {
      const start = text === range.startContainer ? range.startOffset : 0;
      const end = text === range.endContainer ? range.endOffset : len;
      if (end > start) targets.push({ node: text, start, end });
    }
    node = walker.nextNode();
  }

  for (const { node: text, start, end } of targets) {
    // Split off the trailing part first so the leading split's offset stays valid.
    if (end < (text.textContent?.length ?? 0)) text.splitText(end);
    const slice = start > 0 ? text.splitText(start) : text;

    const span = doc.createElement("span");
    span.className = HIGHLIGHT_CLASS;
    span.setAttribute("data-thread-id", meta.threadId);
    span.setAttribute("data-block-id", meta.blockId);
    span.style.setProperty("--hl-color", meta.color);
    if (meta.resolved) span.setAttribute("data-resolved", "true");
    span.setAttribute("role", "button");
    span.setAttribute("tabindex", "0");
    span.setAttribute("aria-label", "Open comment thread on this text");

    slice.parentNode?.insertBefore(span, slice);
    span.appendChild(slice);
  }
}
