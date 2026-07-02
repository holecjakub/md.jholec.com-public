"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import type { TextQuoteAnchor } from "@md/core";
import { buildAnchor } from "@/lib/anchor";
import { deleteComment, type CommentStatus, type CommentThread } from "@/lib/comments-api";
import type { Role } from "@/lib/document-api";
import { identityColor } from "@/lib/identity-color";
import { useCoarsePointer } from "@/lib/use-coarse-pointer";
import { SelectionComposer } from "./SelectionComposer";
import { BadgeLayer } from "./BadgeLayer";
import { InlineHighlightLayer } from "./InlineHighlightLayer";
import { ThreadPopover } from "./ThreadPopover";

/**
 * Orchestrates the Medium/Docs-style commenting overlay above the preview:
 * - selection detection → inline SelectionComposer (create new comments)
 * - inline underline locators on anchored text (InlineHighlightLayer); clicking
 *   one opens ONLY that text's own thread, so a paragraph with several comments
 *   on different sentences disambiguates per-text
 * - right-margin per-block testimonial badges (BadgeLayer); a quiet, non-expanding
 *   indicator whose click opens the block OVERVIEW (every thread on the paragraph)
 * - hover coupling: a shared hovered-block id ties each badge to its underline(s);
 *   an underline hover narrows that to its single thread (hovered-thread id)
 * - click → ThreadPopover (a single thread from an underline, all threads from a
 *   badge), anchored at the text
 *
 * `container` is the preview element (carrying the [data-block-id] blocks).
 * Comment STATE lives one level up (DocumentView) so the owner toolbar count
 * stays live in code view; this receives the thread tree + mutation callbacks.
 */
