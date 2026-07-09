"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MessageSquarePlus } from "lucide-react";
import type { TextQuoteAnchor } from "@md/core";
import {
  buildAnchor,
  buildBlockAnchor,
  createRelocationCache,
  rangeFromOffsets,
} from "@/lib/anchor";
import type { CommentStatus, CommentThreadDTO } from "@/lib/comments-api";
import type { Role } from "@/lib/document-api";
import { identityColor } from "@/lib/identity-color";
import { useCoarsePointer } from "@/lib/use-coarse-pointer";
import { useToast } from "@/components/ui/toast";
import { SelectionComposer } from "./SelectionComposer";
import { BadgeLayer } from "./BadgeLayer";
import { InlineHighlightLayer } from "./InlineHighlightLayer";
import { ThreadPopover } from "./ThreadPopover";

/**
 * Orchestrates the Medium/Docs-style commenting overlay above the preview:
 * - selection detection → inline SelectionComposer (create new comments)
 * - keyboard creation (WCAG 2.1.1): every [data-block-id] block is focusable;
 *   focusing one reveals a "Comment on this block" affordance, and pressing
 *   C (or Enter) opens the SelectionComposer anchored to that whole block —
 *   commenting never requires a pointer
 * - inline underline locators on anchored text (InlineHighlightLayer); clicking
 *   one opens ONLY that text's own thread, so a paragraph with several comments
 *   on different sentences disambiguates per-text
 * - right-margin per-block testimonial badges (BadgeLayer); a quiet, non-expanding
 *   indicator whose click opens the block OVERVIEW (every thread on the paragraph)
 * - hover coupling: fully imperative DOM stamping (perf H7 — hover never
 *   re-renders React). A badge hover stamps data-emphasized on the block's
 *   underline(s) and back on the badge; an underline hover narrows that to its
 *   single thread's spans
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
  threads: CommentThreadDTO[];
  /**
   * The viewer's own display name, used to tint the live-selection overlay with
   * their identity color (the same hue as their avatar). Undefined before the
   * self name is known (e.g. an owner who hasn't posted yet) — the overlay then
   * falls back to `--accent` via the CSS default.
   */
  currentUserName?: string;
  /**
   * Posts a comment; resolves with the posted comment's id (null on failure).
   * The id enables the Undo toast after an emoji quick-react (audit m7).
   */
  addComment: (
    anchor: TextQuoteAnchor,
    body: string,
    authorName?: string,
  ) => Promise<string | null>;
  addReply: (commentId: string, body: string) => Promise<void>;
  react: (commentId: string, emoji: string) => Promise<void>;
  setStatus: (commentId: string, status: CommentStatus) => Promise<void>;
  /**
   * The delete mutation from useComments — the SAME path the Code view uses
   * (audit 3.10): one source of truth for the optimistic drop, the tombstone,
   * and the failure toast + Retry. This layer never talks to the delete API
   * itself; the upstream `threads` prop reflects the drop immediately.
   */
  removeComment: (commentId: string) => Promise<void>;
}) {
  const isTouch = useCoarsePointer();
  const { toast } = useToast();

  // The viewer's identity color for the live-selection overlay. Null until a self
  // name is known (CSS then falls back to --accent).
  const selfColor = useMemo(
    () => (currentUserName ? identityColor(currentUserName) : null),
    [currentUserName],
  );

  // Selection composer state. `rects` are the selection's client rectangles in
  // container-relative px, kept so we can paint a persistent highlight over the
  // chosen text while the composer is open (on touch/keyboard the native
  // selection clears the moment the composer's textarea takes focus; on fine
  // pointers the composer no longer steals focus, and the overlay simply sits
  // on top of the still-live selection). `source` records HOW the composer was
  // opened: keyboard-created composers must focus the field immediately (the
  // user has no pointer to click into it), pointer ones must not (audit M3).
  const [selection, setSelection] = useState<{
    rect: DOMRect;
    anchor: TextQuoteAnchor;
    rects: { top: number; left: number; width: number; height: number }[];
    source: "pointer" | "keyboard";
  } | null>(null);
  // The block that currently holds keyboard focus (B1): drives the visible
  // "Comment on this block" affordance. Container-relative `top` places it.
  const [focusedBlock, setFocusedBlock] = useState<{ blockId: string; top: number } | null>(
    null,
  );
  const affordanceRef = useRef<HTMLButtonElement>(null);
  // Active block popover state (a block can carry several threads).
  const [active, setActive] = useState<
    { blockId: string; threadIds: string[]; rect: DOMRect } | null
  >(null);

  // Shared relocation cache (perf H5): ONE memoized anchor→Range resolution set
  // per container, consumed by BOTH the inline-highlight and badge layers, so a
  // refetch/resize no longer re-runs the full container query + text walk once
  // per thread per layer.
  const relocationCache = useMemo(
    () => (container ? createRelocationCache(container) : null),
    [container],
  );

  // Hover emphasis is fully imperative (perf H7): the hovered thread/block ids
  // live in a ref and the handlers stamp data-emphasized straight onto the
  // matching spans + badge — a mouseover/out never re-renders this layer or the
  // N badges. The two channels mirror the old state semantics: the thread id
  // (underline hover/focus) takes precedence for the spans, so pointing at one
  // sentence's underline lights ONLY that sentence — even when the paragraph
  // carries several comments; the block id (badge hover/focus) lights every
  // underline on the block plus the badge itself.
  const hoverRef = useRef<{ threadId: string | null; blockId: string | null }>({
    threadId: null,
    blockId: null,
  });
  const stampedRef = useRef<Element[]>([]);

  const clearEmphasis = useCallback(() => {
    for (const el of stampedRef.current) el.removeAttribute("data-emphasized");
    stampedRef.current = [];
  }, []);

  const applyEmphasis = useCallback(() => {
    clearEmphasis();
    if (!container) return;
    const { threadId, blockId } = hoverRef.current;
    const spanSelector = threadId
      ? `.md-comment-highlight[data-thread-id="${cssEscape(threadId)}"]`
      : blockId
        ? `.md-comment-highlight[data-block-id="${cssEscape(blockId)}"]`
        : null;
    if (spanSelector) {
      container.querySelectorAll<HTMLElement>(spanSelector).forEach((s) => {
        s.setAttribute("data-emphasized", "true");
        stampedRef.current.push(s);
      });
    }
    // The block-hover channel also lights the block's badge (CSS reads
    // data-emphasized on the button).
    if (blockId) {
      const badge = container.querySelector<HTMLElement>(
        `[data-badge-block-id="${cssEscape(blockId)}"]`,
      );
      if (badge) {
        badge.setAttribute("data-emphasized", "true");
        stampedRef.current.push(badge);
      }
    }
  }, [container, clearEmphasis]);

  // Un-stamp on container swap / unmount so no stale attribute survives.
  useEffect(() => clearEmphasis, [applyEmphasis, clearEmphasis]);

  const setHoveredThread = useCallback(
    (threadId: string | null) => {
      if (hoverRef.current.threadId === threadId) return;
      hoverRef.current = { ...hoverRef.current, threadId };
      applyEmphasis();
    },
    [applyEmphasis],
  );
  const setHoveredBlock = useCallback(
    (blockId: string | null) => {
      if (hoverRef.current.blockId === blockId) return;
      hoverRef.current = { ...hoverRef.current, blockId };
      applyEmphasis();
    },
    [applyEmphasis],
  );

  // Always-current threads for the delegated-DOM handlers. The inline-highlight
  // spans are (re)built imperatively by InlineHighlightLayer's MutationObserver
  // the instant `threads` changes, but React re-binds effect callbacks on a later
  // tick — so a click landing in that gap must NOT read a stale `threads` from a
  // captured closure (it would filter to zero ids and silently no-op the open).
  // Reading through a ref keeps openBlock stable AND correct regardless of timing.
  // Deletes need no local shadow list: removeComment (useComments) drops the row
  // optimistically, so the `threads` prop itself updates on the very click.
  const threadsRef = useRef(threads);
  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

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
      setSelection({ rect, anchor, rects, source: "pointer" });
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

  // Keyboard comment creation (B1, WCAG 2.1.1): open the composer anchored to a
  // whole block — no pointer selection involved. The anchor quotes the block's
  // leading text (buildBlockAnchor), and the persistent highlight overlay paints
  // exactly the anchored range so the user sees what the comment will attach to.
  const openBlockComposer = useCallback(
    (block: HTMLElement) => {
      if (!container) return;
      const anchor = buildBlockAnchor(block);
      if (!anchor) return; // no text to anchor to (e.g. an <hr>)
      const range = rangeFromOffsets(block, 0, anchor.quote.length);
      const rect = range.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const rects = Array.from(range.getClientRects()).map((r) => ({
        top: r.top - containerRect.top + container.scrollTop,
        left: r.left - containerRect.left + container.scrollLeft,
        width: r.width,
        height: r.height,
      }));
      setActive(null);
      setSelection({ rect, anchor, rects, source: "keyboard" });
    },
    [container],
  );

  // Focus tracking for the keyboard affordance (B1). Blocks are the elements
  // whose data-block-id sits on the block itself — inline highlight spans also
  // carry data-block-id, so they are excluded explicitly. Both the affordance
  // and the hotkey are gated on :focus-visible: a pointer CLICK also focuses a
  // tabindex block, but pointer users comment via text selection — without the
  // gate every click would flash the pill, and typing "c" after a click would
  // hijack the open composer's anchor. The affordance stays visible while focus
  // rests on the block OR moves onto the affordance button; anything else hides
  // it (a focus move onto another block re-shows it there).
  useEffect(() => {
    if (!container) return;

    const BLOCK_ONLY = "[data-block-id]:not(.md-comment-highlight)";

    const keyboardFocusedBlockOf = (target: EventTarget | null): HTMLElement | null =>
      target instanceof HTMLElement &&
      target.matches(BLOCK_ONLY) &&
      target.matches(":focus-visible")
        ? target
        : null;

    const onFocusIn = (e: FocusEvent) => {
      const block = keyboardFocusedBlockOf(e.target);
      if (!block || (block.textContent ?? "").trim().length === 0) return;
      const blockId = block.getAttribute("data-block-id");
      if (blockId === null) return;
      const containerRect = container.getBoundingClientRect();
      const top =
        block.getBoundingClientRect().top - containerRect.top + container.scrollTop;
      setFocusedBlock({ blockId, top });
    };
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget;
      if (next instanceof HTMLElement) {
        // Moving onto the affordance keeps it; moving onto another block lets
        // that block's focusin replace it in the same tick.
        if (affordanceRef.current?.contains(next) || next.matches(BLOCK_ONLY)) return;
      }
      setFocusedBlock(null);
    };
    // The documented hotkey: C (or Enter) on a keyboard-focused block opens the
    // composer anchored to that whole block.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "c" && e.key !== "C" && e.key !== "Enter") return;
      const block = keyboardFocusedBlockOf(e.target);
      if (!block) return;
      e.preventDefault();
      openBlockComposer(block);
    };

    container.addEventListener("focusin", onFocusIn);
    container.addEventListener("focusout", onFocusOut);
    container.addEventListener("keydown", onKeyDown);
    return () => {
      container.removeEventListener("focusin", onFocusIn);
      container.removeEventListener("focusout", onFocusOut);
      container.removeEventListener("keydown", onKeyDown);
    };
  }, [container, openBlockComposer]);

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
      if (id) setHoveredThread(id);
    };
    const onOut = (e: Event) => {
      if (threadIdOf(e.target)) setHoveredThread(null);
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
      if (id) setHoveredThread(id);
    };
    const onFocusOut = (e: Event) => {
      if (threadIdOf(e.target)) setHoveredThread(null);
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
  }, [container, openThread, setHoveredThread]);

  const activeThreads: CommentThreadDTO[] = useMemo(() => {
    if (!active) return [];
    const set = new Set(active.threadIds);
    return threads.filter((t) => set.has(t.root.id));
  }, [active, threads]);

  // Live anchor rect for the open ThreadPopover (audit 3.11): resolve the anchor
  // element's CURRENT position on every Floating UI measure so the popover tracks
  // its text through scrolls instead of staying pinned at the click-time rect.
  // Single thread → that thread's own highlight span; block overview → the block's
  // margin badge (what was clicked); fallbacks mirror anchorRectFor. Returning
  // null (element gone, e.g. orphans or mid-rebuild) falls back to the frozen
  // click-time rect inside ThreadPopover.
  const activeLiveRect = useCallback((): DOMRect | null => {
    if (!active || !container) return null;
    if (active.threadIds.length === 1) {
      const span = container.querySelector<HTMLElement>(
        `.md-comment-highlight[data-thread-id="${cssEscape(active.threadIds[0]!)}"]`,
      );
      if (span) return span.getBoundingClientRect();
    }
    if (active.blockId !== "__orphans__") {
      const badge = container.querySelector<HTMLElement>(
        `[data-badge-block-id="${cssEscape(active.blockId)}"]`,
      );
      if (badge) return badge.getBoundingClientRect();
      const block = container.querySelector<HTMLElement>(
        `[data-block-id="${cssEscape(active.blockId)}"]`,
      );
      if (block) return block.getBoundingClientRect();
    }
    return null;
  }, [active, container]);

  return (
    <>
      {/* onDecorated re-stamps the hover emphasis after ANY span rebuild
          (audit invariant L5-2) — including MutationObserver-driven rebuilds
          that happen entirely outside React. */}
      <InlineHighlightLayer
        container={container}
        threads={threads}
        cache={relocationCache}
        onDecorated={applyEmphasis}
      />

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

      {/* Keyboard affordance (B1): visible while a block holds focus. Rendered
          after the blocks in DOM order, so keyboard users act via the documented
          C/Enter hotkey (shown on the pill); pointer users can click it. */}
      {focusedBlock ? (
        <button
          ref={affordanceRef}
          type="button"
          aria-keyshortcuts="c"
          onClick={() => {
            if (!container) return;
            const block = container.querySelector<HTMLElement>(
              `[data-block-id="${cssEscape(focusedBlock.blockId)}"]:not(.md-comment-highlight)`,
            );
            if (block) openBlockComposer(block);
          }}
          className="absolute left-0 z-20 inline-flex -translate-y-[calc(100%+4px)] items-center gap-1.5 rounded-full border border-border bg-elevated px-3 py-1.5 text-xs font-medium text-foreground shadow-sm transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background motion-safe:animate-in motion-safe:fade-in-0"
          style={{ top: focusedBlock.top }}
        >
          <MessageSquarePlus aria-hidden className="size-3.5" />
          Comment on this block
          <kbd
            aria-hidden
            className="rounded border border-border bg-secondary px-1 font-mono text-[0.65rem] leading-4 text-muted-foreground"
          >
            C
          </kbd>
        </button>
      ) : null}

      <BadgeLayer
        container={container}
        threads={threads}
        cache={relocationCache}
        selectedBlockId={active?.blockId ?? null}
        onOpenBlock={openBlock}
        onHoverBlock={setHoveredBlock}
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
        focusOnOpen={isTouch || selection?.source === "keyboard"}
        onClose={closeSelection}
        onSubmitText={async (anchor, body) => {
          await addComment(anchor, body, currentUserName);
        }}
        onSubmitEmoji={async (anchor, emoji) => {
          const id = await addComment(anchor, emoji, currentUserName);
          // An emoji tap posts a FULL comment in one gesture — give a mis-tap a
          // ~5s Undo window (audit m7). `id` is null when the POST failed (the
          // failure toast with Retry has already surfaced in that case).
          if (id) {
            toast({
              message: `${emoji} posted`,
              durationMs: 5000,
              action: { label: "Undo", onClick: () => void removeComment(id) },
            });
          }
        }}
      />

      <ThreadPopover
        open={active !== null}
        threads={activeThreads}
        rect={active?.rect ?? null}
        getLiveRect={activeLiveRect}
        role={role}
        onClose={() => setActive(null)}
        onReply={addReply}
        onReact={react}
        onSetStatus={setStatus}
        onDelete={removeComment}
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
