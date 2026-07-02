"use client";

import { useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Check, MessageSquarePlus, RotateCcw, Trash2, X } from "lucide-react";
import type { CommentDTO, CommentThread } from "@/lib/comments-api";
import type { Role } from "@/lib/document-api";
import { relativeTime } from "@/lib/relative-time";
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
 * The quoted source text that used to head each thread is GONE: the inline
 * underline in the document already conveys exactly which text is under
 * discussion, so repeating it here is redundant. Esc / outside-click close it.
 */
export function ThreadPopover({
  open,
  threads,
  rect,
  role,
  onClose,
  onReply,
  onReact,
  onSetStatus,
  onDelete,
}: {
  open: boolean;
  threads: CommentThread[];
  rect: DOMRect | null;
  role: Role;
  onClose: () => void;
  onReply: (commentId: string, body: string) => Promise<void>;
  onReact: (commentId: string, emoji: string) => Promise<void>;
  onSetStatus: (commentId: string, status: "open" | "resolved") => Promise<void>;
  onDelete: (commentId: string) => Promise<void>;
}) {
  const virtualAnchor = rect ? { getBoundingClientRect: () => rect } : null;
  // On coarse/touch pointers the on-screen keyboard resizes the visual viewport
  // and auto-scrolls the focused field, which would make Floating UI re-measure
  // and relocate the popup the instant the reply field is focused. The anchor is
  // a frozen rect that never moves while the thread is open, so tracking layout
  // shift buys nothing here — disable it on touch to keep the thread visually
  // stable when the keyboard opens. Desktop keeps live tracking.
  const isTouch = useMediaQuery("(pointer: coarse)");

  return (
    <PopoverPrimitive.Root
      open={open && virtualAnchor !== null && threads.length > 0}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          anchor={virtualAnchor}
          side="left"
          align="start"
          sideOffset={20}
          collisionPadding={8}
          disableAnchorTracking={isTouch}
          className="isolate z-50"
        >
          <PopoverPrimitive.Popup
            className="flex max-h-[min(70vh,32rem)] w-[22rem] max-w-[min(22rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-2xl bg-elevated text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
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
  );
}

ThreadPopover.displayName = "ThreadPopover";

function BlockBody({
  threads,
  role,
  onReply,
  onReact,
  onSetStatus,
  onDelete,
}: {
  threads: CommentThread[];
  role: Role;
  onReply: (commentId: string, body: string) => Promise<void>;
  onReact: (commentId: string, emoji: string) => Promise<void>;
  onSetStatus: (commentId: string, status: "open" | "resolved") => Promise<void>;
  onDelete: (commentId: string) => Promise<void>;
}) {
  const totalComments = threads.reduce((sum, t) => sum + 1 + t.replies.length, 0);
  const multi = threads.length > 1;

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

      <div className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
        {threads.map((thread) => (
          <ThreadSection
            key={thread.root.id}
            thread={thread}
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
  role,
  onReply,
  onReact,
  onSetStatus,
  onDelete,
}: {
  thread: CommentThread;
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
      {(resolved || role === "owner") && (
        <div className="mb-1 flex items-center justify-between">
          {resolved ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[0.7rem] font-medium text-muted-foreground">
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
      )}
    >
      <Trash2 aria-hidden />
    </Button>
  );
}

DeleteControl.displayName = "DeleteControl";