export function CommentsLayer({
  role,
  container,
  threads,
  currentUserName,
  addComment,
  addReply,
  react,
  setStatus,
  removeComment,
}: {
  role: Role;
  container: HTMLElement | null;
  threads: CommentThread[];
  /**
   * The viewer's own display name, used to tint the live-selection overlay with
   * their identity color (the same hue as their avatar). Undefined before the
   * self name is known (e.g. an owner who hasn't posted yet) — the overlay then
   * falls back to `--accent` via the CSS default.
   */
  currentUserName?: string;
  addComment: (anchor: TextQuoteAnchor, body: string, authorName?: string) => Promise<void>;
  addReply: (commentId: string, body: string) => Promise<void>;
  react: (commentId: string, emoji: string) => Promise<void>;
  setStatus: (commentId: string, status: CommentStatus) => Promise<void>;
  /**
   * Optional injected delete mutation (owns optimistic state upstream). When the
   * parent does not supply one, this layer falls back to a self-contained delete:
   * it filters the affected thread/reply out locally and calls the API directly,
   * with the realtime broadcast → upstream refetch reconciling the source of
   * truth. Keeps owner moderation working without the parent having to wire it.
   */
  removeComment?: (commentId: string) => Promise<void>;
}) {
  const params = useParams<{ slug?: string }>();
  const slug = typeof params?.slug === "string" ? params.slug : "";
  const isTouch = useCoarsePointer();

  // The viewer's identity color for the live-selection overlay. Null until a self
  // name is known (CSS then falls back to --accent).
  const selfColor = useMemo(
    () => (currentUserName ? identityColor(currentUserName) : null),
    [currentUserName],
  );

  // Ids the owner has deleted but that the upstream `threads` prop may not have
  // dropped yet (the realtime refetch lands a tick later). We filter these out so
  // the popover / underline / badge vanish immediately. Ids that the prop has
  // already dropped become inert (they simply match nothing), so the set stays
  // negligibly small — one entry per delete in a session — with no pruning needed.
  const [deletedIds, setDeletedIds] = useState<ReadonlySet<string>>(() => new Set());
  // Selection composer state. `rects` are the selection's client rectangles in
  // container-relative px, kept so we can paint a persistent highlight over the
  // chosen text while the composer is open (the native selection clears the
  // moment the composer's textarea takes focus).
  const [selection, setSelection] = useState<{
    rect: DOMRect;
    anchor: TextQuoteAnchor;
    rects: { top: number; left: number; width: number; height: number }[];
  } | null>(null);
  // Active block popover state (a block can carry several threads).
  const [active, setActive] = useState<
    { blockId: string; threadIds: string[]; rect: DOMRect } | null
  >(null);
  // Shared hovered-block id powering the badge ↔ all-underlines hint.
  const [hoveredBlockId, setHoveredBlockId] = useState<string | null>(null);
  // Shared hovered-thread id: the single thread currently emphasised. Driven by
  // inline-underline hover/focus and takes precedence over hoveredBlockId, so
  // pointing at one sentence's underline lights ONLY that sentence — even when
  // the paragraph carries several comments. Single-thread blocks fall through to
  // block-id (block == thread there).
  const [hoveredThreadId, setHoveredThreadId] = useState<string | null>(null);

  // Always-current threads for the delegated-DOM handlers. The inline-highlight
  // spans are (re)built imperatively by InlineHighlightLayer's MutationObserver
  // the instant `threads` changes, but React re-binds effect callbacks on a later
  // tick — so a click landing in that gap must NOT read a stale `threads` from a
  // captured closure (it would filter to zero ids and silently no-op the open).
  // Reading through a ref keeps openBlock stable AND correct regardless of timing.
  // Threads with locally-deleted comments removed: drop a whole thread when its
  // root is deleted; drop individual replies otherwise. This is the single view
  // model the overlay (underlines, badges, popover) renders from.
  const visibleThreads = useMemo<CommentThread[]>(() => {
    if (deletedIds.size === 0) return threads;
    return threads
      .filter((t) => !deletedIds.has(t.root.id))
      .map((t) =>
        t.replies.some((r) => deletedIds.has(r.id))
          ? { ...t, replies: t.replies.filter((r) => !deletedIds.has(r.id)) }
          : t,
      );
  }, [threads, deletedIds]);

  const handleDelete = useCallback(
    async (commentId: string) => {
      if (removeComment) {
        await removeComment(commentId);
        return;
      }
      // Optimistically hide, then delete. The server broadcast triggers the
      // upstream refetch, which reconciles `threads` and prunes the id above.
      setDeletedIds((prev) => {
        const next = new Set(prev);
        next.add(commentId);
        return next;
      });
      try {
        await deleteComment(slug, commentId);
      } catch (err) {
        // Roll back the optimistic hide on failure.
        setDeletedIds((prev) => {
          const next = new Set(prev);
          next.delete(commentId);
          return next;
        });
        throw err;
      }
    },
    [removeComment, slug],
  );

  const threadsRef = useRef(visibleThreads);
  useEffect(() => {
    threadsRef.current = visibleThreads;
  }, [visibleThreads]);

  const closeSelection = useCallback(() => {
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  // Detect a non-collapsed selection inside the container and surface the
  // composer at the selection rect.
  useEffect(() => {
    if (!container) return;

    const evaluate = () => {
      const sel = window.getSelection();
      const anchor = buildAnchor(sel, container);
      if (!anchor || !sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const rects = Array.from(range.getClientRects()).map((r) => ({
        top: r.top - containerRect.top + container.scrollTop,
        left: r.left - containerRect.left + container.scrollLeft,
        width: r.width,
        height: r.height,
      }));
      setSelection({ rect, anchor, rects });
      setActive(null);
    };

    // A single shared timer so a later trigger supersedes an earlier one (e.g. a
    // desktop pointerup runs immediately and cancels a pending selectionchange
    // debounce), and so cleanup can cancel anything in flight.
    let settleTimer = 0;
    const scheduleEvaluate = (delay: number) => {
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(evaluate, delay);
    };

    const onPointerUp = () => {
      requestAnimationFrame(() => scheduleEvaluate(0));
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.shiftKey || e.key === "Shift" || e.key.startsWith("Arrow")) {
        scheduleEvaluate(0);
      }
    };

    // TOUCH ONLY. On desktop the selection is only final at `pointerup`/`keyup`, and
    // `selectionchange` fires repeatedly DURING a mouse drag. Evaluating on it there
    // surfaces the autofocusing composer mid-drag, which steals focus and collapses the
    // in-progress selection — the user sees the page jump, nothing stays selected, and
    // only the composer (no highlight) appears. So desktop is driven purely by the
    // pointerup/keyup handlers above.
    //
    // iOS Safari, however, does NOT reliably deliver `pointerup` to the container while
    // its native selection UI is active (long-press to select, then dragging the
    // selection handles) — so on touch the composer would only surface on a much later
    // stray pointerup, feeling sluggish. `selectionchange` fires on `document`
    // throughout the gesture; debounce it so we surface the composer shortly after the
    // selection settles. Guarded to selections inside THIS container, and ignored while
    // collapsed (so clearing the selection or focusing the textarea doesn't re-trigger).
    const onSelectionChange = () => {
      if (!isTouch) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const node = sel.anchorNode;
      if (!node || !container.contains(node)) return;
      scheduleEvaluate(200);
    };

    container.addEventListener("pointerup", onPointerUp);
    container.addEventListener("keyup", onKeyUp);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      window.clearTimeout(settleTimer);
      container.removeEventListener("pointerup", onPointerUp);
      container.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [container, isTouch]);

  const openBlock = useCallback((blockId: string, rect: DOMRect) => {
    const ids = threadsRef.current
      .filter((t) => t.root.anchor.blockId === blockId)
      .map((t) => t.root.id);
    if (ids.length === 0) return;
    setSelection(null);
    setActive({ blockId, threadIds: ids, rect });
  }, []);

  // Open a SINGLE thread's popover, anchored at THAT thread's own sentence span
  // (not the block). This is what the inline underline now routes to: clicking a
  // sentence's underline opens ONLY that sentence's comment, so a paragraph with
  // several comments disambiguates per-text. An optional `rect` lets the caller
  // pass the already-resolved anchor (the clicked span) so a span swapped out by
  // InlineHighlightLayer's rebuild between mousedown and click can't zero the
  // rect; without one we resolve it from the live highlight span (or block).
  const openThread = useCallback(
    (threadId: string, rect?: DOMRect) => {
      const thread = threadsRef.current.find((t) => t.root.id === threadId);
      if (!thread) return;
      const blockId = thread.root.anchor.blockId;
      let resolved: DOMRect | null = rect ?? null;
      if (!resolved && container) {
        const span = container.querySelector<HTMLElement>(
          `.md-comment-highlight[data-thread-id="${cssEscape(threadId)}"]`,
        );
        const block = container.querySelector<HTMLElement>(
          `[data-block-id="${cssEscape(blockId)}"]`,
        );
        resolved = (span ?? block)?.getBoundingClientRect() ?? null;
      }
      if (!resolved) return;
      setSelection(null);
      setActive({ blockId, threadIds: [threadId], rect: resolved });
    },
    [container],
  );

  // Delegated interaction on inline highlights: hover emphasises the block's
  // badge (and sibling underlines); click/Enter opens the block's thread popover
  // anchored at the highlight rect. Listening on the container keeps this in sync
  // with the imperatively-injected spans.
  useEffect(() => {
    if (!container) return;

    const highlightOf = (target: EventTarget | null): Element | null =>
      target instanceof Element ? target.closest(".md-comment-highlight") : null;
    const threadIdOf = (target: EventTarget | null): string | null =>
      highlightOf(target)?.getAttribute("data-thread-id") ?? null;

    // Hovering/focusing an inline underline is thread-precise: it lights only
    // that thread's sentence. The block-wide hint is reserved for the badge.
    const onOver = (e: Event) => {
      const id = threadIdOf(e.target);
      if (id) setHoveredThreadId(id);
    };
    const onOut = (e: Event) => {
      if (threadIdOf(e.target)) setHoveredThreadId(null);
    };
    // Resolve a usable anchor rect for the block. The clicked span may have been
    // swapped out by InlineHighlightLayer's strip+rebuild between mousedown and
    // click (leaving a detached node whose rect is all-zero), so prefer a span
    // that is still attached for this block; fall back to the block element.
    const anchorRectFor = (el: Element, blockId: string): DOMRect => {
      if (el.isConnected) return el.getBoundingClientRect();
      const live = container.querySelector<HTMLElement>(
        `.md-comment-highlight[data-block-id="${cssEscape(blockId)}"]`,
      );
      if (live) return live.getBoundingClientRect();
      const block = container.querySelector<HTMLElement>(
        `[data-block-id="${cssEscape(blockId)}"]`,
      );
      return (block ?? el).getBoundingClientRect();
    };

    // Clicking an underline opens ONLY that span's own thread (single-thread),
    // anchored at the clicked span — so a paragraph with several comments on
    // different sentences disambiguates per-text. The block-wide overview lives
    // on the right-margin badge click instead.
    const onClick = (e: Event) => {
      const el =
        e.target instanceof Element ? e.target.closest(".md-comment-highlight") : null;
      if (!el) return;
      const threadId = el.getAttribute("data-thread-id");
      const blockId = el.getAttribute("data-block-id");
      if (!threadId || !blockId) return;
      openThread(threadId, anchorRectFor(el, blockId));
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const el =
        e.target instanceof Element ? e.target.closest(".md-comment-highlight") : null;
      if (!el) return;
      e.preventDefault();
      const threadId = el.getAttribute("data-thread-id");
      const blockId = el.getAttribute("data-block-id");
      if (!threadId || !blockId) return;
      openThread(threadId, anchorRectFor(el, blockId));
    };
    const onFocusIn = (e: Event) => {
      const id = threadIdOf(e.target);
      if (id) setHoveredThreadId(id);
    };
    const onFocusOut = (e: Event) => {
      if (threadIdOf(e.target)) setHoveredThreadId(null);
    };

    container.addEventListener("mouseover", onOver);
    container.addEventListener("mouseout", onOut);
    container.addEventListener("click", onClick);
    container.addEventListener("keydown", onKeyDown);
    container.addEventListener("focusin", onFocusIn);
    container.addEventListener("focusout", onFocusOut);
    return () => {
      container.removeEventListener("mouseover", onOver);
      container.removeEventListener("mouseout", onOut);
      container.removeEventListener("click", onClick);
      container.removeEventListener("keydown", onKeyDown);
      container.removeEventListener("focusin", onFocusIn);
      container.removeEventListener("focusout", onFocusOut);
    };
  }, [container, openThread]);

  // Emphasise the matching inline underline(s) by stamping data-emphasized so the
  // CSS coupling lights them. Thread-precise FIRST: when an underline is hovered,
  // only that thread's sentence lights. Only when no thread is hovered do we fall
  // back to the badge's block hint, lighting every underline on the block —
  // keeping single-thread blocks identical (block == thread there).
  useEffect(() => {
    if (!container) return;
    const selector = hoveredThreadId
      ? `.md-comment-highlight[data-thread-id="${cssEscape(hoveredThreadId)}"]`
      : hoveredBlockId
        ? `.md-comment-highlight[data-block-id="${cssEscape(hoveredBlockId)}"]`
        : null;
    if (!selector) return;
    const spans = container.querySelectorAll<HTMLElement>(selector);
    spans.forEach((s) => s.setAttribute("data-emphasized", "true"));
    return () => {
      spans.forEach((s) => s.removeAttribute("data-emphasized"));
    };
    // `visibleThreads` is a dep so the emphasis re-applies after the inline-highlight
    // layer rebuilds its spans (e.g. an optimistic comment reconciling with its server
    // row while the badge is hovered) — child rebuild runs before this parent effect,
    // so re-querying here re-stamps the fresh span instead of leaving it un-emphasised.
  }, [container, hoveredThreadId, hoveredBlockId, visibleThreads]);

  const activeThreads: CommentThread[] = useMemo(() => {
    if (!active) return [];
    const set = new Set(active.threadIds);
    return visibleThreads.filter((t) => set.has(t.root.id));
  }, [active, visibleThreads]);

  return (
    <>
      <InlineHighlightLayer container={container} threads={visibleThreads} />

      {/* Persistent highlight over the text being commented on, so the selection
          stays visible after the composer's textarea steals native focus. */}
      {selection
        ? selection.rects.map((r, i) => (
            <span
              key={`${r.top}-${r.left}-${i}`}
              aria-hidden
              data-selection-highlight
              className="pointer-events-none absolute z-10 rounded-[2px]"
              style={{
                top: r.top,
                left: r.left,
                width: r.width,
                height: r.height,
                // Tint the overlay with the viewer's own identity color (the
                // CSS reads this via --hl-color); omitted → falls back to accent.
                ...(selfColor ? { ["--hl-color" as string]: selfColor } : {}),
              }}
            />
          ))
        : null}

      <BadgeLayer
        container={container}
        threads={visibleThreads}
        selectedBlockId={active?.blockId ?? null}
        hoveredBlockId={hoveredBlockId}
        onOpenBlock={openBlock}
        onHoverBlock={setHoveredBlockId}
        onOpenOrphans={(threadIds, rect) => {
          if (threadIds.length === 0) return;
          // Orphaned threads have no block to underline; open them as a synthetic
          // group keyed by the first id so the popover can show/resolve them.
          setSelection(null);
          setActive({ blockId: "__orphans__", threadIds, rect });
        }}
      />

      <SelectionComposer
        open={selection !== null}
        rect={selection?.rect ?? null}
        anchor={selection?.anchor ?? null}
        onClose={closeSelection}
        onSubmitText={async (anchor, body) => {
          await addComment(anchor, body, currentUserName);
        }}
        onSubmitEmoji={async (anchor, emoji) => {
          await addComment(anchor, emoji, currentUserName);
        }}
      />

      <ThreadPopover
        open={active !== null}
        threads={activeThreads}
        rect={active?.rect ?? null}
        role={role}
        onClose={() => setActive(null)}
        onReply={addReply}
        onReact={react}
        onSetStatus={setStatus}
        onDelete={handleDelete}
      />
    </>
  );
}

CommentsLayer.displayName = "CommentsLayer";

/** Escape a value for a CSS attribute-equals selector (with a safe fallback). */
function cssEscape(value: string): string {
  const fn = typeof window !== "undefined" ? window.CSS?.escape : undefined;
  return fn ? fn(value) : value.replace(/["\\]/g, "\\$&");
}
