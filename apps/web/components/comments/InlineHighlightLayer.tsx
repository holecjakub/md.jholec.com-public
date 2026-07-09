"use client";

import { useEffect, useRef } from "react";
import type { RelocationCache } from "@/lib/anchor";
import { identityColor } from "@/lib/identity-color";
import type { CommentThreadDTO } from "@/lib/comments-api";

const HIGHLIGHT_CLASS = "md-comment-highlight";

/**
 * Wraps each comment's anchored text in the rendered preview with a clickable
 * <span.md-comment-highlight> (a thin, low-opacity accent underline locator).
 *
 * This is a DOM side-effect layer, not a rendered tree: react-markdown owns the
 * preview subtree, so we decorate it imperatively. Decoration is an INCREMENTAL
 * per-thread diff (perf H3): each pass compares the spans already in the DOM
 * against the current threads and only unwraps/rewraps the threads that
 * actually changed — B-STATE keeps unchanged threads reference- and
 * signature-stable, so a routine refetch touches nothing. A thread's
 * resolved-flag + author-color signature is part of the diff, so a
 * resolve/recolor still forces a rewrap of just that thread. The full
 * stripHighlights teardown runs only on unmount/container swap.
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
  cache,
  onDecorated,
}: {
  container: HTMLElement | null;
  threads: CommentThreadDTO[];
  /** Shared relocation cache (perf H5), created per container by CommentsLayer. */
  cache: RelocationCache | null;
  /**
   * Called after any decorate pass that actually changed spans, so the parent
   * can re-stamp hover emphasis — the emphasis must survive EVERY span rebuild
   * (audit invariant L5-2), including observer-driven ones outside React.
   */
  onDecorated?: () => void;
}) {
  const threadsRef = useRef(threads);
  const onDecoratedRef = useRef(onDecorated);
  // Latest decorate runner, callable from the threads-diff effect below without
  // tearing down the observer effect.
  const runRef = useRef<() => void>(() => {});

  useEffect(() => {
    onDecoratedRef.current = onDecorated;
  }, [onDecorated]);

  // Keyed on [container, cache] ONLY (perf H3): thread changes do NOT re-run
  // this effect — they run the incremental diff via runRef, so unchanged
  // threads' spans are never detached and the cleanup strip fires only on
  // unmount / container swap.
  useEffect(() => {
    if (!container || !cache) return;

    // Highlights only ever live inside the rendered markdown subtree. Observing
    // it — rather than the whole overlay container — keeps sibling badge
    // repositions and selection-overlay paints from firing decorate probes
    // (perf M4).
    const observed = container.querySelector<HTMLElement>(".md-prose") ?? container;

    const run = () => {
      // Ignore our own mutations: the diff is idempotent, but to avoid an
      // observer loop we disconnect during the rebuild.
      observer.disconnect();
      const changed = decorate(container, threadsRef.current, cache);
      observer.observe(observed, { childList: true, subtree: true, characterData: true });
      if (changed) onDecoratedRef.current?.();
    };
    // Re-decorate if the preview subtree changes underneath us (e.g. a re-render
    // of MarkdownPreview replaces nodes), so highlights survive content updates.
    const observer = new MutationObserver(run);
    runRef.current = run;
    run();

    return () => {
      observer.disconnect();
      runRef.current = () => {};
      stripHighlights(container);
    };
  }, [container, cache]);

  // Thread identity changes → ONE incremental diff pass (add/remove/rewrap only
  // what changed). Reading through threadsRef keeps the observer callback above
  // current too, regardless of effect timing.
  useEffect(() => {
    threadsRef.current = threads;
    runRef.current();
  }, [threads]);

  return null;
}

InlineHighlightLayer.displayName = "InlineHighlightLayer";

/** Unwrap the given spans, restoring original text nodes (idempotent). */
function unwrapSpans(spans: readonly HTMLSpanElement[]): void {
  for (const span of spans) {
    const parent = span.parentNode;
    if (!parent) continue;
    while (span.firstChild) parent.insertBefore(span.firstChild, span);
    parent.removeChild(span);
    parent.normalize();
  }
}

/** Remove ALL highlight wrappers — unmount/container-swap teardown only. */
function stripHighlights(container: HTMLElement): void {
  unwrapSpans(
    Array.from(container.querySelectorAll<HTMLSpanElement>(`span.${HIGHLIGHT_CLASS}`)),
  );
}

