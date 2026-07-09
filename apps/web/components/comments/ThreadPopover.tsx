"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Check, MessageSquarePlus, RotateCcw, Trash2, X } from "lucide-react";
import type { CommentDTO, CommentThreadDTO } from "@/lib/comments-api";
import type { Role } from "@/lib/document-api";
import { relativeTime } from "@/lib/relative-time";
import { useKeyboardInset } from "@/lib/use-keyboard-inset";
import { useMediaQuery } from "@/lib/use-media-query";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Avatar } from "./Avatar";
import { CommentComposer } from "./CommentComposer";
import { ReactionBar } from "./ReactionBar";

/**
 * Expanded comment view for ONE block, anchored next to the block's text (a
 * virtual element at the highlight range / badge rect). Renders every thread on
 * the block — usually one, but a block can carry several — as a stacked list,
 * each with root + replies, reactions, a reply composer, and an owner-only
 * Resolve toggle.
 *
 * The quoted source text heads a thread ONLY when its anchor no longer
 * relocates exactly (block fallback / orphaned — audit M4): with no inline
 * underline in the document, the stored `anchor.quote` is the reader's only way
 * to know which text was under discussion. Exactly-anchored threads stay
 * quote-less — their underline already conveys it. Esc / outside-click close it.
 */
export function ThreadPopover({
  open,
  threads,
  rect,
  getLiveRect,
  role,
  onClose,
  onReply,
  onReact,
  onSetStatus,
  onDelete,
}: {
  open: boolean;
  threads: CommentThreadDTO[];
  rect: DOMRect | null;
  /**
   * Live resolver for the anchor's CURRENT on-screen rect (the highlight span /
   * badge the popover belongs to). Read on every Floating UI measure so the
   * popover tracks its text through scrolls — the click-time `rect` alone froze
   * the anchor where it was at open time, detaching the popover from its text
   * the moment the page scrolled (audit 3.11). Same live-anchor pattern as
   * SelectionComposer; `rect` stays as the open signal and the fallback when the
   * anchor element is (momentarily) gone, e.g. mid-rebuild or for orphans.
   */
  getLiveRect?: () => DOMRect | null;
  role: Role;
  onClose: () => void;
  onReply: (commentId: string, body: string) => Promise<void>;
  onReact: (commentId: string, emoji: string) => Promise<void>;
  onSetStatus: (commentId: string, status: "open" | "resolved") => Promise<void>;
  onDelete: (commentId: string) => Promise<void>;
}) {
  // Keep the last non-null click-time rect so the live anchor always has a
  // fallback (mirrors SelectionComposer's lastRectRef).
  const lastRectRef = useRef<DOMRect | null>(rect);
  useEffect(() => {
    if (rect) lastRectRef.current = rect;
  }, [rect]);
  const virtualAnchor = useMemo(
    () =>
      rect
        ? {
            getBoundingClientRect: () =>
              getLiveRect?.() ?? lastRectRef.current ?? new DOMRect(),
          }
        : null,
    [rect, getLiveRect],
  );
  // On coarse/touch pointers the on-screen keyboard resizes the visual viewport
  // and auto-scrolls the focused field, which would make Floating UI re-measure
  // and relocate the popup the instant the reply field is focused. Tracking
  // layout shift there hurts more than it helps — disable it on touch to keep
  // the thread visually stable when the keyboard opens. Desktop keeps live
  // tracking, so the popover follows its anchored text through scrolls.
  const isTouch = useMediaQuery("(pointer: coarse)");

  // Keyboard docking (audit M19, same treatment as SelectionComposer): a
  // low-anchored popover would sit under the software keyboard the moment the
  // reply field focuses. While the keyboard is up, re-anchor the popup to an
  // invisible bar pinned at the keyboard's top edge (side="top"), so the thread
  // — reply field included — always stays in the visible strip above it.
  const keyboardInset = useKeyboardInset(isTouch && open);
  const keyboardOpen = isTouch && keyboardInset > 0;
  const [dockEl, setDockEl] = useState<HTMLDivElement | null>(null);

  const isOpen = open && rect !== null && threads.length > 0;

  // Focus restore (audit M10, WCAG 2.4.3): this popover opens from a virtual
  // rect — there is no Popover.Trigger for Base UI to return focus to, so on
  // close it would strand focus on <body>. Capture the originating element
  // (highlight span / badge / orphan pill) inside `initialFocus`: Base UI calls
  // it right before moving focus into the popup, so document.activeElement is
  // still the opener at that moment.
  const openerRef = useRef<HTMLElement | null>(null);
  const captureOpener = (): true => {
    openerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return true; // keep Base UI's default initial-focus behavior
  };

  // Last non-empty thread list, for the finalFocus fallback below — by the time
  // Base UI resolves finalFocus the parent may already have cleared `threads`.
  const lastThreadsRef = useRef(threads);
  useEffect(() => {
    if (threads.length > 0) lastThreadsRef.current = threads;
  }, [threads]);

  // Where focus goes on close: the captured opener when it is still in the
  // document; otherwise its live replacement (InlineHighlightLayer strips and
  // rebuilds highlight spans while the popover is open, detaching the captured
  // node) — the first thread's current span, then the block's margin badge.
  const resolveFinalFocus = (): HTMLElement | true => {
    const captured = openerRef.current;
    if (captured?.isConnected && captured !== document.body) return captured;
    const first = lastThreadsRef.current[0];
    if (first) {
      const span = document.querySelector<HTMLElement>(
        `.md-comment-highlight[data-thread-id="${cssEscape(first.root.id)}"]`,
      );
      if (span) return span;
      const badge = document.querySelector<HTMLElement>(
        `[data-badge-block-id="${cssEscape(first.root.anchor.blockId)}"]`,
      );
      if (badge) return badge;
    }
    return true;
  };

  return (
    <>
      {/* Dock target: a zero-height, full-width bar at the keyboard's top edge
          (fixed elements live in the layout viewport, which the keyboard does
          NOT shrink, so bottom = keyboard height lands exactly on its top edge).
          Always rendered so its ref is ready before the keyboard opens. */}
      <div
        ref={setDockEl}
        aria-hidden
        className="pointer-events-none fixed inset-x-0 z-40 h-0"
        style={{ bottom: keyboardInset }}
      />
      <PopoverPrimitive.Root
        open={isOpen && (keyboardOpen ? dockEl !== null : true)}
        onOpenChange={(next) => {
          if (!next) onClose();
        }}
      >
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Positioner
            anchor={keyboardOpen ? dockEl : virtualAnchor}
            side={keyboardOpen ? "top" : "left"}
            align={keyboardOpen ? "center" : "start"}
            sideOffset={keyboardOpen ? 8 : 20}
            collisionPadding={8}
            // Floating-by-the-text state only: when docked, the popup MUST track
            // the dock bar as the keyboard animates open/closed.
            disableAnchorTracking={isTouch && !keyboardOpen}
            className="isolate z-50"
          >
            {/* max-h also honors --available-height (set by the Positioner) so a
                docked popup shrinks to the strip above the keyboard instead of
                extending underneath it. */}
            <PopoverPrimitive.Popup
              initialFocus={captureOpener}
              finalFocus={resolveFinalFocus}
              className="flex max-h-[min(70vh,32rem,var(--available-height))] w-[22rem] max-w-[min(22rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-2xl bg-elevated text-sm text-popover-foreground shadow-popover ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
              aria-label="Comment thread"
            >
              {threads.length > 0 ? (
                <BlockBody
                  threads={threads}
                  role={role}
                  onReply={onReply}
                  onReact={onReact}
                  onSetStatus={onSetStatus}
                  onDelete={onDelete}
                />
              ) : null}
            </PopoverPrimitive.Popup>
          </PopoverPrimitive.Positioner>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
    </>
  );
}