/**
 * Signature per thread = resolved flag + author tint. A change to either forces
 * a rewrap of that thread's spans (a stale --hl-color would never recolor
 * otherwise, and the resolved fade would never apply).
 */
function threadSignature(thread: CommentThreadDTO): string {
  const resolved = thread.root.status === "resolved";
  return `${resolved}|${identityColor(thread.root.author_name)}`;
}

function spanSignature(span: HTMLSpanElement): string {
  const resolved = span.getAttribute("data-resolved") === "true";
  return `${resolved}|${span.style.getPropertyValue("--hl-color").trim()}`;
}

/**
 * Incrementally reconcile the DOM's highlight spans with `threads` (perf H3).
 * Returns true when any span was added, removed, or rewrapped.
 *
 * A thread is UNTOUCHED when its spans still concatenate to exactly the
 * anchored quote and carry the current signature — those spans are never
 * detached. That preserves the no-detach-during-click guarantee (audit
 * invariant L5-3): a needless strip+rebuild would detach the very span a user
 * is mid-click on, the browser would dispatch `click` on the ancestor instead
 * of the removed span, and the thread would silently fail to open.
 */
function decorate(
  container: HTMLElement,
  threads: CommentThreadDTO[],
  cache: RelocationCache,
): boolean {
  // ONE span query, grouped by thread id. querySelectorAll returns document
  // order, so a multi-node quote concatenates in reading order.
  const present = new Map<string, HTMLSpanElement[]>();
  const malformed: HTMLSpanElement[] = [];
  for (const span of Array.from(
    container.querySelectorAll<HTMLSpanElement>(`span.${HIGHLIGHT_CLASS}`),
  )) {
    const id = span.getAttribute("data-thread-id");
    if (!id) {
      malformed.push(span);
      continue;
    }
    const list = present.get(id);
    if (list) list.push(span);
    else present.set(id, [span]);
  }

  const wanted = new Map(threads.map((t) => [t.root.id, t] as const));
  let changed = false;

  // PHASE 1 — strip: malformed spans, vanished threads, and changed threads
  // whose spans must be rebuilt. Stripping (with its text-node normalize)
  // happens BEFORE any resolution so phase 2 ranges are computed against the
  // settled DOM.
  if (malformed.length > 0) {
    unwrapSpans(malformed);
    changed = true;
  }
  const rebuild: CommentThreadDTO[] = [];
  for (const [id, spans] of present) {
    const thread = wanted.get(id);
    if (!thread) {
      unwrapSpans(spans);
      changed = true;
      continue;
    }
    const signature = threadSignature(thread);
    const quote = spans.map((s) => s.textContent ?? "").join("");
    if (quote === thread.root.anchor.quote && spans.every((s) => spanSignature(s) === signature)) {
      continue; // untouched — see the no-detach note above
    }
    unwrapSpans(spans);
    changed = true;
    rebuild.push(thread);
  }
  // Threads with no spans yet: newly added, rebuilt after a content change, or
  // block-fallback/orphaned (those resolve to a cache hit and stay span-less —
  // the badge / top-bar handle them).
  for (const thread of threads) {
    if (!present.has(thread.root.id)) rebuild.push(thread);
  }

  if (rebuild.length === 0) return changed;

  // PHASE 2 — resolve + wrap through the shared cache (perf H5).
  const pass = cache.beginPass(new Set(wanted.keys()));
  for (const thread of rebuild) {
    const result = pass.resolve(thread.root.id, thread.root.anchor);
    // Only mark text we can locate precisely; block-fallback/orphaned anchors
    // have no concrete text run to underline.
    if (result.status !== "exact") continue;

    wrapRange(result.range, {
      threadId: thread.root.id,
      blockId: thread.root.anchor.blockId,
      resolved: thread.root.status === "resolved",
      // Per-author tint: the mark takes the comment author's identity color (the
      // same hue as their avatar), so multiple authors are distinguishable.
      color: identityColor(thread.root.author_name),
    });
    // Wrapping moved the quote's text nodes into the new span(s), which
    // collapses the resolved Range — refresh the shared cache entry so the
    // BadgeLayer consumes a live Range instead of re-deriving one.
    pass.refresh(thread.root.id, thread.root.anchor);
    changed = true;
  }
  return changed;
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