ThreadPopover.displayName = "ThreadPopover";

/** Escape a value for a CSS attribute-equals selector (with a safe fallback). */
function cssEscape(value: string): string {
  const fn = typeof window !== "undefined" ? window.CSS?.escape : undefined;
  return fn ? fn(value) : value.replace(/["\\]/g, "\\$&");
}

/**
 * Where a thread's anchor currently lives in the rendered document (audit M4):
 * - "exact"    — its inline highlight span is painted (InlineHighlightLayer only
 *   paints exact relocations), so the underline already shows the quoted text.
 * - "detached" — the block exists but the quote no longer matches (block-start
 *   fallback): no underline, so the popover must restate `anchor.quote`.
 * - "orphaned" — the block itself has been removed from the document.
 */
type AnchorPresence = "exact" | "detached" | "orphaned";

function anchorPresence(threadId: string, blockId: string): AnchorPresence {
  if (typeof document === "undefined") return "exact";
  const span = document.querySelector(
    `.md-comment-highlight[data-thread-id="${cssEscape(threadId)}"]`,
  );
  if (span) return "exact";
  const block = document.querySelector(`[data-block-id="${cssEscape(blockId)}"]`);
  return block ? "detached" : "orphaned";
}

function BlockBody({
  threads,
  role,
  onReply,
  onReact,
  onSetStatus,
  onDelete,
}: {
  threads: CommentThreadDTO[];
  role: Role;
  onReply: (commentId: string, body: string) => Promise<void>;
  onReact: (commentId: string, emoji: string) => Promise<void>;
  onSetStatus: (commentId: string, status: "open" | "resolved") => Promise<void>;
  onDelete: (commentId: string) => Promise<void>;
}) {
  const totalComments = threads.reduce((sum, t) => sum + 1 + t.replies.length, 0);
  const multi = threads.length > 1;

  // Resolved once per thread-list change; opening the popover happens right
  // after a click on a live span/badge, so the spans are already painted.
  const presence = useMemo(() => {
    const map = new Map<string, AnchorPresence>();
    for (const t of threads) {
      map.set(t.root.id, anchorPresence(t.root.id, t.root.anchor.blockId));
    }
    return map;
  }, [threads]);
  const allOrphaned =
    threads.length > 0 &&
    threads.every((t) => presence.get(t.root.id) === "orphaned");

  return (
    <>
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">
          {multi ? `${threads.length} threads` : "Thread"}
        </h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          {totalComments} {totalComments === 1 ? "comment" : "comments"}
        </span>
      </header>

      {/* Visible orphan-group explainer (audit M4) — previously this context
          lived only in the orphan pill's aria-label, so sighted users had no
          idea why these threads carry no underline in the document. */}
      {allOrphaned ? (
        <p className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
          These comments were left on text that has been removed.
        </p>
      ) : null}

      <div className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
        {threads.map((thread) => (
          <ThreadSection
            key={thread.root.id}
            thread={thread}
            presence={presence.get(thread.root.id) ?? "exact"}
            role={role}
            onReply={onReply}
            onReact={onReact}
            onSetStatus={onSetStatus}
            onDelete={onDelete}
          />
        ))}
      </div>
    </>
  );
}

BlockBody.displayName = "BlockBody";

function ThreadSection({
  thread,
  presence,
  role,
  onReply,
  onReact,
  onSetStatus,
  onDelete,
}: {
  thread: CommentThreadDTO;
  /** How this thread's anchor resolved in the document (drives the quote header). */
  presence: AnchorPresence;
  role: Role;
  onReply: (commentId: string, body: string) => Promise<void>;
  onReact: (commentId: string, emoji: string) => Promise<void>;
  onSetStatus: (commentId: string, status: "open" | "resolved") => Promise<void>;
  onDelete: (commentId: string) => Promise<void>;
}) {
  const { root, replies } = thread;
  const resolved = root.status === "resolved";

  // Desktop keeps the reply field visible; mobile hides it behind a Reply button
  // (revealed on tap) so the compact thread UI stays uncluttered.
  const isDesktop = useMediaQuery("(min-width: 768px)");
  const reduceMotion = useReducedMotion();
  const [replyOpen, setReplyOpen] = useState(false);
  const showComposer = isDesktop || replyOpen;

  // Forwarded to the reply textarea so cancelling can blur it — blurring is what
  // actually dismisses the iOS keyboard (collapsing the box alone does not).
  const replyFieldRef = useRef<HTMLTextAreaElement>(null);
  const cancelReply = () => {
    replyFieldRef.current?.blur();
    setReplyOpen(false);
  };

  // Spring used both for the reply-row entry and the composer reveal — gives the
  // "the message I just sent slid into the list" feel and grows the popover
  // gradually so it never jumps. Reduced-motion users get an instant change.
  const spring = reduceMotion
    ? { duration: 0 }
    : { type: "spring" as const, stiffness: 460, damping: 34, mass: 0.7 };

  return (
    <section className="px-4 py-3">
      {/* Quoted-text header (audit M4): shown ONLY when the anchor did not
          relocate exactly — with no inline underline in the document, the stored
          quote is the reader's only record of which text was commented on. */}
      {presence !== "exact" && root.anchor.quote ? (
        <blockquote className="mb-2 border-l-2 border-border pl-2 text-xs italic text-muted-foreground">
          <span className="line-clamp-2 break-words">{root.anchor.quote}</span>
        </blockquote>
      ) : null}

      {(resolved || role === "owner") && (
        <div className="mb-1 flex items-center justify-between">
          {resolved ? (
            // bg-secondary + muted-foreground is the AA-safe pairing in both
            // themes (audit B2) — bg-muted rendered the pill invisible in dark.
            <span className="rounded-full bg-secondary px-2 py-0.5 text-[0.7rem] font-medium text-muted-foreground">
              Resolved
            </span>
          ) : (
            <span />
          )}
          {role === "owner" ? (
            <Button
              type="button"
              size="xs"
              variant={resolved ? "ghost" : "secondary"}
              onClick={() => void onSetStatus(root.id, resolved ? "open" : "resolved")}
              // Transparent hit extender (audit M12): the visual stays a compact
              // 24px pill, but the touch target grows to ≥44px.
              className="relative before:absolute before:-inset-x-2 before:-inset-y-2.5"
            >
              {resolved ? <RotateCcw aria-hidden /> : <Check aria-hidden />}
              {resolved ? "Reopen" : "Resolve"}
            </Button>
          ) : null}
        </div>
      )}

      <CommentRow comment={root} role={role} onDelete={onDelete} />
      {/* Replies animate in: a new reply expands from height 0 with a spring, so
          the popover grows smoothly instead of snapping taller. `initial={false}`
          keeps already-present replies static when the thread first opens. */}
      <AnimatePresence initial={false}>
        {replies.map((reply) => (
          <motion.div
            key={reply.id}
            layout
            initial={{ opacity: 0, height: 0, y: 6 }}
            animate={{ opacity: 1, height: "auto", y: 0 }}
            exit={{ opacity: 0, height: 0 }}
            transition={spring}
            style={{ overflow: "hidden" }}
          >
            <CommentRow comment={reply} role={role} onDelete={onDelete} />
          </motion.div>
        ))}
      </AnimatePresence>

      <div className="mt-2 flex flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <ReactionBar
            reactions={root.reactions}
            onToggle={(emoji) => void onReact(root.id, emoji)}
          />
          {/* Mobile-only Reply toggle, inline with the reactions. Tapping reveals
              and focuses the composer; tapping again (now "Cancel") collapses it
              and blurs the field so the keyboard dismisses. */}
          {!isDesktop ? (
            <button
              type="button"
              aria-expanded={replyOpen}
              onClick={() => (replyOpen ? cancelReply() : setReplyOpen(true))}
              className={cn(
                "inline-flex h-8 shrink-0 items-center gap-1 rounded-full border border-border px-3 text-xs font-medium text-muted-foreground transition-colors",
                "hover:border-foreground/30 hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                // Transparent hit extender (audit M12): 32px visual → 48px touch
                // target. Vertical only — the ReactionBar sits directly left.
                "relative before:absolute before:inset-x-0 before:-inset-y-2",
              )}
            >
              {replyOpen ? (
                <>
                  <X aria-hidden className="size-3.5" />
                  Cancel
                </>
              ) : (
                <>
                  <MessageSquarePlus aria-hidden className="size-3.5" />
                  Reply
                </>
              )}
            </button>
          ) : null}
        </div>

        <AnimatePresence initial={false}>
          {showComposer ? (
            <motion.div
              layout
              initial={isDesktop ? false : { opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={spring}
              style={{ overflow: "hidden" }}
            >
              <ReplyComposer
                autoFocus={replyOpen}
                fieldRef={replyFieldRef}
                onSubmit={(body) => onReply(root.id, body)}
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </section>
  );
}

ThreadSection.displayName = "ThreadSection";

/**
 * Compact reply composer styled as a visible bordered input field.
 */
function ReplyComposer({
  onSubmit,
  autoFocus = false,
  fieldRef,
}: {
  onSubmit: (body: string) => Promise<void>;
  autoFocus?: boolean;
  /** Set to the inner <textarea> so the parent can blur it (dismiss keyboard). */
  fieldRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  // CommentComposer renders the <textarea> internally and exposes no ref prop.
  // Reach it through the wrapper so cancelReply can blur it without widening
  // CommentComposer's API.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const setFieldRef = (node: HTMLDivElement | null) => {
    wrapperRef.current = node;
    if (fieldRef) {
      fieldRef.current = node?.querySelector("textarea") ?? null;
    }
  };
  return (
    <div
      ref={setFieldRef}
      className="rounded-lg border border-border bg-background px-3 py-2"
    >
      <CommentComposer
        placeholder="Reply…"
        submitLabel="Reply"
        compact
        autoFocus={autoFocus}
        onSubmit={onSubmit}
      />
    </div>
  );
}

ReplyComposer.displayName = "ReplyComposer";

function CommentRow({
  comment,
  role,
  onDelete,
}: {
  comment: CommentDTO;
  role: Role;
  onDelete: (commentId: string) => Promise<void>;
}) {
  return (
    <div className="group/row relative flex gap-2.5 py-2">
      <Avatar name={comment.author_name} size="sm" className="mt-0.5 size-7 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium">{comment.author_name}</span>
          <time
            dateTime={comment.created_at}
            className="shrink-0 text-xs text-foreground/70"
          >
            {relativeTime(comment.created_at)}
          </time>
        </div>
        <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">
          {comment.body}
        </p>
      </div>
      {role === "owner" ? (
        <DeleteControl
          authorName={comment.author_name}
          onConfirm={() => onDelete(comment.id)}
        />
      ) : null}
    </div>
  );
}

CommentRow.displayName = "CommentRow";

/**
 * Owner-only moderation affordance: a small, muted trash button that morphs
 * inline into a two-step "Delete? / Cancel" confirm so a delete is never a
 * one-tap accident. The trash stays unobtrusive (revealed on row hover / focus)
 * but is always keyboard-reachable; the confirm uses the --destructive token and
 * Esc / Cancel backs out without deleting.
 *
 * On coarse / touch pointers there is no hover to reveal it, so the trash rests at
 * a low-but-visible opacity instead of fully hidden — a mobile owner can discover
 * and reach it. The confirm row is given room (wrap + min-width) so the
 * Delete / Cancel buttons aren't squeezed on a narrow (≈390px) viewport.
 */
function DeleteControl({
  authorName,
  onConfirm,
}: {
  authorName: string;
  onConfirm: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);

  if (confirming) {
    return (
      <div
        className="absolute right-0 top-1.5 flex min-w-max flex-wrap items-center justify-end gap-1.5 rounded-lg bg-popover/95 px-2 py-1 shadow-sm ring-1 ring-border backdrop-blur-sm"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setConfirming(false);
          }
        }}
      >
        <span className="mr-0.5 text-xs font-medium text-destructive">Delete?</span>
        <Button
          type="button"
          size="xs"
          variant="destructive"
          disabled={pending}
          autoFocus
          // Vertical-only hit extender (audit M12) — Cancel sits directly right.
          className="relative before:absolute before:inset-x-0 before:-inset-y-2.5"
          onClick={async () => {
            setPending(true);
            try {
              await onConfirm();
            } catch {
              // Surface re-enables the control so the owner can retry.
              setPending(false);
              setConfirming(false);
            }
          }}
        >
          <Trash2 aria-hidden />
          Delete
        </Button>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          disabled={pending}
          onClick={() => setConfirming(false)}
          // Vertical-only hit extender (audit M12) — Delete sits directly left.
          className="relative before:absolute before:inset-x-0 before:-inset-y-2.5"
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <Button
      type="button"
      size="icon-xs"
      variant="ghost"
      title="Delete comment"
      aria-label={`Delete comment by ${authorName}`}
      onClick={() => setConfirming(true)}
      className={cn(
        "absolute right-0 top-1.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover/row:opacity-100",
        // Coarse / touch pointers have no hover to reveal it: keep the trash at a
        // low-but-visible resting opacity so a mobile owner can discover it.
        "[@media(hover:none)]:opacity-60 [@media(pointer:coarse)]:opacity-60",
        // Transparent hit extender (audit M12): 24px visual → 44px touch target.
        "before:absolute before:-inset-2.5",
      )}
    >
      <Trash2 aria-hidden />
    </Button>
  );
}

DeleteControl.displayName = "DeleteControl";
